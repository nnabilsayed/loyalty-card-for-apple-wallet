import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { startFakePush, type FakePush } from "../helpers/fakePush.js";
import { readPkpass } from "../helpers/pkpass.js";
import { addTestAdmin, adminLogin, createTestApp, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("a goal change reaches every phone", () => {
  let ctx: TestApp;
  let fake: FakePush;
  let admin: string;
  const cards: { serial: string; authToken: string }[] = [];

  const register = (c: { serial: string; authToken: string }, device: string, pushToken: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/devices/${device}/registrations/${PASS_TYPE}/${c.serial}`,
      headers: { authorization: `ApplePass ${c.authToken}` },
      payload: { pushToken },
    });
  const downloadedPass = async (c: { serial: string; authToken: string }) => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${c.serial}`,
      headers: { authorization: `ApplePass ${c.authToken}` },
    });
    return readPkpass(res.rawPayload).passJson.storeCard;
  };

  beforeAll(async () => {
    fake = await startFakePush();
    ctx = await createTestApp({}, { APNS_HOST: fake.url });
    await addTestAdmin(ctx, "owner", "owner-password-1");
    admin = await adminLogin(ctx, "owner", "owner-password-1");
    for (const [i, phone] of ["+201001234501", "+201001234502", "+201001234503"].entries()) {
      const c = await issueCard(ctx.db, phone);
      cards.push(c);
      await register(c, `phone-${i}`, `token-${i}`);
    }
    await ctx.db.query("UPDATE cards SET cups = 6 WHERE serial = $1", [cards[0]!.serial]);
    await ctx.db.query("UPDATE cards SET cups = 9 WHERE serial = $1", [cards[1]!.serial]);
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  test("every registered device is pushed", async () => {
    fake.clear();
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { cookie: admin },
      payload: { rewardGoal: 8 },
    });
    expect(res.statusCode).toBe(200);
    await ctx.app.push.idle();
    expect(fake.requests.map((r) => r.token).sort()).toEqual(["token-0", "token-1", "token-2"]);
  });

  test("the downloaded passes show the new goal, and the card that now qualifies says Free drink!", async () => {
    const short = (await downloadedPass(cards[0]!)).secondaryFields!;
    expect(short.find((f) => f.key === "cups")?.value).toBe("6 of 8");
    expect(short.find((f) => f.key === "reward")?.value).toBe("Free drink after 8 cups");

    const qualifying = (await downloadedPass(cards[1]!)).secondaryFields!;
    expect(qualifying.find((f) => f.key === "cups")?.value).toBe("Free drink!");
  });

  test("a device sees every card as changed since before the change", async () => {
    const list = await ctx.app.inject({ method: "GET", url: `/v1/devices/phone-0/registrations/${PASS_TYPE}?passesUpdatedSince=1` });
    expect(list.statusCode).toBe(200);
    expect(list.json().serialNumbers).toEqual([cards[0]!.serial]);
  });

  test("saving the same goal sends no push", async () => {
    fake.clear();
    await ctx.app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie: admin }, payload: { rewardGoal: 8 } });
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("a refused goal sends no push", async () => {
    fake.clear();
    await ctx.app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie: admin }, payload: { rewardGoal: 0 } });
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });
});
