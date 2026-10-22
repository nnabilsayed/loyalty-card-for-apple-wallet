import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPin, isValidPin } from "../auth/pin.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireRole,
  sessionTokenOf,
  setSessionCookie,
} from "../auth/sessions.js";
import type { ReadyDeps } from "../deps.js";
import { lookupCard, redeemCard, stampCard, undoLastStamp, type CardView } from "../domain/cardService.js";
import { maskPhone } from "../domain/phone.js";

/** The card as the staff app receives it: no auth token, and the phone number masked. */
export function cardJson(card: CardView) {
  return {
    serial: card.serial,
    phoneMasked: maskPhone(card.phoneE164),
    cups: card.cups,
    rewardGoal: card.rewardGoal,
    freeDrinkEarned: card.freeDrinkEarned,
    lastStampAt: card.lastStampAt ? card.lastStampAt.toISOString() : null,
    canUndo: card.canUndo,
  };
}

export async function registerStaffRoutes(app: FastifyInstance, deps: ReadyDeps): Promise<void> {
  const { config, db } = deps;
  const secureCookie = config.PUBLIC_BASE_URL.startsWith("https://");
  const loginLimit = { rateLimit: { max: deps.loginRateLimitMax ?? 10, timeWindow: "1 minute" } };

  app.post("/api/staff/login", { config: loginLimit }, async (request, reply) => {
    const body = z.object({ pin: z.string() }).safeParse(request.body);
    // A malformed PIN gets the same answer as a wrong one, so nothing is revealed about the format.
    if (!body.success || !isValidPin(body.data.pin)) {
      return reply.code(401).send({ error: "Wrong PIN" });
    }
    const res = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM baristas WHERE pin_hmac = $1 AND active",
      [hashPin(body.data.pin, config.PIN_PEPPER)],
    );
    const barista = res.rows[0];
    if (!barista) return reply.code(401).send({ error: "Wrong PIN" });

    const { token, expiresAt } = await createSession(db, "barista", barista.id);
    setSessionCookie(reply, token, expiresAt, secureCookie);
    return { name: barista.name };
  });

  app.post("/api/staff/logout", async (request, reply) => {
    const token = sessionTokenOf(request);
    if (token) await destroySession(db, token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/staff/me", { preHandler: requireRole(db, "barista") }, async (request) => {
    return { name: request.auth!.name };
  });

  const staffOnly = { preHandler: requireRole(db, "barista") };
  const serialParam = z.object({ serial: z.string().min(1).max(64) });

  app.get("/api/staff/cards/:serial", staffOnly, async (request, reply) => {
    const { serial } = serialParam.parse(request.params);
    const card = await lookupCard(db, serial);
    if (!card) return reply.code(404).send({ error: "Card not recognized" });
    return cardJson(card);
  });

  app.post("/api/staff/cards/:serial/stamp", staffOnly, async (request, reply) => {
    const { serial } = serialParam.parse(request.params);
    const body = z
      .object({ idempotencyKey: z.string().min(1).max(100), force: z.boolean().default(false) })
      .parse(request.body);
    const actor = { role: "barista" as const, id: request.auth!.id, name: request.auth!.name };

    const result = await stampCard(db, serial, actor, body);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "Card not recognized" });
      if (result.reason === "redeem_first") {
        return reply.code(409).send({ reason: "redeem_first", message: "This card has a free drink waiting. Redeem it first." });
      }
      return reply.code(409).send({
        reason: "cooldown",
        message: `This card was stamped ${result.secondsSinceLastStamp} seconds ago. Stamp again?`,
        secondsSinceLastStamp: result.secondsSinceLastStamp,
      });
    }
    // The phone is woken after the barista has their answer; a slow push never holds up the counter.
    if (!result.replayed) void deps.push.notifyCard(result.card.id);
    return cardJson(result.card);
  });

  app.post("/api/staff/cards/:serial/redeem", staffOnly, async (request, reply) => {
    const { serial } = serialParam.parse(request.params);
    const actor = { role: "barista" as const, id: request.auth!.id, name: request.auth!.name };

    const result = await redeemCard(db, serial, actor);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "Card not recognized" });
      const cups = result.cupsNeeded;
      return reply.code(409).send({
        reason: "not_earned",
        message: `No free drink yet. ${cups} more ${cups === 1 ? "cup" : "cups"} needed.`,
        cupsNeeded: cups,
      });
    }
    void deps.push.notifyCard(result.card.id);
    return cardJson(result.card);
  });

  app.post("/api/staff/cards/:serial/undo", staffOnly, async (request, reply) => {
    const { serial } = serialParam.parse(request.params);
    const actor = { role: "barista" as const, id: request.auth!.id, name: request.auth!.name };

    const result = await undoLastStamp(db, serial, actor);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "Card not recognized" });
      return reply.code(409).send({
        reason: "nothing_to_undo",
        message: "There is no stamp to undo. Only the latest stamp on a card can be undone.",
      });
    }
    void deps.push.notifyCard(result.card.id);
    return cardJson(result.card);
  });
}
