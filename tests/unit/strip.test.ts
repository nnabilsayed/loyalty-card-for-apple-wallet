import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { MAX_CUPS_DRAWN, STRIP_SIZES, drawStrip, stripLayout } from "../../src/wallet/strip.js";

describe("stripLayout", () => {
  test("draws one cup per slot up to the limit", () => {
    expect(stripLayout(4, 10)).toEqual({ kind: "cups", filled: 4, total: 10 });
    expect(stripLayout(1, 1)).toEqual({ kind: "cups", filled: 1, total: 1 });
    expect(stripLayout(7, MAX_CUPS_DRAWN)).toEqual({ kind: "cups", filled: 7, total: MAX_CUPS_DRAWN });
  });

  test("draws a progress bar for goals above the limit", () => {
    expect(stripLayout(37, 50)).toEqual({ kind: "bar", fraction: 0.74 });
    expect(stripLayout(0, 1000)).toEqual({ kind: "bar", fraction: 0 });
  });

  test("never shows more than the goal", () => {
    expect(stripLayout(12, 10)).toEqual({ kind: "cups", filled: 10, total: 10 });
    expect(stripLayout(80, 50)).toEqual({ kind: "bar", fraction: 1 });
  });
});

describe("drawStrip", () => {
  test.each([1, 2, 3] as const)("is the Wallet strip size at %ix", async (scale) => {
    const png = await drawStrip(4, 10, scale);
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(STRIP_SIZES.width * scale);
    expect(meta.height).toBe(STRIP_SIZES.height * scale);
  });

  test("works for a goal of 1, a goal at the limit, and big goals", async () => {
    for (const [cups, goal] of [
      [0, 1],
      [1, 1],
      [20, MAX_CUPS_DRAWN],
      [37, 50],
      [900, 1000],
    ] as const) {
      const meta = await sharp(await drawStrip(cups, goal, 1)).metadata();
      expect(meta.width).toBe(STRIP_SIZES.width);
    }
  });

  test("more filled cups changes the picture", async () => {
    const empty = await drawStrip(0, 10, 1);
    const half = await drawStrip(5, 10, 1);
    expect(Buffer.compare(empty, half)).not.toBe(0);
  });
});
