import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { SESSION_HOURS } from "../../src/auth/sessions.js";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("who can do what", () => {
  let ctx: TestApp;
  let serial: string;

  const unknown = "00000000-0000-4000-8000-000000000000";
  const staffRoutes = (s: string): [string, string, object | undefined][] => [
    ["GET", "/api/staff/me", undefined],
    ["GET", `/api/staff/cards/${s}`, undefined],
    ["POST", `/api/staff/cards/${s}/stamp`, { idempotencyKey: "k" }],
    ["POST", `/api/staff/cards/${s}/redeem`, undefined],
    ["POST", `/api/staff/cards/${s}/undo`, undefined],
  ];
  const adminRoutes: [string, string, object | undefined][] = [
    ["GET", "/api/admin/me", undefined],
    ["GET", "/api/admin/settings", undefined],
    ["PUT", "/api/admin/settings", { rewardGoal: 5 }],
    ["GET", "/api/admin/ledger", undefined],
    ["GET", "/api/admin/baristas", undefined],
    ["POST", "/api/admin/baristas", { name: "X", pin: "999999" }],
    ["PATCH", `/api/admin/baristas/${unknown}`, { name: "X" }],
    ["DELETE", `/api/admin/baristas/${unknown}`, undefined],
  ];
  const call = (method: string, url: string, payload: object | undefined, cookie: string | null) =>
    ctx.app.inject({
      method: method as "GET",
      url,
      headers: cookie ? { cookie } : {},
      payload,
    });

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    await addTestAdmin(ctx, "owner", "owner-password-1");
    serial = (await issueCard(ctx.db, "+201001234567")).serial;
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("nobody signed in can use any staff or admin route", async () => {
    for (const [method, url, payload] of [...staffRoutes(serial), ...adminRoutes]) {
      expect((await call(method, url, payload, null)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(0);
  });

  test("a barista cannot reach any admin route", async () => {
    const barista = await staffLogin(ctx, "123456");
    for (const [method, url, payload] of adminRoutes) {
      expect((await call(method, url, payload, barista)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test("the Admin cannot use the staff routes", async () => {
    const admin = await adminLogin(ctx, "owner", "owner-password-1");
    for (const [method, url, payload] of staffRoutes(serial)) {
      expect((await call(method, url, payload, admin)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test("the public pages and the sign-up stay open", async () => {
    expect((await call("GET", "/join/", undefined, null)).statusCode).toBe(200);
    expect((await call("GET", "/healthz", undefined, null)).statusCode).toBe(200);
  });

  test("a session lasts a shift for a barista and two hours for the Admin", () => {
    expect(SESSION_HOURS).toEqual({ barista: 12, admin: 2 });
  });

  test("the stored expiry matches those lengths", async () => {
    await staffLogin(ctx, "123456");
    await adminLogin(ctx, "owner", "owner-password-1");
    const rows = (
      await ctx.db.query<{ role: string; hours: number }>(
        "SELECT role, extract(epoch FROM (expires_at - created_at)) / 3600 AS hours FROM sessions",
      )
    ).rows;
    for (const row of rows) {
      const expected = row.role === "barista" ? 12 : 2;
      expect(Math.abs(Number(row.hours) - expected)).toBeLessThan(0.02);
    }
  });

  test("an expired session is refused, for a barista and for the Admin", async () => {
    const barista = await staffLogin(ctx, "123456");
    const admin = await adminLogin(ctx, "owner", "owner-password-1");
    expect((await call("GET", "/api/staff/me", undefined, barista)).statusCode).toBe(200);
    expect((await call("GET", "/api/admin/me", undefined, admin)).statusCode).toBe(200);

    await ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");

    expect((await call("GET", "/api/staff/me", undefined, barista)).statusCode).toBe(401);
    expect((await call("GET", "/api/admin/me", undefined, admin)).statusCode).toBe(401);
  });

  test("a barista stays signed in across many stamps in a row, with no sign-in in between", async () => {
    await ctx.db.query("UPDATE settings SET reward_goal = 100");
    const barista = await staffLogin(ctx, "123456");
    for (let i = 0; i < 25; i++) {
      const res = await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: `shift-${i}`, force: true }, barista);
      expect(res.statusCode, `stamp ${i}`).toBe(200);
    }
    expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(25);
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM sessions WHERE role = 'barista' AND expires_at > now()")).rows[0].n).toBe(1);
  });

  describe("removing a barista", () => {
    let omarId: string;

    beforeAll(async () => {
      omarId = await addTestBarista(ctx, "Omar", "654321");
    });

    test("cuts off a session that is already open on the very next request", async () => {
      const omar = await staffLogin(ctx, "654321");
      expect((await call("GET", "/api/staff/me", undefined, omar)).statusCode).toBe(200);
      expect((await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "omar-1", force: true }, omar)).statusCode).toBe(200);
      const admin = await adminLogin(ctx, "owner", "owner-password-1");
      expect((await call("DELETE", `/api/admin/baristas/${omarId}`, undefined, admin)).statusCode).toBe(204);

      expect((await call("GET", "/api/staff/me", undefined, omar)).statusCode).toBe(401);
      expect((await call("POST", `/api/staff/cards/${serial}/stamp`, { idempotencyKey: "after", force: true }, omar)).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "654321" } })).statusCode).toBe(401);
    });

    test("keeps their earlier records, under their name", async () => {
      const rows = (await ctx.db.query("SELECT type, actor_role, actor_name FROM ledger_events WHERE actor_name = 'Omar'")).rows;
      expect(rows).toEqual([{ type: "stamp_forced", actor_role: "barista", actor_name: "Omar" }]);
    });

    test("their sessions are deleted, not just ignored", async () => {
      expect((await ctx.db.query("SELECT 1 FROM sessions WHERE barista_id = $1", [omarId])).rowCount).toBe(0);
    });
  });

  test("a barista's earlier stamps still show their name after they are removed", async () => {
    const lena = await addTestBarista(ctx, "Lena", "777888");
    const cookie = await staffLogin(ctx, "777888");
    const card = (await issueCard(ctx.db, "+201001234599")).serial;
    await call("POST", `/api/staff/cards/${card}/stamp`, { idempotencyKey: "lena-1" }, cookie);
    const admin = await adminLogin(ctx, "owner", "owner-password-1");
    await call("DELETE", `/api/admin/baristas/${lena}`, undefined, admin);

    const records = (await call("GET", "/api/admin/ledger?type=stamp&actor=Lena", undefined, admin)).json();
    expect(records).toHaveLength(1);
    expect(records[0].actorName).toBe("Lena");
  });
});
