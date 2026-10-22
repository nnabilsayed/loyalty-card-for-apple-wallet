import { hashPin, isValidPin } from "../auth/pin.js";
import { withTransaction, type Db } from "../db/pool.js";
import { recordEvent, type Actor } from "./ledger.js";

export class PinInUseError extends Error {
  constructor() {
    super("That PIN is already in use by another barista");
  }
}

export class InvalidPinError extends Error {
  constructor() {
    super("A PIN must be exactly six digits");
  }
}

export interface Barista {
  id: string;
  name: string;
}

export interface BaristaListing extends Barista {
  createdAt: string;
}

export class BaristaNotFoundError extends Error {
  constructor() {
    super("No such barista");
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** Adds a barista with their own PIN and records it. */
export async function createBarista(db: Db, pepper: string, name: string, pin: string, actor: Actor): Promise<Barista> {
  if (!isValidPin(pin)) throw new InvalidPinError();
  try {
    return await withTransaction(db, async (tx) => {
      const res = await tx.query<Barista>(
        "INSERT INTO baristas (name, pin_hmac) VALUES ($1, $2) RETURNING id, name",
        [name, hashPin(pin, pepper)],
      );
      const barista = res.rows[0]!;
      await recordEvent(tx, { type: "barista_added", actor, after: { baristaId: barista.id, name: barista.name } });
      return barista;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PinInUseError();
    throw err;
  }
}

/** The active baristas, oldest first. Never includes PINs. */
export async function listBaristas(db: Db): Promise<BaristaListing[]> {
  const res = await db.query<{ id: string; name: string; created_at: Date }>(
    "SELECT id, name, created_at FROM baristas WHERE active ORDER BY created_at, name",
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() }));
}

/**
 * Changes a barista's name and/or PIN. A new PIN takes effect at once and the old one stops working.
 * Records already written keep the name they were written under.
 */
export async function updateBarista(
  db: Db,
  pepper: string,
  id: string,
  changes: { name?: string; pin?: string },
  actor: Actor,
): Promise<BaristaListing> {
  if (changes.pin !== undefined && !isValidPin(changes.pin)) throw new InvalidPinError();
  try {
    return await withTransaction(db, async (tx) => {
      const current = await tx.query<{ id: string; name: string; created_at: Date }>(
        "SELECT id, name, created_at FROM baristas WHERE id = $1 AND active FOR UPDATE",
        [id],
      );
      const barista = current.rows[0];
      if (!barista) throw new BaristaNotFoundError();

      let name = barista.name;
      if (changes.name !== undefined && changes.name !== barista.name) {
        await tx.query("UPDATE baristas SET name = $2 WHERE id = $1", [id, changes.name]);
        await recordEvent(tx, {
          type: "barista_renamed",
          actor,
          before: { baristaId: id, name: barista.name },
          after: { baristaId: id, name: changes.name },
        });
        name = changes.name;
      }
      if (changes.pin !== undefined) {
        await tx.query("UPDATE baristas SET pin_hmac = $2 WHERE id = $1", [id, hashPin(changes.pin, pepper)]);
        // The PIN itself is never written to the records.
        await recordEvent(tx, { type: "barista_pin_changed", actor, after: { baristaId: id, name } });
      }
      return { id, name, createdAt: barista.created_at.toISOString() };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PinInUseError();
    throw err;
  }
}

/** Removes a barista: they lose access at once (their sessions are deleted) and their records stay. */
export async function removeBarista(db: Db, id: string, actor: Actor): Promise<void> {
  await withTransaction(db, async (tx) => {
    const res = await tx.query<{ name: string }>(
      "UPDATE baristas SET active = false, removed_at = now() WHERE id = $1 AND active RETURNING name",
      [id],
    );
    const barista = res.rows[0];
    if (!barista) throw new BaristaNotFoundError();
    await tx.query("DELETE FROM sessions WHERE barista_id = $1", [id]);
    await recordEvent(tx, { type: "barista_removed", actor, before: { baristaId: id, name: barista.name } });
  });
}
