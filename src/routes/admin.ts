import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireRole,
  sessionTokenOf,
  setSessionCookie,
} from "../auth/sessions.js";
import type { ReadyDeps } from "../deps.js";
import { parseRewardGoal } from "../domain/cardRules.js";
import {
  BaristaNotFoundError,
  createBarista,
  InvalidPinError,
  listBaristas,
  PinInUseError,
  removeBarista,
  updateBarista,
} from "../domain/baristaService.js";
import {
  changeGoal,
  cleanAnnouncement,
  findCustomerByPhone,
  getSettings,
  listAnnouncements,
  listLedger,
  reissueCard,
  sendAnnouncement,
} from "../domain/cardService.js";
import { normalizePhone } from "../domain/phone.js";

export async function registerAdminRoutes(app: FastifyInstance, deps: ReadyDeps): Promise<void> {
  const { config, db } = deps;
  const secureCookie = config.PUBLIC_BASE_URL.startsWith("https://");
  const loginLimit = { rateLimit: { max: deps.loginRateLimitMax ?? 10, timeWindow: "1 minute" } };
  const dummyHash = await hashPassword(randomBytes(16).toString("hex"));

  app.post("/api/admin/login", { config: loginLimit }, async (request, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).safeParse(request.body);
    if (!body.success) return reply.code(401).send({ error: "Wrong username or password" });

    const res = await db.query<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM admins WHERE username = $1",
      [body.data.username],
    );
    const admin = res.rows[0];
    // Always run a real password check so a wrong username takes as long as a wrong password.
    const ok = await verifyPassword(body.data.password, admin?.password_hash ?? dummyHash);
    if (!admin || !ok) return reply.code(401).send({ error: "Wrong username or password" });

    const { token, expiresAt } = await createSession(db, "admin", admin.id);
    setSessionCookie(reply, token, expiresAt, secureCookie);
    return { ok: true };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const token = sessionTokenOf(request);
    if (token) await destroySession(db, token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/admin/me", { preHandler: requireRole(db, "admin") }, async (request) => {
    return { name: request.auth!.name };
  });

  const adminOnly = { preHandler: requireRole(db, "admin") };
  const actorOf = (auth: { id: string; name: string }) => ({ role: "admin" as const, id: auth.id, name: auth.name });
  const settingsJson = async () => {
    const s = await getSettings(db);
    return {
      rewardGoal: s.rewardGoal,
      announcementText: s.announcementText,
      announcementAt: s.announcementAt ? s.announcementAt.toISOString() : null,
    };
  };

  app.get("/api/admin/settings", adminOnly, async () => settingsJson());

  app.put("/api/admin/settings", adminOnly, async (request, reply) => {
    const body = z.object({ rewardGoal: z.unknown() }).parse(request.body ?? {});
    const goal = parseRewardGoal(body.rewardGoal);
    if (goal === null) {
      return reply.code(422).send({ error: "The reward goal must be a whole number of 1 or more" });
    }
    const result = await changeGoal(db, goal, actorOf(request.auth!));
    // Every card now shows a different goal, so every phone is woken.
    if (result.changed) void deps.push.notifyAll();
    return settingsJson();
  });

  app.get("/api/admin/ledger", adminOnly, async (request) => {
    const q = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        type: z.string().max(40).optional(),
        actor: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).default(100),
      })
      .parse(request.query);
    return listLedger(db, { ...q, limit: Math.min(q.limit, 500) });
  });

  const pinSchema = z.string().regex(/^[0-9]{6}$/, "A PIN is exactly six digits");
  const nameSchema = z.string().trim().min(1).max(60);
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const baristaIdOf = (params: unknown) => {
    const id = (params as { id?: string }).id ?? "";
    return idPattern.test(id) ? id : null;
  };

  /** Turns the barista errors into answers; anything else is a real failure. */
  function baristaError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof PinInUseError) return reply.code(409).send({ error: "That PIN is already used by another barista. Choose a different one." });
    if (err instanceof InvalidPinError) return reply.code(422).send({ error: "A PIN is exactly six digits" });
    if (err instanceof BaristaNotFoundError) return reply.code(404).send({ error: "No such barista" });
    throw err;
  }

  app.get("/api/admin/baristas", adminOnly, async () => listBaristas(db));

  app.post("/api/admin/baristas", adminOnly, async (request, reply) => {
    const body = z.object({ name: nameSchema, pin: pinSchema }).parse(request.body ?? {});
    try {
      const barista = await createBarista(db, config.PIN_PEPPER, body.name, body.pin, actorOf(request.auth!));
      return reply.code(201).send({ ...barista, createdAt: new Date().toISOString() });
    } catch (err) {
      return baristaError(err, reply);
    }
  });

  app.patch("/api/admin/baristas/:id", adminOnly, async (request, reply) => {
    const id = baristaIdOf(request.params);
    if (!id) return reply.code(404).send({ error: "No such barista" });
    const body = z
      .object({ name: nameSchema.optional(), pin: pinSchema.optional() })
      .refine((b) => b.name !== undefined || b.pin !== undefined, { message: "Send a name or a PIN to change" })
      .parse(request.body ?? {});
    try {
      return await updateBarista(db, config.PIN_PEPPER, id, body, actorOf(request.auth!));
    } catch (err) {
      return baristaError(err, reply);
    }
  });

  app.delete("/api/admin/baristas/:id", adminOnly, async (request, reply) => {
    const id = baristaIdOf(request.params);
    if (!id) return reply.code(404).send({ error: "No such barista" });
    try {
      await removeBarista(db, id, actorOf(request.auth!));
      return reply.code(204).send();
    } catch (err) {
      return baristaError(err, reply);
    }
  });

  app.get("/api/admin/announcements", adminOnly, async (request) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).default(20) }).parse(request.query);
    return listAnnouncements(db, Math.min(q.limit, 100));
  });

  app.post("/api/admin/announcements", adminOnly, async (request, reply) => {
    const body = z.object({ text: z.unknown() }).parse(request.body ?? {});
    const text = cleanAnnouncement(body.text);
    if (text === null) {
      return reply.code(422).send({ error: "Write a message of 1 to 200 characters" });
    }
    const result = await sendAnnouncement(db, text, actorOf(request.auth!));
    // Accepted: the phones are woken in the background, a few at a time.
    void deps.push.notifyAll();
    return reply.code(202).send(result);
  });

  app.get("/api/admin/customers", adminOnly, async (request, reply) => {
    const q = z.object({ phone: z.string().min(1) }).parse(request.query);
    const phone = normalizePhone(q.phone, config.DEFAULT_PHONE_REGION);
    if (!phone) return reply.code(422).send({ error: "Enter a valid phone number" });
    const customer = await findCustomerByPhone(db, phone);
    if (!customer) return reply.code(404).send({ error: "No customer with that number" });
    return customer;
  });

  app.post("/api/admin/customers/:id/reissue", adminOnly, async (request, reply) => {
    const id = baristaIdOf(request.params);
    if (!id) return reply.code(404).send({ error: "No such customer" });
    const result = await reissueCard(db, id, actorOf(request.auth!));
    if (!result) return reply.code(404).send({ error: "No such customer" });
    return reply.code(201).send({ passUrl: `/card/${result.serial}.pkpass` });
  });
}
