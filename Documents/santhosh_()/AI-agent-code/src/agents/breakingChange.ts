/**
 * agents/breakingChange.ts — Breaking change detection agent.
 *
 * Analyzes git diffs and codebase changes to detect breaking changes
 * across API contracts, database schemas, message bus contracts,
 * and cross-service dependencies.
 */

import { askAI } from "../services/aiEngine.js";
import {
  getRecentDiff,
  getChangedFiles,
  getRecentCommits
} from "../services/github.js";
import { readRepoFile } from "../services/techDetector.js";
import { createLogger } from "../utils/logger.js";
import {
  parseAIJson,
  BreakingChangeResultSchema,
  type TechProfile,
  type BreakingChangeResult,
  type AgentResult
} from "../schemas.js";

const log = createLogger("BreakingChange");

/**
 * Detect breaking changes in the last N commits.
 */
export async function detectBreakingChanges(
  repoPath: string,
  profile: TechProfile,
  commits: number = 5
): Promise<AgentResult<BreakingChangeResult>> {
  log.info("Detecting breaking changes", { path: repoPath, commits });

  try {
    const diff = await getRecentDiff(repoPath, commits);
    const changedFiles = await getChangedFiles(repoPath, commits);
    const commitLog = await getRecentCommits(repoPath, commits);

    if (!diff && changedFiles.length === 0) {
      return {
        success: true,
        message: "No changes detected in the specified commit range.",
        data: {
          riskLevel: "LOW",
          changeType: ["None"],
          affectedConsumers: [],
          findings: [],
          recommendations: ["No changes detected."],
          checklist: {
            dtosChecked: true,
            enumsChecked: true,
            typesChecked: true,
            defaultsChecked: true,
            databaseChecked: true,
            messagesChecked: true,
            consumersChecked: true,
            rollbackChecked: true
          }
        }
      };
    }

    // Read changed files content for context
    const changedFileContents: string[] = [];
    for (const file of changedFiles.slice(0, 15)) {
      const content = readRepoFile(repoPath, file);
      if (content) {
        changedFileContents.push(`=== ${file} ===\n${content.slice(0, 2000)}`);
      }
    }

    const prompt = `You are an expert software architect performing a breaking change analysis on a codebase.

## Codebase Context
- Languages: ${profile.languages
      .map((l) => `${l.name} (${l.percentage}%)`)
      .join(", ")}
- Frameworks: ${profile.frameworks.join(", ") || "none"}
- Architecture: ${profile.architecture}
- Databases: ${profile.databases.join(", ") || "none"}

## Recent Commits
${commitLog}

## Changed Files (${changedFiles.length} files)
${changedFiles.join("\n")}

## Git Diff
${diff.slice(0, 15000)}

## Changed File Contents
${changedFileContents.join("\n\n").slice(0, 10000)}

## Breaking Change Categories to Check

### 1. API Contract Changes (HTTP/gRPC)
- Request/Response DTOs: Adding required fields, removing fields, changing types, renaming fields
- Endpoint signatures: Path changes, method changes, query param changes
- Response structures: Nested object changes, array item type changes, nullability changes
- Status codes: New error responses, removed success codes

### 2. Database Schema Changes
- Column changes: Dropping columns, changing types, removing constraints, renaming
- Table changes: Table drops, partitioning changes, index removals
- Migration safety: Check for irreversible migrations
- Downstream SQL: Services running direct SQL against tables

### 3. Message Bus Contracts
- Message patterns: Changes to message types, routing keys, queue names
- Payload contracts: DTO changes for events/commands
- Consumer impact: Downstream services listening to changed events

### 4. Cross-Service Dependencies
- Library exports: Changes to public APIs
- Shared contracts: Interface changes affecting multiple services
- Internal service calls: Service-to-service DTO changes

## Common Breaking Patterns
| Change | Breaking? | Mitigation |
|--------|-----------|------------|
| Add required field to DTO | YES | Make optional with default |
| Remove field from response | YES | Deprecate first |
| Rename column in DB | YES | Create alias, dual-write |
| Change enum string values | YES | Add new, deprecate old |
| Narrow type (string→union) | YES | Keep wider type |
| Add new endpoint | No | Safe with versioning |
| Add optional field | No | Ensure nullable handling |

Respond ONLY with valid JSON (no markdown fences):
{
  "riskLevel": "LOW|MEDIUM|HIGH|BREAKING",
  "changeType": ["API", "Database", "Message", "Library", "Config", "None"],
  "affectedConsumers": ["list of services/libraries/consumers affected"],
  "findings": [
    { "file": "path/to/file", "change": "description of change", "breaking": true, "impact": "who/what is affected" }
  ],
  "recommendations": ["specific action to mitigate"],
  "checklist": {
    "dtosChecked": true,
    "enumsChecked": true,
    "typesChecked": true,
    "defaultsChecked": true,
    "databaseChecked": true,
    "messagesChecked": true,
    "consumersChecked": true,
    "rollbackChecked": true
  }
}`;

    const raw = await askAI(prompt, repoPath);
    const result = parseAIJson(raw, BreakingChangeResultSchema);

    log.info("Breaking change analysis complete", {
      riskLevel: result.riskLevel,
      findings: result.findings.length,
      breaking: result.findings.filter((f) => f.breaking).length
    });

    return {
      success: true,
      message: `Risk: ${result.riskLevel} — ${
        result.findings.length
      } findings (${
        result.findings.filter((f) => f.breaking).length
      } breaking)`,
      data: result
    };
  } catch (err) {
    const error = err as Error;
    log.error("Breaking change detection failed", { error: error.message });
    return {
      success: false,
      message: `Breaking change detection failed: ${error.message}`,
      error: error.message
    };
  }
}
