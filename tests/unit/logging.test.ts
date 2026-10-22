import { describe, expect, test } from "vitest";
import { redactUrl, requestSerializer } from "../../src/logging.js";

const serial = "AbCdEfGhIjKlMnOpQrStUv"; // 22 characters, the shape of a real card code

describe("redactUrl", () => {
  test("hides the card code in a pass download", () => {
    const out = redactUrl(`/card/${serial}.pkpass`);
    expect(out).toBe("/card/AbCdEf….pkpass");
    expect(out).not.toContain(serial);
  });

  test("hides the card code in staff routes", () => {
    expect(redactUrl(`/api/staff/cards/${serial}`)).toBe("/api/staff/cards/AbCdEf…");
    expect(redactUrl(`/api/staff/cards/${serial}/stamp`)).toBe("/api/staff/cards/AbCdEf…/stamp");
  });

  test("hides the card code in Apple's web service paths but keeps the rest", () => {
    expect(redactUrl(`/v1/passes/pass.test.loyalty/${serial}`)).toBe("/v1/passes/pass.test.loyalty/AbCdEf…");
    expect(redactUrl(`/v1/devices/dev-1/registrations/pass.test.loyalty/${serial}`)).toBe(
      "/v1/devices/dev-1/registrations/pass.test.loyalty/AbCdEf…",
    );
  });

  test("hides a phone number in the query", () => {
    expect(redactUrl("/api/admin/customers?phone=%2B201001234567")).toBe("/api/admin/customers?phone=%5Bredacted%5D");
    expect(redactUrl("/api/admin/customers?phone=010%200123%204567&x=1")).toBe(
      "/api/admin/customers?phone=%5Bredacted%5D&x=1",
    );
  });

  test("leaves ordinary URLs alone", () => {
    expect(redactUrl("/api/join")).toBe("/api/join");
    expect(redactUrl("/api/admin/ledger?type=stamp&limit=50")).toBe("/api/admin/ledger?type=stamp&limit=50");
    expect(redactUrl("/v1/devices/dev-1/registrations/pass.test.loyalty?passesUpdatedSince=123")).toBe(
      "/v1/devices/dev-1/registrations/pass.test.loyalty?passesUpdatedSince=123",
    );
    expect(redactUrl("/admin/")).toBe("/admin/");
  });
});

describe("requestSerializer", () => {
  test("keeps what is useful for debugging and nothing secret", () => {
    // A real request also carries headers and cookies; the serializer must not pass them on.
    const request = {
      method: "POST",
      url: `/api/staff/cards/${serial}/stamp`,
      ip: "10.0.0.1",
      headers: { authorization: "ApplePass secret-token", cookie: "session=abc" },
    };
    const logged = requestSerializer(request);
    expect(logged).toEqual({ method: "POST", url: "/api/staff/cards/AbCdEf…/stamp", remoteAddress: "10.0.0.1" });
    expect(JSON.stringify(logged)).not.toContain("secret-token");
    expect(JSON.stringify(logged)).not.toContain("session=abc");
  });
});
