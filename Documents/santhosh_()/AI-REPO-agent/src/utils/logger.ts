/**
 * utils/logger.ts -- Simple structured logger with color-coded levels.
 *
 * No external dependencies. Wraps console.log/console.error with:
 *   - ISO timestamp
 *   - Component/phase prefix
 *   - Color coding (via ANSI escape codes)
 *   - Log levels: debug, info, warn, error
 *
 * Every line is passed through redactSecrets() so tokens echoed in error
 * messages (git remote URLs, GitLab API bodies, ...) never reach the logs.
 *
 * Usage:
 *   import { createLogger } from "../utils/logger.js";
 *   const log = createLogger("Coordinator");
 *   log.info("Pipeline started", { taskId: "abc123" });
 */

import { redactSecrets } from "./redact.js";

// ─── ANSI color codes ────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const COLORS = {
  debug: "\x1b[36m",   // cyan
  info: "\x1b[32m",    // green
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
} as const;

const LEVEL_LABELS = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
} as const;

type LogLevel = keyof typeof COLORS;

// ─── Env-based log level filtering ───────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Unknown values (e.g. a typo like "warning") fall back to "debug" instead
// of silently disabling all logging.
const envLevel = process.env.LOG_LEVEL?.toLowerCase();
const MIN_LEVEL: LogLevel =
  envLevel && envLevel in LEVEL_PRIORITY ? (envLevel as LogLevel) : "debug";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return "";
  const parts = Object.entries(extra).map(([k, v]) => {
    if (typeof v === "string") return `${k}="${v}"`;
    return `${k}=${JSON.stringify(v)}`;
  });
  return ` ${DIM}${parts.join(" ")}${RESET}`;
}

// ─── Logger interface ────────────────────────────────────────────────────────

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * Create a logger scoped to a component name.
 *
 * @param component - Name shown in brackets, e.g. "Coordinator", "Git", "Coder"
 */
export function createLogger(component: string): Logger {
  function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const color = COLORS[level];
    const label = LEVEL_LABELS[level];
    const ts = formatTimestamp();
    const extraStr = formatExtra(extra);

    const line = redactSecrets(
      `${DIM}${ts}${RESET} ${color}${BOLD}${label}${RESET} ${color}[${component}]${RESET} ${message}${extraStr}`
    );

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}
