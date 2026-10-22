import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src import memory
from src.models import Portal, WorkMode
from src.phases import discovery as d


def days_ago(n):
    return (datetime.now() - timedelta(days=n)).isoformat()


# ── compute_match_score ────────────────────────────────────────────────────

def test_perfect_score(config, make_job):
    job = make_job(job_description="python fastapi", date_posted=days_ago(1))
    b = d.compute_match_score(job, config, ["Python", "FastAPI"])
    assert (b.skills_match, b.role_title_match, b.location_match, b.recency, b.company_pref) == (40, 20, 20, 10, 5)
    assert b.total == 95


def test_skills_partial_ratio(config, make_job):
    job = make_job(job_description="python only")
    assert d.compute_match_score(job, config, ["python", "go", "rust", "java"]).skills_match == 10


def test_no_resume_skills_scores_zero_for_skills(config, make_job):
    assert d.compute_match_score(make_job(), config, []).skills_match == 0


def test_role_partial_match(config, make_job):
    b = d.compute_match_score(make_job(role_title="Senior Developer"), config, [])
    assert b.role_title_match == 10
    b = d.compute_match_score(make_job(role_title="Accountant"), config, [])
    assert b.role_title_match == 0


def test_location_and_remote(config, make_job):
    assert d.compute_match_score(make_job(location="Paris"), config, []).location_match == 0
    remote = make_job(location="Anywhere", work_mode=WorkMode.REMOTE)
    assert d.compute_match_score(remote, config, []).location_match == 20
    config.preferred_locations = ["Chennai"]
    assert d.compute_match_score(remote, config, []).location_match == 0


@pytest.mark.parametrize("posted,expected", [
    (lambda: days_ago(0), 10), (lambda: days_ago(7), 10), (lambda: days_ago(10), 5),
    (lambda: days_ago(14), 5), (lambda: days_ago(30), 0), (lambda: "not-a-date", 5), (lambda: None, 0),
])
def test_recency(config, make_job, posted, expected):
    assert d.compute_match_score(make_job(date_posted=posted()), config, []).recency == expected


def test_company_preference(config, make_job):
    assert d.compute_match_score(make_job(), config, []).company_pref == 5
    config.target_companies = ["Acme"]
    assert d.compute_match_score(make_job(), config, []).company_pref == 10
    assert d.compute_match_score(make_job(company_name="Other"), config, []).company_pref == 0


# BUG: src/phases/discovery.py:59-60. Adzuna returns `created` as an ISO string
# with a "Z" suffix (e.g. "2026-10-21T08:00:00Z"). On Python < 3.11
# datetime.fromisoformat() rejects the "Z" (ValueError); on 3.11+ it parses to a
# tz-AWARE datetime and `datetime.now() - posted` raises TypeError (naive minus
# aware). Both are swallowed by the except clause, so every live Adzuna job gets
# the 5-point "unknown date" credit instead of 10 for a fresh posting.
@pytest.mark.xfail(reason="discovery.py:59 mis-scores tz-aware/'Z' Adzuna dates as unknown", strict=True)
def test_recency_for_adzuna_utc_timestamp(config, make_job):
    created = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert d.compute_match_score(make_job(date_posted=created), config, []).recency == 10


# ── run_discovery ──────────────────────────────────────────────────────────

@pytest.fixture
def ddg_candidates(monkeypatch):
    holder = {"jobs": []}
    monkeypatch.setattr(d, "adzuna_configured", lambda: False)
    monkeypatch.setattr(d, "_discover_via_duckduckgo", AsyncMock(side_effect=lambda cfg: holder["jobs"]))
    return holder


async def test_run_discovery_filters_dedupes_ranks_and_persists(config, make_job, ddg_candidates):
    memory.save_job(make_job("already-seen"))
    ddg_candidates["jobs"] = [
        make_job("good", job_description="python", date_posted=days_ago(1)),       # 40+20+20+10+5 = 95
        make_job("good", job_description="python", date_posted=days_ago(1)),       # duplicate id
        make_job("ok", job_description="nothing", date_posted=days_ago(1)),        # 0+20+20+10+5 = 55
        make_job("low", role_title="Chef", location="Paris", job_description=""),  # 5
        make_job("excluded", company_name="BadCorp", job_description="python"),
        make_job("already-seen"),
    ]
    jobs = await d.run_discovery(config, ["python"])
    assert [(j.job_id, j.match_score) for j in jobs] == [("good", 95), ("ok", 55)]
    assert {j.job_id for j in memory.get_all_jobs()} == {"already-seen", "good", "ok"}


async def test_run_discovery_respects_result_limit(config, make_job, ddg_candidates):
    config.agent_settings.discovery_result_limit = 2
    ddg_candidates["jobs"] = [make_job(f"j{i}", job_description="python") for i in range(5)]
    assert len(await d.run_discovery(config, ["python"])) == 2


async def test_run_discovery_defaults_skills_to_empty(config, make_job, ddg_candidates):
    config.minimum_match_score = 0
    ddg_candidates["jobs"] = [make_job("a")]
    assert [j.job_id for j in await d.run_discovery(config)] == ["a"]


async def test_run_discovery_adzuna_uses_gentler_floor_and_forwards_filters(config, make_job, monkeypatch):
    config.minimum_match_score = 90
    monkeypatch.setattr(d, "adzuna_configured", lambda: True)
    # 0 skills + 20 role + 20 loc + 0 recency + 5 company = 45 -> passes floor min(90, 45)
    search = AsyncMock(return_value=[make_job("adzuna-1", portal=Portal.ADZUNA)])
    monkeypatch.setattr(d, "search_adzuna", search)
    jobs = await d.run_discovery(config, [], role="AI Developer", location="Chennai", work_type="hybrid")
    assert [j.job_id for j in jobs] == ["adzuna-1"]
    search.assert_awaited_once_with(config, [], role="AI Developer", location="Chennai", work_type="hybrid")


async def test_discover_via_duckduckgo_builds_queries_and_parses(config, monkeypatch, make_job):
    import duckduckgo_search

    class FakeDDGS:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def text(self, q, max_results=10):
            if "naukri" in q:
                raise RuntimeError("rate limited")
            return [{"title": q, "href": "https://x", "body": "b"}]

    monkeypatch.setattr(duckduckgo_search, "DDGS", FakeDDGS)
    parse = AsyncMock(side_effect=lambda raw, portal, cfg: [make_job(f"{portal}-{len(raw)}")])
    monkeypatch.setattr(d, "parse_search_results_with_llm", parse)
    jobs = await d._discover_via_duckduckgo(config)
    # 2 roles x 2 locations x 2 portals
    assert parse.await_count == 8
    raws = [c.args[0] for c in parse.await_args_list]
    assert sum(1 for r in raws if r == []) == 4  # naukri queries failed -> empty
    assert len(jobs) == 8


# ── LLM parsing (Gemini fully mocked) ──────────────────────────────────────

@pytest.fixture
def fake_llm(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "fake")
    llm = MagicMock()
    llm.ainvoke = AsyncMock()
    ctor = MagicMock(return_value=llm)
    monkeypatch.setattr(d, "ChatGoogleGenerativeAI", ctor)
    return SimpleNamespace(ctor=ctor, llm=llm)


async def test_parse_search_results_with_llm(config, fake_llm):
    fake_llm.llm.ainvoke.return_value = SimpleNamespace(content=json.dumps([
        {"job_id": "li-1", "company_name": "Acme", "role_title": "Dev", "work_mode": "remote"},
        {"job_id": "", "role_title": "No id"},
        {"job_id": "li-3", "role_title": ""},
        {"job_id": "li-4", "role_title": "Bad", "work_mode": "teleport"},
    ]))
    jobs = await d.parse_search_results_with_llm([{"t": i} for i in range(30)], "linkedin", config)
    assert [j.job_id for j in jobs] == ["li-1"]
    assert jobs[0].portal is Portal.LINKEDIN and jobs[0].work_mode is WorkMode.REMOTE
    assert fake_llm.ctor.call_args.kwargs["google_api_key"] == "fake"
    assert fake_llm.ctor.call_args.kwargs["model"] == config.agent_settings.model
    human = fake_llm.llm.ainvoke.await_args.args[0][1].content
    assert '"t": 19' in human and '"t": 20' not in human  # truncated to 20 results


async def test_parse_search_results_with_llm_bad_json(config, fake_llm):
    fake_llm.llm.ainvoke.return_value = SimpleNamespace(content="```json not json```")
    assert await d.parse_search_results_with_llm([], "naukri", config) == []


async def test_parse_search_results_requires_api_key(config, monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    with pytest.raises(EnvironmentError):
        await d.parse_search_results_with_llm([], "linkedin", config)


def test_format_discovery_table(make_job):
    assert d.format_discovery_table([]) == "No matching jobs found."
    long = make_job("x", application_url="https://example.com/" + "a" * 100)
    out = d.format_discovery_table([make_job(), long]).splitlines()
    assert out[0].startswith("| # | Role")
    assert "| 1 | Backend Developer | Acme | linkedin | Chennai, India | 80/100 |" in out[2]
    assert out[3].endswith("... |")
