import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { issueCard } from "../../src/domain/cardService.js";
import { addTestAdmin, addTestBarista, adminLogin, createTestApp, staffLogin, type TestApp } from "../helpers/testApp.js";

describe("admin: announcements", () => {
  let ctx: TestApp;
  let admin: string;

  const send = (payload: unknown, cookie: string | null = admin) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      headers: cookie ? { cookie } : {},
      payload: payload as object,
    });
  const settings = async () =>
    (await ctx.db.query("SELECT announcement_text, announcement_at FROM settings")).rows[0];

  beforeAll(async () => {
    ctx = await createTestApp();
    await addTestAdmin(ctx, "owner", "owner-password-1");
    await addTestBarista(ctx, "Sara", "123456");
    admin = await adminLogin(ctx, "owner", "owner-password-1");
    for (const phone of ["+201001234501", "+201001234502", "+201001234503"]) await issueCard(ctx.db, phone);
  });
  afterAll(async () => {
    await ctx.close();
  });

  test("sending is accepted and says how many cards it goes to", async () => {
    const res = await send({ text: "Double stamps this Friday" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ cardsTargeted: 3 });
  });

  test("the text becomes the current announcement", async () => {
    const row = await settings();
    expect(row.announcement_text).toBe("Double stamps this Friday");
    expect(row.announcement_at).toBeInstanceOf(Date);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: admin } })).json()).toMatchObject({
      announcementText: "Double stamps this Friday",
    });
  });

  test("it is kept in the sent history and in the records with who sent it", async () => {
    const sent = (await ctx.db.query("SELECT text, sent_by, cards_targeted FROM announcements")).rows;
    expect(sent).toEqual([{ text: "Double stamps this Friday", sent_by: "owner", cards_targeted: 3 }]);

    const event = (await ctx.db.query("SELECT actor_role, actor_name, after FROM ledger_events WHERE type = 'announcement'")).rows;
    expect(event).toEqual([
      { actor_role: "admin", actor_name: "owner", after: { text: "Double stamps this Friday", cardsTargeted: 3 } },
    ]);
  });

  test("a newer announcement replaces the current one but the history keeps both", async () => {
    expect((await send({ text: "Closed on Sunday" })).statusCode).toBe(202);
    expect((await settings()).announcement_text).toBe("Closed on Sunday");
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM announcements")).rows[0].n).toBe(2);
  });

  test("leading and trailing spaces are trimmed", async () => {
    await send({ text: "   Free cookie with every coffee   " });
    expect((await settings()).announcement_text).toBe("Free cookie with every coffee");
  });

  test("text of exactly 200 characters is accepted", async () => {
    const text = "a".repeat(200);
    expect((await send({ text })).statusCode).toBe(202);
    expect((await settings()).announcement_text).toBe(text);
  });

  test("Arabic text and emoji are accepted, and 200 means 200 characters, not bytes", async () => {
    const arabic = "خصم خاص على القهوة اليوم ☕";
    expect((await send({ text: arabic })).statusCode).toBe(202);
    expect((await settings()).announcement_text).toBe(arabic);
    expect((await send({ text: "☕".repeat(200) })).statusCode).toBe(202);
    expect((await send({ text: "☕".repeat(201) })).statusCode).toBe(422);
  });

  test.each([["empty", ""], ["only spaces", "    "], ["missing", undefined], ["not text", 42], ["null", null], ["too long", "a".repeat(201)]])(
    "%s text is refused with 422 and nothing changes",
    async (_label, text) => {
      const before = await settings();
      const count = (await ctx.db.query("SELECT count(*)::int AS n FROM announcements")).rows[0].n;
      const res = await send({ text });
      expect(res.statusCode).toBe(422);
      expect(await settings()).toEqual(before);
      expect((await ctx.db.query("SELECT count(*)::int AS n FROM announcements")).rows[0].n).toBe(count);
    },
  );

  test("the sent history lists the newest first with who sent it and how many cards", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/admin/announcements", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]).toMatchObject({ sentBy: "owner", cardsTargeted: 3 });
    expect(typeof rows[0].text).toBe("string");
    const times = rows.map((r: { sentAt: string }) => Date.parse(r.sentAt));
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
    const first = await ctx.app.inject({ method: "GET", url: "/api/admin/announcements?limit=1", headers: { cookie: admin } });
    expect(first.json()).toHaveLength(1);
  });

  test("the history needs an Admin session too", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/announcements" })).statusCode).toBe(401);
  });

  test("needs an Admin session", async () => {
    const barista = await staffLogin(ctx, "123456");
    expect((await send({ text: "Hello" }, null)).statusCode).toBe(401);
    expect((await send({ text: "Hello" }, barista)).statusCode).toBe(401);
  });

  test("with no cards at all it still works and reaches 0", async () => {
    const empty = await createTestApp();
    try {
      await addTestAdmin(empty, "owner", "owner-password-1");
      const cookie = await adminLogin(empty, "owner", "owner-password-1");
      const res = await empty.app.inject({
        method: "POST",
        url: "/api/admin/announcements",
        headers: { cookie },
        payload: { text: "Opening soon" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ cardsTargeted: 0 });
    } finally {
      await empty.close();
    }
  });
});
