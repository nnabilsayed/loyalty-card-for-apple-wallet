import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { createTestApp, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";
const DEVICE = "device-library-1";

describe("Apple pass web service", () => {
  let ctx: TestApp;
  let serial: string;
  let token: string;
  let otherSerial: string;
  let otherToken: string;

  const auth = (t: string) => ({ authorization: `ApplePass ${t}` });
  const register = (s = serial, t = token, body: unknown = { pushToken: "aabbccdd" }, device = DEVICE, type = PASS_TYPE) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/devices/${device}/registrations/${type}/${s}`,
      headers: t ? auth(t) : {},
      payload: body as object,
    });
  const list = (query = "", device = DEVICE, type = PASS_TYPE) =>
    ctx.app.inject({ method: "GET", url: `/v1/devices/${device}/registrations/${type}${query}` });
  const touch = (s: string) =>
    ctx.db.query("UPDATE cards SET updated_at = clock_timestamp() WHERE serial = $1", [s]);

  beforeAll(async () => {
    ctx = await createTestApp();
    const a = await issueCard(ctx.db, "+201001234567");
    const b = await issueCard(ctx.db, "+201001234568");
    serial = a.serial;
    token = a.authToken;
    otherSerial = b.serial;
    otherToken = b.authToken;
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe("register a device", () => {
    test("201 for a new registration, 200 when repeated", async () => {
      expect((await register()).statusCode).toBe(201);
      expect((await register()).statusCode).toBe(200);
    });

    test("a repeat with a new push token replaces the old one", async () => {
      await register(serial, token, { pushToken: "11223344" });
      const rows = (await ctx.db.query("SELECT push_token FROM device_registrations")).rows;
      expect(rows).toEqual([{ push_token: "11223344" }]);
    });

    test("401 with a missing, wrong, or another card's token", async () => {
      expect((await register(serial, "")).statusCode).toBe(401);
      expect((await register(serial, "not-the-token")).statusCode).toBe(401);
      expect((await register(serial, otherToken)).statusCode).toBe(401);
    });

    test("404 for an unknown serial or a different pass type", async () => {
      expect((await register("unknown-serial-0000000", token)).statusCode).toBe(404);
      expect((await register(serial, token, { pushToken: "aa" }, DEVICE, "pass.someone.else")).statusCode).toBe(404);
    });

    test("a body without a push token is refused", async () => {
      expect((await register(serial, token, {})).statusCode).toBe(422);
    });
  });

  describe("list changed passes", () => {
    test("200 with the serial and a tag when nothing was asked for yet", async () => {
      const res = await list();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.serialNumbers).toEqual([serial]);
      expect(body.lastUpdated).toMatch(/^[0-9]+$/);
    });

    test("204 when nothing changed since the tag", async () => {
      const tag = (await list()).json().lastUpdated;
      expect((await list(`?passesUpdatedSince=${tag}`)).statusCode).toBe(204);
    });

    test("after a change the serial is listed again with a newer tag", async () => {
      const before = (await list()).json().lastUpdated;
      await touch(serial);
      const res = await list(`?passesUpdatedSince=${before}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().serialNumbers).toEqual([serial]);
      expect(BigInt(res.json().lastUpdated)).toBeGreaterThan(BigInt(before));
    });

    test("only passes registered to that device are listed", async () => {
      await register(otherSerial, otherToken, { pushToken: "99" }, "device-library-2");
      expect((await list("", "device-library-2")).json().serialNumbers).toEqual([otherSerial]);
      expect((await list()).json().serialNumbers).toEqual([serial]);
    });

    test("204 for a device with no registrations", async () => {
      expect((await list("", "never-seen")).statusCode).toBe(204);
    });

    test("404 for a different pass type", async () => {
      expect((await list("", DEVICE, "pass.someone.else")).statusCode).toBe(404);
    });
  });

  describe("get the latest pass", () => {
    const get = (s: string, headers: Record<string, string> = {}) =>
      ctx.app.inject({ method: "GET", url: `/v1/passes/${PASS_TYPE}/${s}`, headers });

    test("200 with a pass file for the right token", async () => {
      const res = await get(serial, auth(token));
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/vnd.apple.pkpass");
      expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
    });

    test("401 without a token or with the wrong one", async () => {
      expect((await get(serial)).statusCode).toBe(401);
      expect((await get(serial, auth("nope"))).statusCode).toBe(401);
      expect((await get(serial, auth(otherToken))).statusCode).toBe(401);
    });

    test("404 for an unknown serial or pass type", async () => {
      expect((await get("unknown-serial-0000000", auth(token))).statusCode).toBe(404);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/passes/pass.someone.else/${serial}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(404);
    });

    test("always serves the current version (no stale 304)", async () => {
      const res = await get(serial, { ...auth(token), "if-modified-since": new Date(Date.now() + 60_000).toUTCString() });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("unregister a device", () => {
    const unregister = (s: string, t: string, device = DEVICE) =>
      ctx.app.inject({
        method: "DELETE",
        url: `/v1/devices/${device}/registrations/${PASS_TYPE}/${s}`,
        headers: t ? auth(t) : {},
      });

    test("401 with a wrong token and the registration stays", async () => {
      expect((await unregister(serial, "nope")).statusCode).toBe(401);
      expect((await list()).json().serialNumbers).toEqual([serial]);
    });

    test("200 removes it, and 200 again when it is already gone", async () => {
      expect((await unregister(serial, token)).statusCode).toBe(200);
      expect((await list()).statusCode).toBe(204);
      expect((await unregister(serial, token)).statusCode).toBe(200);
    });
  });

  describe("device logs", () => {
    test("200 and nothing is stored", async () => {
      const before = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events")).rows[0].n;
      const res = await ctx.app.inject({ method: "POST", url: "/v1/log", payload: { logs: ["something happened"] } });
      expect(res.statusCode).toBe(200);
      const after = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events")).rows[0].n;
      expect(after).toBe(before);
    });
  });
});
