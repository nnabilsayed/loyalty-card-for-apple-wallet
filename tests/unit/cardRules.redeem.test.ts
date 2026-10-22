import { describe, expect, test } from "vitest";
import { redeem } from "../../src/domain/cardRules.js";

describe("redeem rule", () => {
  test("a card that earned a drink resets to 0 and is no longer earned", () => {
    expect(redeem({ cups: 10, freeDrinkEarned: true }, 10)).toEqual({
      ok: true,
      after: { cups: 0, freeDrinkEarned: false },
    });
  });

  test("a card past a lowered goal still redeems and resets fully", () => {
    expect(redeem({ cups: 9, freeDrinkEarned: true }, 8)).toEqual({
      ok: true,
      after: { cups: 0, freeDrinkEarned: false },
    });
  });

  test("a card that has not earned a drink is refused, saying how many cups are still needed", () => {
    expect(redeem({ cups: 4, freeDrinkEarned: false }, 10)).toEqual({ ok: false, reason: "not_earned", cupsNeeded: 6 });
    expect(redeem({ cups: 0, freeDrinkEarned: false }, 1)).toEqual({ ok: false, reason: "not_earned", cupsNeeded: 1 });
  });

  test("redeeming twice for the same cups is refused the second time", () => {
    const first = redeem({ cups: 10, freeDrinkEarned: true }, 10);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(redeem(first.after, 10)).toEqual({ ok: false, reason: "not_earned", cupsNeeded: 10 });
  });
});
