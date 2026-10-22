import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Gives every test file a PostgreSQL server. If TEST_DATABASE_URL is set it is used as is;
 * otherwise a throwaway PostgreSQL is started from the `embedded-postgres` package, so the
 * tests need no database credentials.
 */
export default async function setup(project: TestProject) {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) {
    project.provide("dbUrl", fromEnv);
    return;
  }

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = mkdtempSync(join(tmpdir(), "dnd-loyalty-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // Customers' messages can be Arabic or emoji, so the database must be UTF-8 whatever the OS locale is.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("dnd_loyalty_test");
  project.provide("dbUrl", `postgres://postgres:postgres@127.0.0.1:${port}/dnd_loyalty_test`);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
