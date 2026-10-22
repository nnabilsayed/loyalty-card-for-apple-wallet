import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  addTestAdmin,
  addTestBarista,
  adminLogin,
  createTestApp,
  sessionCookie,
  staffLogin,
  type TestApp,
} from "../helpers/testApp.js";

describe("staff and admin sign-in", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    await addTestAdmin(ctx, "owner", "owner-password-1");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("a barista signs in with their own PIN and gets a session cookie", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "Sara" });
    const cookie = res.cookies.find((c) => c.name === "session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    expect(cookie?.secure).toBe(true);
  });

  test("a wrong PIN is refused with no cookie", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "654321" } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  test("a malformed PIN is refused the same way", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "12" } });
    expect(res.statusCode).toBe(401);
  });

  test("the admin signs in with username and password", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: "owner", password: "owner-password-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === "session")).toBe(true);
  });

  test("a wrong admin password or unknown username is refused", async () => {
    const wrongPassword = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: "owner", password: "not-the-password" },
    });
    const unknownUser = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: "nobody", password: "owner-password-1" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
  });

  test("a staff route needs a session", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/staff/me" });
    expect(res.statusCode).toBe(401);
  });

  test("a signed-in barista can reach staff routes, and logout ends the session", async () => {
    const cookie = await staffLogin(ctx, "123456");
    const me = await ctx.app.inject({ method: "GET", url: "/api/staff/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ name: "Sara" });

    const out = await ctx.app.inject({ method: "POST", url: "/api/staff/logout", headers: { cookie } });
    expect(out.statusCode).toBe(204);

    const after = await ctx.app.inject({ method: "GET", url: "/api/staff/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  test("a barista session cannot reach admin routes, and an admin session cannot reach staff routes", async () => {
    const staff = await staffLogin(ctx, "123456");
    const admin = await adminLogin(ctx, "owner", "owner-password-1");

    const staffOnAdmin = await ctx.app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: staff } });
    const adminOnStaff = await ctx.app.inject({ method: "GET", url: "/api/staff/me", headers: { cookie: admin } });
    const adminOnAdmin = await ctx.app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: admin } });

    expect(staffOnAdmin.statusCode).toBe(401);
    expect(adminOnStaff.statusCode).toBe(401);
    expect(adminOnAdmin.statusCode).toBe(200);
  });

  test("a tampered session cookie is refused", async () => {
    const cookie = await staffLogin(ctx, "123456");
    const tampered = cookie.slice(0, -3) + "xyz";
    const res = await ctx.app.inject({ method: "GET", url: "/api/staff/me", headers: { cookie: tampered } });
    expect(res.statusCode).toBe(401);
  });

  test("sessions are stored hashed, never as the cookie value", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } });
    const value = decodeURIComponent(sessionCookie(res).split("=")[1]!);
    const rows = await ctx.db.query("SELECT token_hash FROM sessions");
    for (const row of rows.rows) expect(value).not.toContain(row.token_hash);
    expect(rows.rows.some((r) => value.includes(r.token_hash))).toBe(false);
  });
});

describe("login throttling", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ loginRateLimitMax: 10 });
    await addTestBarista(ctx, "Sara", "123456");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("repeated attempts from one address get 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "000000" } });
      statuses.push(res.statusCode);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
  });
});
