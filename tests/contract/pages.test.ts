import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestApp, type TestApp } from "../helpers/testApp.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});

test("the sign-up page is served and tells customers about offers and news", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/join/" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  expect(res.body).toContain("Phone number");
  expect(res.body).toContain("offers and news");
});

test("the shared stylesheet and sign-up script are served", async () => {
  expect((await ctx.app.inject({ method: "GET", url: "/shared.css" })).statusCode).toBe(200);
  expect((await ctx.app.inject({ method: "GET", url: "/join/join.js" })).statusCode).toBe(200);
});

test("an unknown path is 404", async () => {
  expect((await ctx.app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
});

test("the staff page is served, is not indexed, and loads its script", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/staff/" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("Staff sign-in");
  expect(res.body).toContain('name="robots" content="noindex"');
  expect(res.body).toContain("staff.bundle.js");
});

test("the owner dashboard is served and is not indexed", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/admin/" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("Owner sign-in");
  expect(res.body).toContain("Reward goal");
  expect(res.body).toContain('name="robots" content="noindex"');
});
