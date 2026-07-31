# AI Job Hunt Agent

An autonomous job-search assistant that **discovers**, **scores**, and **tailors** applications for you — and is **deliberately engineered so it can never submit an application on its own**.

The agent pulls live openings, ranks them against your skills and preferences with a transparent weighted score, and can rewrite your résumé per job description. Everything up to the moment of *filing* an application is automated; the final submission is gated behind four independent, mutually reinforcing safety guards and always requires a deliberate human action.

> **Core guarantee:** No single action — and nothing the web dashboard can trigger — will ever submit a job application. Reaching a real submission requires several separate, intentional steps taken by you. See [Safety model](#safety-model).

Built with **LangGraph**, **Google Gemini** (via `langchain-google-genai`), **Playwright**, **FastAPI**, and the free **Adzuna** jobs API.

---

## Table of contents

- [What it does](#what-it-does)
- [Two data modes: live vs. test](#two-data-modes-live-vs-test)
- [Setup](#setup)
- [Running](#running)
  - [Web dashboard](#web-dashboard)
  - [CLI](#cli)
- [The web dashboard & filter bar](#the-web-dashboard--filter-bar)
- [HTTP endpoints](#http-endpoints)
- [How discovery & scoring work](#how-discovery--scoring-work)
- [Pipeline phases](#pipeline-phases)
- [Safety model](#safety-model)
- [Configuration (`config.yaml`)](#configuration-configyaml)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Owner](#owner)

---

## What it does

| Phase | What happens |
|-------|--------------|
| **1. Discover** | Fetches openings (live from Adzuna, or mock data in test mode), scores each against your skills/roles/locations, dedupes, ranks, and persists the top matches. |
| **2. Tailor** | Rewrites your résumé and cover letter against a specific job description with keyword / ATS optimization (Gemini-powered). |
| **3. Approve** | Surfaces tailored jobs for **human review**. Nothing proceeds past this point automatically. |
| **4. Submit** | Browser automation (Playwright) that fills an application form. **Reachable only by an explicit, separate CLI invocation** — never from an "all" run and never from the web UI. |
| **5. Report** | Produces a daily summary of pipeline activity. |

The result is a triage-and-prep tool: it does the tedious discovery, scoring, and tailoring, then stops and hands control back to you.

---

## Two data modes: live vs. test

The app runs in one of two modes, **auto-detected at startup** from your environment:

| Mode | When | Data source |
|------|------|-------------|
| **Live** | Both `ADZUNA_APP_ID` **and** `ADZUNA_APP_KEY` are set (non-empty) | Real openings from the [Adzuna](https://developer.adzuna.com/) API |
| **Test** (default) | Either Adzuna key is missing | Local mock jobs — no external calls |

Detection is equivalent to:

```python
REAL_DATA = bool(ADZUNA_APP_ID and ADZUNA_APP_KEY)
TEST_MODE = not REAL_DATA
```

**You flip to live mode simply by adding both Adzuna keys** to your `.env` — there is no flag to toggle. Test mode is the safe default: with no keys, the agent uses mock discovery/tailoring only and makes no portal or LLM calls.

> These flags are evaluated **once at process start**. Changing the environment variables mid-run does not re-flip the mode — restart the server to switch.

You can always check the current mode at runtime via the `GET /mode` endpoint (or the pill in the dashboard header, which reads either `Test mode · submission disabled` or `Live · Adzuna · submission disabled`).

See [SWITCH_TO_REAL_MODE.md](SWITCH_TO_REAL_MODE.md) for the step-by-step going-live guide.

---

## Setup

### 1. Create a virtual environment & install dependencies

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | Required? | Purpose | Free key from |
|----------|-----------|---------|---------------|
| `ADZUNA_APP_ID` | For **live** data | Adzuna app id | [developer.adzuna.com](https://developer.adzuna.com/) |
| `ADZUNA_APP_KEY` | For **live** data | Adzuna app key | [developer.adzuna.com](https://developer.adzuna.com/) |
| `GOOGLE_API_KEY` | Only for **tailoring** | Google Gemini access | [aistudio.google.com](https://aistudio.google.com/) |

- **Both** Adzuna keys are needed to switch on live discovery. Setting them automatically enables live mode (see [Two data modes](#two-data-modes-live-vs-test)).
- **`GOOGLE_API_KEY`** is only required for the résumé-tailoring phase (and the DuckDuckGo fallback parser). Live Adzuna discovery does **not** call the LLM, so you can browse and score real jobs without a Gemini key.
- `.env` also supports notification settings (`NOTIFICATION_CHANNEL`, SMTP block, `SLACK_WEBHOOK_URL`, Twilio WhatsApp block), portal credentials, and `DATABASE_URL`.

> `.env` is git-ignored. Never commit real keys.

### 3. Fill in `config.yaml`

`config.yaml` ships as a **template**. Edit it with your own roles, locations, and preferences — see [Configuration](#configuration-configyaml). **Do not commit personal data** (email, phone, expected salary, etc.) to a public repository.

### 4. Add your base résumé

Place your résumé at `./resume/base_resume.pdf`, or upload it through the dashboard (drag-and-drop; PDF or DOCX accepted — it is saved as `resume/base_resume.pdf`).

---

## Running

### Web dashboard

```bash
uvicorn web_server:app --host 127.0.0.1 --port 4200
```

Open **http://localhost:4200**.

The dashboard is the friendliest way to browse and score jobs. Note that the web path runs the **discovery phase only** — it fetches and scores openings and advances a visual stepper, but does not run tailoring, approval, or submission. The full multi-phase pipeline runs exclusively via the CLI.

### CLI

```bash
python agent.py
```

Run a specific phase or the whole (non-submitting) pipeline:

```bash
# Discovery → tailoring → approval, then STOP (never submits)
python agent.py --phase all --max-jobs 10

# Individual phases
python agent.py --phase discover
python agent.py --phase tailor  --job-id "adzuna-1234567890"
python agent.py --phase approve --response "APPROVE adzuna-1234567890"
python agent.py --phase report
python agent.py --phase status

# Supply skills to improve match scoring
python agent.py --phase discover --skills python nestjs react langchain
```

**Flags:**

| Flag | Default | Meaning |
|------|---------|---------|
| `--phase` | `all` | One of `all`, `discover`, `tailor`, `approve`, `submit`, `report`, `status` |
| `--max-jobs` | `10` | Cap on jobs carried through the run |
| `--job-id` | `None` | Target a single job (tailor/submit) |
| `--config` | `None` | Path to a `config.yaml` |
| `--response` | — | Approval verb, e.g. `"APPROVE <job_id>"`, `"SKIP <job_id>"`, `"STOP"` |
| `--skills` | `[]` | Résumé skills used for match scoring |

> An `--phase all` run **halts after approval** by design. The `submit` phase is reachable only by explicitly calling `python agent.py --phase submit`, and even then it refuses to act unless `auto_submit` is flipped on. See [Safety model](#safety-model).

---

## The web dashboard & filter bar

The single-page dashboard shows a stats row, a pipeline stepper (with **Submit permanently locked 🔒**), safety-guard cards, and a grid of scored job cards (progress ring, badges for location / work mode / portal, description snippet, and a **Tailor résumé** preview showing animated before→after bars for keyword match, ATS score, and missing keywords).

At the top is a **filter bar** with six controls:

| Control | Effect |
|---------|--------|
| **Search** | Free-text over role + company + description |
| **Role** | Backend / Full Stack / AI / Agent / Node.js / Python Developer |
| **Location** | Chennai / Bengaluru / Mumbai / Delhi / Hyderabad / Pune / Remote / Singapore / London / USA |
| **Work type** | remote / hybrid / on-site |
| **Min match** | 0 / 70 / 80 / 90 |
| **Source** | adzuna / linkedin / naukri / indeed / wellfound |

The filter bar does **two** things:

1. **Narrows what's shown now** — it instantly filters the already-loaded jobs in your browser (by min score, work mode, source, location, and search text) and displays an "X of N roles" count. No round-trip.
2. **Steers the next Adzuna search** — the **Role**, **Location**, and **Work type** selections are also sent with the next run request, so the following live search fetches exactly that slice. Narrowing to a single role/location keeps the query focused **and conserves the free Adzuna quota** — a run makes at most **~8 Adzuna API calls** (a hard `MAX_REQUESTS_PER_RUN = 8` cap).

---

## HTTP endpoints

| Method & path | Purpose |
|---------------|---------|
| `GET /` | Serves the dashboard (`frontend/index.html`, with an inline fallback UI). |
| `POST /upload-resume` | Uploads a `.pdf`/`.docx` (others rejected with 400); saved as `resume/base_resume.pdf`. |
| `POST /run-agent` | Starts a background discovery run for a `phase`; returns immediately. Rejects with 400 if a run is already in progress. |
| `GET /jobs` | Returns all persisted jobs. |
| `GET /tailoring/{job_id}` | Returns a tailoring preview for a job (404 if unknown). |
| `GET /status` | Returns the live run status (`running`, `phase`, `message`). |
| `GET /mode` | Reports `{ test_mode, live, source }` for the current mode. |

The dashboard polls `/status` and reloads `/jobs` shortly after kicking off a run; there is no server push.

---

## How discovery & scoring work

**Source selection.** If Adzuna is configured, discovery queries the Adzuna REST API. Otherwise it falls back to a **DuckDuckGo** web search whose results are parsed into structured jobs by Gemini.

- **Adzuna path** maps your locations to Adzuna regions (Chennai, Bengaluru/Bangalore, Mumbai, Delhi, Hyderabad, Pune, Coimbatore, India, Remote → India; Singapore; London; UK; USA). Locations with no Adzuna region (e.g. **Dubai/UAE**) are skipped. Descriptions are cleaned of HTML, work mode is inferred from the text, and each job is prefixed `adzuna-<id>`. **No LLM is used on this path** — that preserves your Gemini free-tier quota for tailoring.
- **DuckDuckGo fallback** builds site-scoped queries for your configured portals and uses Gemini to extract structured job objects.

**Match score (0–100)** is a transparent weighted sum:

| Component | Cap | Basis |
|-----------|-----|-------|
| Skills match | 40 | Fraction of your résumé skills found in the JD |
| Role-title match | 20 | Full (20) or partial-word (10) match against `target_roles` |
| Location match | 20 | Preferred location in the job location, or Remote + "Remote" preferred |
| Recency | 10 | ≤7 days → 10, ≤14 → 5, unparseable → 5, missing → 0 |
| Company preference | 10 | 10 if in `target_companies`; neutral 5 if that list is empty |

**Filtering.** Jobs are deduped (in-memory + SQLite), dropped if the company is excluded, and skipped if they score below the floor. The floor is your `minimum_match_score` — except on the Adzuna path, which uses a gentler `min(minimum_match_score, 45)` because Adzuna snippets are short; ranking then surfaces the best. Survivors are sorted by score and truncated to `discovery_result_limit`.

---

## Pipeline phases

The CLI compiles a five-node **LangGraph** workflow:

```
init → discover → tailor → approve ──▶ END   (the "all" run stops here)

                                  submit → report → END
                                  ▲
                          (reachable only via --phase submit)
```

1. **discover** — run discovery + scoring; persist top matches.
2. **tailor** — rewrite résumé/cover letter per JD (optionally for a single `--job-id`).
3. **approve** — collect tailored jobs for human review; **always routes to END**.
4. **submit** — Playwright form-fill; refuses to act if `auto_submit` is true; reachable only from a direct `--phase submit`.
5. **report** — send the daily summary.

---

## Safety model

The agent cannot auto-apply. Four independent guards enforce this — each one alone is sufficient:

1. **Test-mode default.** With no Adzuna keys, `TEST_MODE` is on and the app uses mock data only — no portal calls, no LLM calls, no submission path reachable from the web server at all.
2. **`auto_submit: false`.** Enforced twice: `agent.py` hard-exits before building the graph if it's true, and the `submit` node refuses to act and returns a safety error if it's true.
3. **Severed approval→submit edge.** In the LangGraph workflow, routing after approval returns `END` in *every* branch. There is **no edge** wiring `approve` to `submit`, so an "all" run can never flow into submission automatically.
4. **Disabled Playwright click.** The actual application-filing browser `.click()` is commented out in the submission code.

**Net effect:** reaching a real submission requires (a) a deliberate, separate `agent.py --phase submit` invocation, **and** (b) flipping `auto_submit` to `true`, **and** (c) re-enabling the commented Playwright click. No single action — and nothing the dashboard exposes — can submit an application.

---

## Configuration (`config.yaml`)

`config.yaml` ships as a **template**. Fill it with your own details locally and **do not commit personal data** (email, phone, expected salary) to a public repository.

| Field | Purpose |
|-------|---------|
| `user_profile` | Your `name`, `email`, `phone`, `location`, `linkedin_url`, `portfolio_url`, `notice_period`, `expected_salary`, `willing_to_relocate`, `preferred_work_mode`. |
| `target_roles` | Job titles to search for and score against. |
| `target_companies` | Preferred companies (empty ⇒ broad search + neutral company scoring). |
| `excluded_companies` | Companies to always drop during discovery. |
| `preferred_locations` | Where you want to work (unmapped locations are skipped on the Adzuna path). |
| `minimum_match_score` | Score floor (default `70`; the Adzuna path softens this to `min(score, 45)`). |
| `portals_to_use` | Portals for the DuckDuckGo fallback query builder (`linkedin`, `naukri`, `indeed`, `wellfound`). |
| `base_resume_path` | Path to your base résumé (`./resume/base_resume.pdf`). |
| `agent_settings` | `max_daily_applications` (15), **`auto_submit` (false — keep it false)**, `retry_limit` (3), `retry_delay_seconds` (5), `discovery_result_limit` (10), `model` (`gemini-2.0-flash`), `notification_channel` (`email`). |
| `schedule` | Suggested daily times per phase and a timezone (loaded for reference; no scheduler is bundled). |

> The LLM is **Google Gemini** — `agent_settings.model` names a Gemini model (the template uses `gemini-2.0-flash`), used via `langchain-google-genai` and keyed by `GOOGLE_API_KEY`.

### Notification channels

Set `NOTIFICATION_CHANNEL` in `.env` to one of:

- `email` — SMTP (Gmail app passwords work well)
- `slack` — incoming webhook (`SLACK_WEBHOOK_URL`)
- `whatsapp` — Twilio API

---

## Project structure

```
AI-job-hunt/
├── agent.py                 # CLI entry point (5-phase LangGraph pipeline)
├── web_server.py            # FastAPI app — dashboard + JSON API
├── config.yaml              # User profile & agent settings (TEMPLATE)
├── requirements.txt         # Python dependencies
├── .env.example             # Environment-variable template
├── .gitignore
├── frontend/
│   └── index.html           # Single-page dashboard (served at /)
├── resume/
│   └── base_resume.pdf      # Your base résumé (uploaded or placed here)
├── db/
│   └── jobhunt.db           # SQLite persistence
└── src/
    ├── config.py            # YAML + .env loader (Pydantic models)
    ├── models.py            # Pydantic models & enums (Job, Portal, JobStatus, …)
    ├── memory.py            # SQLite job store (init/save/dedup/query)
    ├── graph.py             # LangGraph workflow & routing
    ├── test_mode.py         # Mock discovery/tailoring for test mode
    ├── phases/
    │   ├── discovery.py     # Phase 1: discovery, scoring, ranking
    │   ├── tailoring.py     # Phase 2: résumé/cover-letter rewrite
    │   ├── approval.py      # Phase 3: human approval gate
    │   ├── submission.py    # Phase 4: Playwright form-fill (click disabled)
    │   └── reporting.py     # Phase 5: daily summary
    └── tools/
        ├── adzuna.py        # Adzuna API client (live jobs)
        ├── web_search.py    # DuckDuckGo fallback query builder
        ├── browser.py       # Playwright browser helpers
        ├── file_ops.py      # File read/write utilities
        ├── notification.py  # Email / Slack / WhatsApp alerts
        └── memory_tools.py  # DB tool wrappers
```

---

## Tech stack

- **Web:** FastAPI, Uvicorn (ASGI), `python-multipart` (file uploads).
- **Orchestration:** LangGraph (`StateGraph`), LangChain (+ community).
- **LLM:** Google Gemini via `langchain-google-genai` (`ChatGoogleGenerativeAI`), keyed by `GOOGLE_API_KEY`.
- **Job data:** Adzuna REST API (live) with a DuckDuckGo + BeautifulSoup fallback.
- **Browser automation:** Playwright (submit click disabled by default).
- **HTTP:** httpx (async Adzuna client).
- **Persistence:** SQLite via `aiosqlite`.
- **Docs/résumé:** `python-docx`, `fpdf2`.
- **Config/models:** Pydantic v2, PyYAML, python-dotenv.
- **CLI/UX:** Rich (panels & tables).

---

## Owner

**Santhosh Rubenraj Solomon** — GitHub: [@Santhosh-Rubenraj-Solomon](https://github.com/Santhosh-Rubenraj-Solomon)

---

*For personal use. Review each target portal's Terms of Service before enabling any browser automation.*
