import { inject, expect, test } from "vitest";
import pg from "pg";

test("the test PostgreSQL starts and answers", async () => {
  const client = new pg.Client({ connectionString: inject("dbUrl") });
  await client.connect();
  const res = await client.query("select 1 as one");
  await client.end();
  expect(res.rows[0].one).toBe(1);
});
