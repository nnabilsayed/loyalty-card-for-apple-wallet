import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

/** The Pass Type ID certificate lasts about a year. When it expires, passes silently stop updating. */
export const WARN_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

export interface ExpiryLogger {
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface ExpiryStatus {
  level: "ok" | "warn" | "expired";
  daysLeft: number;
  expires: Date;
}

/** Whole days until the certificate expires (negative once it has). */
export function certDaysLeft(certPath: string, now: Date = new Date()): number {
  return expiryOf(certPath, now).daysLeft;
}

function expiryOf(certPath: string, now: Date): { daysLeft: number; expires: Date } {
  let pem: Buffer;
  try {
    pem = readFileSync(certPath);
  } catch (err) {
    throw new Error(`Cannot read the pass certificate at ${certPath}: ${(err as Error).message}`, { cause: err });
  }
  const expires = new Date(new X509Certificate(pem).validTo);
  return { daysLeft: Math.floor((expires.getTime() - now.getTime()) / DAY_MS), expires };
}

/** Logs a warning inside the warning window and an error once expired. */
export function checkCertExpiry(certPath: string, log: ExpiryLogger, now: Date = new Date()): ExpiryStatus {
  const { daysLeft, expires } = expiryOf(certPath, now);
  if (expires.getTime() <= now.getTime()) {
    log.error({ expires: expires.toISOString() }, "The pass certificate has expired: passes cannot be signed or updated. Renew it in the Apple Developer portal.");
    return { level: "expired", daysLeft, expires };
  }
  if (daysLeft <= WARN_DAYS) {
    log.warn({ daysLeft, expires: expires.toISOString() }, `The pass certificate expires in ${daysLeft} days. Renew it in the Apple Developer portal.`);
    return { level: "warn", daysLeft, expires };
  }
  return { level: "ok", daysLeft, expires };
}

/** Checks now and then once a day. The timer does not keep the process alive. */
export function watchCertExpiry(certPath: string, log: ExpiryLogger): NodeJS.Timeout {
  const run = () => {
    try {
      checkCertExpiry(certPath, log);
    } catch (err) {
      log.error({ err: (err as Error).message }, "Could not check the pass certificate expiry");
    }
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}
