/**
 * services/gitlabService.ts — GitLab MR creation.
 *
 * Primary: glab CLI via async execFile (argument array, no shell).
 * Fallback: Node native fetch() to GitLab REST API.
 *
 * Values are passed as `--flag=value` so a title or description that
 * starts with "-" can never be parsed as another flag. Errors are
 * redacted before they are thrown/logged because they can echo the
 * GitLab response body or the token-bearing environment.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG, assertValidBranchName } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { redactSecrets } from "../utils/redact.js";
import type { MrInput, MrResult } from "../types.js";

const execFileAsync = promisify(execFile);
const MR_TIMEOUT = 30_000; // 30 seconds

/**
 * Keep the description comfortably below the per-argument limit of
 * execve (MAX_ARG_STRLEN is 128 KiB on Linux). MR descriptions this long
 * are never useful anyway.
 */
const MAX_DESCRIPTION_LEN = 100_000;

const log = createLogger("GitLab");

function truncateDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_LEN) return description;
  return description.slice(0, MAX_DESCRIPTION_LEN) + "\n\n_...description truncated_";
}

/**
 * Create a GitLab merge request.
 *
 * Tries glab CLI first. If that fails, falls back to the
 * GitLab REST API via fetch().
 */
export async function createMergeRequest(input: MrInput): Promise<MrResult> {
  assertValidBranchName(input.branchName);
  try {
    return await createViaGlab(input);
  } catch (glabErr) {
    log.warn("glab CLI failed, falling back to REST API", {
      error: glabErr instanceof Error ? glabErr.message : String(glabErr),
    });
    return await createViaApi(input);
  }
}

// ─── glab CLI ─────────────────────────────────────────────────────────────────

/**
 * Build the glab argument list. Exported for tests.
 */
export function buildGlabArgs(input: MrInput): string[] {
  const { branchName, title, description, reviewerIds } = input;

  // execFile does not use a shell, so the description is passed verbatim.
  // (The previous `$(cat file)` argument was sent to GitLab literally.)
  const args = [
    "mr",
    "create",
    `--source-branch=${branchName}`,
    `--target-branch=${CONFIG.repo.baseBranch}`,
    `--title=${title}`,
    `--description=${truncateDescription(description)}`,
    "--no-editor",
    "--yes",
  ];

  for (const id of reviewerIds ?? []) {
    if (Number.isInteger(id) && id > 0) args.push(`--reviewer-id=${id}`);
  }
  return args;
}

async function createViaGlab(input: MrInput): Promise<MrResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("glab", buildGlabArgs(input), {
      cwd: CONFIG.repo.root,
      timeout: MR_TIMEOUT,
      env: {
        ...process.env,
        GITLAB_TOKEN: CONFIG.gitlab.token,
        GITLAB_HOST: CONFIG.gitlab.host,
      },
    }));
  } catch (err: unknown) {
    // The default execFile error message embeds the full command line
    // (including the whole MR description) — keep it short and redacted.
    const e = err as { code?: unknown; stderr?: string; message?: string };
    const detail = String(e.stderr || e.message || "unknown error").slice(0, 1000);
    throw new Error(redactSecrets(`glab mr create failed (${String(e.code ?? "error")}): ${detail}`));
  }

  const urlMatch = stdout.match(/(https?:\/\/[^\s]+merge_requests\/\d+)/);
  const iidMatch = stdout.match(/!(\d+)/) ?? urlMatch?.[1].match(/merge_requests\/(\d+)/);

  if (!urlMatch) {
    // Don't fall back to the API here: the MR may well have been created.
    log.warn("glab output did not contain a merge request URL", {
      output: stdout.slice(0, 500),
    });
  }

  return {
    url: urlMatch?.[1] || `${CONFIG.gitlab.host}/merge_requests`,
    iid: parseInt(iidMatch?.[1] || "0", 10),
  };
}

// ─── REST API fallback ────────────────────────────────────────────────────────

async function createViaApi(input: MrInput): Promise<MrResult> {
  const { branchName, title, description, reviewerIds } = input;
  const url = `${CONFIG.gitlab.host}/api/v4/projects/${encodeURIComponent(CONFIG.gitlab.projectId)}/merge_requests`;

  const body: Record<string, unknown> = {
    source_branch: branchName,
    target_branch: CONFIG.repo.baseBranch,
    title,
    description: truncateDescription(description),
  };

  if (reviewerIds && reviewerIds.length > 0) {
    body.reviewer_ids = reviewerIds;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": CONFIG.gitlab.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MR_TIMEOUT),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      redactSecrets(`GitLab API returned ${response.status}: ${text.slice(0, 1000)}`)
    );
  }

  const data = (await response.json()) as { web_url: string; iid: number };
  return {
    url: data.web_url,
    iid: data.iid,
  };
}
