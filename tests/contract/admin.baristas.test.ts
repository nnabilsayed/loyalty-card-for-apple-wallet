import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("admin: baristas", () => {
  let ctx: TestApp;
  let admin: string;

  const send = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, cookie: string | null = admin) =>
    ctx.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object });
  const add = (name: unknown, pin: unknown) => send("POST", "/api/admin/baristas", { name, pin });
  const ledger = async (type: string) =>
    (await ctx.db.query("SELECT actor_role, actor_name, after, before FROM ledger_events WHERE type = $1 ORDER BY id", [type])).rows;

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestAdmin(ctx, "owner", "owner-password-1");
    admin = await adminLogin(ctx, "owner", "owner-password-1");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("starts with no baristas", async () => {
    const res = await send("GET", "/api/admin/baristas");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  test("adding a barista with a name and a 6-digit PIN works, and they can sign in", async () => {
    const res = await add("Sara", "123456");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Sara" });
    expect(res.json().id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).not.toContain("123456");
    expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } })).statusCode).toBe(200);
  });

  test("the list shows names, never PINs", async () => {
    const res = await send("GET", "/api/admin/baristas");
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ name: "Sara" });
    expect(Object.keys(res.json()[0]).sort()).toEqual(["createdAt", "id", "name"]);
  });

  test("adding is recorded with who did it", async () => {
    const rows = await ledger("barista_added");
    expect(rows.at(-1)).toMatchObject({ actor_role: "admin", actor_name: "owner" });
    expect(rows.at(-1)!.after.name).toBe("Sara");
    expect(JSON.stringify(rows)).not.toContain("123456");
  });

  test.each(["12345", "1234567", "abcdef", "12 456", "", 123456, null, undefined])("a PIN of %j is refused", async (pin) => {
    const res = await add("Omar", pin);
    expect(res.statusCode).toBe(422);
  });

  test.each(["", "   ", null, undefined, 42])("a name of %j is refused", async (name) => {
    expect((await add(name, "654321")).statusCode).toBe(422);
  });

  test("a PIN another active barista already uses is refused with 409", async () => {
    const res = await add("Omar", "123456");
    expect(res.statusCode).toBe(409);
    expect((await send("GET", "/api/admin/baristas")).json()).toHaveLength(1);
  });

  test("changing a barista's PIN works: the old PIN stops and the new one signs in", async () => {
    const id = (await send("GET", "/api/admin/baristas")).json()[0].id;
    const res = await send("PATCH", `/api/admin/baristas/${id}`, { pin: "111222" });
    expect(res.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "111222" } })).statusCode).toBe(200);
    const rows = await ledger("barista_pin_changed");
    expect(rows.at(-1)).toMatchObject({ actor_role: "admin", actor_name: "owner" });
    expect(JSON.stringify(rows)).not.toContain("111222");
  });

  test("renaming works, is recorded, and old records keep the name they were made under", async () => {
    const id = (await send("GET", "/api/admin/baristas")).json()[0].id;
    const res = await send("PATCH", `/api/admin/baristas/${id}`, { name: "Sara M." });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Sara M.");
    const rows = await ledger("barista_renamed");
    expect(rows.at(-1)).toMatchObject({ before: { name: "Sara" }, after: { name: "Sara M." } });
    expect((await ledger("barista_added"))[0]!.after.name).toBe("Sara");
  });

  test("a PATCH needs a name or a PIN, and a bad PIN is refused", async () => {
    const id = (await send("GET", "/api/admin/baristas")).json()[0].id;
    expect((await send("PATCH", `/api/admin/baristas/${id}`, {})).statusCode).toBe(422);
    expect((await send("PATCH", `/api/admin/baristas/${id}`, { pin: "12" })).statusCode).toBe(422);
  });

  test("changing to a PIN another barista uses is refused with 409", async () => {
    await add("Omar", "654321");
    const sara = (await send("GET", "/api/admin/baristas")).json().find((b: { name: string }) => b.name === "Sara M.");
    expect((await send("PATCH", `/api/admin/baristas/${sara.id}`, { pin: "654321" })).statusCode).toBe(409);
  });

  test("an unknown barista is 404 for change and remove", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await send("PATCH", `/api/admin/baristas/${unknown}`, { name: "X" })).statusCode).toBe(404);
    expect((await send("DELETE", `/api/admin/baristas/${unknown}`)).statusCode).toBe(404);
    expect((await send("DELETE", "/api/admin/baristas/not-an-id")).statusCode).toBe(404);
  });

  test("removing a barista: 204, gone from the list, can no longer sign in, recorded", async () => {
    const omar = (await send("GET", "/api/admin/baristas")).json().find((b: { name: string }) => b.name === "Omar");
    expect((await send("DELETE", `/api/admin/baristas/${omar.id}`)).statusCode).toBe(204);
    expect((await send("GET", "/api/admin/baristas")).json().map((b: { name: string }) => b.name)).toEqual(["Sara M."]);
    expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "654321" } })).statusCode).toBe(401);
    const rows = await ledger("barista_removed");
    expect(rows.at(-1)).toMatchObject({ actor_role: "admin", actor_name: "owner", before: { name: "Omar" } });
  });

  test("a removed barista cannot be changed or removed again", async () => {
    const removed = (await ctx.db.query("SELECT id FROM baristas WHERE name = 'Omar'")).rows[0].id;
    expect((await send("PATCH", `/api/admin/baristas/${removed}`, { name: "Omar again" })).statusCode).toBe(404);
    expect((await send("DELETE", `/api/admin/baristas/${removed}`)).statusCode).toBe(404);
  });

  test("a removed barista's PIN can be given to someone new", async () => {
    expect((await add("Layla", "654321")).statusCode).toBe(201);
  });

  test("every barista route needs an Admin session", async () => {
    const barista = await staffLogin(ctx, "111222");
    const id = "00000000-0000-4000-8000-000000000000";
    for (const cookie of [null, barista]) {
      expect((await send("GET", "/api/admin/baristas", undefined, cookie)).statusCode).toBe(401);
      expect((await send("POST", "/api/admin/baristas", { name: "X", pin: "999999" }, cookie)).statusCode).toBe(401);
      expect((await send("PATCH", `/api/admin/baristas/${id}`, { name: "X" }, cookie)).statusCode).toBe(401);
      expect((await send("DELETE", `/api/admin/baristas/${id}`, undefined, cookie)).statusCode).toBe(401);
    }
  });
});

describe("barista created through the test helper", () => {
  test("can sign in with their PIN", async () => {
    const ctx = await createTestApp();
    try {
      await addTestBarista(ctx, "Sara", "123456");
      expect((await ctx.app.inject({ method: "POST", url: "/api/staff/login", payload: { pin: "123456" } })).statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
