import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addTestAdmin, addTestBarista, createTestApp, type TestApp } from "../helpers/testApp.js";

describe("repeated wrong PINs and passwords are slowed down", () => {
  let ctx: TestApp;

  const wrongPin = (ip: string) =>
    ctx.app.inject({ method: "POST", url: "/api/staff/login", remoteAddress: ip, payload: { pin: "000000" } });
  const wrongPassword = (ip: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/admin/login",
      remoteAddress: ip,
      payload: { username: "owner", password: "not-the-password" },
    });

  beforeAll(async () => {
    ctx = await createTestApp({ loginRateLimitMax: 5 });
    await addTestBarista(ctx, "Sara", "123456");
    await addTestAdmin(ctx, "owner", "owner-password-1");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("the sixth wrong PIN from one address gets 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await wrongPin("10.0.0.1")).statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  test("the throttled answer says when to try again", async () => {
    const res = await wrongPin("10.0.0.1");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  test("a different address is not affected", async () => {
    expect((await wrongPin("10.0.0.2")).statusCode).toBe(401);
  });

  test("the right PIN is also held back while an address is throttled", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", remoteAddress: "10.0.0.1", payload: { pin: "123456" } });
    expect(res.statusCode).toBe(429);
  });

  test("the right PIN works from a fresh address", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/staff/login", remoteAddress: "10.0.0.3", payload: { pin: "123456" } });
    expect(res.statusCode).toBe(200);
  });

  test("the same goes for admin passwords", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await wrongPassword("10.0.1.1")).statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect((await wrongPassword("10.0.1.2")).statusCode).toBe(401);
  });

  test("a throttled attempt never signs anyone in", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/login",
      remoteAddress: "10.0.1.1",
      payload: { username: "owner", password: "owner-password-1" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.cookies).toHaveLength(0);
  });
});
