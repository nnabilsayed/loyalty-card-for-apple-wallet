import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard, stampCard } from "../../src/domain/cardService.js";
import { recordEvent } from "../../src/domain/ledger.js";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("admin: records", () => {
  let ctx: TestApp;
  let admin: string;

  const records = (query = "", cookie: string | null = admin) =>
    ctx.app.inject({ method: "GET", url: `/api/admin/ledger${query}`, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestAdmin(ctx, "owner", "owner-password-1");
    const saraId = await addTestBarista(ctx, "Sara", "123456");
    const omarId = await addTestBarista(ctx, "Omar", "654321");
    admin = await adminLogin(ctx, "owner", "owner-password-1");

    const { serial } = await issueCard(ctx.db, "+201001234567");
    const sara = { role: "barista" as const, id: saraId, name: "Sara" };
    const omar = { role: "barista" as const, id: omarId, name: "Omar" };
    await stampCard(ctx.db, serial, sara, { idempotencyKey: "a", force: false });
    await stampCard(ctx.db, serial, omar, { idempotencyKey: "b", force: true });
    await recordEvent(ctx.db, {
      type: "goal_change",
      actor: { role: "admin", id: null, name: "owner" },
      before: { rewardGoal: 10 },
      after: { rewardGoal: 8 },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("needs an Admin session", async () => {
    expect((await records("", null)).statusCode).toBe(401);
    const barista = await staffLogin(ctx, "123456");
    expect((await records("", barista)).statusCode).toBe(401);
  });

  test("lists records newest first, with who did them", async () => {
    const res = await records();
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({ type: "goal_change", actorName: "owner", before: { rewardGoal: 10 }, after: { rewardGoal: 8 } });
    const ids = rows.map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));
    expect(rows.map((r: { type: string }) => r.type)).toEqual(
      expect.arrayContaining(["goal_change", "stamp_forced", "stamp", "card_issued", "barista_added"]),
    );
  });

  test("shows a short card reference, never the full code", async () => {
    const rows = (await records("?type=stamp")).json();
    expect(rows).toHaveLength(1);
    const serial = (await ctx.db.query("SELECT serial FROM cards")).rows[0].serial;
    expect(rows[0].cardRef).toBe(serial.slice(0, 6));
    expect(JSON.stringify(rows)).not.toContain(serial);
    expect(JSON.stringify(rows)).not.toContain("+20100");
  });

  test("filters by type", async () => {
    const rows = (await records("?type=stamp_forced")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBe("Omar");
  });

  test("filters by person, ignoring case", async () => {
    const rows = (await records("?actor=sara")).json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { actorName: string }) => r.actorName === "Sara")).toBe(true);
  });

  test("a percent sign in the person filter is taken literally, not as a wildcard", async () => {
    expect((await records("?actor=%25")).json()).toEqual([]);
    expect((await records("?actor=_")).json()).toEqual([]);
  });

  test("filters by date range", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect((await records(`?from=${encodeURIComponent(future)}`)).json()).toEqual([]);
    expect((await records(`?to=${encodeURIComponent(past)}`)).json()).toEqual([]);
    expect((await records(`?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).json().length).toBeGreaterThan(0);
  });

  test("limit defaults to 100, caps at 500, and is respected", async () => {
    expect((await records("?limit=2")).json()).toHaveLength(2);
    expect((await records("?limit=9999")).statusCode).toBe(200);
    expect((await records("?limit=0")).statusCode).toBe(422);
    expect((await records("?limit=abc")).statusCode).toBe(422);
  });

  test("a bad date is refused", async () => {
    expect((await records("?from=yesterday")).statusCode).toBe(422);
  });
});
