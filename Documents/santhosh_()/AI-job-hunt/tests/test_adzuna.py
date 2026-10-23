import httpx
import pytest

from src.models import Portal, WorkMode
from src.tools import adzuna as az


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "key")


@pytest.fixture
def transport(monkeypatch):
    """Route every httpx.AsyncClient created by the adzuna module to a mock."""
    state = {"requests": [], "handler": lambda req: httpx.Response(200, json={"results": []})}

    def handler(request):
        state["requests"].append(request)
        return state["handler"](request)

    real = httpx.AsyncClient
    monkeypatch.setattr(az.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return state


@pytest.mark.parametrize("app_id,app_key,expected", [("", "", False), ("a", "", False), ("", "b", False), ("a", "b", True)])
def test_adzuna_configured(monkeypatch, app_id, app_key, expected):
    monkeypatch.setenv("ADZUNA_APP_ID", app_id)
    monkeypatch.setenv("ADZUNA_APP_KEY", app_key)
    assert az.adzuna_configured() is expected


def test_clean_and_infer_work_mode():
    assert az._clean("<b>Senior</b> &amp; <i>Lead</i> ") == "Senior & Lead"
    assert az._clean(None) == ""
    assert az._infer_work_mode("Fully REMOTE role") is WorkMode.REMOTE
    assert az._infer_work_mode("hybrid 3 days") is WorkMode.HYBRID
    assert az._infer_work_mode("office") is WorkMode.UNKNOWN


async def test_search_adzuna_without_keys_makes_no_calls(config, transport):
    assert await az.search_adzuna(config) == []
    assert transport["requests"] == []


async def test_search_adzuna_maps_results(config, keys, transport):
    transport["handler"] = lambda req: httpx.Response(200, json={"results": [
        {"id": 1, "title": "<strong>Backend</strong> Developer", "description": "Remote python &amp; go",
         "company": {"display_name": "Acme"}, "location": {"display_name": "Chennai"},
         "created": "2026-10-20T00:00:00Z", "redirect_url": "https://adzuna/1"},
        {"id": 1, "title": "dup"},
        {"id": 2, "title": "X", "description": "", "company": None, "location": None},
    ]})
    config.target_roles = ["Backend Developer"]
    config.preferred_locations = ["Chennai"]
    jobs = await az.search_adzuna(config)
    assert [j.job_id for j in jobs] == ["adzuna-1", "adzuna-2"]
    j = jobs[0]
    assert (j.role_title, j.company_name, j.location) == ("Backend Developer", "Acme", "Chennai")
    assert j.job_description == "Remote python & go"
    assert j.work_mode is WorkMode.REMOTE and j.portal is Portal.ADZUNA
    assert j.application_url == "https://adzuna/1"
    assert jobs[1].company_name == "Unknown" and jobs[1].location == ""

    req = transport["requests"][0]
    assert req.url.path == "/v1/api/jobs/in/search/1"
    assert req.url.params["what"] == "Backend Developer"
    assert req.url.params["where"] == "Chennai"
    assert req.url.params["app_id"] == "id" and req.url.params["app_key"] == "key"


async def test_search_adzuna_region_mapping_and_skips(config, keys, transport):
    config.target_roles = ["Dev"]
    config.preferred_locations = ["Remote", "Dubai", "London", "USA"]
    await az.search_adzuna(config)
    got = [(r.url.path.split("/")[4], r.url.params["what"], r.url.params.get("where")) for r in transport["requests"]]
    assert got == [("in", "Dev remote", None), ("gb", "Dev", "London"), ("us", "Dev", None)]


@pytest.mark.parametrize("wt,what", [("remote", "AI Dev remote"), ("hybrid", "AI Dev hybrid"),
                                     ("on-site", "AI Dev on-site"), ("", "AI Dev")])
async def test_search_adzuna_filters_override_config(config, keys, transport, wt, what):
    await az.search_adzuna(config, role="AI Dev", location="Pune", work_type=wt)
    assert len(transport["requests"]) == 1
    assert transport["requests"][0].url.params["what"] == what
    assert transport["requests"][0].url.params["where"] == "Pune"


async def test_search_adzuna_caps_requests_per_run(config, keys, transport):
    config.target_roles = [f"Role{i}" for i in range(5)]
    config.preferred_locations = ["Chennai", "Pune", "Delhi"]
    await az.search_adzuna(config)
    assert len(transport["requests"]) == az.MAX_REQUESTS_PER_RUN


async def test_search_adzuna_tolerates_http_errors(config, keys, transport):
    config.target_roles = ["Dev"]
    config.preferred_locations = ["Chennai", "Pune"]
    responses = iter([httpx.Response(500), httpx.Response(200, json={"results": [{"id": 9, "title": "T"}]})])
    transport["handler"] = lambda req: next(responses)
    jobs = await az.search_adzuna(config)
    assert [j.job_id for j in jobs] == ["adzuna-9"]
