import { describe, expect, test } from "vitest";
import { normalizePhone } from "../../src/domain/phone.js";

describe("normalizePhone (default region EG)", () => {
  test.each([
    ["010 0123 4567", "+201001234567"],
    ["0100 123 4567", "+201001234567"],
    ["+20 100 123 4567", "+201001234567"],
    ["0020 100 123 4567", "+201001234567"],
    ["010-0123-4567", "+201001234567"],
    ["01201234567", "+201201234567"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizePhone(input, "EG")).toBe(expected);
  });

  test("a number with another country code is kept as entered", () => {
    expect(normalizePhone("+44 7911 123456", "EG")).toBe("+447911123456");
    expect(normalizePhone("+966 50 123 4567", "EG")).toBe("+966501234567");
  });

  test("the same number written two ways gives the same value", () => {
    expect(normalizePhone("0100 123 4567", "EG")).toBe(normalizePhone("+20 100 123 4567", "EG"));
  });

  test.each(["", "   ", "abc", "123", "010 0123", "+20 100", "01001234567890123"])("rejects %j", (input) => {
    expect(normalizePhone(input, "EG")).toBeNull();
  });
});
