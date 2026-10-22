import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { parseConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { seedAdmin } from "./db/seedAdmin.js";
import type { AppDeps, ReadyDeps } from "./deps.js";
import { requestSerializer } from "./logging.js";
import { watchCertExpiry } from "./wallet/certExpiry.js";
import { createApplePush, type PushSender } from "./wallet/push.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAppleRoutes } from "./routes/apple.js";
import { registerJoinRoutes } from "./routes/join.js";
import { registerStaffRoutes } from "./routes/staff.js";

export type { AppDeps } from "./deps.js";

declare module "fastify" {
  interface FastifyInstance {
    push: PushSender;
  }
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

/** Builds the app with everything it needs passed in, so tests can run it without a network. */
export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: (deps.logger ?? true) ? { serializers: { req: requestSerializer } } : false,
    bodyLimit: 64 * 1024,
  });
  const https = deps.config.PUBLIC_BASE_URL.startsWith("https://");

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(rateLimit, { global: false });

  // Protective headers on every answer. The pages load only their own scripts and styles, so a
  // script injected into a page cannot run, and no page can be put inside another site's frame.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", csp);
    // Only the staff page needs the camera.
    reply.header("permissions-policy", request.url.startsWith("/staff") ? "camera=(self), microphone=(), geolocation=()" : "camera=(), microphone=(), geolocation=()");
    if (https) reply.header("strict-transport-security", "max-age=31536000");
    if (request.url.startsWith("/api/") || request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: "Invalid input", issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    request.log.error({ err }, "Unhandled error");
    return reply.code(500).send({ error: "Something went wrong" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  const push = deps.push ?? createApplePush(deps.config, deps.db, app.log);
  app.decorate("push", push);
  const ready: ReadyDeps = { ...deps, push };

  await registerJoinRoutes(app, ready);
  await registerAppleRoutes(app, ready);
  await registerStaffRoutes(app, ready);
  await registerAdminRoutes(app, ready);

  await app.register(fastifyStatic, { root: webRoot, prefix: "/", index: "index.html" });

  return app;
}

/** Start-up: read the environment, migrate the database, make sure the Admin exists, listen. */
async function main(): Promise<void> {
  const config = parseConfig();
  const db = createPool(config.DATABASE_URL);
  await runMigrations(db);
  await seedAdmin(db, config);

  const app = await buildServer({ config, db });
  watchCertExpiry(config.PASS_CERT_PATH, app.log);
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
