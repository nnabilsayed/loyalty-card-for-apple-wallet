import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard, stampCard, type StampOutcome } from "../../src/domain/cardService.js";
import { createTestApp, type TestApp } from "../helpers/testApp.js";

const sara = { role: "barista" as const, id: "11111111-1111-1111-1111-111111111111", name: "Sara" };
const omar = { role: "barista" as const, id: "22222222-2222-2222-2222-222222222222", name: "Omar" };

describe("stamping under concurrency", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const cupsOf = async (serial: string) =>
    (await ctx.db.query("SELECT cups, free_drink_earned FROM cards WHERE serial = $1", [serial])).rows[0];
  const stampEvents = async (serial: string) =>
    (
      await ctx.db.query(
        `SELECT e.type FROM ledger_events e JOIN cards c ON c.id = e.card_id
          WHERE c.serial = $1 AND e.type IN ('stamp','stamp_forced')`,
        [serial],
      )
    ).rows;

  test("two baristas stamping the same card at the same moment add exactly one stamp", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000001");
    const results = await Promise.all([
      stampCard(ctx.db, serial, sara, { idempotencyKey: "a", force: false }),
      stampCard(ctx.db, serial, omar, { idempotencyKey: "b", force: false }),
    ]);

    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r): r is Extract<StampOutcome, { ok: false }> => !r.ok);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: "cooldown" });
    expect((await cupsOf(serial)).cups).toBe(1);
    expect(await stampEvents(serial)).toHaveLength(1);
  });

  test("the same idempotency key sent twice stamps once and returns the same result", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000002");
    const first = await stampCard(ctx.db, serial, sara, { idempotencyKey: "tap-1", force: false });
    const again = await stampCard(ctx.db, serial, sara, { idempotencyKey: "tap-1", force: false });

    expect(first).toMatchObject({ ok: true, card: { cups: 1 } });
    expect(again).toMatchObject({ ok: true, replayed: true, card: { cups: 1 } });
    expect((await cupsOf(serial)).cups).toBe(1);
    expect(await stampEvents(serial)).toHaveLength(1);
  });

  test("a retry still returns the first result after the card has moved on", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000003");
    await stampCard(ctx.db, serial, sara, { idempotencyKey: "k1", force: false });
    await stampCard(ctx.db, serial, sara, { idempotencyKey: "k2", force: true });
    const retry = await stampCard(ctx.db, serial, sara, { idempotencyKey: "k1", force: false });
    expect(retry).toMatchObject({ ok: true, replayed: true, card: { cups: 1 } });
    expect((await cupsOf(serial)).cups).toBe(2);
  });

  test("a forced second stamp goes through and is recorded as stamp_forced", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000004");
    await stampCard(ctx.db, serial, sara, { idempotencyKey: "x1", force: false });
    const refused = await stampCard(ctx.db, serial, sara, { idempotencyKey: "x2", force: false });
    expect(refused).toMatchObject({ ok: false, reason: "cooldown" });

    const forced = await stampCard(ctx.db, serial, sara, { idempotencyKey: "x3", force: true });
    expect(forced).toMatchObject({ ok: true, card: { cups: 2 } });
    expect((await stampEvents(serial)).map((e) => e.type)).toEqual(["stamp", "stamp_forced"]);
  });

  test("many simultaneous forced stamps never lose or double count", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000005");
    await ctx.db.query("UPDATE settings SET reward_goal = 100");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => stampCard(ctx.db, serial, sara, { idempotencyKey: `m${i}`, force: true })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await cupsOf(serial)).cups).toBe(12);
    expect(await stampEvents(serial)).toHaveLength(12);
  });

  test("the card never passes the goal: the stamp that reaches it earns the drink, the next is refused", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000006");
    await ctx.db.query("UPDATE settings SET reward_goal = 2");
    await stampCard(ctx.db, serial, sara, { idempotencyKey: "g1", force: true });
    const reaching = await stampCard(ctx.db, serial, sara, { idempotencyKey: "g2", force: true });
    const extra = await stampCard(ctx.db, serial, sara, { idempotencyKey: "g3", force: true });

    expect(reaching).toMatchObject({ ok: true, card: { cups: 2, freeDrinkEarned: true } });
    expect(extra).toMatchObject({ ok: false, reason: "redeem_first" });
    expect(await cupsOf(serial)).toEqual({ cups: 2, free_drink_earned: true });
  });

  test("an unknown serial is reported as not found", async () => {
    const r = await stampCard(ctx.db, "no-such-serial-0000000", sara, { idempotencyKey: "z", force: false });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  test("a stamp bumps the card's change tag and records who did it", async () => {
    const { serial } = await issueCard(ctx.db, "+201000000007");
    const before = (await ctx.db.query("SELECT updated_at FROM cards WHERE serial = $1", [serial])).rows[0].updated_at;
    await stampCard(ctx.db, serial, omar, { idempotencyKey: "t1", force: false });
    const after = (await ctx.db.query("SELECT updated_at FROM cards WHERE serial = $1", [serial])).rows[0].updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const event = (
      await ctx.db.query(
        `SELECT actor_name, before, after FROM ledger_events e JOIN cards c ON c.id = e.card_id
          WHERE c.serial = $1 AND e.type = 'stamp'`,
        [serial],
      )
    ).rows[0];
    expect(event.actor_name).toBe("Omar");
    expect(event.before).toEqual({ cups: 0, freeDrinkEarned: false });
    expect(event.after).toEqual({ cups: 1, freeDrinkEarned: false });
  });
});
