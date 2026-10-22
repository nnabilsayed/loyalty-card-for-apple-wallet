import { randomBytes } from "node:crypto";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { redeem, stamp, undo } from "./cardRules.js";
import { recordEvent, type Actor } from "./ledger.js";

export class PhoneAlreadyHasCardError extends Error {
  constructor() {
    super("That phone number already has a card");
  }
}

export interface CardRow {
  id: string;
  serial: string;
  authToken: string;
  cups: number;
  freeDrinkEarned: boolean;
  updatedAt: Date;
}

export interface Settings {
  rewardGoal: number;
  announcementText: string | null;
  announcementAt: Date | null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** 128 random bits: the card's serial, also the QR payload. Cannot be guessed or counted up from. */
export function newSerial(): string {
  return randomBytes(16).toString("base64url");
}

/** A separate secret that only the phone and the server know. */
export function newAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Creates the customer and their card. Refuses if the number already has one. */
export async function issueCard(db: Db, phoneE164: string): Promise<Pick<CardRow, "id" | "serial" | "authToken">> {
  try {
    return await withTransaction(db, async (tx) => {
      const customer = await tx.query<{ id: string }>("INSERT INTO customers (phone_e164) VALUES ($1) RETURNING id", [phoneE164]);
      const serial = newSerial();
      const authToken = newAuthToken();
      const card = await tx.query<{ id: string }>(
        "INSERT INTO cards (customer_id, serial, auth_token) VALUES ($1, $2, $3) RETURNING id",
        [customer.rows[0]!.id, serial, authToken],
      );
      const id = card.rows[0]!.id;
      await recordEvent(tx, {
        type: "card_issued",
        cardId: id,
        actor: { role: "customer", id: null, name: "Customer sign-up" },
        after: { cups: 0, freeDrinkEarned: false },
      });
      return { id, serial, authToken };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PhoneAlreadyHasCardError();
    throw err;
  }
}

interface RawCard {
  id: string;
  serial: string;
  auth_token: string;
  cups: number;
  free_drink_earned: boolean;
  updated_at: Date;
}

export function toCardRow(r: RawCard): CardRow {
  return {
    id: r.id,
    serial: r.serial,
    authToken: r.auth_token,
    cups: r.cups,
    freeDrinkEarned: r.free_drink_earned,
    updatedAt: r.updated_at,
  };
}

export async function findCardBySerial(db: Db, serial: string): Promise<CardRow | null> {
  const res = await db.query<RawCard>(
    "SELECT id, serial, auth_token, cups, free_drink_earned, updated_at FROM cards WHERE serial = $1",
    [serial],
  );
  return res.rows[0] ? toCardRow(res.rows[0]) : null;
}

export async function getSettings(db: Db): Promise<Settings> {
  const res = await db.query<{ reward_goal: number; announcement_text: string | null; announcement_at: Date | null }>(
    "SELECT reward_goal, announcement_text, announcement_at FROM settings WHERE id = 1",
  );
  const row = res.rows[0]!;
  return { rewardGoal: row.reward_goal, announcementText: row.announcement_text, announcementAt: row.announcement_at };
}

/** What the staff app shows for a card. */
export interface CardView {
  id: string;
  serial: string;
  /** The customer's number. Staff screens must show it masked (see maskPhone). */
  phoneE164: string;
  cups: number;
  rewardGoal: number;
  freeDrinkEarned: boolean;
  lastStampAt: Date | null;
  /** True when the card's latest record is a stamp that can still be undone. */
  canUndo: boolean;
}

export type StampOutcome =
  | { ok: true; replayed: boolean; card: CardView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "redeem_first" }
  | { ok: false; reason: "cooldown"; secondsSinceLastStamp: number };

interface LockedCard {
  id: string;
  serial: string;
  cups: number;
  free_drink_earned: boolean;
}

/** The latest stamp that has not been undone, and the database's clock, read together. */
async function lastStamp(tx: Tx | Db, cardId: string): Promise<{ lastStampAt: Date | null; now: Date }> {
  const res = await tx.query<{ at: Date | null; now: Date }>(
    `SELECT (SELECT e.at FROM ledger_events e
              WHERE e.card_id = $1 AND e.type IN ('stamp', 'stamp_forced')
                AND NOT EXISTS (SELECT 1 FROM ledger_events u
                                 WHERE u.card_id = e.card_id AND u.type = 'undo'
                                   AND (u.after->>'undoes')::bigint = e.id)
              ORDER BY e.id DESC LIMIT 1) AS at,
            clock_timestamp() AS now`,
    [cardId],
  );
  return { lastStampAt: res.rows[0]!.at, now: res.rows[0]!.now };
}

/** The card as the staff app shows it. */
export async function viewCard(tx: Tx | Db, cardId: string): Promise<CardView> {
  const res = await tx.query<LockedCard & { reward_goal: number; latest_type: string | null; phone_e164: string }>(
    `SELECT c.id, c.serial, c.cups, c.free_drink_earned, s.reward_goal, cu.phone_e164,
            (SELECT type FROM ledger_events WHERE card_id = c.id ORDER BY id DESC LIMIT 1) AS latest_type
       FROM cards c JOIN customers cu ON cu.id = c.customer_id, settings s
      WHERE c.id = $1 AND s.id = 1`,
    [cardId],
  );
  const row = res.rows[0]!;
  const { lastStampAt } = await lastStamp(tx, cardId);
  return {
    id: row.id,
    serial: row.serial,
    phoneE164: row.phone_e164,
    cups: row.cups,
    rewardGoal: row.reward_goal,
    freeDrinkEarned: row.free_drink_earned,
    lastStampAt,
    canUndo: row.latest_type === "stamp" || row.latest_type === "stamp_forced",
  };
}

/** Looks a card up by its scanned or typed code. */
export async function lookupCard(db: Db, serial: string): Promise<CardView | null> {
  const found = await db.query<{ id: string }>("SELECT id FROM cards WHERE serial = $1", [serial]);
  return found.rows[0] ? viewCard(db, found.rows[0].id) : null;
}

/**
 * Adds one stamp. The card row is locked for the whole transaction, so two simultaneous requests
 * are applied one after the other. A repeated `idempotencyKey` returns the first result without
 * stamping again.
 */
export async function stampCard(
  db: Db,
  serial: string,
  actor: Actor,
  options: { idempotencyKey: string; force: boolean },
): Promise<StampOutcome> {
  return withTransaction(db, async (tx): Promise<StampOutcome> => {
    const locked = await tx.query<LockedCard>(
      "SELECT id, serial, cups, free_drink_earned FROM cards WHERE serial = $1 FOR UPDATE",
      [serial],
    );
    const card = locked.rows[0];
    if (!card) return { ok: false, reason: "not_found" };

    if (actor.id) {
      const prior = await tx.query<{ after: { cups: number; freeDrinkEarned: boolean } }>(
        "SELECT after FROM ledger_events WHERE card_id = $1 AND actor_id = $2 AND idempotency_key = $3",
        [card.id, actor.id, options.idempotencyKey],
      );
      if (prior.rows[0]) {
        const view = await viewCard(tx, card.id);
        return {
          ok: true,
          replayed: true,
          card: { ...view, cups: prior.rows[0].after.cups, freeDrinkEarned: prior.rows[0].after.freeDrinkEarned },
        };
      }
    }

    const goal = (await tx.query<{ reward_goal: number }>("SELECT reward_goal FROM settings WHERE id = 1")).rows[0]!
      .reward_goal;
    const { lastStampAt, now } = await lastStamp(tx, card.id);
    const result = stamp({ cups: card.cups, freeDrinkEarned: card.free_drink_earned, lastStampAt }, goal, now, options.force);
    if (!result.ok) return result;

    await tx.query("UPDATE cards SET cups = $2, free_drink_earned = $3, updated_at = clock_timestamp() WHERE id = $1", [
      card.id,
      result.after.cups,
      result.after.freeDrinkEarned,
    ]);
    await recordEvent(tx, {
      type: result.type,
      cardId: card.id,
      actor,
      before: { cups: card.cups, freeDrinkEarned: card.free_drink_earned },
      after: result.after,
      idempotencyKey: options.idempotencyKey,
    });
    return { ok: true, replayed: false, card: await viewCard(tx, card.id) };
  });
}

export type RedeemOutcome =
  | { ok: true; card: CardView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_earned"; cupsNeeded: number };

/** Redeems a free drink and starts the card over at 0. The card row is locked for the transaction. */
export async function redeemCard(db: Db, serial: string, actor: Actor): Promise<RedeemOutcome> {
  return withTransaction(db, async (tx): Promise<RedeemOutcome> => {
    const locked = await tx.query<LockedCard>(
      "SELECT id, serial, cups, free_drink_earned FROM cards WHERE serial = $1 FOR UPDATE",
      [serial],
    );
    const card = locked.rows[0];
    if (!card) return { ok: false, reason: "not_found" };

    const goal = (await tx.query<{ reward_goal: number }>("SELECT reward_goal FROM settings WHERE id = 1")).rows[0]!
      .reward_goal;
    const result = redeem({ cups: card.cups, freeDrinkEarned: card.free_drink_earned }, goal);
    if (!result.ok) return result;

    await tx.query("UPDATE cards SET cups = $2, free_drink_earned = $3, updated_at = clock_timestamp() WHERE id = $1", [
      card.id,
      result.after.cups,
      result.after.freeDrinkEarned,
    ]);
    await recordEvent(tx, {
      type: "redeem",
      cardId: card.id,
      actor,
      before: { cups: card.cups, freeDrinkEarned: card.free_drink_earned },
      after: result.after,
    });
    return { ok: true, card: await viewCard(tx, card.id) };
  });
}

export interface GoalChange {
  changed: boolean;
  rewardGoal: number;
  /** Cards that became "free drink earned" because of this change. */
  newlyEarned: number;
}

/**
 * Sets the reward goal for everyone at once: cards that now meet it become earned (see
 * earnedAfterGoalChange), every card is marked changed so phones refresh, and it is recorded.
 * Saving the same goal again does nothing.
 */
export async function changeGoal(db: Db, newGoal: number, actor: Actor): Promise<GoalChange> {
  return withTransaction(db, async (tx) => {
    const current = (await tx.query<{ reward_goal: number }>("SELECT reward_goal FROM settings WHERE id = 1 FOR UPDATE")).rows[0]!
      .reward_goal;
    if (current === newGoal) return { changed: false, rewardGoal: current, newlyEarned: 0 };

    await tx.query("UPDATE settings SET reward_goal = $1 WHERE id = 1", [newGoal]);
    // The flag is only ever set here, never cleared (earnedAfterGoalChange).
    const earned = await tx.query("UPDATE cards SET free_drink_earned = true WHERE cups >= $1 AND NOT free_drink_earned", [newGoal]);
    await tx.query("UPDATE cards SET updated_at = clock_timestamp()");
    await recordEvent(tx, {
      type: "goal_change",
      actor,
      before: { rewardGoal: current },
      after: { rewardGoal: newGoal, cardsNowEarned: earned.rowCount ?? 0 },
    });
    return { changed: true, rewardGoal: newGoal, newlyEarned: earned.rowCount ?? 0 };
  });
}

export interface LedgerFilter {
  from?: string;
  to?: string;
  type?: string;
  actor?: string;
  limit: number;
}

export interface LedgerRow {
  id: number;
  at: string;
  type: string;
  cardRef: string | null;
  actorName: string;
  before: unknown;
  after: unknown;
}

/** The owner's view of the records, newest first. Only a short card reference is shown, never the full code. */
export async function listLedger(db: Db, f: LedgerFilter): Promise<LedgerRow[]> {
  const actor = f.actor ? `%${f.actor.replace(/[\\%_]/g, "\\$&")}%` : null;
  const res = await db.query<{
    id: string;
    at: Date;
    type: string;
    card_ref: string | null;
    actor_name: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT e.id, e.at, e.type, left(c.serial, 6) AS card_ref, e.actor_name, e.before, e.after
       FROM ledger_events e LEFT JOIN cards c ON c.id = e.card_id
      WHERE ($1::timestamptz IS NULL OR e.at >= $1)
        AND ($2::timestamptz IS NULL OR e.at <= $2)
        AND ($3::text IS NULL OR e.type = $3)
        AND ($4::text IS NULL OR e.actor_name ILIKE $4)
      ORDER BY e.id DESC
      LIMIT $5`,
    [f.from ?? null, f.to ?? null, f.type ?? null, actor, f.limit],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: r.at.toISOString(),
    type: r.type,
    cardRef: r.card_ref,
    actorName: r.actor_name,
    before: r.before,
    after: r.after,
  }));
}

export type UndoOutcome =
  | { ok: true; card: CardView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "nothing_to_undo" };

/** Takes back the card's most recent stamp. Only a stamp can be undone, and only while it is the latest record. */
export async function undoLastStamp(db: Db, serial: string, actor: Actor): Promise<UndoOutcome> {
  return withTransaction(db, async (tx): Promise<UndoOutcome> => {
    const locked = await tx.query<LockedCard>(
      "SELECT id, serial, cups, free_drink_earned FROM cards WHERE serial = $1 FOR UPDATE",
      [serial],
    );
    const card = locked.rows[0];
    if (!card) return { ok: false, reason: "not_found" };

    const goal = (await tx.query<{ reward_goal: number }>("SELECT reward_goal FROM settings WHERE id = 1")).rows[0]!
      .reward_goal;
    const latest = (
      await tx.query<{ id: string; type: string; before: { cups: number; freeDrinkEarned: boolean } | null }>(
        "SELECT id, type, before FROM ledger_events WHERE card_id = $1 ORDER BY id DESC LIMIT 1",
        [card.id],
      )
    ).rows[0];
    const result = undo(latest ? { id: Number(latest.id), type: latest.type, before: latest.before } : null, goal);
    if (!result.ok) return result;

    await tx.query("UPDATE cards SET cups = $2, free_drink_earned = $3, updated_at = clock_timestamp() WHERE id = $1", [
      card.id,
      result.after.cups,
      result.after.freeDrinkEarned,
    ]);
    await recordEvent(tx, {
      type: "undo",
      cardId: card.id,
      actor,
      before: { cups: card.cups, freeDrinkEarned: card.free_drink_earned },
      after: { ...result.after, undoes: result.undoes },
    });
    return { ok: true, card: await viewCard(tx, card.id) };
  });
}

/** The longest announcement, in characters (not bytes). */
export const MAX_ANNOUNCEMENT_LENGTH = 200;

/** Trims the text and checks it is 1 to 200 characters. Returns null if it is not usable. */
export function cleanAnnouncement(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const length = Array.from(text).length;
  return length >= 1 && length <= MAX_ANNOUNCEMENT_LENGTH ? text : null;
}

/**
 * Makes `text` the announcement on every card: stores it, keeps it in the sent history, marks every
 * card changed so phones refresh, and records it. Returns how many cards it goes to.
 */
export async function sendAnnouncement(db: Db, text: string, actor: Actor): Promise<{ cardsTargeted: number }> {
  return withTransaction(db, async (tx) => {
    const cards = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM cards")).rows[0]!.n;
    await tx.query("UPDATE settings SET announcement_text = $1, announcement_at = now() WHERE id = 1", [text]);
    await tx.query("INSERT INTO announcements (text, sent_by, cards_targeted) VALUES ($1, $2, $3)", [text, actor.name, cards]);
    await tx.query("UPDATE cards SET updated_at = clock_timestamp()");
    await recordEvent(tx, { type: "announcement", actor, after: { text, cardsTargeted: cards } });
    return { cardsTargeted: cards };
  });
}

export interface SentAnnouncement {
  text: string;
  sentAt: string;
  sentBy: string;
  cardsTargeted: number;
}

/** The announcements sent so far, newest first. */
export async function listAnnouncements(db: Db, limit: number): Promise<SentAnnouncement[]> {
  const res = await db.query<{ text: string; sent_at: Date; sent_by: string; cards_targeted: number }>(
    "SELECT text, sent_at, sent_by, cards_targeted FROM announcements ORDER BY sent_at DESC, id DESC LIMIT $1",
    [limit],
  );
  return res.rows.map((r) => ({ text: r.text, sentAt: r.sent_at.toISOString(), sentBy: r.sent_by, cardsTargeted: r.cards_targeted }));
}

export interface CustomerSummary {
  customerId: string;
  phone: string;
  cups: number;
  rewardGoal: number;
  freeDrinkEarned: boolean;
  createdAt: string;
}

/** Finds a customer by their normalized phone number. Never returns the card code or its token. */
export async function findCustomerByPhone(db: Db, phoneE164: string): Promise<CustomerSummary | null> {
  const res = await db.query<{
    id: string;
    phone_e164: string;
    cups: number;
    free_drink_earned: boolean;
    created_at: Date;
    reward_goal: number;
  }>(
    `SELECT cu.id, cu.phone_e164, c.cups, c.free_drink_earned, cu.created_at, s.reward_goal
       FROM customers cu JOIN cards c ON c.customer_id = cu.id, settings s
      WHERE cu.phone_e164 = $1 AND s.id = 1`,
    [phoneE164],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    customerId: r.id,
    phone: r.phone_e164,
    cups: r.cups,
    rewardGoal: r.reward_goal,
    freeDrinkEarned: r.free_drink_earned,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Replaces a customer's card (lost phone, deleted card): the same card gets a new code and token,
 * so the old QR code stops working at once, and the cups and any earned drink carry over.
 * Phones registered for the old card are forgotten.
 */
export async function reissueCard(db: Db, customerId: string, actor: Actor): Promise<{ serial: string } | null> {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<{ id: string; serial: string; cups: number; free_drink_earned: boolean }>(
      "SELECT id, serial, cups, free_drink_earned FROM cards WHERE customer_id = $1 FOR UPDATE",
      [customerId],
    );
    const card = found.rows[0];
    if (!card) return null;

    const serial = newSerial();
    await tx.query("UPDATE cards SET serial = $2, auth_token = $3, updated_at = clock_timestamp() WHERE id = $1", [
      card.id,
      serial,
      newAuthToken(),
    ]);
    await tx.query("DELETE FROM device_registrations WHERE card_id = $1", [card.id]);
    await recordEvent(tx, {
      type: "card_reissued",
      cardId: card.id,
      actor,
      before: { cardRef: card.serial.slice(0, 6) },
      after: { cardRef: serial.slice(0, 6), cups: card.cups, freeDrinkEarned: card.free_drink_earned },
    });
    return { serial };
  });
}
