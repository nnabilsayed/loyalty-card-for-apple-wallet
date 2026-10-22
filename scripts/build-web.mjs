import { build } from "esbuild";

// Bundles the staff page's script together with the QR scanner library into one file.
await build({
  entryPoints: ["web/staff/staff.js"],
  outfile: "web/staff/staff.bundle.js",
  bundle: true,
  format: "esm",
  target: ["safari15", "chrome100"],
  minify: true,
  sourcemap: false,
  logLevel: "info",
});
