/**
 * utils/reviewerCache.ts — Caches the list of potential reviewers from
 * a configured list of Slack user IDs (REVIEWER_USER_IDS env var).
 *
 * On first call (or after TTL expiry), resolves display names via
 * the Slack API, filters out bots, and caches the result for 30 minutes.
 *
 * If REVIEWER_USER_IDS is not configured, returns null — callers should
 * fall back to the standard multi_users_select element.
 */

import type { WebClient } from "@slack/web-api";
import { CONFIG } from "../config.js";
import { createLogger } from "./logger.js";

const log = createLogger("ReviewerCache");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewerInfo {
  slackId: string;
  displayName: string;
}

// ─── Cache state ─────────────────────────────────────────────────────────────

let cachedReviewers: ReviewerInfo[] = [];
let lastFetched = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the cached reviewer list, refreshing if stale.
 * Returns null when REVIEWER_USER_IDS is not configured (caller should
 * fall back to multi_users_select).
 */
export async function getReviewers(
  client: WebClient,
): Promise<ReviewerInfo[] | null> {
  if (!CONFIG.reviewerUserIds || CONFIG.reviewerUserIds.length === 0) {
    return null;
  }

  // `lastFetched > 0` (not `cachedReviewers.length > 0`) marks a completed
  // fetch, so an empty result (all lookups failed / filtered) is cached too
  // instead of re-hitting users.info for every ID on each modal open.
  const now = Date.now();
  if (lastFetched > 0 && now - lastFetched < CACHE_TTL) {
    return cachedReviewers;
  }

  await refreshReviewers(client);
  return cachedReviewers;
}

/**
 * Force-refresh the reviewer cache from Slack.
 */
export async function refreshReviewers(client: WebClient): Promise<void> {
  const userIds = CONFIG.reviewerUserIds;
  if (!userIds || userIds.length === 0) return;

  log.info("Refreshing reviewer list", { count: userIds.length });

  try {
    const reviewers: ReviewerInfo[] = [];

    for (const userId of userIds) {
      try {
        const info = await client.users.info({ user: userId });
        const user = info.user;
        if (!user || user.is_bot || user.id === "USLACKBOT") continue;

        const displayName =
          user.profile?.display_name ||
          user.profile?.real_name ||
          user.real_name ||
          user.name ||
          userId;

        reviewers.push({ slackId: userId, displayName });
      } catch (err) {
        log.warn("Failed to fetch user info", {
          userId,
          error: String(err),
        });
      }
    }

    // Sort alphabetically by display name
    reviewers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    cachedReviewers = reviewers;
    lastFetched = Date.now();

    log.info("Reviewer cache refreshed", { count: reviewers.length });
  } catch (err) {
    log.error("Failed to refresh reviewer cache", { error: String(err) });
  }
}
