/**
 * utils/userMapping.ts — Map Slack user IDs to GitLab user IDs.
 *
 * Strategy (in order):
 * 1. Check SLACK_TO_GITLAB_MAP env var for explicit username mappings
 * 2. Look up Slack user's email via users.info API
 * 3. Search GitLab for user by email via REST API
 * 4. Return GitLab user IDs for MR reviewer assignment
 *
 * Designed to fail gracefully — if a mapping can't be resolved for
 * a particular Slack user, that user is skipped (with a warning log)
 * rather than failing the entire pipeline.
 */

import type { WebClient } from "@slack/web-api";
import { CONFIG } from "../config.js";
import { createLogger } from "./logger.js";

const log = createLogger("UserMapping");

/** Parsed entry from SLACK_TO_GITLAB_MAP env var. */
interface ExplicitMapping {
  slackUserId: string;
  gitlabUsername: string;
}

/**
 * Parse the SLACK_TO_GITLAB_MAP env var.
 *
 * Format: "U02LCL1JGVD:george.username,U0ANOTHER:other.user"
 * Returns an array of { slackUserId, gitlabUsername } entries.
 */
function parseExplicitMappings(): ExplicitMapping[] {
  const raw = process.env.SLACK_TO_GITLAB_MAP?.trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [slackUserId, gitlabUsername] = pair.split(":");
      if (!slackUserId || !gitlabUsername) {
        log.warn("Invalid SLACK_TO_GITLAB_MAP entry (expected SLACK_ID:gitlab_username)", { pair });
        return null;
      }
      return { slackUserId: slackUserId.trim(), gitlabUsername: gitlabUsername.trim() };
    })
    .filter((entry): entry is ExplicitMapping => entry !== null);
}

/**
 * Look up a GitLab user ID by username via the GitLab REST API.
 * Returns the user ID or null if not found.
 */
async function getGitLabUserIdByUsername(username: string): Promise<number | null> {
  const url = `${CONFIG.gitlab.host}/api/v4/users?username=${encodeURIComponent(username)}`;

  try {
    const response = await fetch(url, {
      headers: { "PRIVATE-TOKEN": CONFIG.gitlab.token },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn("GitLab user lookup by username failed", {
        username,
        status: response.status,
      });
      return null;
    }

    const users = (await response.json()) as Array<{ id: number; username: string }>;
    if (users.length === 0) {
      log.warn("No GitLab user found for username", { username });
      return null;
    }

    return users[0].id;
  } catch (err) {
    log.error("GitLab user lookup threw", { username, error: String(err) });
    return null;
  }
}

/**
 * Look up a GitLab user ID by email via the GitLab REST API.
 * Returns the user ID or null if not found.
 */
async function getGitLabUserIdByEmail(email: string): Promise<number | null> {
  const url = `${CONFIG.gitlab.host}/api/v4/users?search=${encodeURIComponent(email)}`;

  try {
    const response = await fetch(url, {
      headers: { "PRIVATE-TOKEN": CONFIG.gitlab.token },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn("GitLab user lookup by email failed", {
        email,
        status: response.status,
      });
      return null;
    }

    const users = (await response.json()) as Array<{ id: number; email?: string }>;
    // The search endpoint is fuzzy — verify the email matches
    const match = users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (!match) {
      log.warn("No exact GitLab user match for email", { email, candidateCount: users.length });
      return null;
    }

    return match.id;
  } catch (err) {
    log.error("GitLab email lookup threw", { email, error: String(err) });
    return null;
  }
}

/**
 * Get a Slack user's email via the users.info API.
 * Returns the email or null if not available.
 */
async function getSlackUserEmail(
  slackClient: WebClient,
  slackUserId: string,
): Promise<string | null> {
  try {
    const result = await slackClient.users.info({ user: slackUserId });
    const email = result.user?.profile?.email;
    if (!email) {
      log.warn("Slack user has no email in profile", { slackUserId });
      return null;
    }
    return email;
  } catch (err) {
    log.error("Slack users.info failed", { slackUserId, error: String(err) });
    return null;
  }
}

/**
 * Resolve a single Slack user ID to a GitLab user ID.
 *
 * 1. Check explicit SLACK_TO_GITLAB_MAP mapping
 * 2. Look up Slack user's email, then search GitLab by email
 *
 * Returns the GitLab user ID or null if resolution fails.
 */
async function resolveOneUser(
  slackClient: WebClient,
  slackUserId: string,
  explicitMappings: ExplicitMapping[],
): Promise<number | null> {
  // Strategy 1: Explicit mapping via env var
  const explicit = explicitMappings.find((m) => m.slackUserId === slackUserId);
  if (explicit) {
    log.info("Found explicit mapping", {
      slackUserId,
      gitlabUsername: explicit.gitlabUsername,
    });
    const gitlabId = await getGitLabUserIdByUsername(explicit.gitlabUsername);
    if (gitlabId !== null) {
      return gitlabId;
    }
    log.warn("Explicit mapping username not found in GitLab, trying email fallback", {
      slackUserId,
      gitlabUsername: explicit.gitlabUsername,
    });
    // Fall through to email strategy
  }

  // Strategy 2: Slack email -> GitLab email lookup
  const email = await getSlackUserEmail(slackClient, slackUserId);
  if (email) {
    log.info("Attempting GitLab lookup by email", { slackUserId, email });
    const gitlabId = await getGitLabUserIdByEmail(email);
    if (gitlabId !== null) {
      return gitlabId;
    }
  }

  log.warn("Could not resolve Slack user to GitLab user", { slackUserId });
  return null;
}

/**
 * Map an array of Slack user IDs to GitLab user IDs.
 *
 * Uses a two-tier strategy:
 * 1. Explicit SLACK_TO_GITLAB_MAP env var (fast, reliable)
 * 2. Slack email -> GitLab email lookup (automatic, requires matching emails)
 *
 * Users that cannot be resolved are silently dropped (with a warning log).
 * Returns an array of GitLab user IDs ready for MR assignment.
 */
export async function resolveGitLabReviewers(
  slackClient: WebClient,
  slackUserIds: string[],
): Promise<number[]> {
  if (slackUserIds.length === 0) return [];

  log.info("Resolving GitLab reviewers", { slackUserIds });

  const explicitMappings = parseExplicitMappings();

  const results = await Promise.all(
    slackUserIds.map((id) => resolveOneUser(slackClient, id, explicitMappings)),
  );

  const resolved = results.filter((id): id is number => id !== null);

  log.info("Reviewer resolution complete", {
    requested: slackUserIds.length,
    resolved: resolved.length,
    gitlabUserIds: resolved,
  });

  return resolved;
}
