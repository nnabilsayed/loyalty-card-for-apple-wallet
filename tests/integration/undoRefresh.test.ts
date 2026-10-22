import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { startFakePush, type FakePush } from "../helpers/fakePush.js";
import { readPkpass } from "../helpers/pkpass.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("an undo reaches the customer's phone", () => {
  let ctx: TestApp;
  let fake: FakePush;
  let cookie: string;
  let serial: string;
  let authToken: string;

  const post = (path: string, payload?: object) =>
    ctx.app.inject({ method: "POST", url: `/api/staff/cards/${serial}/${path}`, headers: { cookie }, payload });
  const cupsOnPass = async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${serial}`,
      headers: { authorization: `ApplePass ${authToken}` },
    });
    return readPkpass(res.rawPayload).passJson.storeCard.secondaryFields?.find((f) => f.key === "cups")?.value;
  };

  beforeAll(async () => {
    fake = await startFakePush();
    ctx = await createTestApp({}, { APNS_HOST: fake.url });
    await addTestBarista(ctx, "Sara", "123456");
    cookie = await staffLogin(ctx, "123456");
    const card = await issueCard(ctx.db, "+201001234567");
    serial = card.serial;
    authToken = card.authToken;
    await ctx.app.inject({
      method: "POST",
      url: `/v1/devices/phone-1/registrations/${PASS_TYPE}/${serial}`,
      headers: { authorization: `ApplePass ${authToken}` },
      payload: { pushToken: "aa11" },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  test("after a stamp the pass shows 1; after the undo the pass shows 0 and the phone is pushed", async () => {
    await post("stamp", { idempotencyKey: "a" });
    await ctx.app.push.idle();
    expect(await cupsOnPass()).toBe("1 of 10");

    fake.clear();
    expect((await post("undo")).statusCode).toBe(200);
    await ctx.app.push.idle();
    expect(fake.requests.map((r) => r.token)).toEqual(["aa11"]);
    expect(await cupsOnPass()).toBe("0 of 10");
  });

  test("a refused undo sends no push", async () => {
    fake.clear();
    expect((await post("undo")).statusCode).toBe(409);
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("the records hold both the stamp and the undo, linked together", async () => {
    const rows = (
      await ctx.db.query(
        `SELECT e.id, e.type, e.actor_name, e.before, e.after FROM ledger_events e JOIN cards c ON c.id = e.card_id
          WHERE c.serial = $1 AND e.type IN ('stamp', 'undo') ORDER BY e.id`,
        [serial],
      )
    ).rows;
    expect(rows.map((r) => r.type)).toEqual(["stamp", "undo"]);
    expect(rows[1].actor_name).toBe("Sara");
    expect(rows[1].before).toEqual({ cups: 1, freeDrinkEarned: false });
    expect(rows[1].after).toEqual({ cups: 0, freeDrinkEarned: false, undoes: Number(rows[0].id) });
  });
});
