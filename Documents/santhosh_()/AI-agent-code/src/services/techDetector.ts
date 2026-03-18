/**
 * services/techDetector.ts — Auto-detect tech stack from codebase.
 *
 * Scans file extensions, dependency files, config files, and directory
 * structure to build a comprehensive TechProfile without AI calls.
 * This is the fast, deterministic first pass.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import type { TechProfile, FileEntry } from "../schemas.js";

const log = createLogger("TechDetector");

// ─── Language detection by extension ─────────────────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".pyw": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".c": "C",
  ".h": "C",
  ".swift": "Swift",
  ".dart": "Dart",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".clj": "Clojure",
  ".lua": "Lua",
  ".r": "R",
  ".R": "R",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".proto": "Protobuf",
  ".vue": "Vue",
  ".svelte": "Svelte"
};

// ─── Framework detection from dependencies ───────────────────────────────────

const FRAMEWORK_INDICATORS: Record<string, string[]> = {
  React: ["react", "react-dom"],
  "Next.js": ["next"],
  "Vue.js": ["vue"],
  "Nuxt.js": ["nuxt"],
  Angular: ["@angular/core"],
  Svelte: ["svelte"],
  SvelteKit: ["@sveltejs/kit"],
  Express: ["express"],
  NestJS: ["@nestjs/core"],
  Fastify: ["fastify"],
  Koa: ["koa"],
  Hono: ["hono"],
  Django: ["django"],
  Flask: ["flask"],
  FastAPI: ["fastapi"],
  "Spring Boot": ["spring-boot-starter"],
  Rails: ["rails"],
  Laravel: ["laravel/framework"],
  Gin: ["github.com/gin-gonic/gin"],
  Actix: ["actix-web"],
  "Tailwind CSS": ["tailwindcss"],
  Prisma: ["prisma", "@prisma/client"],
  TypeORM: ["typeorm"],
  Drizzle: ["drizzle-orm"],
  Sequelize: ["sequelize"],
  Mongoose: ["mongoose"]
};

const DATABASE_INDICATORS: Record<string, string[]> = {
  PostgreSQL: ["pg", "postgres", "@prisma/client", "typeorm"],
  MySQL: ["mysql", "mysql2"],
  MongoDB: ["mongoose", "mongodb"],
  Redis: ["redis", "ioredis"],
  SQLite: ["better-sqlite3", "sqlite3"],
  DynamoDB: ["@aws-sdk/client-dynamodb"],
  Elasticsearch: ["@elastic/elasticsearch"]
};

const TEST_FRAMEWORK_INDICATORS: Record<string, string[]> = {
  Jest: ["jest", "@jest/core"],
  Vitest: ["vitest"],
  Mocha: ["mocha"],
  Pytest: ["pytest"],
  JUnit: ["junit"],
  Playwright: ["@playwright/test"],
  Cypress: ["cypress"],
  "Testing Library": ["@testing-library/react", "@testing-library/jest-dom"]
};

const CI_CD_FILES: Record<string, string> = {
  ".github/workflows": "GitHub Actions",
  ".gitlab-ci.yml": "GitLab CI",
  Jenkinsfile: "Jenkins",
  ".circleci": "CircleCI",
  ".travis.yml": "Travis CI",
  "azure-pipelines.yml": "Azure DevOps",
  "bitbucket-pipelines.yml": "Bitbucket Pipelines",
  Dockerfile: "Docker",
  "docker-compose.yml": "Docker Compose",
  "docker-compose.yaml": "Docker Compose",
  k8s: "Kubernetes",
  kubernetes: "Kubernetes",
  helm: "Helm"
};

const LINTER_FILES: Record<string, string> = {
  ".eslintrc": "ESLint",
  ".eslintrc.js": "ESLint",
  ".eslintrc.json": "ESLint",
  ".eslintrc.yml": "ESLint",
  "eslint.config.js": "ESLint",
  "eslint.config.mjs": "ESLint",
  ".prettierrc": "Prettier",
  ".prettierrc.js": "Prettier",
  ".prettierrc.json": "Prettier",
  ".stylelintrc": "Stylelint",
  "biome.json": "Biome",
  ".rubocop.yml": "RuboCop",
  pylintrc: "Pylint",
  ".pylintrc": "Pylint",
  "ruff.toml": "Ruff",
  ".ruff.toml": "Ruff"
};

// ─── Recursive file scanner ─────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".turbo",
  ".nx",
  "vendor",
  "target",
  "bin",
  "obj",
  ".gradle"
]);

function scanFiles(
  dir: string,
  basePath: string,
  files: FileEntry[],
  depth = 0
): void {
  if (depth > 8) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && depth === 0 && entry.isDirectory())
      continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      scanFiles(fullPath, basePath, files, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const language = EXTENSION_LANGUAGE_MAP[ext] || "Other";

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size <= CONFIG.limits.maxFileSizeBytes) {
          files.push({
            path: relativePath,
            extension: ext,
            sizeBytes: stat.size,
            language
          });
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }
}

// ─── Dependency file readers ─────────────────────────────────────────────────

function readJsonDeps(filePath: string): {
  deps: Record<string, string>;
  devDeps: Record<string, string>;
} {
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      deps: content.dependencies || {},
      devDeps: content.devDependencies || {}
    };
  } catch {
    return { deps: {}, devDeps: {} };
  }
}

function readPythonDeps(repoPath: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const reqFiles = [
    "requirements.txt",
    "requirements-dev.txt",
    "requirements/base.txt"
  ];

  for (const f of reqFiles) {
    const fp = path.join(repoPath, f);
    if (fs.existsSync(fp)) {
      const lines = fs.readFileSync(fp, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) {
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:[>=<~!]+(.+))?$/);
          if (match) deps[match[1]] = match[2] || "*";
        }
      }
    }
  }

  // Also check pyproject.toml
  const pyproject = path.join(repoPath, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    const content = fs.readFileSync(pyproject, "utf-8");
    const depMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depMatch) {
      const items = depMatch[1].match(/"([^"]+)"/g);
      items?.forEach((item) => {
        const name = item
          .replace(/"/g, "")
          .split(/[>=<~!]/)[0]
          .trim();
        deps[name] = "*";
      });
    }
  }

  return deps;
}

// ─── Detect entry points ─────────────────────────────────────────────────────

function detectEntryPoints(repoPath: string, files: FileEntry[]): string[] {
  const entryPoints: string[] = [];
  const candidates = [
    "src/main.ts",
    "src/index.ts",
    "src/app.ts",
    "src/server.ts",
    "src/main.js",
    "src/index.js",
    "src/app.js",
    "src/server.js",
    "main.py",
    "app.py",
    "manage.py",
    "wsgi.py",
    "main.go",
    "cmd/main.go",
    "src/main.rs",
    "src/lib.rs",
    "Main.java",
    "Application.java",
    "index.html"
  ];

  for (const candidate of candidates) {
    if (
      files.some(
        (f) => f.path === candidate || f.path.endsWith(`/${candidate}`)
      )
    ) {
      entryPoints.push(candidate);
    }
  }

  // Check package.json main/bin
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.main) entryPoints.push(pkg.main);
      if (pkg.bin) {
        if (typeof pkg.bin === "string") entryPoints.push(pkg.bin);
        else
          Object.values(pkg.bin).forEach((v) => entryPoints.push(v as string));
      }
    } catch {
      /* skip */
    }
  }

  return [...new Set(entryPoints)];
}

// ─── Detect architecture pattern ─────────────────────────────────────────────

function detectArchitecture(
  repoPath: string,
  files: FileEntry[],
  frameworks: string[]
): string {
  const paths = files.map((f) => f.path);
  const hasDir = (name: string) =>
    paths.some((p) => p.includes(`/${name}/`) || p.startsWith(`${name}/`));

  if (
    fs.existsSync(path.join(repoPath, "nx.json")) ||
    fs.existsSync(path.join(repoPath, "lerna.json"))
  ) {
    return "Monorepo (Nx/Lerna)";
  }
  if (
    fs.existsSync(path.join(repoPath, "turbo.json")) ||
    fs.existsSync(path.join(repoPath, "pnpm-workspace.yaml"))
  ) {
    return "Monorepo (Turborepo)";
  }
  if (hasDir("controllers") && hasDir("services") && hasDir("models")) {
    return "MVC (Model-View-Controller)";
  }
  if (hasDir("modules") && frameworks.includes("NestJS")) {
    return "Modular Monolith (NestJS)";
  }
  if (hasDir("routes") && hasDir("middleware")) {
    return "Layered (Routes + Middleware)";
  }
  if (hasDir("domain") && hasDir("infrastructure") && hasDir("application")) {
    return "Clean Architecture / DDD";
  }
  if (hasDir("pages") || hasDir("app")) {
    if (frameworks.includes("Next.js") || frameworks.includes("Nuxt.js")) {
      return "Full-Stack SSR Framework";
    }
  }
  if (
    hasDir("components") &&
    (frameworks.includes("React") || frameworks.includes("Vue.js"))
  ) {
    return "SPA (Single Page Application)";
  }
  if (hasDir("handlers") && hasDir("functions")) {
    return "Serverless";
  }

  return "Standard";
}

// ─── Main detection function ─────────────────────────────────────────────────

export function detectTechProfile(repoPath: string): TechProfile {
  log.info("Scanning codebase", { path: repoPath });

  // Step 1: Scan all files
  const files: FileEntry[] = [];
  scanFiles(repoPath, repoPath, files);

  // Step 2: Language stats
  const langCounts: Record<string, number> = {};
  for (const f of files) {
    if (f.language !== "Other") {
      langCounts[f.language] = (langCounts[f.language] || 0) + 1;
    }
  }
  const totalCodeFiles =
    Object.values(langCounts).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(langCounts)
    .map(([name, count]) => ({
      name,
      percentage: Math.round((count / totalCodeFiles) * 100),
      fileCount: count
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  // Step 3: Read dependencies
  let deps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};
  let packageManager = "unknown";

  const pkgJsonPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const result = readJsonDeps(pkgJsonPath);
    deps = result.deps;
    devDeps = result.devDeps;
    packageManager = fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(repoPath, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(repoPath, "bun.lockb"))
      ? "bun"
      : "npm";
  } else if (
    fs.existsSync(path.join(repoPath, "requirements.txt")) ||
    fs.existsSync(path.join(repoPath, "pyproject.toml"))
  ) {
    deps = readPythonDeps(repoPath);
    packageManager = fs.existsSync(path.join(repoPath, "Pipfile"))
      ? "pipenv"
      : fs.existsSync(path.join(repoPath, "poetry.lock"))
      ? "poetry"
      : "pip";
  } else if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    packageManager = "go modules";
  } else if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
    packageManager = "cargo";
  } else if (fs.existsSync(path.join(repoPath, "Gemfile"))) {
    packageManager = "bundler";
  } else if (fs.existsSync(path.join(repoPath, "pom.xml"))) {
    packageManager = "maven";
  } else if (
    fs.existsSync(path.join(repoPath, "build.gradle")) ||
    fs.existsSync(path.join(repoPath, "build.gradle.kts"))
  ) {
    packageManager = "gradle";
  }

  const allDeps = { ...deps, ...devDeps };

  // Step 4: Detect frameworks
  const frameworks: string[] = [];
  for (const [fw, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
    if (indicators.some((ind) => ind in allDeps)) {
      frameworks.push(fw);
    }
  }

  // Step 5: Detect databases
  const databases: string[] = [];
  for (const [db, indicators] of Object.entries(DATABASE_INDICATORS)) {
    if (indicators.some((ind) => ind in allDeps)) {
      databases.push(db);
    }
  }

  // Step 6: Detect test frameworks
  const testFrameworks: string[] = [];
  for (const [tf, indicators] of Object.entries(TEST_FRAMEWORK_INDICATORS)) {
    if (indicators.some((ind) => ind in allDeps)) {
      testFrameworks.push(tf);
    }
  }

  // Step 7: Detect build tools
  const buildTools: string[] = [];
  if (
    fs.existsSync(path.join(repoPath, "webpack.config.js")) ||
    fs.existsSync(path.join(repoPath, "webpack.config.ts"))
  )
    buildTools.push("Webpack");
  if (
    fs.existsSync(path.join(repoPath, "vite.config.ts")) ||
    fs.existsSync(path.join(repoPath, "vite.config.js"))
  )
    buildTools.push("Vite");
  if (fs.existsSync(path.join(repoPath, "rollup.config.js")))
    buildTools.push("Rollup");
  if (
    fs.existsSync(path.join(repoPath, "esbuild.config.js")) ||
    "esbuild" in allDeps
  )
    buildTools.push("esbuild");
  if (fs.existsSync(path.join(repoPath, "tsconfig.json")))
    buildTools.push("TypeScript Compiler");
  if (fs.existsSync(path.join(repoPath, "nx.json"))) buildTools.push("Nx");
  if (fs.existsSync(path.join(repoPath, "turbo.json")))
    buildTools.push("Turborepo");
  if (fs.existsSync(path.join(repoPath, "Makefile"))) buildTools.push("Make");

  // Step 8: Detect CI/CD
  const ciCd: string[] = [];
  for (const [filePath, name] of Object.entries(CI_CD_FILES)) {
    if (fs.existsSync(path.join(repoPath, filePath))) {
      ciCd.push(name);
    }
  }

  // Step 9: Detect linters
  const linters: string[] = [];
  for (const [filePath, name] of Object.entries(LINTER_FILES)) {
    if (fs.existsSync(path.join(repoPath, filePath))) {
      if (!linters.includes(name)) linters.push(name);
    }
  }

  // Step 10: Architecture
  const architecture = detectArchitecture(repoPath, files, frameworks);

  // Step 11: Entry points
  const entryPoints = detectEntryPoints(repoPath, files);

  // Estimate total lines
  const totalLinesEstimate = files.reduce(
    (sum, f) => sum + Math.ceil(f.sizeBytes / 40),
    0
  );

  const profile: TechProfile = {
    languages,
    frameworks,
    buildTools,
    databases,
    architecture,
    packageManager,
    testFrameworks,
    linters,
    ciCd,
    entryPoints,
    totalFiles: files.length,
    totalLinesEstimate,
    dependencies: deps,
    devDependencies: devDeps
  };

  log.info("Tech profile detected", {
    languages: languages.map((l) => l.name).join(", "),
    frameworks: frameworks.join(", ") || "none",
    architecture,
    files: files.length
  });

  return profile;
}

/**
 * Get a file tree string for the repo (limited to depth 3).
 */
export function getFileTree(repoPath: string, maxDepth = 3): string {
  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries = entries.filter(
      (e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith(".")
    );
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length && lines.length < 200; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(path.join(dir, entry.name), prefix + childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  walk(repoPath, "", 0);
  return lines.join("\n");
}

/**
 * Read a file from the repo (with size limit).
 */
export function readRepoFile(
  repoPath: string,
  filePath: string
): string | null {
  const fullPath = path.join(repoPath, filePath);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > CONFIG.limits.maxFileSizeBytes) return null;
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}
