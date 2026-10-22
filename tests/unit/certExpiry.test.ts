import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { describe, expect, test, vi } from "vitest";
import { WARN_DAYS, certDaysLeft, checkCertExpiry } from "../../src/wallet/certExpiry.js";
import { ensureTestCerts } from "../helpers/certs.js";

const DAY = 24 * 3600 * 1000;

/** A throwaway self-signed certificate that expires `days` from `now` (can be negative). */
function certExpiringIn(days: number, now: Date): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(now.getTime() - 400 * DAY);
  cert.validity.notAfter = new Date(now.getTime() + days * DAY);
  cert.setSubject([{ name: "commonName", value: "expiry test" }]);
  cert.setIssuer([{ name: "commonName", value: "expiry test" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const dir = mkdtempSync(join(tmpdir(), "cert-expiry-"));
  const path = join(dir, "pass.pem");
  writeFileSync(path, forge.pki.certificateToPem(cert));
  return path;
}

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("certificate expiry", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  test("the warning window is 30 days", () => {
    expect(WARN_DAYS).toBe(30);
  });

  test("counts the whole days left", () => {
    // Certificates store whole seconds, so a day count can land one below the exact figure.
    expect([299, 300]).toContain(certDaysLeft(certExpiringIn(300, now), now));
    expect(certDaysLeft(certExpiringIn(10.5, now), now)).toBe(10);
  });

  test("a certificate far from expiring is fine and logs nothing", () => {
    const log = logger();
    const result = checkCertExpiry(certExpiringIn(300, now), log, now);
    expect(result.level).toBe("ok");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  test("within 30 days it warns, saying how many days are left", () => {
    const log = logger();
    const result = checkCertExpiry(certExpiringIn(12.5, now), log, now);
    expect(result).toMatchObject({ level: "warn", daysLeft: 12 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).toContain("12");
    expect(log.error).not.toHaveBeenCalled();
  });

  test("exactly 30 days left already warns", () => {
    const result = checkCertExpiry(certExpiringIn(30.2, now), logger(), now);
    expect(result.level).toBe("warn");
  });

  test("an expired certificate is an error, because passes stop updating", () => {
    const log = logger();
    const result = checkCertExpiry(certExpiringIn(-2, now), log, now);
    expect(result.level).toBe("expired");
    expect(result.daysLeft).toBeLessThan(0);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  test("works on the test certificate the suite signs with", () => {
    const { certPath } = ensureTestCerts();
    expect(certDaysLeft(certPath)).toBeGreaterThan(30);
  });

  test("a missing file gives a readable error", () => {
    expect(() => certDaysLeft("D:/no/such/pass.pem")).toThrow(/pass certificate/i);
  });
});
