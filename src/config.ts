import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  PASS_TYPE_ID: z.string().min(1),
  APPLE_TEAM_ID: z.string().min(1),
  PASS_CERT_PATH: z.string().min(1),
  PASS_KEY_PATH: z.string().min(1),
  PASS_KEY_PASSPHRASE: z.string().optional(),
  WWDR_CERT_PATH: z.string().min(1),
  SHOP_NAME: z.string().min(1).default("Coffee Shop"),
  APNS_HOST: z.string().url().default("https://api.push.apple.com"),
  PIN_PEPPER: z.string().min(16, "must be at least 16 characters"),
  SESSION_SECRET: z.string().min(16, "must be at least 16 characters"),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8, "must be at least 8 characters"),
  DEFAULT_PHONE_REGION: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase())
    .default("EG"),
});

export type Config = z.infer<typeof schema>;

/** Reads and checks the environment. Throws one readable message listing everything wrong. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value in .env (e.g. `PASS_KEY_PASSPHRASE=`) counts as not set.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration. Fix these environment variables:\n${lines.join("\n")}`);
  }
  return result.data;
}
