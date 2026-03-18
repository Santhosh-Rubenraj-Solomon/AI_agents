/**
 * middleware/rateLimit.ts — Per-user /ecr cooldown.
 *
 * In-memory Map<userId, lastTimestamp>. If a user fires /ecr
 * within RATE_LIMIT_SECONDS of their last invocation, they get
 * an ephemeral "please wait" response.
 */

import { CONFIG } from "../config.js";

const lastInvocation = new Map<string, number>();

export interface RateLimitCheck {
  /** Whether the user is allowed through. */
  allowed: boolean;
  /** Seconds remaining until the cooldown expires (0 if allowed). */
  retryAfterSeconds: number;
}

/**
 * Check if a user is rate-limited.
 * If allowed, records the current timestamp.
 */
export function checkRateLimit(userId: string): RateLimitCheck {
  const now = Date.now();
  const last = lastInvocation.get(userId);
  const cooldownMs = CONFIG.pipeline.rateLimitSeconds * 1000;

  if (last && now - last < cooldownMs) {
    const retryAfterSeconds = Math.ceil((cooldownMs - (now - last)) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  lastInvocation.set(userId, now);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Clear rate limit for a user (e.g., after pipeline completes).
 */
export function clearRateLimit(userId: string): void {
  lastInvocation.delete(userId);
}
