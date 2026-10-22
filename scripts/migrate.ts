import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in .env (see .env.example).");
  process.exit(1);
}

const db = createPool(url);
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await db.end();
}
