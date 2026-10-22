import { createHmac } from "node:crypto";

const PIN_PATTERN = /^[0-9]{6}$/;

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

/**
 * HMAC-SHA256 of the PIN with a secret pepper that lives outside the database.
 * The same PIN always gives the same value, so a PIN alone finds its barista in one lookup.
 */
export function hashPin(pin: string, pepper: string): string {
  if (!isValidPin(pin)) throw new Error("A PIN must be exactly six digits");
  return createHmac("sha256", pepper).update(pin).digest("hex");
}
