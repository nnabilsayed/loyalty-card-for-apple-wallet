import { ensureTestCerts, testCertDir } from "../tests/helpers/certs.js";

const certs = ensureTestCerts();
console.log(`Throwaway test certificates are in ${testCertDir}`);
console.log(certs);
console.log("These are for tests only. Real passes need the certificates from the Apple Developer portal.");
