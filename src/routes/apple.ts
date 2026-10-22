import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ReadyDeps } from "../deps.js";
import { findCardBySerial, getSettings, type CardRow } from "../domain/cardService.js";
import { buildPass } from "../wallet/passBuilder.js";

/** Apple's pass web service. The contract is fixed by Apple; see contracts/apple-web-service.md. */
export async function registerAppleRoutes(app: FastifyInstance, deps: ReadyDeps): Promise<void> {
  const { config, db } = deps;

  function tokenOf(request: FastifyRequest): string | null {
    const match = /^ApplePass (.+)$/.exec(request.headers.authorization ?? "");
    return match ? match[1]! : null;
  }

  function tokenMatches(card: CardRow, token: string | null): boolean {
    if (!token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(card.authToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Resolves the card for a request that acts on one pass, or sends 404 / 401. */
  async function authorizedCard(
    request: FastifyRequest,
    reply: FastifyReply,
    passType: string,
    serial: string,
  ): Promise<CardRow | null> {
    if (passType !== config.PASS_TYPE_ID) {
      await reply.code(404).send();
      return null;
    }
    const card = await findCardBySerial(db, serial);
    if (!card) {
      await reply.code(404).send();
      return null;
    }
    if (!tokenMatches(card, tokenOf(request))) {
      await reply.code(401).send();
      return null;
    }
    return card;
  }

  type RegParams = { device: string; passType: string; serial: string };
  const regPath = "/v1/devices/:device/registrations/:passType/:serial";

  // 1. Register a device for a pass.
  app.post<{ Params: RegParams }>(regPath, async (request, reply) => {
    const { device, passType, serial } = request.params;
    const card = await authorizedCard(request, reply, passType, serial);
    if (!card) return;
    const body = z.object({ pushToken: z.string().min(1) }).parse(request.body);
    const res = await db.query<{ inserted: boolean }>(
      `INSERT INTO device_registrations (device_library_id, card_id, push_token) VALUES ($1, $2, $3)
       ON CONFLICT (device_library_id, card_id) DO UPDATE SET push_token = EXCLUDED.push_token
       RETURNING (xmax = 0) AS inserted`,
      [device, card.id, body.pushToken],
    );
    return reply.code(res.rows[0]!.inserted ? 201 : 200).send();
  });

  // 2. List the passes on a device that changed since a tag.
  app.get<{ Params: { device: string; passType: string }; Querystring: { passesUpdatedSince?: string } }>(
    "/v1/devices/:device/registrations/:passType",
    async (request, reply) => {
      const { device, passType } = request.params;
      if (passType !== config.PASS_TYPE_ID) return reply.code(404).send();
      const since = /^[0-9]+$/.test(request.query.passesUpdatedSince ?? "") ? request.query.passesUpdatedSince! : null;

      // The tag is the card's last change in microseconds since 1970, so it never repeats or misses.
      const res = await db.query<{ serial: string; tag: string }>(
        `SELECT c.serial, (extract(epoch FROM c.updated_at) * 1000000)::bigint::text AS tag
           FROM device_registrations r
           JOIN cards c ON c.id = r.card_id
          WHERE r.device_library_id = $1
            AND ($2::bigint IS NULL OR (extract(epoch FROM c.updated_at) * 1000000)::bigint > $2::bigint)
          ORDER BY c.updated_at`,
        [device, since],
      );
      if (res.rows.length === 0) return reply.code(204).send();
      const lastUpdated = res.rows.reduce((max, r) => (BigInt(r.tag) > BigInt(max) ? r.tag : max), res.rows[0]!.tag);
      return { serialNumbers: res.rows.map((r) => r.serial), lastUpdated };
    },
  );

  // 3. Get the latest version of a pass.
  // No Last-Modified / 304: a change in the same second as the last download would be missed,
  // and a stamp must always reach the phone. The pass is small, so always sending it is cheap.
  app.get<{ Params: { passType: string; serial: string } }>("/v1/passes/:passType/:serial", async (request, reply) => {
    const { passType, serial } = request.params;
    const card = await authorizedCard(request, reply, passType, serial);
    if (!card) return;
    const pass = await buildPass(config, card, await getSettings(db));
    return reply.header("content-type", "application/vnd.apple.pkpass").header("cache-control", "no-store").send(pass);
  });

  // 4. Unregister a device.
  app.delete<{ Params: RegParams }>(regPath, async (request, reply) => {
    const { device, passType, serial } = request.params;
    const card = await authorizedCard(request, reply, passType, serial);
    if (!card) return;
    await db.query("DELETE FROM device_registrations WHERE device_library_id = $1 AND card_id = $2", [device, card.id]);
    return reply.code(200).send();
  });

  // 5. Receive device logs. They go to the server log only; nothing from a device is trusted or stored.
  app.post("/v1/log", async (request, reply) => {
    const body = z.object({ logs: z.array(z.string()).max(100) }).safeParse(request.body);
    if (body.success) {
      for (const line of body.data.logs) request.log.info({ walletLog: line.slice(0, 500) }, "Wallet device log");
    }
    return reply.code(200).send();
  });
}
