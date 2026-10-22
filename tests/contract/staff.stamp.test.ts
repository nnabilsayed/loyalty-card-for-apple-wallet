import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("staff: look up and stamp a card", () => {
  let ctx: TestApp;
  let cookie: string;

  const call = (method: "GET" | "POST", url: string, payload?: unknown, withCookie = true) =>
    ctx.app.inject({ method, url, headers: withCookie ? { cookie } : {}, payload: payload as object });
  const newCard = async (phone: string) => (await issueCard(ctx.db, phone)).serial;

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    cookie = await staffLogin(ctx, "123456");
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe("GET /api/staff/cards/{serial}", () => {
    test("returns the card with a masked phone number and nothing secret", async () => {
      const serial = await newCard("+201001234567");
      const res = await call("GET", `/api/staff/cards/${serial}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        serial,
        phoneMasked: "+20 100 *** 4567",
        cups: 0,
        rewardGoal: 10,
        freeDrinkEarned: false,
        lastStampAt: null,
        canUndo: false,
      });
      expect(res.body).not.toContain("1234567");
      expect(res.body).not.toContain("auth");
    });

    test("an unknown code is 404 and nothing changes", async () => {
      const before = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events")).rows[0].n;
      const res = await call("GET", "/api/staff/cards/not-one-of-ours-000000");
      expect(res.statusCode).toBe(404);
      const after = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events")).rows[0].n;
      expect(after).toBe(before);
    });

    test("needs a signed-in barista", async () => {
      const serial = await newCard("+201001234568");
      expect((await call("GET", `/api/staff/cards/${serial}`, undefined, false)).statusCode).toBe(401);
    });
  });

  describe("POST /api/staff/cards/{serial}/stamp", () => {
    test("adds a cup and returns the new state", async () => {
      const serial = await newCard("+201001234569");
      const res = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "tap-1" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ serial, cups: 1, rewardGoal: 10, freeDrinkEarned: false, canUndo: true });
      expect(res.json().lastStampAt).toBeTruthy();
    });

    test("a retry with the same key returns the same result and does not stamp again", async () => {
      const serial = await newCard("+201001234570");
      await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "tap-1" });
      const again = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "tap-1" });
      expect(again.statusCode).toBe(200);
      expect(again.json().cups).toBe(1);
    });

    test("a quick second tap is refused with cooldown, and confirming with force stamps", async () => {
      const serial = await newCard("+201001234571");
      await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "a" });
      const refused = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "b" });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "cooldown" });
      expect(refused.json().secondsSinceLastStamp).toBeLessThan(5);
      expect(refused.json().message).toBeTruthy();

      const forced = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "c", force: true });
      expect(forced.statusCode).toBe(200);
      expect(forced.json().cups).toBe(2);
    });

    test("a card that earned a drink says redeem first, even when forced", async () => {
      const serial = await newCard("+201001234572");
      await ctx.db.query("UPDATE cards SET cups = 10, free_drink_earned = true WHERE serial = $1", [serial]);
      for (const force of [false, true]) {
        const res = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: `r${force}`, force });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ reason: "redeem_first" });
      }
    });

    test("reaching the goal shows the free drink", async () => {
      const serial = await newCard("+201001234573");
      await ctx.db.query("UPDATE cards SET cups = 9 WHERE serial = $1", [serial]);
      const res = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "last" });
      expect(res.json()).toMatchObject({ cups: 10, freeDrinkEarned: true });
    });

    test("not signed in is 401 and nothing changes", async () => {
      const serial = await newCard("+201001234574");
      const res = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "x" }, false);
      expect(res.statusCode).toBe(401);
      expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(0);
    });

    test("an unknown code is 404", async () => {
      const res = await call("POST", "/api/staff/cards/not-one-of-ours-000000/stamp", { idempotencyKey: "x" });
      expect(res.statusCode).toBe(404);
    });

    test("a missing idempotency key is refused", async () => {
      const serial = await newCard("+201001234575");
      expect((await call("POST", `/api/staff/cards/${serial}/stamp`, {})).statusCode).toBe(422);
      expect((await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "" })).statusCode).toBe(422);
    });

    test("the record names the barista who stamped", async () => {
      const serial = await newCard("+201001234576");
      await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "who" });
      const row = (
        await ctx.db.query(
          `SELECT e.actor_role, e.actor_name FROM ledger_events e JOIN cards c ON c.id = e.card_id
            WHERE c.serial = $1 AND e.type = 'stamp'`,
          [serial],
        )
      ).rows[0];
      expect(row).toEqual({ actor_role: "barista", actor_name: "Sara" });
    });
  });
});
