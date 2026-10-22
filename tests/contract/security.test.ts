import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("security headers and limits", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    await addTestAdmin(ctx, "owner", "owner-password-1");
  });
  afterAll(async () => {
    await ctx.close();
  });

  const pages = ["/join/", "/staff/", "/admin/"];

  test.each(pages)("%s is served with the protective headers", async (url) => {
    const res = await ctx.app.inject({ method: "GET", url });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("only the staff page may use the camera", async () => {
    const staff = await ctx.app.inject({ method: "GET", url: "/staff/" });
    const join = await ctx.app.inject({ method: "GET", url: "/join/" });
    expect(String(staff.headers["permissions-policy"])).toContain("camera=(self)");
    expect(String(join.headers["permissions-policy"])).toContain("camera=()");
  });

  test("answers from the API are never cached", async () => {
    const cookie = await staffLogin(ctx, "123456");
    const me = await ctx.app.inject({ method: "GET", url: "/api/staff/me", headers: { cookie } });
    expect(me.headers["cache-control"]).toContain("no-store");
    const adminCookie = await adminLogin(ctx, "owner", "owner-password-1");
    const settings = await ctx.app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: adminCookie } });
    expect(settings.headers["cache-control"]).toContain("no-store");
    const refused = await ctx.app.inject({ method: "GET", url: "/api/staff/me" });
    expect(refused.headers["cache-control"]).toContain("no-store");
  });

  test("the session cookie is HTTP-only, same-site strict, and secure over https", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } });
    const cookie = res.cookies.find((c) => c.name === "session");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect(cookie?.expires).toBeInstanceOf(Date);
  });

  test("a request body over the size limit is refused", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/join",
      payload: { phone: "0".repeat(100_000) },
    });
    expect(res.statusCode).toBe(413);
  });

  test("error answers do not leak internals", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: "not json", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+/);
    expect(res.body).not.toContain("node_modules");
  });
});
