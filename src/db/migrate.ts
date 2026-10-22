import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.js";

const defaultDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Announcements and names can be Arabic or emoji, so a database that is not UTF-8 would fail on real input. */
export async function assertUtf8(db: Db): Promise<void> {
  const res = await db.query<{ enc: string }>("SELECT current_setting('server_encoding') AS enc");
  const enc = res.rows[0]!.enc;
  if (enc.toUpperCase() !== "UTF8") {
    throw new Error(`The database encoding is ${enc} but must be UTF8. Create the database with ENCODING 'UTF8'.`);
  }
}

/** Applies every `NNN_name.sql` file in `dir` that has not been applied yet, in name order. */
export async function runMigrations(db: Db, dir: string = defaultDir): Promise<string[]> {
  await assertUtf8(db);
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return applied;
}
