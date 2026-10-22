import { describe, expect, test } from "vitest";
import { COOLDOWN_SECONDS, stamp, type CardState } from "../../src/domain/cardRules.js";

const now = new Date("2026-10-20T12:00:00Z");
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

const card = (over: Partial<CardState> = {}): CardState => ({
  cups: 4,
  freeDrinkEarned: false,
  lastStampAt: null,
  ...over,
});

describe("stamp rule", () => {
  test("the cooldown is 90 seconds", () => {
    expect(COOLDOWN_SECONDS).toBe(90);
  });

  test("adds one cup", () => {
    const r = stamp(card(), 10, now, false);
    expect(r).toEqual({ ok: true, type: "stamp", after: { cups: 5, freeDrinkEarned: false } });
  });

  test("reaching the goal earns a free drink", () => {
    const r = stamp(card({ cups: 9 }), 10, now, false);
    expect(r).toEqual({ ok: true, type: "stamp", after: { cups: 10, freeDrinkEarned: true } });
  });

  test("a goal of 1 is earned by the first stamp", () => {
    const r = stamp(card({ cups: 0 }), 1, now, false);
    expect(r).toMatchObject({ ok: true, after: { cups: 1, freeDrinkEarned: true } });
  });

  test("a card that already earned a drink must be redeemed first", () => {
    const r = stamp(card({ cups: 10, freeDrinkEarned: true }), 10, now, false);
    expect(r).toEqual({ ok: false, reason: "redeem_first" });
  });

  test("redeem-first cannot be forced past", () => {
    const r = stamp(card({ cups: 10, freeDrinkEarned: true }), 10, now, true);
    expect(r).toEqual({ ok: false, reason: "redeem_first" });
  });

  test("a second stamp inside the cooldown is refused with how long ago the last one was", () => {
    const r = stamp(card({ lastStampAt: secondsAgo(30) }), 10, now, false);
    expect(r).toEqual({ ok: false, reason: "cooldown", secondsSinceLastStamp: 30 });
  });

  test("the cooldown ends at 90 seconds", () => {
    expect(stamp(card({ lastStampAt: secondsAgo(89) }), 10, now, false)).toMatchObject({ ok: false, reason: "cooldown" });
    expect(stamp(card({ lastStampAt: secondsAgo(90) }), 10, now, false)).toMatchObject({ ok: true });
  });

  test("a confirmed (forced) stamp inside the cooldown goes through and is typed stamp_forced", () => {
    const r = stamp(card({ lastStampAt: secondsAgo(5) }), 10, now, true);
    expect(r).toEqual({ ok: true, type: "stamp_forced", after: { cups: 5, freeDrinkEarned: false } });
  });

  test("force outside the cooldown is a normal stamp", () => {
    const r = stamp(card({ lastStampAt: secondsAgo(300) }), 10, now, true);
    expect(r).toMatchObject({ ok: true, type: "stamp" });
  });

  test("the count never goes up past what the goal allows", () => {
    // A card whose count is already past a lowered goal is earned, so stamping is refused.
    const r = stamp(card({ cups: 9, freeDrinkEarned: true }), 8, now, false);
    expect(r).toEqual({ ok: false, reason: "redeem_first" });
  });
});
