import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

describe("passwords", () => {
  test("the correct password verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  test("a wrong password does not verify", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batterz", hash)).toBe(false);
  });

  test("the same password hashes differently each time (salted)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
  });

  test("the hash does not contain the password", async () => {
    expect(await hashPassword("secret-password-123")).not.toContain("secret-password-123");
  });

  test("a malformed stored hash never verifies", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});
