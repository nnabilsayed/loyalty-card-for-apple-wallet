import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("staff: redeem a free drink", () => {
  let ctx: TestApp;
  let cookie: string;

  const redeem = (serial: string, withCookie = true) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/staff/cards/${serial}/redeem`,
      headers: withCookie ? { cookie } : {},
    });
  const earnedCard = async (phone: string) => {
    const { serial } = await issueCard(ctx.db, phone);
    await ctx.db.query("UPDATE cards SET cups = 10, free_drink_earned = true WHERE serial = $1", [serial]);
    return serial;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    cookie = await staffLogin(ctx, "123456");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("redeeming an earned card resets it to 0", async () => {
    const serial = await earnedCard("+201001234567");
    const res = await redeem(serial);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serial, cups: 0, freeDrinkEarned: false, rewardGoal: 10 });
  });

  test("the same set of cups cannot be redeemed twice", async () => {
    const serial = await earnedCard("+201001234568");
    expect((await redeem(serial)).statusCode).toBe(200);
    const again = await redeem(serial);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "not_earned" });
  });

  test("a card below the goal is refused and the message says how many cups are still needed", async () => {
    const { serial } = await issueCard(ctx.db, "+201001234569");
    await ctx.db.query("UPDATE cards SET cups = 4 WHERE serial = $1", [serial]);
    const res = await redeem(serial);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_earned", cupsNeeded: 6 });
    expect(res.json().message).toContain("6");
    expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(4);
  });

  test("not signed in is 401 and the card is untouched", async () => {
    const serial = await earnedCard("+201001234570");
    expect((await redeem(serial, false)).statusCode).toBe(401);
    expect((await ctx.db.query("SELECT free_drink_earned FROM cards WHERE serial = $1", [serial])).rows[0].free_drink_earned).toBe(true);
  });

  test("an unknown code is 404", async () => {
    expect((await redeem("not-one-of-ours-000000")).statusCode).toBe(404);
  });

  test("the record shows who redeemed and the before and after", async () => {
    const serial = await earnedCard("+201001234571");
    await redeem(serial);
    const event = (
      await ctx.db.query(
        `SELECT e.actor_role, e.actor_name, e.before, e.after FROM ledger_events e JOIN cards c ON c.id = e.card_id
          WHERE c.serial = $1 AND e.type = 'redeem'`,
        [serial],
      )
    ).rows[0];
    expect(event).toEqual({
      actor_role: "barista",
      actor_name: "Sara",
      before: { cups: 10, freeDrinkEarned: true },
      after: { cups: 0, freeDrinkEarned: false },
    });
  });

  test("a new set of cups can be collected after redeeming", async () => {
    const serial = await earnedCard("+201001234572");
    await redeem(serial);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/staff/cards/${serial}/stamp`,
      headers: { cookie },
      payload: { idempotencyKey: "after-redeem" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cups).toBe(1);
  });
});
