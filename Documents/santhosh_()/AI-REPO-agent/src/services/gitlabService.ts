/**
 * services/gitlabService.ts — GitLab MR creation.
 *
 * Primary: glab CLI via async execFile.
 * Fallback: Node native fetch() to GitLab REST API.
 *
 * Description is passed via temp file to glab to avoid
 * shell escaping issues with complex markdown.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CONFIG } from "../config.js";
import type { MrInput, MrResult } from "../types.js";

const execFileAsync = promisify(execFile);
const MR_TIMEOUT = 30_000; // 30 seconds

/**
 * Create a GitLab merge request.
 *
 * Tries glab CLI first. If that fails, falls back to the
 * GitLab REST API via fetch().
 */
export async function createMergeRequest(input: MrInput): Promise<MrResult> {
  try {
    return await createViaGlab(input);
  } catch (glabErr) {
    console.warn("[GitLab] glab CLI failed, falling back to REST API:", glabErr);
    return await createViaApi(input);
  }
}

// ─── glab CLI ─────────────────────────────────────────────────────────────────

async function createViaGlab(input: MrInput): Promise<MrResult> {
  const { branchName, title, description, reviewerIds } = input;

  // Write description to temp file to avoid shell escaping hell
  const tmpDesc = path.join(
    os.tmpdir(),
    `ecr-mr-desc-${Date.now()}.md`
  );
  await fs.writeFile(tmpDesc, description, "utf-8");

  try {
    // Build args — append --reviewer-id flags for each reviewer
    const args = [
      "mr",
      "create",
      "--source-branch", branchName,
      "--target-branch", CONFIG.repo.baseBranch,
      "--title", title,
      "--description", `$(cat "${tmpDesc}")`,
      "--no-editor",
      "--yes",
    ];

    if (reviewerIds && reviewerIds.length > 0) {
      for (const id of reviewerIds) {
        args.push("--reviewer-id", String(id));
      }
    }

    const { stdout } = await execFileAsync(
      "glab",
      args,
      {
        cwd: CONFIG.repo.root,
        timeout: MR_TIMEOUT,
        env: {
          ...process.env,
          GITLAB_TOKEN: CONFIG.gitlab.token,
          GITLAB_HOST: CONFIG.gitlab.host,
        },
      }
    );

    const urlMatch = stdout.match(/(https?:\/\/[^\s]+merge_requests\/\d+)/);
    const iidMatch = stdout.match(/!(\d+)/);

    return {
      url: urlMatch?.[1] || `${CONFIG.gitlab.host}/merge_requests`,
      iid: parseInt(iidMatch?.[1] || "0"),
    };
  } finally {
    try {
      await fs.unlink(tmpDesc);
    } catch {
      // Best effort
    }
  }
}

// ─── REST API fallback ────────────────────────────────────────────────────────

async function createViaApi(input: MrInput): Promise<MrResult> {
  const { branchName, title, description, reviewerIds } = input;
  const url = `${CONFIG.gitlab.host}/api/v4/projects/${encodeURIComponent(CONFIG.gitlab.projectId)}/merge_requests`;

  const body: Record<string, unknown> = {
    source_branch: branchName,
    target_branch: CONFIG.repo.baseBranch,
    title,
    description,
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
    const body = await response.text();
    throw new Error(`GitLab API returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { web_url: string; iid: number };
  return {
    url: data.web_url,
    iid: data.iid,
  };
}
