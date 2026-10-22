import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";

const here = dirname(fileURLToPath(import.meta.url));
export const testCertDir = resolve(here, "..", ".certs");

export interface TestCerts {
  /** Stands in for Apple's WWDR intermediate certificate. */
  wwdrPath: string;
  /** Stands in for the Pass Type ID certificate. */
  certPath: string;
  keyPath: string;
}

function makeCert(
  subject: string,
  publicKey: forge.pki.PublicKey,
  signingKey: forge.pki.rsa.PrivateKey,
  issuer: string,
  isCa: boolean,
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: subject }]);
  cert.setIssuer([{ name: "commonName", value: issuer }]);
  cert.setExtensions([{ name: "basicConstraints", cA: isCa }]);
  cert.sign(signingKey, forge.md.sha256.create());
  return cert;
}

/**
 * Throwaway certificates for tests, so nothing needs Apple's real ones. They live in
 * tests/.certs/ (git-ignored) and are only created if missing.
 */
export function ensureTestCerts(): TestCerts {
  const wwdrPath = join(testCertDir, "wwdr.pem");
  const certPath = join(testCertDir, "pass.pem");
  const keyPath = join(testCertDir, "pass.key");

  if (!existsSync(wwdrPath) || !existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(testCertDir, { recursive: true });
    const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const ca = makeCert("Test WWDR CA", caKeys.publicKey, caKeys.privateKey, "Test WWDR CA", true);
    const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const leaf = makeCert("Pass Type ID: pass.test.loyalty", leafKeys.publicKey, caKeys.privateKey, "Test WWDR CA", false);
    writeFileSync(wwdrPath, forge.pki.certificateToPem(ca));
    writeFileSync(certPath, forge.pki.certificateToPem(leaf));
    writeFileSync(keyPath, forge.pki.privateKeyToPem(leafKeys.privateKey));
  }
  return { wwdrPath, certPath, keyPath };
}
