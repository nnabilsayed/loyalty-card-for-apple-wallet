import type { Db, Tx } from "../db/pool.js";

export type LedgerType =
  | "stamp"
  | "stamp_forced"
  | "redeem"
  | "undo"
  | "goal_change"
  | "announcement"
  | "card_issued"
  | "card_reissued"
  | "barista_added"
  | "barista_removed"
  | "barista_pin_changed"
  | "barista_renamed";

/** Who did something. `name` is copied into the record so it stays readable after a barista is removed. */
export interface Actor {
  role: "barista" | "admin" | "customer" | "system";
  id: string | null;
  name: string;
}

export interface LedgerEntry {
  type: LedgerType;
  actor: Actor;
  cardId?: string | null;
  before?: unknown;
  after?: unknown;
  idempotencyKey?: string | null;
}

/** Appends one row to the permanent record. Pass the transaction so it commits with the change it describes. */
export async function recordEvent(db: Db | Tx, entry: LedgerEntry): Promise<number> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO ledger_events (at, type, card_id, actor_role, actor_id, actor_name, before, after, idempotency_key)
     VALUES (clock_timestamp(), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      entry.type,
      entry.cardId ?? null,
      entry.actor.role,
      entry.actor.id,
      entry.actor.name,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.idempotencyKey ?? null,
    ],
  );
  return Number(res.rows[0]!.id);
}
