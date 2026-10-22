import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import forge from "node-forge";

export interface PassField {
  key: string;
  label?: string;
  value: string;
  changeMessage?: string;
}

export interface PassJson {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;
  webServiceURL: string;
  authenticationToken: string;
  barcodes?: { format: string; message: string; messageEncoding: string }[];
  storeCard: Record<string, PassField[] | undefined>;
}

export interface ReadPass {
  files: Record<string, Buffer>;
  passJson: PassJson;
}

/** Unzips a .pkpass and parses its pass.json. */
export function readPkpass(buf: Buffer): ReadPass {
  const raw = unzipSync(new Uint8Array(buf));
  const files: Record<string, Buffer> = {};
  for (const [name, data] of Object.entries(raw)) files[name] = Buffer.from(data);
  if (!files["pass.json"]) throw new Error("pass.json is missing");
  return { files, passJson: JSON.parse(files["pass.json"].toString("utf8")) };
}

/** Checks manifest.json lists every file once with the right SHA-1, and nothing else is in the pass. */
export function checkManifest(files: Record<string, Buffer>): string[] {
  const problems: string[] = [];
  if (!files["manifest.json"]) return ["manifest.json is missing"];
  const manifest: Record<string, string> = JSON.parse(files["manifest.json"].toString("utf8"));
  for (const [name, data] of Object.entries(files)) {
    if (name === "manifest.json" || name === "signature") continue;
    const expected = createHash("sha1").update(data).digest("hex");
    if (manifest[name] !== expected) problems.push(`hash of ${name} does not match the manifest`);
  }
  for (const name of Object.keys(manifest)) {
    if (!files[name]) problems.push(`${name} is in the manifest but not in the pass`);
  }
  return problems;
}

const OID_SHA1 = "1.3.14.3.2.26";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";

function digestFor(oid: string) {
  if (oid === OID_SHA1) return { name: "sha1", md: forge.md.sha1 };
  if (oid === OID_SHA256) return { name: "sha256", md: forge.md.sha256 };
  throw new Error(`Unsupported digest algorithm ${oid}`);
}

/**
 * Verifies the detached PKCS#7 signature over manifest.json against the signing certificate:
 * the signed message-digest attribute matches the manifest, and the RSA signature over the signed
 * attributes verifies with the certificate's public key. Returns a list of problems (empty = valid).
 */
export function verifySignature(manifest: Buffer, signature: Buffer, signerCertPem: string): string[] {
  const problems: string[] = [];
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(signature.toString("binary")));
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as unknown as {
    rawCapture: { signerInfos?: forge.asn1.Asn1 | forge.asn1.Asn1[] };
  };
  const captured = p7.rawCapture.signerInfos;
  const signerInfo = Array.isArray(captured) ? captured[0] : captured;
  if (!signerInfo) return ["The signature has no signer"];

  const parts = signerInfo.value as forge.asn1.Asn1[];
  const digestAlgorithm = parts[2]!.value as forge.asn1.Asn1[];
  const digestOid = forge.asn1.derToOid(digestAlgorithm[0]!.value as string);
  const attrs = parts[3]!;
  const signatureBytes = parts[parts.length - 1]!.value as string;
  const { md } = digestFor(digestOid);

  // The signed attributes must carry the digest of manifest.json.
  const attrList = attrs.value as forge.asn1.Asn1[];
  const digestAttr = attrList.find((a) => forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0]!.value as string) === OID_MESSAGE_DIGEST);
  if (!digestAttr) {
    problems.push("The signed attributes have no message digest");
  } else {
    const signed = ((digestAttr.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!.value as string;
    const actual = md.create().update(manifest.toString("binary")).digest().getBytes();
    if (signed !== actual) problems.push("The signed digest does not match manifest.json");
  }

  // The RSA signature covers the signed attributes, re-encoded as a SET.
  const asSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs.value as forge.asn1.Asn1[]);
  const toVerify = md.create().update(forge.asn1.toDer(asSet).getBytes()).digest().getBytes();
  const cert = forge.pki.certificateFromPem(signerCertPem);
  const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
  if (!publicKey.verify(toVerify, signatureBytes)) problems.push("The RSA signature does not verify");
  return problems;
}
