# AI agents

Working repo for the agent projects behind **[santhoshrubenraj.web.app](https://santhoshrubenraj.web.app)**.

Each directory is a self-contained project with its own README, stack and run
instructions. The common thread is how the dangerous action is handled: in every
one of these, the step that can do real damage — submit the application,
reprocess the payment, write to the repo — is made structurally unreachable
first, then deliberately wired. A config flag you can flip is not a safety
mechanism.

| Project | What it does | Stack |
|---|---|---|
| [**AI-DS Ledger Reconciler**](Documents/santhosh_%28%29/ai-ds-ledger-reconciler) | A payment webhook can arrive several times — networks retry. This records each transaction exactly once across a cluster, then has an agent inspect the shared ledger and heal any row that drifted from the processor's view. The distributed lock is deliberately held past success, so its TTL doubles as an idempotency window. | NestJS · Redis · PostgreSQL · Nginx · Docker |
| [**AI Code Analyzer**](Documents/santhosh_%28%29/AI-agent-code) | Paste a GitHub URL into a Telegram chat; it clones the repo, works out the tech stack, and answers architecture, breaking-change and bug-fix questions in plain English. Stack detection is deterministic and model-free — fast, free, and provable by a standalone demo that needs no API key. | TypeScript · Telegraf · SQLite |
| [**Job-Hunt Agent**](Documents/santhosh_%28%29/AI-job-hunt) | Finds real openings, tailors the résumé per posting, and routes every application through a human approval gate. It cannot auto-submit: four independent, each-sufficient guards block it, and the graph edge to the submit step is severed rather than gated by an interrupt — an interrupt is re-enabled by a config flag, a deleted edge is not. | Python · LangGraph · Playwright · FastAPI |
| [**ECR Dev Factory**](Documents/santhosh_%28%29/AI-REPO-agent) | Describe a coding task in plain English in Slack; it plans the work, writes the code in a throwaway git worktree, reviews and fixes its own output, then opens a merge request. A human approves before a line is written. Durable, resumable phase machine persisted in SQLite, each phase a swappable agent. | TypeScript · Slack Bolt · SQLite · GitLab |

## Related repositories

- **[ai-diff-reviewer](https://github.com/Santhosh-Rubenraj-Solomon/ai-diff-reviewer)** — reviews the git diff you haven't pushed yet, feeding the model the repository's own history of the exact lines changed. Every finding has to survive an argument against itself before it prints.
- **[library](https://github.com/Santhosh-Rubenraj-Solomon/library)** — full-stack community library: Fastify + TypeORM + PostgreSQL across three stateless replicas behind an nginx load balancer, Angular 17 frontend.
- **[portfolio](https://github.com/Santhosh-Rubenraj-Solomon/portfolio)** — the site above.

## Layout

Projects live under `Documents/santhosh_()/`. The paths are an artefact of how
this repo was first initialised and say nothing about the projects themselves —
each one is independent and runs on its own.

## Status

These are working projects, not polished products. Where one has a known
weakness, it is stated in that project's own README rather than left for you to
find. Build and run instructions are per-project.

---

**Santhosh Rubenraj Solomon** — backend engineer, payments · Chennai, India
[santhoshrubenraj.web.app](https://santhoshrubenraj.web.app) · [LinkedIn](https://www.linkedin.com/in/santhosh-ruben-raj-solomon)
