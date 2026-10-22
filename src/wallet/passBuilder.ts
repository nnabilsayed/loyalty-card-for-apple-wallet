import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PKPass } from "passkit-generator";
import type { Config } from "../config.js";
import { drawStrip } from "./strip.js";

export interface PassCard {
  serial: string;
  authToken: string;
  cups: number;
  freeDrinkEarned: boolean;
}

export interface PassSettings {
  rewardGoal: number;
  announcementText: string | null;
}

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "pass");
const IMAGE_FILES = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"] as const;
const DEFAULT_NEWS = "Show this card at the counter to collect a cup with every drink.";

let cachedAssets: Record<string, Buffer> | undefined;
function assets(): Record<string, Buffer> {
  cachedAssets ??= Object.fromEntries(IMAGE_FILES.map((f) => [f, readFileSync(join(assetsDir, f))]));
  return cachedAssets;
}

const certCache = new WeakMap<Config, { wwdr: Buffer; signerCert: Buffer; signerKey: Buffer }>();
function certificates(config: Config) {
  let certs = certCache.get(config);
  if (!certs) {
    certs = {
      wwdr: readFileSync(config.WWDR_CERT_PATH),
      signerCert: readFileSync(config.PASS_CERT_PATH),
      signerKey: readFileSync(config.PASS_KEY_PATH),
    };
    certCache.set(config, certs);
  }
  return certs;
}

/** The text on the card: "4 of 10", or "Free drink!" once earned. */
export function cupsText(card: Pick<PassCard, "cups" | "freeDrinkEarned">, goal: number): string {
  return card.freeDrinkEarned ? "Free drink!" : `${Math.min(card.cups, goal)} of ${goal}`;
}

/** Builds and signs the .pkpass for a card from its current state. */
export async function buildPass(config: Config, card: PassCard, settings: PassSettings): Promise<Buffer> {
  const certs = certificates(config);
  const goal = settings.rewardGoal;
  // An earned card shows a full strip, even if the goal was lowered below its count.
  const stripCups = card.freeDrinkEarned ? goal : card.cups;

  const pass = new PKPass(
    {},
    {
      wwdr: certs.wwdr,
      signerCert: certs.signerCert,
      signerKey: certs.signerKey,
      signerKeyPassphrase: config.PASS_KEY_PASSPHRASE,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: config.PASS_TYPE_ID,
      teamIdentifier: config.APPLE_TEAM_ID,
      serialNumber: card.serial,
      organizationName: config.SHOP_NAME,
      description: `${config.SHOP_NAME} loyalty card`,
      logoText: config.SHOP_NAME,
      webServiceURL: config.PUBLIC_BASE_URL.replace(/\/+$/, "") + "/",
      authenticationToken: card.authToken,
      backgroundColor: "rgb(111, 78, 55)",
      foregroundColor: "rgb(255, 255, 255)",
      labelColor: "rgb(232, 218, 200)",
    },
  );

  pass.type = "storeCard";
  pass.secondaryFields.push(
    {
      key: "cups",
      label: "CUPS",
      value: cupsText(card, goal),
      changeMessage: "Your card: %@",
    },
    {
      key: "reward",
      label: "REWARD",
      value: `Free drink after ${goal} ${goal === 1 ? "cup" : "cups"}`,
    },
  );
  pass.auxiliaryFields.push({
    key: "announcement",
    label: "NEWS",
    value: settings.announcementText?.trim() || DEFAULT_NEWS,
    changeMessage: "%@",
  });
  pass.setBarcodes({ format: "PKBarcodeFormatQR", message: card.serial, messageEncoding: "iso-8859-1" });

  for (const [name, data] of Object.entries(assets())) pass.addBuffer(name, data);
  for (const scale of [1, 2, 3] as const) {
    pass.addBuffer(scale === 1 ? "strip.png" : `strip@${scale}x.png`, await drawStrip(stripCups, goal, scale));
  }

  return pass.getAsBuffer();
}
