import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Db } from "../db/pool.js";

export const SESSION_COOKIE = "session";

/** How long a sign-in lasts: a barista's shift, a shorter time for the Admin. */
export const SESSION_HOURS = { barista: 12, admin: 2 } as const;

export type Role = keyof typeof SESSION_HOURS;

export interface AuthContext {
  role: Role;
  id: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Db, role: Role, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS[role] * 3600 * 1000);
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await db.query(
    "INSERT INTO sessions (token_hash, role, barista_id, admin_id, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [hashToken(token), role, role === "barista" ? userId : null, role === "admin" ? userId : null, expiresAt],
  );
  return { token, expiresAt };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** Finds a live session. A removed barista's session is treated as not found. */
export async function findSession(db: Db, token: string): Promise<AuthContext | null> {
  const res = await db.query<{
    role: Role;
    barista_id: string | null;
    admin_id: string | null;
    barista_name: string | null;
    barista_active: boolean | null;
    admin_name: string | null;
  }>(
    `SELECT s.role, s.barista_id, s.admin_id,
            b.name AS barista_name, b.active AS barista_active, a.username AS admin_name
       FROM sessions s
       LEFT JOIN baristas b ON b.id = s.barista_id
       LEFT JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.role === "barista") {
    if (!row.barista_id || !row.barista_name || !row.barista_active) return null;
    return { role: "barista", id: row.barista_id, name: row.barista_name };
  }
  if (!row.admin_id || !row.admin_name) return null;
  return { role: "admin", id: row.admin_id, name: row.admin_name };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    expires: expiresAt,
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** The session token from a request's signed cookie, or null if missing or tampered with. */
export function sessionTokenOf(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/** Route guard: only a live session with the given role gets through; everyone else gets 401. */
export function requireRole(db: Db, role: Role): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const token = sessionTokenOf(request);
    const auth = token ? await findSession(db, token) : null;
    if (!auth || auth.role !== role) {
      return reply.code(401).send({ error: "Not signed in" });
    }
    request.auth = auth;
  };
}
