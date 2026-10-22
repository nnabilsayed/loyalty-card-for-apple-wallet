import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ReadyDeps } from "../deps.js";
import { findCardBySerial, getSettings, issueCard, PhoneAlreadyHasCardError } from "../domain/cardService.js";
import { normalizePhone } from "../domain/phone.js";
import { buildPass } from "../wallet/passBuilder.js";

export async function registerJoinRoutes(app: FastifyInstance, deps: ReadyDeps): Promise<void> {
  const { config, db } = deps;
  const joinLimit = { rateLimit: { max: deps.joinRateLimitMax ?? 20, timeWindow: "1 minute" } };

  app.post("/api/join", { config: joinLimit }, async (request, reply) => {
    const body = z.object({ phone: z.string() }).safeParse(request.body);
    const phone = body.success ? normalizePhone(body.data.phone, config.DEFAULT_PHONE_REGION) : null;
    if (!phone) {
      return reply.code(422).send({ error: "Enter a valid phone number" });
    }
    try {
      const card = await issueCard(db, phone);
      return reply.code(201).send({ passUrl: `/card/${card.serial}.pkpass` });
    } catch (err) {
      // No pass is returned for an existing number: numbers are not verified, so anyone who knew a
      // number could otherwise take that customer's card.
      if (err instanceof PhoneAlreadyHasCardError) {
        return reply.code(409).send({ error: "This number already has a card. Please ask the staff for help." });
      }
      throw err;
    }
  });

  app.get<{ Params: { file: string } }>("/card/:file", async (request, reply) => {
    const match = /^([A-Za-z0-9_-]+)\.pkpass$/.exec(request.params.file);
    const card = match ? await findCardBySerial(db, match[1]!) : null;
    if (!card) return reply.code(404).send({ error: "Card not found" });

    const settings = await getSettings(db);
    const pass = await buildPass(config, card, settings);
    return reply
      .header("content-type", "application/vnd.apple.pkpass")
      .header("content-disposition", `attachment; filename="${config.SHOP_NAME.replace(/[^A-Za-z0-9 _-]/g, "")}.pkpass"`)
      .header("cache-control", "no-store")
      .send(pass);
  });
}
