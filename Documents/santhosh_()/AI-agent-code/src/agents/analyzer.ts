/**
 * agents/analyzer.ts — Deep codebase analyzer agent.
 *
 * Phase 2: After tech detection, uses AI to deeply analyze architecture,
 * data models, API endpoints, and key components.
 */

import { askAI } from "../services/aiEngine.js";
import { getFileTree, readRepoFile } from "../services/techDetector.js";
import { createLogger } from "../utils/logger.js";
import { parseAIJson, AnalysisResultSchema } from "../schemas.js";
import type { TechProfile, AnalysisResult, AgentResult } from "../types.js";

const log = createLogger("Analyzer");

/**
 * Build context from key files in the repo for AI analysis.
 */
function gatherKeyFileContents(repoPath: string, profile: TechProfile): string {
  const sections: string[] = [];

  // Try to read entry points
  for (const entry of profile.entryPoints.slice(0, 3)) {
    const content = readRepoFile(repoPath, entry);
    if (content) {
      sections.push(`=== ${entry} ===\n${content.slice(0, 3000)}`);
    }
  }

  // Try to read common config files
  const configFiles = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "tsconfig.json",
    "nest-cli.json",
    "angular.json",
    "docker-compose.yml",
    "docker-compose.yaml"
  ];
  for (const cf of configFiles) {
    const content = readRepoFile(repoPath, cf);
    if (content) {
      sections.push(`=== ${cf} ===\n${content.slice(0, 2000)}`);
    }
  }

  return sections.join("\n\n");
}

/**
 * Run deep analysis on a cloned repo.
 */
export async function analyzeCodebase(
  repoPath: string,
  profile: TechProfile
): Promise<AgentResult<AnalysisResult>> {
  log.info("Starting deep analysis", { path: repoPath });

  try {
    const fileTree = getFileTree(repoPath, 3);
    const keyFiles = gatherKeyFileContents(repoPath, profile);

    const prompt = `You are an expert software architect analyzing an open-source codebase.

TECH PROFILE:
- Languages: ${profile.languages
      .map((l) => `${l.name} (${l.percentage}%)`)
      .join(", ")}
- Frameworks: ${profile.frameworks.join(", ") || "none detected"}
- Architecture: ${profile.architecture}
- Databases: ${profile.databases.join(", ") || "none detected"}
- Build Tools: ${profile.buildTools.join(", ") || "none"}
- Test Frameworks: ${profile.testFrameworks.join(", ") || "none"}
- Total Files: ${profile.totalFiles}
- Package Manager: ${profile.packageManager}

FILE TREE:
${fileTree}

KEY FILES:
${keyFiles}

Analyze this codebase and respond ONLY with valid JSON (no markdown fences):
{
  "summary": "2-3 sentence overview of what this project does",
  "architecture": "Detailed architecture description — patterns, layers, how components interact",
  "keyComponents": [
    { "name": "ComponentName", "path": "relative/path", "purpose": "what it does", "type": "controller|service|model|middleware|utility|config|test|migration|other" }
  ],
  "dataModels": [
    { "name": "ModelName", "path": "path/to/model", "fields": ["field1: type", "field2: type"], "relationships": ["has many X", "belongs to Y"] }
  ],
  "apiEndpoints": [
    { "method": "GET|POST|PUT|DELETE|PATCH", "path": "/api/path", "handler": "ControllerName.method", "description": "what it does" }
  ],
  "concerns": ["potential issue 1", "potential issue 2"],
  "strengths": ["good practice 1", "good practice 2"]
}

Be thorough but concise. List up to 15 key components, 10 data models, 20 API endpoints, 5 concerns, 5 strengths.
If you can't determine something, use empty arrays. Always return valid JSON.`;

    const raw = await askAI(prompt, repoPath);
    const analysis = parseAIJson(raw, AnalysisResultSchema);

    log.info("Analysis complete", {
      components: analysis.keyComponents.length,
      models: analysis.dataModels.length,
      endpoints: analysis.apiEndpoints.length
    });

    return {
      success: true,
      message: `Analysis complete: ${analysis.keyComponents.length} components, ${analysis.dataModels.length} models, ${analysis.apiEndpoints.length} endpoints`,
      data: analysis
    };
  } catch (err) {
    const error = err as Error;
    log.error("Analysis failed", { error: error.message });
    return {
      success: false,
      message: `Analysis failed: ${error.message}`,
      error: error.message
    };
  }
}
