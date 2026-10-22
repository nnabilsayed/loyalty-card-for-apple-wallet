import { parseConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { createBarista, InvalidPinError, PinInUseError } from "../src/domain/baristaService.js";

const [name, pin] = process.argv.slice(2);
if (!name || !pin) {
  console.error('Usage: npm run barista:add -- "<name>" <6-digit-pin>');
  process.exit(1);
}

const config = parseConfig();
const db = createPool(config.DATABASE_URL);
try {
  await runMigrations(db);
  const barista = await createBarista(db, config.PIN_PEPPER, name, pin, { role: "system", id: null, name: "add-barista script" });
  console.log(`Added ${barista.name}. They can sign in to the staff app with their PIN.`);
} catch (err) {
  if (err instanceof InvalidPinError || err instanceof PinInUseError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await db.end();
}
