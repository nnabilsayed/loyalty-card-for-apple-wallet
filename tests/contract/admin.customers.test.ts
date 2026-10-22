import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("admin: find a customer and replace a lost card", () => {
  let ctx: TestApp;
  let admin: string;
  let customerId: string;
  let serial: string;
  let authToken: string;

  const find = (phone: string, cookie: string | null = admin) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/admin/customers?phone=${encodeURIComponent(phone)}`,
      headers: cookie ? { cookie } : {},
    });
  const reissue = (id: string, cookie: string | null = admin) =>
    ctx.app.inject({ method: "POST", url: `/api/admin/customers/${id}/reissue`, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestAdmin(ctx, "owner", "owner-password-1");
    await addTestBarista(ctx, "Sara", "123456");
    admin = await adminLogin(ctx, "owner", "owner-password-1");

    const card = await issueCard(ctx.db, "+201001234567");
    serial = card.serial;
    authToken = card.authToken;
    await ctx.db.query("UPDATE cards SET cups = 6 WHERE serial = $1", [serial]);
    customerId = (await ctx.db.query("SELECT id FROM customers")).rows[0].id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe("find by phone number", () => {
    test.each(["010 0123 4567", "+20 100 123 4567", "01001234567", "0020 100 123 4567"])("finds the customer typed as %s", async (typed) => {
      const res = await find(typed);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        customerId,
        phone: "+201001234567",
        cups: 6,
        rewardGoal: 10,
        freeDrinkEarned: false,
      });
      expect(res.json().createdAt).toBeTruthy();
    });

    test("never shows the card code or its auth token", async () => {
      const body = (await find("01001234567")).body;
      expect(body).not.toContain(serial);
      expect(body).not.toContain(authToken);
    });

    test("an unknown number is 404", async () => {
      expect((await find("0111 222 3333")).statusCode).toBe(404);
    });

    test("an invalid or missing number is 422", async () => {
      expect((await find("abc")).statusCode).toBe(422);
      expect((await find("")).statusCode).toBe(422);
      expect((await ctx.app.inject({ method: "GET", url: "/api/admin/customers", headers: { cookie: admin } })).statusCode).toBe(422);
    });

    test("needs an Admin session", async () => {
      const barista = await staffLogin(ctx, "123456");
      expect((await find("01001234567", null)).statusCode).toBe(401);
      expect((await find("01001234567", barista)).statusCode).toBe(401);
    });
  });

  describe("replace a card", () => {
    let newPassUrl: string;

    test("reissuing gives a new pass link", async () => {
      await ctx.app.inject({
        method: "POST",
        url: `/v1/devices/old-phone/registrations/${PASS_TYPE}/${serial}`,
        headers: { authorization: `ApplePass ${authToken}` },
        payload: { pushToken: "old-token" },
      });

      const res = await reissue(customerId);
      expect(res.statusCode).toBe(201);
      newPassUrl = res.json().passUrl;
      expect(newPassUrl).toMatch(/^\/card\/[A-Za-z0-9_-]{22}\.pkpass$/);
      expect(newPassUrl).not.toContain(serial);
    });

    test("the new card downloads and keeps the same cups", async () => {
      const dl = await ctx.app.inject({ method: "GET", url: newPassUrl });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-type"]).toBe("application/vnd.apple.pkpass");
      const row = (await ctx.db.query("SELECT cups, free_drink_earned FROM cards")).rows;
      expect(row).toEqual([{ cups: 6, free_drink_earned: false }]);
      expect((await ctx.db.query("SELECT count(*)::int AS n FROM cards")).rows[0].n).toBe(1);
    });

    test("the old card stops working everywhere", async () => {
      const barista = await staffLogin(ctx, "123456");
      expect((await ctx.app.inject({ method: "GET", url: `/card/${serial}.pkpass` })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: "GET", url: `/api/staff/cards/${serial}`, headers: { cookie: barista } })).statusCode).toBe(404);
      expect(
        (
          await ctx.app.inject({
            method: "POST",
            url: `/api/staff/cards/${serial}/stamp`,
            headers: { cookie: barista },
            payload: { idempotencyKey: "old" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await ctx.app.inject({
            method: "GET",
            url: `/v1/passes/${PASS_TYPE}/${serial}`,
            headers: { authorization: `ApplePass ${authToken}` },
          })
        ).statusCode,
      ).toBe(404);
    });

    test("the old phone is no longer registered for updates", async () => {
      expect((await ctx.db.query("SELECT 1 FROM device_registrations")).rowCount).toBe(0);
      const list = await ctx.app.inject({ method: "GET", url: `/v1/devices/old-phone/registrations/${PASS_TYPE}` });
      expect(list.statusCode).toBe(204);
    });

    test("the new serial and auth token are different from the old ones", async () => {
      const row = (await ctx.db.query("SELECT serial, auth_token FROM cards")).rows[0];
      expect(row.serial).not.toBe(serial);
      expect(row.auth_token).not.toBe(authToken);
      expect(row.auth_token.length).toBeGreaterThanOrEqual(32);
      const withOldToken = await ctx.app.inject({
        method: "GET",
        url: `/v1/passes/${PASS_TYPE}/${row.serial}`,
        headers: { authorization: `ApplePass ${authToken}` },
      });
      expect(withOldToken.statusCode).toBe(401);
    });

    test("it is recorded with who did it and a short reference, never a full code", async () => {
      const rows = (await ctx.db.query("SELECT actor_role, actor_name, before, after FROM ledger_events WHERE type = 'card_reissued'")).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_role: "admin", actor_name: "owner", before: { cardRef: serial.slice(0, 6) } });
      expect(JSON.stringify(rows)).not.toContain(serial);
    });

    test("an earned free drink is kept on the replacement", async () => {
      await ctx.db.query("UPDATE cards SET cups = 10, free_drink_earned = true");
      expect((await reissue(customerId)).statusCode).toBe(201);
      expect((await ctx.db.query("SELECT cups, free_drink_earned FROM cards")).rows).toEqual([{ cups: 10, free_drink_earned: true }]);
    });

    test("an unknown or malformed customer is 404", async () => {
      expect((await reissue("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
      expect((await reissue("not-an-id")).statusCode).toBe(404);
    });

    test("needs an Admin session and changes nothing without one", async () => {
      const before = (await ctx.db.query("SELECT serial FROM cards")).rows[0].serial;
      const barista = await staffLogin(ctx, "123456");
      expect((await reissue(customerId, null)).statusCode).toBe(401);
      expect((await reissue(customerId, barista)).statusCode).toBe(401);
      expect((await ctx.db.query("SELECT serial FROM cards")).rows[0].serial).toBe(before);
    });
  });
});
