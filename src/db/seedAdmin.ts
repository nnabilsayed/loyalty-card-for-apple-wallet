import { hashPassword } from "../auth/password.js";
import type { Config } from "../config.js";
import type { Db } from "./pool.js";

/** Creates the Admin from ADMIN_USERNAME / ADMIN_PASSWORD on first start. Does nothing if an Admin exists. */
export async function seedAdmin(db: Db, config: Pick<Config, "ADMIN_USERNAME" | "ADMIN_PASSWORD">): Promise<boolean> {
  const existing = await db.query("SELECT 1 FROM admins LIMIT 1");
  if (existing.rowCount) return false;
  await db.query("INSERT INTO admins (username, password_hash) VALUES ($1, $2)", [
    config.ADMIN_USERNAME,
    await hashPassword(config.ADMIN_PASSWORD),
  ]);
  return true;
}
