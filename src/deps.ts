import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { PushSender } from "./wallet/push.js";

/** Everything the routes need, passed in so tests can supply their own. */
export interface AppDeps {
  config: Config;
  db: Db;
  /** Sends the push that wakes phones. Defaults to Apple's push service using the configured certificate. */
  push?: PushSender;
  /** Turn request logging on or off (off in tests). */
  logger?: boolean;
  /** How many login attempts one address may make per minute before getting 429. */
  loginRateLimitMax?: number;
  /** How many sign-ups one address may make per minute before getting 429. */
  joinRateLimitMax?: number;
}

/** The deps once defaults are filled in: what the routes receive. */
export type ReadyDeps = AppDeps & { push: PushSender };
