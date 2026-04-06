"""Web search tool — uses DuckDuckGo to find job listings across portals."""

import json
from typing import Optional

from langchain_core.tools import tool
from duckduckgo_search import DDGS


PORTAL_DOMAINS = {
    "linkedin": "linkedin.com/jobs",
    "naukri": "naukri.com",
    "indeed": "indeed.com",
    "wellfound": "wellfound.com",
}


@tool
def web_search(query: str, max_results: int = 10) -> str:
    """Search the web for job listings. Returns a JSON list of results with
    title, url, and snippet."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return json.dumps(results, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool
def search_jobs_on_portal(
    role: str,
    location: str,
    portal: str,
    max_results: int = 10,
) -> str:
    """Search for jobs on a specific portal using a structured query.

    Args:
        role: Job title to search for (e.g. 'Backend Developer')
        location: Location filter (e.g. 'Chennai')
        portal: Portal name — linkedin, naukri, indeed, wellfound
        max_results: Maximum number of results to return
    """
    domain = PORTAL_DOMAINS.get(portal, portal)
    query = f"{role} jobs in {location} site:{domain}"
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return json.dumps(results, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def build_search_queries(
    roles: list[str],
    locations: list[str],
    portals: list[str],
) -> list[dict]:
    """Generate all (role, location, portal) search query combinations."""
    queries = []
    for role in roles:
        for location in locations:
            for portal in portals:
                domain = PORTAL_DOMAINS.get(portal, portal)
                queries.append({
                    "role": role,
                    "location": location,
                    "portal": portal,
                    "query": f"{role} jobs in {location} site:{domain}",
                })
    return queries
