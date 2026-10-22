import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import pg from "pg";
import { createPool, type Db } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";

export interface TestDb {
  db: Db;
  url: string;
  drop: () => Promise<void>;
}

/**
 * Creates a fresh, fully migrated database for one test file. Call `drop()` in `afterAll`.
 * `migrate: false` returns an empty database (used to test the migrations themselves).
 */
export async function createTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  const adminUrl = inject("dbUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();

  const db = createPool(url);
  if (options.migrate !== false) await runMigrations(db);

  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
