# AI Code Analyzer — Telegram Bot

A Telegram-driven AI agent that analyzes open-source GitHub repositories for tech stack, architecture, data models, breaking changes, and guides bug fixes/feature implementations end-to-end through conversational Q&A.

## Features

- **Auto Tech Detection** — Scans file extensions, dependency files, configs to detect languages, frameworks, databases, build tools, CI/CD, linters
- **Deep AI Analysis** — Uses Claude CLI or OpenAI to analyze architecture, key components, data models, API endpoints
- **Breaking Change Detection** — Analyzes git diffs against a comprehensive checklist (API, DB, Message Bus, Cross-Service)
- **Bug Fix Guidance** — Step-by-step Q&A flow to identify root cause and suggest fixes
- **Feature Planning** — Guided implementation planning with architecture decisions and code examples
- **Architecture Review** — Deep-dive into codebase architecture patterns and data flows
- **Session Persistence** — SQLite-backed sessions survive bot restarts

## Quick Start

### 1. Prerequisites
- Node.js ≥ 20
- A Telegram Bot Token (get from [@BotFather](https://t.me/BotFather))
- Claude CLI installed (`claude` command available) OR an OpenAI API key

### 2. Setup

```bash
cd AI-agent-code
npm install
cp .env.example .env
# Edit .env with your Telegram bot token
```

### 3. Configure `.env`

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
AI_ENGINE=claude        # or "openai"
OPENAI_API_KEY=         # only if AI_ENGINE=openai
GITHUB_TOKEN=           # optional, for private repos
```

### 4. Run

```bash
npm run dev
```

### 5. Use in Telegram

1. Open your bot in Telegram
2. Send `/start` to see the welcome message
3. Paste a GitHub URL like `https://github.com/expressjs/express`
4. The bot will clone, profile, and analyze the repo
5. Use commands like `/bugfix`, `/feature`, `/breaking` to start guided flows
6. Ask any question about the codebase in natural language

## Commands

| Command | Description |
|---------|-------------|
| `/analyze <url>` | Clone & analyze a GitHub repo |
| `/profile` | Show detected tech profile |
| `/breaking [N]` | Detect breaking changes in last N commits |
| `/bugfix` | Start bug fix guidance flow |
| `/feature` | Start feature implementation flow |
| `/architecture` | Explore codebase architecture |
| `/summary` | Summarize current conversation |
| `/reset` | Clear session & start fresh |
| `/help` | Show available commands |

## Architecture

```
src/
├── app.ts                    # Telegram bot entry point
├── config.ts                 # Zod-validated environment config
├── types.ts                  # TypeScript type definitions
├── schemas.ts                # Zod schemas + AI output parser
├── agents/
│   ├── analyzer.ts           # Deep codebase analyzer (AI-powered)
│   ├── breakingChange.ts     # Breaking change detector (AI-powered)
│   └── advisor.ts            # Conversational Q&A advisor (AI-powered)
├── services/
│   ├── github.ts             # GitHub repo cloning/management
│   ├── aiEngine.ts           # AI engine abstraction (Claude CLI / OpenAI)
│   └── techDetector.ts       # Fast tech stack auto-detection (no AI)
├── handlers/
│   ├── commands.ts           # Telegram command handlers
│   └── messageHandler.ts     # Free-text message routing
├── state/
│   └── store.ts              # SQLite session persistence
└── utils/
    └── logger.ts             # Structured logger
```

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript
- **Bot Framework:** Telegraf (Telegram Bot API)
- **AI Engines:** Claude CLI / OpenAI GPT-4o
- **Database:** SQLite (better-sqlite3)
- **Git:** simple-git
- **Validation:** Zod
