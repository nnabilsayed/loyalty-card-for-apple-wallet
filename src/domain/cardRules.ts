/**
 * The loyalty rules as pure functions: no database, no HTTP, no Apple. The service layer
 * runs them inside a transaction.
 */

/** A second stamp on the same card inside this many seconds needs the barista to confirm it. */
export const COOLDOWN_SECONDS = 90;

export interface CardState {
  cups: number;
  freeDrinkEarned: boolean;
  /** When the card's latest stamp that was not undone happened, or null if none. */
  lastStampAt: Date | null;
}

export interface CardAfter {
  cups: number;
  freeDrinkEarned: boolean;
}

export type StampResult =
  | { ok: true; type: "stamp" | "stamp_forced"; after: CardAfter }
  | { ok: false; reason: "redeem_first" }
  | { ok: false; reason: "cooldown"; secondsSinceLastStamp: number };

/**
 * Adds one cup. Refused if a free drink is waiting to be redeemed (that cannot be forced past),
 * or if the last stamp was less than COOLDOWN_SECONDS ago unless the barista confirmed with `force`.
 */
export function stamp(card: CardState, rewardGoal: number, now: Date, force: boolean): StampResult {
  if (card.freeDrinkEarned) return { ok: false, reason: "redeem_first" };

  let forced = false;
  if (card.lastStampAt) {
    const seconds = Math.floor((now.getTime() - card.lastStampAt.getTime()) / 1000);
    if (seconds < COOLDOWN_SECONDS) {
      if (!force) return { ok: false, reason: "cooldown", secondsSinceLastStamp: Math.max(seconds, 0) };
      forced = true;
    }
  }

  const cups = card.cups + 1;
  return {
    ok: true,
    type: forced ? "stamp_forced" : "stamp",
    after: { cups, freeDrinkEarned: cups >= rewardGoal },
  };
}

export type RedeemResult =
  | { ok: true; after: CardAfter }
  | { ok: false; reason: "not_earned"; cupsNeeded: number };

/** Redeems a free drink: only for a card that has earned one, and it starts the next set of cups from 0. */
export function redeem(card: Pick<CardState, "cups" | "freeDrinkEarned">, rewardGoal: number): RedeemResult {
  if (!card.freeDrinkEarned) {
    return { ok: false, reason: "not_earned", cupsNeeded: Math.max(rewardGoal - card.cups, 0) };
  }
  return { ok: true, after: { cups: 0, freeDrinkEarned: false } };
}

/** The largest value the database column can hold. There is no other upper limit on the goal. */
export const MAX_REWARD_GOAL = 2_147_483_647;

/** A reward goal is any whole number of 1 or more. Returns null for anything else. */
export function parseRewardGoal(value: unknown): number | null {
  const n = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_REWARD_GOAL) return null;
  return n;
}

/**
 * After the goal changes: a card that now meets the goal has earned a drink, and a card that
 * had already earned one keeps it, even if the goal went up.
 */
export function earnedAfterGoalChange(card: Pick<CardState, "cups" | "freeDrinkEarned">, newGoal: number): boolean {
  return card.freeDrinkEarned || card.cups >= newGoal;
}

/** The most recent record about one card: what the undo rule looks at. */
export interface LatestEvent {
  id: number;
  type: string;
  before: CardAfter | null;
}

export type UndoResult =
  | { ok: true; after: CardAfter; undoes: number }
  | { ok: false; reason: "nothing_to_undo" };

/**
 * Undoes the card's most recent record, but only if that is a stamp. A redeem, an earlier stamp
 * buried under newer records, or an undo itself cannot be undone. The restored count is judged
 * against today's goal, in case the goal was lowered after the stamp.
 */
export function undo(latest: LatestEvent | null, rewardGoal: number): UndoResult {
  if (!latest || !latest.before || (latest.type !== "stamp" && latest.type !== "stamp_forced")) {
    return { ok: false, reason: "nothing_to_undo" };
  }
  const { cups, freeDrinkEarned } = latest.before;
  return {
    ok: true,
    undoes: latest.id,
    after: { cups, freeDrinkEarned: earnedAfterGoalChange({ cups, freeDrinkEarned }, rewardGoal) },
  };
}
