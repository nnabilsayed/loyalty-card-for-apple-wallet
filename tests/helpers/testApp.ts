import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Config } from "../../src/config.js";
import type { Db } from "../../src/db/pool.js";
import { buildServer, type AppDeps } from "../../src/server.js";
import { hashPassword } from "../../src/auth/password.js";
import { createBarista } from "../../src/domain/baristaService.js";
import { ensureTestCerts } from "./certs.js";
import { createTestDb } from "./testDb.js";

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  close: () => Promise<void>;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const certs = ensureTestCerts();
  return {
    DATABASE_URL: "unused-in-tests",
    PUBLIC_BASE_URL: "https://loyalty.test",
    PORT: 0,
    PASS_TYPE_ID: "pass.test.loyalty",
    APPLE_TEAM_ID: "TEAM123456",
    PASS_CERT_PATH: certs.certPath,
    PASS_KEY_PATH: certs.keyPath,
    WWDR_CERT_PATH: certs.wwdrPath,
    SHOP_NAME: "Test Coffee",
    APNS_HOST: "https://push.invalid",
    PIN_PEPPER: "test-pin-pepper-0123456789",
    SESSION_SECRET: "test-session-secret-0123456789",
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD: "owner-password-1",
    DEFAULT_PHONE_REGION: "EG",
    ...overrides,
  };
}

/** A fully wired app on its own fresh database. Call `close()` in `afterAll`. */
export async function createTestApp(extra: Partial<AppDeps> = {}, configOverrides: Partial<Config> = {}): Promise<TestApp> {
  const t = await createTestDb();
  const config = testConfig(configOverrides);
  const app = await buildServer({ config, db: t.db, logger: false, loginRateLimitMax: 1000, joinRateLimitMax: 1000, ...extra });
  await app.ready();
  return {
    app,
    db: t.db,
    config,
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}

export async function addTestBarista(ctx: TestApp, name: string, pin: string): Promise<string> {
  const barista = await createBarista(ctx.db, ctx.config.PIN_PEPPER, name, pin, { role: "system", id: null, name: "test" });
  return barista.id;
}

export async function addTestAdmin(ctx: TestApp, username: string, password: string): Promise<string> {
  const res = await ctx.db.query<{ id: string }>(
    "INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING id",
    [username, await hashPassword(password)],
  );
  return res.rows[0]!.id;
}

/** The `name=value` part of the session cookie in a response, ready to send back as a Cookie header. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === "session");
  if (!cookie) throw new Error("No session cookie in the response");
  return `${cookie.name}=${cookie.value}`;
}

export async function staffLogin(ctx: TestApp, pin: string): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin } });
  if (res.statusCode !== 200) throw new Error(`Staff login failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

export async function adminLogin(ctx: TestApp, username: string, password: string): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`Admin login failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}
