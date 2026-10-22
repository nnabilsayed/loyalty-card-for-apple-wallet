import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { startFakePush, type FakePush } from "../helpers/fakePush.js";
import { readPkpass } from "../helpers/pkpass.js";
import { addTestAdmin, adminLogin, createTestApp, type TestApp } from "../helpers/testApp.js";

const PASS_TYPE = "pass.test.loyalty";

describe("an announcement reaches every card", () => {
  let ctx: TestApp;
  let fake: FakePush;
  let admin: string;
  const cards: { serial: string; authToken: string }[] = [];

  const announce = (text: string) =>
    ctx.app.inject({ method: "POST", url: "/api/admin/announcements", headers: { cookie: admin }, payload: { text } });
  const newsField = async (c: { serial: string; authToken: string }) => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${c.serial}`,
      headers: { authorization: `ApplePass ${c.authToken}` },
    });
    return readPkpass(res.rawPayload).passJson.storeCard.auxiliaryFields?.find((f) => f.key === "announcement");
  };

  beforeAll(async () => {
    fake = await startFakePush();
    ctx = await createTestApp({}, { APNS_HOST: fake.url });
    await addTestAdmin(ctx, "owner", "owner-password-1");
    admin = await adminLogin(ctx, "owner", "owner-password-1");
    for (const [i, phone] of ["+201001234501", "+201001234502", "+201001234503"].entries()) {
      const c = await issueCard(ctx.db, phone);
      cards.push(c);
      // Only the first two cards are on a phone; the third was never added to Wallet.
      if (i < 2) {
        await ctx.app.inject({
          method: "POST",
          url: `/v1/devices/phone-${i}/registrations/${PASS_TYPE}/${c.serial}`,
          headers: { authorization: `ApplePass ${c.authToken}` },
          payload: { pushToken: `token-${i}` },
        });
      }
    }
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  test("before any announcement the card shows a friendly default", async () => {
    const field = await newsField(cards[0]!);
    expect(field?.value).toContain("Show this card");
    expect(field?.changeMessage).toContain("%@");
  });

  test("after sending, the text is on every card in a field that notifies when it changes", async () => {
    expect((await announce("Double stamps this Friday")).statusCode).toBe(202);
    await ctx.app.push.idle();

    for (const c of cards) {
      const field = await newsField(c);
      expect(field?.value).toBe("Double stamps this Friday");
      expect(field?.changeMessage).toContain("%@");
    }
  });

  test("every phone with the card in Wallet was pushed, once", async () => {
    fake.clear();
    await announce("Closed on Sunday");
    await ctx.app.push.idle();
    expect(fake.requests.map((r) => r.token).sort()).toEqual(["token-0", "token-1"]);
  });

  test("every card is marked changed so phones download the new text", async () => {
    const list = await ctx.app.inject({ method: "GET", url: `/v1/devices/phone-0/registrations/${PASS_TYPE}?passesUpdatedSince=1` });
    expect(list.json().serialNumbers).toEqual([cards[0]!.serial]);
  });

  test("a card that was never added to Wallet is still counted as reached", async () => {
    const res = await announce("Happy Eid");
    expect(res.json()).toEqual({ cardsTargeted: 3 });
    await ctx.app.push.idle();
  });

  test("a refused announcement sends no push", async () => {
    await ctx.app.push.idle(); // let the previous test's pushes finish first
    fake.clear();
    expect((await announce("")).statusCode).toBe(422);
    await ctx.app.push.idle();
    expect(fake.requests).toHaveLength(0);
  });

  test("the pass stays valid and its count is untouched", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/passes/${PASS_TYPE}/${cards[0]!.serial}`,
      headers: { authorization: `ApplePass ${cards[0]!.authToken}` },
    });
    const { passJson } = readPkpass(res.rawPayload);
    expect(passJson.storeCard.secondaryFields?.find((f) => f.key === "cups")?.value).toBe("0 of 10");
  });
});
