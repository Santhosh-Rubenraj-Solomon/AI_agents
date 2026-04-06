# AI Job Application Agent

An autonomous AI-powered job application assistant that discovers relevant jobs, tailors your resume per JD, and prepares applications for human-approved submission.

Built with **LangChain**, **LangGraph**, **Playwright**, and **Anthropic Claude**.

---

## Features

| Phase | Description |
|-------|-------------|
| **Discovery** | Searches LinkedIn, Naukri, Indeed, Wellfound for matching jobs |
| **Tailoring** | Rewrites resume & cover letter per JD with ATS optimization |
| **Approval** | Sends notifications for human review before any submission |
| **Submission** | Browser automation to fill and submit applications |
| **Reporting** | Daily summary reports with keyword performance metrics |

## Safety

- **Never submits** without explicit human approval
- **Never stores** passwords in code — env vars only
- **Never applies** to the same job twice (dedup via SQLite)
- **Daily limit** of 15 applications (configurable)
- **Retry limit** of 3 per browser action with failure notifications

---

## Quick Start

### 1. Install dependencies

```bash
cd AI-job-hunt
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env with your API keys and portal credentials
```

### 3. Edit your profile

Edit `config.yaml` with your name, skills, target roles, locations, and preferences.

### 4. Add your base resume

Place your resume at `./resume/base_resume.pdf`

### 5. Run the agent

```bash
# Full pipeline (discover → tailor → approve)
python agent.py --phase all --max-jobs 10

# Individual phases
python agent.py --phase discover
python agent.py --phase tailor --job-id "linkedin_job_12345"
python agent.py --phase approve --response "APPROVE linkedin_job_12345"
python agent.py --phase submit
python agent.py --phase report
python agent.py --phase status

# With skills for better matching
python agent.py --phase discover --skills python django react postgresql
```

---

## Project Structure

```
AI-job-hunt/
├── agent.py                 # Main entry point (CLI)
├── config.yaml              # User profile & agent settings
├── requirements.txt         # Python dependencies
├── .env.example             # Environment variable template
├── .gitignore
├── resume/                  # Place your base resume here
│   └── base_resume.pdf
├── applications/            # Generated per-job resumes & cover letters
│   └── {company}_{role}/
│       ├── resume_v1.docx
│       ├── resume_v1.pdf
│       └── cover_letter.txt
├── db/                      # SQLite database
│   └── jobhunt.db
├── screenshots/             # Browser automation screenshots
└── src/
    ├── config.py            # Config loader & env helpers
    ├── models.py            # Pydantic data models
    ├── memory.py            # SQLite memory store
    ├── graph.py             # LangGraph workflow orchestration
    ├── tools/
    │   ├── web_search.py    # DuckDuckGo job search
    │   ├── browser.py       # Playwright browser automation
    │   ├── file_ops.py      # File read/write utilities
    │   ├── notification.py  # Email/Slack/WhatsApp alerts
    │   └── memory_tools.py  # LangChain tool wrappers for DB
    └── phases/
        ├── discovery.py     # Phase 1: Job discovery & scoring
        ├── tailoring.py     # Phase 2: Resume & cover letter generation
        ├── approval.py      # Phase 3: Human approval gate
        ├── submission.py    # Phase 4: Browser-based form submission
        └── reporting.py     # Phase 5: Daily summary reports
```

---

## Recommended Daily Schedule

| Time | Command |
|------|---------|
| 8:00 AM | `python agent.py --phase discover` |
| 8:30 AM | `python agent.py --phase tailor` |
| 9:00 AM | Review approval notifications |
| 12:00 PM | `python agent.py --phase submit` |
| 6:00 PM | `python agent.py --phase report` |

---

## Configuration

### config.yaml

Key settings to customize:

- **`user_profile`** — Your name, email, phone, LinkedIn, notice period
- **`target_roles`** — Job titles to search for
- **`preferred_locations`** — Where you want to work
- **`minimum_match_score`** — Skip jobs below this threshold (0–100)
- **`excluded_companies`** — Companies to never apply to
- **`agent_settings.max_daily_applications`** — Daily cap (default: 15)
- **`agent_settings.model`** — Anthropic model to use

### Notification Channels

Set `NOTIFICATION_CHANNEL` in `.env` to one of:
- **`email`** — SMTP (Gmail app passwords work well)
- **`slack`** — Incoming webhook
- **`whatsapp`** — Twilio API

---

## Safety Checklist

Before going live:

- [ ] Credentials in `.env`, not in code
- [ ] `.env` in `.gitignore`
- [ ] `auto_submit: false` in config.yaml
- [ ] Daily limit ≤ 15
- [ ] Notification channel configured and tested
- [ ] Base resume placed in `./resume/`
- [ ] Test run on a dummy job completed

---

## License

For personal use only. Review target portal Terms of Service before deploying automation.
