"""Adzuna job-search API — real, structured job listings on the free tier.

Get free credentials at https://developer.adzuna.com/ and put them in .env:
    ADZUNA_APP_ID=...
    ADZUNA_APP_KEY=...

Adzuna returns structured JSON, so discovery no longer needs the LLM just to
parse results — that keeps the Gemini free-tier quota for tailoring.
"""

import html
import os
import re
from typing import Optional

import httpx

from src.config import AppConfig
from src.models import Job, JobStatus, Portal, WorkMode

ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs"

# Preferred-location -> (Adzuna country code, "where" filter).
# Adzuna supports: gb, us, at, au, be, br, ca, ch, de, es, fr, in, it, mx, nl,
# nz, pl, sg, za. Unmapped locations (e.g. Dubai/UAE — no Adzuna region) are skipped.
LOCATION_MAP: dict[str, tuple[str, str]] = {
    "chennai": ("in", "Chennai"),
    "bengaluru": ("in", "Bengaluru"),
    "bangalore": ("in", "Bangalore"),
    "mumbai": ("in", "Mumbai"),
    "delhi": ("in", "Delhi"),
    "hyderabad": ("in", "Hyderabad"),
    "pune": ("in", "Pune"),
    "coimbatore": ("in", "Coimbatore"),
    "india": ("in", ""),
    "remote": ("in", ""),        # role query gets " remote" appended below
    "singapore": ("sg", "Singapore"),
    "london": ("gb", "London"),
    "uk": ("gb", ""),
    "usa": ("us", ""),
    "us": ("us", ""),
}

# Cap requests per discovery run so the free tier lasts (≈ this many calls/run).
MAX_REQUESTS_PER_RUN = 8


def adzuna_credentials() -> tuple[str, str]:
    return os.getenv("ADZUNA_APP_ID", ""), os.getenv("ADZUNA_APP_KEY", "")


def adzuna_configured() -> bool:
    app_id, app_key = adzuna_credentials()
    return bool(app_id and app_key)


def _clean(text: Optional[str]) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def _infer_work_mode(text: str) -> WorkMode:
    t = text.lower()
    if "remote" in t:
        return WorkMode.REMOTE
    if "hybrid" in t:
        return WorkMode.HYBRID
    return WorkMode.UNKNOWN


async def search_adzuna(
    config: AppConfig,
    resume_skills: Optional[list[str]] = None,
    role: Optional[str] = None,
    location: Optional[str] = None,
    work_type: Optional[str] = None,
) -> list[Job]:
    """Query Adzuna for roles × locations and return raw Job rows.

    role/location override the config defaults (from the UI filters), which also
    narrows to a single query and conserves the free-tier quota. work_type biases
    the query text (remote/hybrid/on-site) for better-matched results.
    """
    app_id, app_key = adzuna_credentials()
    if not (app_id and app_key):
        return []

    roles = [role] if role else config.target_roles
    locations = [location] if location else config.preferred_locations
    wt = (work_type or "").strip().lower()

    jobs: list[Job] = []
    seen: set[str] = set()
    requests_made = 0

    async with httpx.AsyncClient(timeout=20.0) as client:
        for role in roles:
            for loc in locations:
                if requests_made >= MAX_REQUESTS_PER_RUN:
                    break
                mapping = LOCATION_MAP.get(loc.strip().lower())
                if not mapping:
                    continue  # skip unsupported regions (e.g. Dubai)
                country, where = mapping
                what = role
                if loc.strip().lower() == "remote" or wt == "remote":
                    what = f"{role} remote"
                elif wt in ("hybrid", "on-site"):
                    what = f"{role} {wt}"

                params = {
                    "app_id": app_id,
                    "app_key": app_key,
                    "results_per_page": 20,
                    "what": what,
                    "max_days_old": 30,
                    "content-type": "application/json",
                }
                if where:
                    params["where"] = where

                requests_made += 1
                try:
                    resp = await client.get(f"{ADZUNA_BASE}/{country}/search/1", params=params)
                    resp.raise_for_status()
                    data = resp.json()
                except Exception:
                    continue

                for it in data.get("results", []):
                    jid = f"adzuna-{it.get('id')}"
                    if jid in seen:
                        continue
                    seen.add(jid)
                    company = (it.get("company") or {}).get("display_name")
                    location_name = (it.get("location") or {}).get("display_name", "")
                    title = _clean(it.get("title"))
                    desc = _clean(it.get("description"))
                    jobs.append(
                        Job(
                            job_id=jid,
                            company_name=_clean(company) or "Unknown",
                            role_title=title,
                            location=_clean(location_name),
                            work_mode=_infer_work_mode(f"{title} {desc}"),
                            date_posted=it.get("created"),
                            application_url=it.get("redirect_url", ""),
                            job_description=desc,
                            portal=Portal.ADZUNA,
                            status=JobStatus.DISCOVERED,
                        )
                    )
            if requests_made >= MAX_REQUESTS_PER_RUN:
                break

    return jobs
