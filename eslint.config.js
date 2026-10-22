import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "coverage/", "web/**/*.bundle.js", "tests/.certs/", "tests/.pgdata/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web/**/*.js"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly", fetch: "readonly", navigator: "readonly", location: "readonly", console: "readonly", URL: "readonly", URLSearchParams: "readonly", FormData: "readonly", setTimeout: "readonly", clearTimeout: "readonly", crypto: "readonly" },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
