import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTechProfile, getFileTree, readRepoFile } from "../src/services/techDetector.js";
import { makeTree, rmTree } from "./helpers.js";

const dirs: string[] = [];
function tree(files: Record<string, string | Buffer>) {
  const d = makeTree(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmTree(dirs.pop()!);
});

describe("detectTechProfile — Node/Next.js project", () => {
  const files = {
    "package.json": JSON.stringify({
      main: "dist/index.js",
      bin: { cli: "bin/cli.js", other: "dist/index.js" },
      dependencies: { react: "^18", next: "^14", pg: "^8", "@prisma/client": "^5" },
      devDependencies: { vitest: "^2", esbuild: "^0.20", "@playwright/test": "^1" },
    }),
    "yarn.lock": "",
    "tsconfig.json": "{}",
    "vite.config.ts": "",
    Dockerfile: "FROM node",
    ".github/workflows/ci.yml": "on: push",
    ".eslintrc.json": "{}",
    ".eslintrc.js": "",
    ".prettierrc": "{}",
    "src/index.ts": "export {}\n".repeat(10),
    "src/app.tsx": "x",
    "pages/index.tsx": "x",
    "styles/site.css": "body{}",
    "node_modules/react/index.js": "ignored",
    "dist/index.js": "ignored",
    ".hidden/secret.ts": "ignored",
  };

  it("detects languages, deps, frameworks, tooling and architecture", () => {
    const root = tree(files);
    const p = detectTechProfile(root);

    // Hidden top-level *directories* are skipped, but hidden files (.eslintrc.js) are scanned.
    expect(p.languages).toEqual([
      { name: "TypeScript", percentage: 80, fileCount: 4 },
      { name: "JavaScript", percentage: 20, fileCount: 1 },
    ]);
    expect(p.totalFiles).toBe(12); // node_modules/dist/.hidden excluded; css/json counted as "Other"
    expect(p.frameworks).toEqual(["React", "Next.js", "Prisma"]);
    expect(p.databases).toEqual(["PostgreSQL"]);
    expect(p.testFrameworks).toEqual(["Vitest", "Playwright"]);
    expect(p.buildTools).toEqual(["Vite", "esbuild", "TypeScript Compiler"]);
    expect(p.ciCd).toEqual(["GitHub Actions", "Docker"]);
    expect(p.linters).toEqual(["ESLint", "Prettier"]);
    expect(p.packageManager).toBe("yarn");
    expect(p.architecture).toBe("Full-Stack SSR Framework");
    expect(p.entryPoints).toEqual(["src/index.ts", "dist/index.js", "bin/cli.js"]);
    expect(p.dependencies).toHaveProperty("next");
    expect(p.devDependencies).toHaveProperty("vitest");
  });

  it("estimates lines as ceil(bytes/40) per file", () => {
    const root = tree({ "a.ts": "x".repeat(41), "b.ts": "x".repeat(40), "c.ts": "" });
    expect(detectTechProfile(root).totalLinesEstimate).toBe(2 + 1 + 0);
  });

  it("computes rounded language percentages sorted by file count", () => {
    const root = tree({ "a.ts": "", "b.ts": "", "c.py": "", "d.go": "" });
    expect(detectTechProfile(root).languages).toEqual([
      { name: "TypeScript", percentage: 50, fileCount: 2 },
      { name: "Python", percentage: 25, fileCount: 1 },
      { name: "Go", percentage: 25, fileCount: 1 },
    ]);
  });

  it("maps upper-case extensions via lower-casing (e.g. .R, .TS)", () => {
    const root = tree({ "model.R": "", "X.TS": "" });
    expect(detectTechProfile(root).languages.map((l) => l.name).sort()).toEqual(["R", "TypeScript"]);
  });
});

describe("detectTechProfile — package managers", () => {
  it.each([
    [{ "package.json": "{}", "pnpm-lock.yaml": "", "yarn.lock": "" }, "pnpm"],
    [{ "package.json": "{}", "bun.lockb": "" }, "bun"],
    [{ "package.json": "{}" }, "npm"],
    [{ "requirements.txt": "flask" }, "pip"],
    [{ "requirements.txt": "flask", Pipfile: "" }, "pipenv"],
    [{ "pyproject.toml": "", "poetry.lock": "" }, "poetry"],
    [{ "go.mod": "module x" }, "go modules"],
    [{ "Cargo.toml": "" }, "cargo"],
    [{ Gemfile: "" }, "bundler"],
    [{ "pom.xml": "" }, "maven"],
    [{ "build.gradle.kts": "" }, "gradle"],
    [{ "README.md": "" }, "unknown"],
  ])("%j -> %s", (files, pm) => {
    expect(detectTechProfile(tree(files)).packageManager).toBe(pm);
  });

  it("tolerates a malformed package.json", () => {
    const p = detectTechProfile(tree({ "package.json": "{ not json" }));
    expect(p.packageManager).toBe("npm");
    expect(p.dependencies).toEqual({});
  });
});

describe("detectTechProfile — Python deps", () => {
  it("parses requirements files and pyproject dependencies", () => {
    const root = tree({
      "requirements.txt": "# comment\ndjango==4.2\n-r base.txt\nrequests>=2.0\nflask\n\n",
      "requirements-dev.txt": "pytest~=8.0\n",
      "pyproject.toml": '[project]\ndependencies = [\n  "fastapi>=0.110",\n  "uvicorn",\n]\n',
    });
    const p = detectTechProfile(root);
    expect(p.dependencies).toEqual({
      django: "4.2",
      requests: "2.0",
      flask: "*",
      pytest: "8.0",
      fastapi: "*",
      uvicorn: "*",
    });
    expect(p.frameworks).toEqual(["Django", "Flask", "FastAPI"]);
    expect(p.testFrameworks).toEqual(["Pytest"]);
  });
});

describe("detectTechProfile — architecture heuristics", () => {
  const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });
  it.each([
    [{ "nx.json": "{}" }, "Monorepo (Nx/Lerna)"],
    [{ "lerna.json": "{}" }, "Monorepo (Nx/Lerna)"],
    [{ "pnpm-workspace.yaml": "" }, "Monorepo (Turborepo)"],
    [{ "src/controllers/a.ts": "", "src/services/b.ts": "", "src/models/c.ts": "" }, "MVC (Model-View-Controller)"],
    [{ "package.json": pkg({ "@nestjs/core": "1" }), "src/modules/a.ts": "" }, "Modular Monolith (NestJS)"],
    [{ "routes/a.js": "", "middleware/b.js": "" }, "Layered (Routes + Middleware)"],
    [{ "domain/a.ts": "", "infrastructure/b.ts": "", "application/c.ts": "" }, "Clean Architecture / DDD"],
    [{ "package.json": pkg({ vue: "3" }), "src/components/A.vue": "" }, "SPA (Single Page Application)"],
    [{ "handlers/a.ts": "", "functions/b.ts": "" }, "Serverless"],
    [{ "pages/index.tsx": "" }, "Standard"],
    [{}, "Standard"],
  ])("%j -> %s", (files, arch) => {
    expect(detectTechProfile(tree(files)).architecture).toBe(arch);
  });

  it("adds Nx/Turborepo/Make build tools", () => {
    const p = detectTechProfile(tree({ "nx.json": "", "turbo.json": "", Makefile: "", "rollup.config.js": "", "webpack.config.js": "" }));
    expect(p.buildTools).toEqual(["Webpack", "Rollup", "Nx", "Turborepo", "Make"]);
  });
});

describe("detectTechProfile — scanning limits", () => {
  it("skips files above MAX_FILE_SIZE_BYTES (500000 in tests)", () => {
    const root = tree({ "big.ts": Buffer.alloc(500_001, 97), "ok.ts": Buffer.alloc(500_000, 97) });
    const p = detectTechProfile(root);
    expect(p.totalFiles).toBe(1);
  });

  it("scans at most 8 directory levels below the root", () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join("/");
    // root is depth 0, so files inside d0..d7 (depth 8) are scanned; d8/ (depth 9) is not.
    const root = tree({ [`${deep}/deep.ts`]: "", "d0/d1/d2/d3/d4/d5/d6/d7/ok.ts": "", "d0/d1/d2/d3/d4/d5/d6/d7/d8/edge.ts": "" });
    expect(detectTechProfile(root).totalFiles).toBe(1);
  });

  it("handles an empty or missing directory", () => {
    const empty = detectTechProfile(tree({}));
    expect(empty).toMatchObject({ totalFiles: 0, languages: [], packageManager: "unknown", entryPoints: [] });
    expect(detectTechProfile("/definitely/not/here").totalFiles).toBe(0);
  });
});

describe("getFileTree", () => {
  it("lists directories first, alphabetically, with tree connectors", () => {
    const root = tree({ "b.ts": "", "a.ts": "", "src/x.ts": "", "lib/y.ts": "", ".env": "", "node_modules/z.js": "" });
    expect(getFileTree(root)).toBe(
      ["├── lib/", "│   └── y.ts", "├── src/", "│   └── x.ts", "├── a.ts", "└── b.ts"].join("\n"),
    );
  });

  it("respects maxDepth", () => {
    const root = tree({ "a/b/c/d.ts": "" });
    expect(getFileTree(root, 1)).toBe(["└── a/", "    └── b/"].join("\n"));
    expect(getFileTree(root, 0)).toBe("└── a/");
  });

  it("caps output around 200 lines", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`f${String(i).padStart(3, "0")}.ts`] = "";
    expect(getFileTree(tree(files)).split("\n")).toHaveLength(200);
  });

  it("returns an empty string for a missing directory", () => {
    expect(getFileTree("/no/such/dir")).toBe("");
  });
});

describe("readRepoFile", () => {
  it("reads files relative to the repo root", () => {
    const root = tree({ "src/a.ts": "hello" });
    expect(readRepoFile(root, "src/a.ts")).toBe("hello");
  });

  it("returns null for missing, directory or oversized files", () => {
    const root = tree({ "big.txt": Buffer.alloc(500_001, 97), "dir/x": "" });
    expect(readRepoFile(root, "nope.ts")).toBeNull();
    expect(readRepoFile(root, "big.txt")).toBeNull();
    expect(readRepoFile(root, "dir")).toBeNull();
  });

  // BUG (src/services/techDetector.ts:609): no containment check — "../" escapes the
  // repo root. advisor.ts feeds file names taken from the *user's chat message* into
  // readRepoFile and sends the contents to the LLM/chat, so any user can exfiltrate files
  // readable by the bot process (e.g. "../../../../home/bot/.config/secrets.json").
  it.skip("BUG: refuses to read files outside the repo root", () => {
    const root = tree({ "repo/a.ts": "", "secret.json": '{"token":"s3cr3t"}' });
    expect(readRepoFile(path.join(root, "repo"), "../secret.json")).toBeNull();
  });
});

// Silence unused import lint in some editors
void fs;
