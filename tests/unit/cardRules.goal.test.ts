import { describe, expect, test } from "vitest";
import { earnedAfterGoalChange, parseRewardGoal } from "../../src/domain/cardRules.js";

describe("parseRewardGoal", () => {
  test.each([1, 8, 10, 12, 20, 21, 100, 5000])("accepts the whole number %i", (n) => {
    expect(parseRewardGoal(n)).toBe(n);
  });

  test("accepts a whole number sent as text", () => {
    expect(parseRewardGoal("12")).toBe(12);
  });

  test.each([0, -3, 2.5, NaN, Infinity, "abc", "", "1.5", null, undefined, {}, [], true, 2 ** 31])("rejects %j", (v) => {
    expect(parseRewardGoal(v)).toBeNull();
  });
});

describe("earnedAfterGoalChange", () => {
  test("a card that now meets the goal becomes earned", () => {
    // 9 cups, goal lowered 10 -> 8
    expect(earnedAfterGoalChange({ cups: 9, freeDrinkEarned: false }, 8)).toBe(true);
    expect(earnedAfterGoalChange({ cups: 8, freeDrinkEarned: false }, 8)).toBe(true);
  });

  test("a card still short of the goal is not earned", () => {
    expect(earnedAfterGoalChange({ cups: 6, freeDrinkEarned: false }, 12)).toBe(false);
    expect(earnedAfterGoalChange({ cups: 7, freeDrinkEarned: false }, 8)).toBe(false);
  });

  test("an earned card stays earned when the goal is raised", () => {
    // earned at a goal of 10, goal raised to 12
    expect(earnedAfterGoalChange({ cups: 10, freeDrinkEarned: true }, 12)).toBe(true);
  });

  test("the earned flag is never cleared, whatever the new goal", () => {
    for (const goal of [1, 5, 10, 50, 5000]) {
      expect(earnedAfterGoalChange({ cups: 3, freeDrinkEarned: true }, goal)).toBe(true);
    }
  });

  test("a card with 0 cups is earned only when the goal is 0 or less, which cannot happen", () => {
    expect(earnedAfterGoalChange({ cups: 0, freeDrinkEarned: false }, 1)).toBe(false);
  });
});
