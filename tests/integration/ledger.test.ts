import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "../helpers/testDb.js";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

async function insertEvent(): Promise<number> {
  const res = await t.db.query<{ id: string }>(
    `INSERT INTO ledger_events (type, actor_role, actor_name, after)
     VALUES ('goal_change', 'admin', 'Owner', '{"rewardGoal": 8}') RETURNING id`,
  );
  return Number(res.rows[0]!.id);
}

test("an insert works", async () => {
  const id = await insertEvent();
  expect(id).toBeGreaterThan(0);
});

test("an UPDATE is refused", async () => {
  const id = await insertEvent();
  await expect(t.db.query("UPDATE ledger_events SET actor_name = 'Someone' WHERE id = $1", [id])).rejects.toThrow(
    /append-only/,
  );
});

test("a DELETE is refused", async () => {
  const id = await insertEvent();
  await expect(t.db.query("DELETE FROM ledger_events WHERE id = $1", [id])).rejects.toThrow(/append-only/);
});

test("a TRUNCATE is refused", async () => {
  await expect(t.db.query("TRUNCATE ledger_events")).rejects.toThrow(/append-only/);
});

test("the same actor cannot reuse an idempotency key on the same card, but can on another", async () => {
  const actor = "00000000-0000-0000-0000-000000000001";
  const customer = await t.db.query<{ id: string }>("INSERT INTO customers (phone_e164) VALUES ('+201000000001') RETURNING id");
  const other = await t.db.query<{ id: string }>("INSERT INTO customers (phone_e164) VALUES ('+201000000002') RETURNING id");
  const cardA = (
    await t.db.query<{ id: string }>("INSERT INTO cards (customer_id, serial, auth_token) VALUES ($1, 'serial-a', 'tok') RETURNING id", [customer.rows[0]!.id])
  ).rows[0]!.id;
  const cardB = (
    await t.db.query<{ id: string }>("INSERT INTO cards (customer_id, serial, auth_token) VALUES ($1, 'serial-b', 'tok') RETURNING id", [other.rows[0]!.id])
  ).rows[0]!.id;
  const insert = (cardId: string) =>
    t.db.query(
      `INSERT INTO ledger_events (type, card_id, actor_role, actor_id, actor_name, idempotency_key)
       VALUES ('stamp', $1, 'barista', $2, 'Sara', 'key-1')`,
      [cardId, actor],
    );
  await insert(cardA);
  await expect(insert(cardA)).rejects.toThrow(/duplicate key/);
  await insert(cardB);
});
