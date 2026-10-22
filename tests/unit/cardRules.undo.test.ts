import { describe, expect, test } from "vitest";
import { undo, type LatestEvent } from "../../src/domain/cardRules.js";

const stampEvent = (before: { cups: number; freeDrinkEarned: boolean }, type: LatestEvent["type"] = "stamp"): LatestEvent => ({
  id: 41,
  type,
  before,
});

describe("undo rule", () => {
  test("undoing a stamp restores the earlier count and points at the stamp it undoes", () => {
    expect(undo(stampEvent({ cups: 4, freeDrinkEarned: false }), 10)).toEqual({
      ok: true,
      after: { cups: 4, freeDrinkEarned: false },
      undoes: 41,
    });
  });

  test("a confirmed repeat stamp can be undone too", () => {
    expect(undo(stampEvent({ cups: 4, freeDrinkEarned: false }, "stamp_forced"), 10)).toMatchObject({
      ok: true,
      after: { cups: 4, freeDrinkEarned: false },
    });
  });

  test("undoing the stamp that earned a drink takes the free drink back", () => {
    expect(undo(stampEvent({ cups: 9, freeDrinkEarned: false }), 10)).toMatchObject({
      ok: true,
      after: { cups: 9, freeDrinkEarned: false },
    });
  });

  test("if the goal was lowered since, the restored count is judged against the current goal", () => {
    // stamped 9 -> 10 at a goal of 10, then the goal was lowered to 8: 9 cups already meets it
    expect(undo(stampEvent({ cups: 9, freeDrinkEarned: false }), 8)).toMatchObject({
      ok: true,
      after: { cups: 9, freeDrinkEarned: true },
    });
  });

  test("a redeem cannot be undone", () => {
    expect(undo({ id: 7, type: "redeem", before: { cups: 10, freeDrinkEarned: true } }, 10)).toEqual({
      ok: false,
      reason: "nothing_to_undo",
    });
  });

  test("an undo cannot be undone", () => {
    expect(undo({ id: 8, type: "undo", before: { cups: 5, freeDrinkEarned: false } }, 10)).toEqual({
      ok: false,
      reason: "nothing_to_undo",
    });
  });

  test("a card that was only just issued has nothing to undo", () => {
    expect(undo({ id: 1, type: "card_issued", before: null }, 10)).toEqual({ ok: false, reason: "nothing_to_undo" });
    expect(undo(null, 10)).toEqual({ ok: false, reason: "nothing_to_undo" });
  });
});
