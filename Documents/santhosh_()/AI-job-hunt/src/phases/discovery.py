"""Phase 1 — Job Discovery: search portals, score, filter, and rank jobs."""

import json
from datetime import datetime, timedelta
from typing import Optional

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, SystemMessage

from src.config import AppConfig, get_gemini_api_key
from src.models import (
    Job, JobStatus, Portal, WorkMode, MatchScoreBreakdown,
)
from src.memory import save_job, job_exists
from src.tools.web_search import build_search_queries
from src.tools.adzuna import search_adzuna, adzuna_configured

# ── Scoring ───────────────────────────────────────────────────────────────

def compute_match_score(
    job: Job,
    config: AppConfig,
    resume_skills: list[str],
) -> MatchScoreBreakdown:
    """Score a job (0-100) against user profile and resume skills."""
    breakdown = MatchScoreBreakdown()

    # Skills match (40 pts)
    jd_lower = job.job_description.lower()
    matched = [s for s in resume_skills if s.lower() in jd_lower]
    if resume_skills:
        ratio = len(matched) / len(resume_skills)
        breakdown.skills_match = min(40, int(ratio * 40))

    # Role title match (20 pts)
    for target in config.target_roles:
        if target.lower() in job.role_title.lower():
            breakdown.role_title_match = 20
            break
    else:
        # Partial match
        for target in config.target_roles:
            words = target.lower().split()
            if any(w in job.role_title.lower() for w in words):
                breakdown.role_title_match = 10
                break

    # Location match (20 pts)
    for loc in config.preferred_locations:
        if loc.lower() in job.location.lower():
            breakdown.location_match = 20
            break
    if job.work_mode == WorkMode.REMOTE and "Remote" in config.preferred_locations:
        breakdown.location_match = 20

    # Recency (10 pts)
    if job.date_posted:
        try:
            posted = datetime.fromisoformat(job.date_posted)
            days_ago = (datetime.now() - posted).days
            if days_ago <= 7:
                breakdown.recency = 10
            elif days_ago <= 14:
                breakdown.recency = 5
        except (ValueError, TypeError):
            breakdown.recency = 5  # Unknown date — partial credit

    # Company preference (10 pts)
    if config.target_companies:
        if job.company_name in config.target_companies:
            breakdown.company_pref = 10
    else:
        breakdown.company_pref = 5  # No preference — neutral score

    breakdown.total = (
        breakdown.skills_match
        + breakdown.role_title_match
        + breakdown.location_match
        + breakdown.recency
        + breakdown.company_pref
    )
    return breakdown


# ── LLM-based JD parsing ─────────────────────────────────────────────────

async def parse_search_results_with_llm(
    raw_results: list[dict],
    portal: str,
    config: AppConfig,
) -> list[Job]:
    """Use the LLM to extract structured job data from raw search results."""
    llm = ChatGoogleGenerativeAI(
        model=config.agent_settings.model,
        google_api_key=get_gemini_api_key(),
        max_output_tokens=4096,
    )

    results_text = json.dumps(raw_results[:20], indent=2)

    system = SystemMessage(content=(
        "You are a job listing parser. Given raw web search results, extract "
        "structured job information. Return a JSON array of objects with keys: "
        "job_id (use a unique slug from the URL), company_name, role_title, "
        "location, work_mode (remote/on-site/hybrid/unknown), date_posted "
        "(ISO format or null), application_url, job_description (the snippet). "
        "Only include results that are actual job postings. Skip ads, articles, "
        "and non-job pages. Return ONLY valid JSON, no markdown fences."
    ))

    human = HumanMessage(content=(
        f"Portal: {portal}\n\nRaw search results:\n{results_text}"
    ))

    response = await llm.ainvoke([system, human])

    try:
        parsed = json.loads(response.content)
        jobs = []
        for item in parsed:
            try:
                job = Job(
                    job_id=item.get("job_id", ""),
                    company_name=item.get("company_name", "Unknown"),
                    role_title=item.get("role_title", ""),
                    location=item.get("location", ""),
                    work_mode=item.get("work_mode", "unknown"),
                    date_posted=item.get("date_posted"),
                    application_url=item.get("application_url", ""),
                    job_description=item.get("job_description", ""),
                    portal=portal,
                    status=JobStatus.DISCOVERED,
                )
                if job.job_id and job.role_title:
                    jobs.append(job)
            except Exception:
                continue
        return jobs
    except (json.JSONDecodeError, TypeError):
        return []


# ── Main Discovery Flow ──────────────────────────────────────────────────

async def run_discovery(
    config: AppConfig,
    resume_skills: Optional[list[str]] = None,
    role: Optional[str] = None,
    location: Optional[str] = None,
    work_type: Optional[str] = None,
) -> list[Job]:
    """Execute the full job discovery phase.

    Uses the Adzuna API when credentials are configured (real structured jobs,
    no LLM needed to parse); otherwise falls back to DuckDuckGo + LLM parsing.
    Optional role/location/work_type narrow the search (from the UI filters).
    """
    if resume_skills is None:
        resume_skills = []

    if adzuna_configured():
        candidates = await search_adzuna(
            config, resume_skills, role=role, location=location, work_type=work_type,
        )
        # Adzuna descriptions are short snippets, so keyword-in-JD scoring runs
        # lower than curated data — use a gentler floor and let ranking surface
        # the best matches.
        floor = min(config.minimum_match_score, 45)
    else:
        candidates = await _discover_via_duckduckgo(config)
        floor = config.minimum_match_score

    all_jobs: list[Job] = []
    seen_ids: set[str] = set()

    for job in candidates:
        if job.job_id in seen_ids:
            continue
        if job_exists(job.job_id):
            seen_ids.add(job.job_id)
            continue
        if job.company_name in config.excluded_companies:
            continue

        job.match_score = compute_match_score(job, config, resume_skills).total
        if job.match_score < floor:
            continue

        seen_ids.add(job.job_id)
        all_jobs.append(job)

    all_jobs.sort(key=lambda j: j.match_score, reverse=True)
    top_jobs = all_jobs[: config.agent_settings.discovery_result_limit]

    for job in top_jobs:
        save_job(job)

    return top_jobs


async def _discover_via_duckduckgo(config: AppConfig) -> list[Job]:
    """No-key fallback: search DuckDuckGo and parse results with the LLM."""
    from duckduckgo_search import DDGS

    queries = build_search_queries(
        config.target_roles,
        config.preferred_locations,
        config.portals_to_use,
    )
    jobs: list[Job] = []
    for q in queries:
        try:
            with DDGS() as ddgs:
                raw = list(ddgs.text(q["query"], max_results=10))
        except Exception:
            raw = []
        jobs.extend(await parse_search_results_with_llm(raw, q["portal"], config))
    return jobs


def format_discovery_table(jobs: list[Job]) -> str:
    """Format discovered jobs as a markdown table."""
    if not jobs:
        return "No matching jobs found."

    lines = [
        "| # | Role | Company | Portal | Location | Match Score | URL |",
        "|---|------|---------|--------|----------|-------------|-----|",
    ]
    for i, j in enumerate(jobs, 1):
        url = j.application_url[:50] + "..." if len(j.application_url) > 50 else j.application_url
        lines.append(
            f"| {i} | {j.role_title} | {j.company_name} | {j.portal.value} "
            f"| {j.location} | {j.match_score}/100 | {url} |"
        )
    return "\n".join(lines)
