import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { buildPass, type PassCard, type PassSettings } from "../../src/wallet/passBuilder.js";
import { checkManifest, readPkpass, verifySignature, type PassJson } from "../helpers/pkpass.js";
import { testConfig } from "../helpers/testApp.js";

const config = testConfig();
const card: PassCard = { serial: "AbCdEfGhIjKlMnOpQrStUv", authToken: "t".repeat(40), cups: 4, freeDrinkEarned: false };
const settings: PassSettings = { rewardGoal: 10, announcementText: null };

async function build(c: Partial<PassCard> = {}, s: Partial<PassSettings> = {}) {
  return readPkpass(await buildPass(config, { ...card, ...c }, { ...settings, ...s }));
}

function field(pass: PassJson, section: string, key: string) {
  return pass.storeCard[section]?.find((f) => f.key === key);
}

describe("a built pass", () => {
  test("has every key Apple requires", async () => {
    const { passJson } = await build();
    expect(passJson.formatVersion).toBe(1);
    expect(passJson.passTypeIdentifier).toBe(config.PASS_TYPE_ID);
    expect(passJson.teamIdentifier).toBe(config.APPLE_TEAM_ID);
    expect(passJson.serialNumber).toBe(card.serial);
    expect(passJson.organizationName).toBeTruthy();
    expect(passJson.description).toBeTruthy();
    expect(passJson.storeCard).toBeTruthy();
  });

  test("points the phone at our web service with an auth token of at least 16 characters", async () => {
    const { passJson } = await build();
    expect(passJson.webServiceURL).toBe("https://loyalty.test/");
    expect(passJson.authenticationToken).toBe(card.authToken);
    expect(passJson.authenticationToken.length).toBeGreaterThanOrEqual(16);
  });

  test("carries a QR code whose message is the serial and never the count", async () => {
    const { passJson } = await build();
    expect(passJson.barcodes).toEqual([
      { format: "PKBarcodeFormatQR", message: card.serial, messageEncoding: "iso-8859-1" },
    ]);
    expect(JSON.stringify(passJson.barcodes)).not.toContain("4");
  });

  test("has the images Wallet needs", async () => {
    const { files } = await build();
    for (const name of ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "strip.png", "strip@2x.png", "strip@3x.png"]) {
      expect(files[name], name).toBeTruthy();
    }
    const strip = await sharp(files["strip@2x.png"]).metadata();
    expect(strip.width).toBe(750);
  });

  test("lists every file in the manifest with the right hash", async () => {
    const { files } = await build();
    expect(checkManifest(files)).toEqual([]);
  });

  test("is signed so the signature verifies against the signing certificate", async () => {
    const { files } = await build();
    const problems = verifySignature(files["manifest.json"]!, files["signature"]!, readFileSync(config.PASS_CERT_PATH, "utf8"));
    expect(problems).toEqual([]);
  });

  test("the signature check fails for a manifest that was not signed", async () => {
    const { files } = await build();
    const forged = Buffer.from(files["manifest.json"]!.toString().replace(/[0-9a-f]/, (c) => (c === "0" ? "1" : "0")));
    const problems = verifySignature(forged, files["signature"]!, readFileSync(config.PASS_CERT_PATH, "utf8"));
    expect(problems.length).toBeGreaterThan(0);
  });

  test("a tampered file no longer matches the manifest", async () => {
    const { files } = await build();
    files["pass.json"] = Buffer.from(files["pass.json"]!.toString().replace("AbCd", "XXXX"));
    expect(checkManifest(files)).toContain("hash of pass.json does not match the manifest");
  });
});

describe("what the card shows", () => {
  test("the count out of the goal", async () => {
    const { passJson } = await build({ cups: 4 }, { rewardGoal: 10 });
    expect(field(passJson, "secondaryFields", "cups")?.value).toBe("4 of 10");
  });

  test("a change message so Wallet notifies when the count changes", async () => {
    const { passJson } = await build();
    expect(field(passJson, "secondaryFields", "cups")?.changeMessage).toContain("%@");
  });

  test("works for a goal of 1 and for a big goal", async () => {
    expect(field((await build({ cups: 0 }, { rewardGoal: 1 })).passJson, "secondaryFields", "cups")?.value).toBe("0 of 1");
    expect(field((await build({ cups: 37 }, { rewardGoal: 50 })).passJson, "secondaryFields", "cups")?.value).toBe("37 of 50");
  });

  test("an earned card says Free drink! and caps the count at the goal", async () => {
    const { passJson } = await build({ cups: 12, freeDrinkEarned: true }, { rewardGoal: 10 });
    expect(field(passJson, "secondaryFields", "cups")?.value).toBe("Free drink!");
    expect(JSON.stringify(passJson)).not.toContain("12 of");
  });

  test("the announcement is a field with a change message, so new text notifies", async () => {
    const withText = await build({}, { announcementText: "Double stamps this Friday" });
    const f = field(withText.passJson, "auxiliaryFields", "announcement");
    expect(f?.value).toBe("Double stamps this Friday");
    expect(f?.changeMessage).toContain("%@");

    const without = await build({}, { announcementText: null });
    const g = field(without.passJson, "auxiliaryFields", "announcement");
    expect(g?.value).toBeTruthy();
    expect(g?.changeMessage).toContain("%@");
  });
});
