import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("staff: undo the latest stamp", () => {
  let ctx: TestApp;
  let sara: string;
  let omar: string;

  const call = (cookie: string | null, path: string, payload?: object) =>
    ctx.app.inject({ method: "POST", url: path, headers: cookie ? { cookie } : {}, payload });
  const stamp = (serial: string, key: string, force = false, cookie: string | null = sara) =>
    call(cookie, `/api/staff/cards/${serial}/stamp`, { idempotencyKey: key, force });
  const undo = (serial: string, cookie: string | null = sara) => call(cookie, `/api/staff/cards/${serial}/undo`);
  const newCard = async (phone: string) => (await issueCard(ctx.db, phone)).serial;

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestBarista(ctx, "Sara", "123456");
    await addTestBarista(ctx, "Omar", "654321");
    sara = await staffLogin(ctx, "123456");
    omar = await staffLogin(ctx, "654321");
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("a stamp can be undone and the earlier count comes back", async () => {
    const serial = await newCard("+201001234567");
    await stamp(serial, "a");
    const res = await undo(serial);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serial, cups: 0, freeDrinkEarned: false, canUndo: false });
  });

  test("the stamp response says it can be undone", async () => {
    const serial = await newCard("+201001234568");
    expect((await stamp(serial, "a")).json().canUndo).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/staff/cards/${serial}`, headers: { cookie: sara } })).json().canUndo).toBe(true);
  });

  test("another barista can undo it", async () => {
    const serial = await newCard("+201001234569");
    await stamp(serial, "a", false, sara);
    const res = await undo(serial, omar);
    expect(res.statusCode).toBe(200);
    expect(res.json().cups).toBe(0);
  });

  test("undoing the stamp that earned the free drink takes the free drink back", async () => {
    const serial = await newCard("+201001234570");
    await ctx.db.query("UPDATE cards SET cups = 9 WHERE serial = $1", [serial]);
    expect((await stamp(serial, "last")).json()).toMatchObject({ cups: 10, freeDrinkEarned: true });
    expect((await undo(serial)).json()).toMatchObject({ cups: 9, freeDrinkEarned: false });
  });

  test("after an undo the next stamp is not held back by the cooldown", async () => {
    const serial = await newCard("+201001234571");
    await stamp(serial, "a");
    await undo(serial);
    const again = await stamp(serial, "b");
    expect(again.statusCode).toBe(200);
    expect(again.json().cups).toBe(1);
  });

  test("it can only undo once: a second undo, or an undo on a fresh card, is refused", async () => {
    const serial = await newCard("+201001234572");
    await stamp(serial, "a");
    expect((await undo(serial)).statusCode).toBe(200);
    const second = await undo(serial);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "nothing_to_undo" });
    expect(second.json().message).toBeTruthy();

    const fresh = await newCard("+201001234573");
    expect((await undo(fresh)).statusCode).toBe(409);
  });

  test("a redeem cannot be undone", async () => {
    const serial = await newCard("+201001234574");
    await ctx.db.query("UPDATE cards SET cups = 10, free_drink_earned = true WHERE serial = $1", [serial]);
    expect((await call(sara, `/api/staff/cards/${serial}/redeem`)).statusCode).toBe(200);
    const res = await undo(serial);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "nothing_to_undo" });
  });

  test("only the latest stamp can be undone: after two stamps one undo takes back one, and the earlier stamp stays", async () => {
    const serial = await newCard("+201001234575");
    await stamp(serial, "a");
    await stamp(serial, "b", true);
    expect((await undo(serial)).json().cups).toBe(1);
    // The latest record is now the undo, so there is nothing further to undo. The first stamp stands.
    expect((await undo(serial)).statusCode).toBe(409);
    expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(1);
  });

  test("not signed in is 401 and nothing changes", async () => {
    const serial = await newCard("+201001234576");
    await stamp(serial, "a");
    expect((await undo(serial, null)).statusCode).toBe(401);
    expect((await ctx.db.query("SELECT cups FROM cards WHERE serial = $1", [serial])).rows[0].cups).toBe(1);
  });

  test("an unknown code is 404", async () => {
    expect((await undo("not-one-of-ours-000000")).statusCode).toBe(404);
  });
});
