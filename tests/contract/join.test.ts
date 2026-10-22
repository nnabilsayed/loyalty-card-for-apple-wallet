import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestApp, type TestApp } from "../helpers/testApp.js";

describe("customer sign-up", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const join = (phone: unknown) => ctx.app.inject({ method: "POST", url: "/api/join", payload: { phone } });

  test("a new number gets a card and a link to its pass", async () => {
    const res = await join("010 0123 4567");
    expect(res.statusCode).toBe(201);
    const { passUrl } = res.json();
    expect(passUrl).toMatch(/^\/card\/[A-Za-z0-9_-]{22}\.pkpass$/);

    const customer = await ctx.db.query("SELECT phone_e164 FROM customers");
    expect(customer.rows).toEqual([{ phone_e164: "+201001234567" }]);
  });

  test("the card has a 128-bit random serial, a long auth token, 0 cups, and a ledger record", async () => {
    const card = (await ctx.db.query("SELECT serial, auth_token, cups, free_drink_earned FROM cards")).rows[0];
    expect(card.serial).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(card.auth_token.length).toBeGreaterThanOrEqual(32);
    expect(card.cups).toBe(0);
    expect(card.free_drink_earned).toBe(false);

    const events = (await ctx.db.query("SELECT type, actor_role FROM ledger_events WHERE type = 'card_issued'")).rows;
    expect(events).toEqual([{ type: "card_issued", actor_role: "customer" }]);
  });

  test("the same number written another way is refused and no pass is returned", async () => {
    const res = await join("+20 100 123 4567");
    expect(res.statusCode).toBe(409);
    expect(res.json().passUrl).toBeUndefined();
    expect(res.body).not.toContain(".pkpass");
    expect((await ctx.db.query("SELECT 1 FROM cards")).rowCount).toBe(1);
  });

  test("a missing or invalid number is refused", async () => {
    for (const phone of ["", "   ", "abc", "123", undefined, 12345, null]) {
      const res = await join(phone);
      expect(res.statusCode, `phone ${JSON.stringify(phone)}`).toBe(422);
    }
    const noBody = await ctx.app.inject({ method: "POST", url: "/api/join" });
    expect(noBody.statusCode).toBe(422);
    expect((await ctx.db.query("SELECT 1 FROM cards")).rowCount).toBe(1);
  });

  test("two customers get different serials", async () => {
    const a = (await join("0111 222 3333")).json().passUrl;
    const b = (await join("0122 333 4444")).json().passUrl;
    expect(a).not.toBe(b);
  });

  test("the pass downloads as a Wallet pass file", async () => {
    const serial = (await ctx.db.query("SELECT serial FROM cards LIMIT 1")).rows[0].serial;
    const res = await ctx.app.inject({ method: "GET", url: `/card/${serial}.pkpass` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  test("an unknown serial is 404", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/card/does-not-exist-00000.pkpass" });
    expect(res.statusCode).toBe(404);
  });
});

describe("sign-up rate limit", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ joinRateLimitMax: 3 });
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("too many sign-ups from one address get 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/api/join", payload: { phone: `010 0000 000${i}` } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
  });
});
