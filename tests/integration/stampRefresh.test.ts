import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { readPkpass } from "../helpers/pkpass.js";
import { startFakePush, type FakePush } from "../helpers/fakePush.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("a stamp reaches the customer's phone", () => {
  let ctx: TestApp;
  let fake: FakePush;
  let cookie: string;
  let serial: string;
  let authToken: string;

  const stamp = (key: string, force = false) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/staff/cards/${serial}/stamp`,
      headers: { cookie },
      payload: { idempotencyKey: key, force },
    });
  const register = (device: string, pushToken: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/devices/${device}/registrations/${PASS_TYPE}/${serial}`,
      headers: { authorization: `ApplePass ${authToken}` },
      payload: { pushToken },
    });

  beforeAll(async () => {
    fake = await startFakePush();
    ctx = await createTestApp({}, { APNS_HOST: fake.url });
    await addTestBarista(ctx, "Sara", "123456");
    cookie = await staffLogin(ctx, "123456");
    const card = await issueCard(ctx.db, "+201001234567");
    serial = card.serial;
    authToken = card.authToken;
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  test("a stamp sends one empty push to each registered device of that card", async () => {
    await register("phone-1", "aa11");
    await register("phone-2", "bb22");
    fake.clear();

    expect((await stamp("t1")).statusCode).toBe(200);
    await ctx.app.push.idle();

    expect(fake.requests.map((r) => r.token).sort()).toEqual(["aa11", "bb22"]);
    for (const r of fake.requests) {
      expect(r.topic).toBe(PASS_TYPE);
      expect(JSON.parse(r.body)).toEqual({});
    }
  });

  test("a refused stamp sends no push", async () => {
    fake.clear();
    expect((await stamp("t2")).statusCode).toBe(409);
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("a replayed tap does not push again", async () => {
    fake.clear();
    expect((await stamp("t1")).statusCode).toBe(200);
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("another card's devices are not pushed", async () => {
    const other = await issueCard(ctx.db, "+201001234568");
    await ctx.app.inject({
      method: "POST",
      url: `/v1/devices/phone-9/registrations/${PASS_TYPE}/${other.serial}`,
      headers: { authorization: `ApplePass ${other.authToken}` },
      payload: { pushToken: "cc33" },
    });
    fake.clear();
    await stamp("t3", true);
    await ctx.app.push.idle();
    expect(fake.requests.map((r) => r.token)).not.toContain("cc33");
  });

  test("afterwards the phone sees the card as changed and downloads the new count", async () => {
    const list = await ctx.app.inject({ method: "GET", url: `/v1/devices/phone-1/registrations/${PASS_TYPE}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().serialNumbers).toEqual([serial]);

    const since = list.json().lastUpdated;
    await stamp("t4", true);
    const changed = await ctx.app.inject({
      method: "GET",
      url: `/v1/devices/phone-1/registrations/${PASS_TYPE}?passesUpdatedSince=${since}`,
    });
    expect(changed.statusCode).toBe(200);
    expect(BigInt(changed.json().lastUpdated)).toBeGreaterThan(BigInt(since));

    const pass = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${serial}`,
      headers: { authorization: `ApplePass ${authToken}` },
    });
    const { passJson } = readPkpass(pass.rawPayload);
    const cups = passJson.storeCard.secondaryFields?.find((f) => f.key === "cups");
    expect(cups?.value).toBe("3 of 10");
  });

  test("a device Apple says is gone (410) is removed from the registrations", async () => {
    fake.failToken("aa11", 410, "Unregistered");
    fake.clear();
    await stamp("t5", true);
    await ctx.app.push.idle();

    const tokens = (await ctx.db.query("SELECT push_token FROM device_registrations")).rows.map((r) => r.push_token);
    expect(tokens).not.toContain("aa11");
    expect(tokens).toContain("bb22");
  });

  test("a push that fails for another reason does not break the stamp or drop the device", async () => {
    fake.failToken("bb22", 500, "InternalServerError");
    const res = await stamp("t6", true);
    expect(res.statusCode).toBe(200);
    await ctx.app.push.idle();
    const tokens = (await ctx.db.query("SELECT push_token FROM device_registrations")).rows.map((r) => r.push_token);
    expect(tokens).toContain("bb22");
  });
});
