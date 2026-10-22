import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("admin: reward goal", () => {
  let ctx: TestApp;
  let admin: string;

  const get = (cookie?: string) =>
    ctx.app.inject({ method: "GET", url: "/api/admin/settings", headers: cookie ? { cookie } : {} });
  const put = (payload: unknown, cookie: string | null = admin) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: cookie ? { cookie } : {},
      payload: payload as object,
    });
  const goalRow = async () => (await ctx.db.query("SELECT reward_goal FROM settings")).rows[0].reward_goal;
  const card = async (phone: string, cups: number, earned = false) => {
    const { serial } = await issueCard(ctx.db, phone);
    await ctx.db.query("UPDATE cards SET cups = $2, free_drink_earned = $3 WHERE serial = $1", [serial, cups, earned]);
    return serial;
  };
  const cardRow = async (serial: string) =>
    (await ctx.db.query("SELECT cups, free_drink_earned FROM cards WHERE serial = $1", [serial])).rows[0];

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestAdmin(ctx, "owner", "owner-password-1");
    await addTestBarista(ctx, "Sara", "123456");
    admin = await adminLogin(ctx, "owner", "owner-password-1");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("GET shows the starting goal of 10", async () => {
    const res = await get(admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rewardGoal: 10, announcementText: null, announcementAt: null });
  });

  test("needs an Admin session: signed out and barista sessions get 401", async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await put({ rewardGoal: 5 }, null)).statusCode).toBe(401);
    const barista = await staffLogin(ctx, "123456");
    expect((await get(barista)).statusCode).toBe(401);
    expect((await put({ rewardGoal: 5 }, barista)).statusCode).toBe(401);
    expect(await goalRow()).toBe(10);
  });

  test("PUT changes the goal and GET shows it", async () => {
    const res = await put({ rewardGoal: 8 });
    expect(res.statusCode).toBe(200);
    expect(res.json().rewardGoal).toBe(8);
    expect((await get(admin)).json().rewardGoal).toBe(8);
    expect(await goalRow()).toBe(8);
  });

  test("the staff app sees the new goal at once", async () => {
    const barista = await staffLogin(ctx, "123456");
    const serial = await card("+201001234501", 0);
    const res = await ctx.app.inject({ method: "GET", url: `/api/staff/cards/${serial}`, headers: { cookie: barista } });
    expect(res.json().rewardGoal).toBe(8);
  });

  test.each([0, -3, 2.5, "abc", null, 2 ** 31])("%j is refused with 422 and the goal is unchanged", async (value) => {
    const res = await put({ rewardGoal: value });
    expect(res.statusCode).toBe(422);
    expect(await goalRow()).toBe(8);
  });

  test("a missing value is refused", async () => {
    expect((await put({})).statusCode).toBe(422);
  });

  test("there is no upper limit: 100 and 5000 are accepted", async () => {
    expect((await put({ rewardGoal: 100 })).statusCode).toBe(200);
    expect((await put({ rewardGoal: 5000 })).statusCode).toBe(200);
    expect(await goalRow()).toBe(5000);
    await put({ rewardGoal: 10 });
  });

  test("lowering the goal makes cards that now meet it earned", async () => {
    await put({ rewardGoal: 10 });
    const nine = await card("+201001234502", 9);
    const six = await card("+201001234503", 6);
    await put({ rewardGoal: 8 });
    expect(await cardRow(nine)).toEqual({ cups: 9, free_drink_earned: true });
    expect(await cardRow(six)).toEqual({ cups: 6, free_drink_earned: false });
  });

  test("raising the goal keeps an earned card earned and moves others further away", async () => {
    await put({ rewardGoal: 10 });
    const earned = await card("+201001234504", 10, true);
    const six = await card("+201001234505", 6);
    await put({ rewardGoal: 12 });
    expect(await cardRow(earned)).toEqual({ cups: 10, free_drink_earned: true });
    expect(await cardRow(six)).toEqual({ cups: 6, free_drink_earned: false });
    const barista = await staffLogin(ctx, "123456");
    const view = await ctx.app.inject({ method: "GET", url: `/api/staff/cards/${six}`, headers: { cookie: barista } });
    expect(view.json()).toMatchObject({ cups: 6, rewardGoal: 12 });
  });

  test("a goal change is recorded with the old value, the new value, and who did it", async () => {
    await put({ rewardGoal: 15 });
    const event = (
      await ctx.db.query(
        "SELECT actor_role, actor_name, before, after FROM ledger_events WHERE type = 'goal_change' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    expect(event).toMatchObject({
      actor_role: "admin",
      actor_name: "owner",
      before: { rewardGoal: 12 },
      after: { rewardGoal: 15 },
    });
  });

  test("saving the same goal again changes nothing and records nothing", async () => {
    const before = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events WHERE type = 'goal_change'")).rows[0].n;
    expect((await put({ rewardGoal: 15 })).statusCode).toBe(200);
    const after = (await ctx.db.query("SELECT count(*)::int AS n FROM ledger_events WHERE type = 'goal_change'")).rows[0].n;
    expect(after).toBe(before);
  });
});
