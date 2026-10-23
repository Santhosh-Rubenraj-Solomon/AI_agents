/**
 * utils/redact.ts — Keep secrets out of logs, Slack messages and child processes.
 *
 * Two concerns:
 *   1. redactSecrets(): scrubs known secret values (the configured Slack /
 *      GitLab tokens) and common token shapes (xoxb-, xapp-, glpat-,
 *      credentials embedded in URLs) from any text before it is logged or
 *      posted to Slack. Error messages from git/glab/fetch can echo remote
 *      URLs or response bodies that contain credentials.
 *   2. scrubbedEnv(): builds an environment for child processes that run
 *      LLM-written or LLM-driven code (Claude CLI, nx lint/test, the review
 *      CLI) without the bot's Slack / GitLab credentials.
 *
 * Reads secrets from process.env directly (not CONFIG) so it can be used
 * by the logger without creating an import cycle with config.ts.
 */

/** Env vars that hold this app's own credentials. */
export const SECRET_ENV_VARS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "GITLAB_TOKEN",
] as const;

const REDACTED = "[REDACTED]";

/** Token shapes that should never appear in logs or Slack, whatever their source. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bxox[abprs]-[A-Za-z0-9-]+/g,      // Slack bot/user/refresh tokens
  /\bxapp-[A-Za-z0-9-]+/g,            // Slack app-level tokens
  /\bglpat-[A-Za-z0-9_-]{8,}/g,       // GitLab personal access tokens
  /\bgl(?:oas|dt|rt|cbt|ptt|ft)-[A-Za-z0-9_-]{8,}/g, // other GitLab token prefixes
];

/** Credentials embedded in URLs, e.g. https://oauth2:TOKEN@gitlab.example.com */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/** PRIVATE-TOKEN / Authorization header values echoed in error output. */
const AUTH_HEADERS = /\b(PRIVATE-TOKEN|Authorization)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi;

function configuredSecrets(): string[] {
  return SECRET_ENV_VARS
    .map((k) => process.env[k])
    .filter((v): v is string => typeof v === "string" && v.length >= 6);
}

/**
 * Replace secrets in `text` with "[REDACTED]".
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of configuredSecrets()) {
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(AUTH_HEADERS, `$1$2${REDACTED}`);
  return out;
}

/**
 * Deep-redact string values inside a JSON-serialisable value (e.g. Slack
 * blocks). Non-string leaves are returned unchanged.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/**
 * A copy of process.env (plus `extra`) without this app's credentials.
 * Use for every child process that executes code we did not write.
 */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SECRET_ENV_VARS) delete env[key];
  return { ...env, ...extra };
}
