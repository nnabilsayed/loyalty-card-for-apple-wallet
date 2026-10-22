import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { startFakePush, type FakePush } from "../helpers/fakePush.js";
import { readPkpass } from "../helpers/pkpass.js";
import { addTestBarista, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("a redeemed card reaches the customer's phone", () => {
  let ctx: TestApp;
  let fake: FakePush;
  let cookie: string;
  let serial: string;
  let authToken: string;

  const passFields = async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${serial}`,
      headers: { authorization: `ApplePass ${authToken}` },
    });
    const { passJson, files } = readPkpass(res.rawPayload);
    return { cups: passJson.storeCard.secondaryFields?.find((f) => f.key === "cups"), files };
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

  test("before redeeming, the card says Free drink!", async () => {
    await ctx.db.query("UPDATE cards SET cups = 10, free_drink_earned = true WHERE serial = $1", [serial]);
    expect((await passFields()).cups?.value).toBe("Free drink!");
  });

  test("redeeming resets the pass to 0 and pushes the phone", async () => {
    fake.clear();
    const res = await ctx.app.inject({ method: "POST", url: `/api/staff/cards/${serial}/redeem`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await ctx.app.push.idle();

    expect(fake.requests.map((r) => r.token)).toEqual(["aa11"]);
    expect((await passFields()).cups?.value).toBe("0 of 10");
  });

  test("a refused redeem sends no push", async () => {
    fake.clear();
    const res = await ctx.app.inject({ method: "POST", url: `/api/staff/cards/${serial}/redeem`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("an earned card shows a full strip even when its count is past a lowered goal", async () => {
    await ctx.db.query("UPDATE settings SET reward_goal = 8");
    await ctx.db.query("UPDATE cards SET cups = 9, free_drink_earned = true WHERE serial = $1", [serial]);
    const { cups, files } = await passFields();
    expect(cups?.value).toBe("Free drink!");
    expect(files["strip.png"]).toBeTruthy();
  });
});
