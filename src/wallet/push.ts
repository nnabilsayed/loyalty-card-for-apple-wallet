import { readFileSync } from "node:fs";
import http2 from "node:http2";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";

export interface PushLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

/** Wakes phones so they fetch the latest version of a card. */
export interface PushSender {
  /** Pushes to every device registered for one card. Never throws; failures are logged. */
  notifyCard: (cardId: string) => Promise<void>;
  /** Pushes to every registered device (goal change, announcement). */
  notifyAll: () => Promise<void>;
  /** Resolves when every push started so far has finished. Used by tests and at shutdown. */
  idle: () => Promise<void>;
}

interface Registration {
  device_library_id: string;
  card_id: string;
  push_token: string;
}

type PushResult = { kind: "ok" } | { kind: "gone" } | { kind: "failed"; status: number; reason: string };

const MAX_AT_ONCE = 10;

/**
 * Sends the empty push Apple's pass protocol uses, over HTTP/2, authenticated with the Pass Type ID
 * certificate. The push carries no data; the phone then asks our web service what changed.
 */
export function createApplePush(config: Config, db: Db, log: PushLogger): PushSender {
  const pending = new Set<Promise<void>>();
  let tls: { cert: Buffer; key: Buffer } | undefined;

  function credentials() {
    tls ??= { cert: readFileSync(config.PASS_CERT_PATH), key: readFileSync(config.PASS_KEY_PATH) };
    return tls;
  }

  function sendOne(session: http2.ClientHttp2Session, token: string): Promise<PushResult> {
    return new Promise((resolve) => {
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        "apns-topic": config.PASS_TYPE_ID,
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => (body += chunk));
      req.on("error", (err) => resolve({ kind: "failed", status: 0, reason: err.message }));
      req.on("end", () => {
        if (status === 200) return resolve({ kind: "ok" });
        let reason = "";
        try {
          reason = (JSON.parse(body) as { reason?: string }).reason ?? "";
        } catch {
          // not JSON; keep the empty reason
        }
        if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") return resolve({ kind: "gone" });
        resolve({ kind: "failed", status, reason });
      });
      req.end("{}");
    });
  }

  async function send(registrations: Registration[]): Promise<void> {
    if (registrations.length === 0) return;
    const session = http2.connect(config.APNS_HOST, config.APNS_HOST.startsWith("https") ? credentials() : {});
    session.on("error", (err) => log.warn({ err: err.message }, "Push connection error"));
    try {
      for (let i = 0; i < registrations.length; i += MAX_AT_ONCE) {
        const batch = registrations.slice(i, i + MAX_AT_ONCE);
        const results = await Promise.all(batch.map((r) => sendOne(session, r.push_token)));
        for (const [n, result] of results.entries()) {
          const reg = batch[n]!;
          if (result.kind === "gone") {
            await db.query("DELETE FROM device_registrations WHERE device_library_id = $1 AND card_id = $2", [
              reg.device_library_id,
              reg.card_id,
            ]);
          } else if (result.kind === "failed") {
            log.warn({ status: result.status, reason: result.reason }, "Push was not accepted");
          }
        }
      }
    } finally {
      session.close();
    }
  }

  function track(work: Promise<void>): Promise<void> {
    const guarded = work.catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Push failed");
    });
    pending.add(guarded);
    void guarded.finally(() => pending.delete(guarded));
    return guarded;
  }

  return {
    notifyCard: (cardId) =>
      track(
        db
          .query<Registration>("SELECT device_library_id, card_id, push_token FROM device_registrations WHERE card_id = $1", [cardId])
          .then((res) => send(res.rows)),
      ),
    notifyAll: () =>
      track(
        db
          .query<Registration>("SELECT device_library_id, card_id, push_token FROM device_registrations")
          .then((res) => send(res.rows)),
      ),
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
