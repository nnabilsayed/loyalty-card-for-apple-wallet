import { describe, expect, test } from "vitest";
import { hashPin, isValidPin } from "../../src/auth/pin.js";

const pepper = "a-long-test-pepper-value";

describe("isValidPin", () => {
  test("accepts exactly six digits", () => {
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("000000")).toBe(true);
  });

  test.each(["12345", "1234567", "12a456", "", " 12345", "12345 ", "١٢٣٤٥٦"])("rejects %j", (pin) => {
    expect(isValidPin(pin)).toBe(false);
  });
});

describe("hashPin", () => {
  test("gives the same value for the same PIN and pepper", () => {
    expect(hashPin("123456", pepper)).toBe(hashPin("123456", pepper));
  });

  test("gives a different value for a different PIN", () => {
    expect(hashPin("123456", pepper)).not.toBe(hashPin("123457", pepper));
  });

  test("gives a different value for a different pepper", () => {
    expect(hashPin("123456", pepper)).not.toBe(hashPin("123456", "another-test-pepper-value"));
  });

  test("never contains the PIN", () => {
    expect(hashPin("123456", pepper)).not.toContain("123456");
  });

  test("refuses a PIN that is not six digits", () => {
    expect(() => hashPin("12345", pepper)).toThrow(/six digits/);
  });
});
