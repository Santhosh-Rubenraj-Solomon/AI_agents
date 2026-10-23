from unittest.mock import AsyncMock, MagicMock

import pytest
from langgraph.graph import END

from src import graph as g
from src import memory
from src.models import JobStatus


@pytest.fixture
def state(config):
    return {
        "config": config,
        "phase": "all",
        "discovered_jobs": [],
        "tailoring_results": [],
        "approval_results": [],
        "submission_results": [],
        "report": "",
        "resume_skills": ["python"],
        "errors": [],
        "max_jobs": 10,
        "target_job_id": None,
    }


@pytest.fixture
def phases(monkeypatch, make_job):
    """Replace every phase implementation the graph calls with a mock."""
    m = MagicMock()
    m.run_discovery = AsyncMock(return_value=[make_job("a"), make_job("b"), make_job("c")])
    m.run_tailoring = AsyncMock(side_effect=lambda jobs, cfg: [{"job_id": j.job_id} for j in jobs])
    m.send_approval_requests = AsyncMock(side_effect=lambda jobs, cfg: [{"job_id": j.job_id} for j in jobs])
    m.run_submission = AsyncMock(return_value=[{"job_id": "a", "status": "applied"}])
    m.send_daily_report = AsyncMock(return_value="REPORT")
    for name in ("run_discovery", "run_tailoring", "send_approval_requests", "run_submission", "send_daily_report"):
        monkeypatch.setattr(g, name, getattr(m, name))
    monkeypatch.setattr(g, "format_discovery_table", lambda jobs: "table")
    monkeypatch.setattr(g, "format_tailoring_table", lambda r: "t")
    monkeypatch.setattr(g, "format_approval_summary", lambda r: "s")
    return m


# ── Routing ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "phase,expected",
    [("discover", "discover"), ("tailor", "tailor"), ("approve", "approve"),
     ("submit", "submit"), ("report", "report"), ("all", "discover"), ("weird", "discover")],
)
def test_route_after_init(phase, expected):
    assert g.route_after_init({"phase": phase}) == expected


def test_route_after_init_defaults_to_discover():
    assert g.route_after_init({}) == "discover"


def test_route_after_discover_and_tailor():
    assert g.route_after_discover({"phase": "discover"}) == END
    assert g.route_after_discover({"phase": "all"}) == "tailor"
    assert g.route_after_tailor({"phase": "tailor"}) == END
    assert g.route_after_tailor({"phase": "all"}) == "approve"


@pytest.mark.parametrize("phase", ["approve", "all", "submit", "anything"])
def test_route_after_approve_never_reaches_submit(phase):
    """Safety guard #3: approval never routes to submission."""
    assert g.route_after_approve({"phase": phase}) == END


def test_route_after_submit_goes_to_report():
    assert g.route_after_submit({"phase": "submit"}) == "report"
    assert g.route_after_submit({}) == "report"


# ── Nodes ──────────────────────────────────────────────────────────────────

async def test_node_init_initialises_db(state, isolated_db):
    isolated_db.unlink()
    assert await g.node_init(state) == {"errors": []}
    assert isolated_db.exists()


async def test_node_discover_truncates_to_max_jobs(state, phases):
    state["max_jobs"] = 2
    out = await g.node_discover(state)
    assert [j.job_id for j in out["discovered_jobs"]] == ["a", "b"]
    phases.run_discovery.assert_awaited_once_with(state["config"], ["python"])


async def test_node_discover_captures_errors(state, phases):
    phases.run_discovery.side_effect = RuntimeError("quota")
    out = await g.node_discover(state)
    assert out == {"discovered_jobs": [], "errors": ["Discovery failed: quota"]}


async def test_node_tailor_no_jobs(state, phases):
    out = await g.node_tailor(state)
    assert out == {"tailoring_results": [], "errors": ["No jobs to tailor."]}
    phases.run_tailoring.assert_not_awaited()


async def test_node_tailor_filters_to_target(state, phases, make_job):
    state["discovered_jobs"] = [make_job("a"), make_job("b")]
    state["target_job_id"] = "b"
    out = await g.node_tailor(state)
    assert out["tailoring_results"] == [{"job_id": "b"}]


async def test_node_tailor_loads_target_from_db(state, phases, make_job):
    memory.save_job(make_job("from-db"))
    state["target_job_id"] = "from-db"
    out = await g.node_tailor(state)
    assert out["tailoring_results"] == [{"job_id": "from-db"}]


async def test_node_tailor_unknown_target(state, phases):
    state["target_job_id"] = "ghost"
    out = await g.node_tailor(state)
    assert out["errors"] == ["No jobs to tailor."]


async def test_node_tailor_captures_errors(state, phases, make_job):
    state["discovered_jobs"] = [make_job()]
    phases.run_tailoring.side_effect = ValueError("llm down")
    out = await g.node_tailor(state)
    assert out == {"tailoring_results": [], "errors": ["Tailoring failed: llm down"]}


async def test_node_approve_uses_tailored_jobs_from_db(state, phases, make_job):
    memory.save_job(make_job("t1", status=JobStatus.TAILORED))
    memory.save_job(make_job("d1", status=JobStatus.DISCOVERED))
    out = await g.node_approve(state)
    assert out == {"approval_results": [{"job_id": "t1"}]}


async def test_node_approve_without_tailored_jobs(state, phases):
    out = await g.node_approve(state)
    assert out["errors"] == ["No tailored jobs to approve."]
    phases.send_approval_requests.assert_not_awaited()


async def test_node_approve_captures_errors(state, phases, make_job):
    memory.save_job(make_job("t1", status=JobStatus.TAILORED))
    phases.send_approval_requests.side_effect = RuntimeError("smtp")
    out = await g.node_approve(state)
    assert out["errors"] == ["Approval failed: smtp"]


async def test_node_submit_refuses_when_auto_submit_true(state, phases, make_job):
    """Safety guard #2 (graph side)."""
    memory.save_job(make_job("ok", status=JobStatus.APPROVED))
    state["config"].agent_settings.auto_submit = True
    out = await g.node_submit(state)
    assert out["submission_results"] == []
    assert "SAFETY" in out["errors"][0]
    phases.run_submission.assert_not_awaited()


async def test_node_submit_no_approved_jobs(state, phases):
    out = await g.node_submit(state)
    assert out["errors"] == ["No approved jobs to submit."]


async def test_node_submit_runs_for_approved(state, phases, make_job):
    memory.save_job(make_job("ok", status=JobStatus.APPROVED))
    out = await g.node_submit(state)
    assert out == {"submission_results": [{"job_id": "a", "status": "applied"}]}
    jobs_arg = phases.run_submission.await_args.args[0]
    assert [j.job_id for j in jobs_arg] == ["ok"]


async def test_node_submit_captures_errors(state, phases, make_job):
    memory.save_job(make_job("ok", status=JobStatus.APPROVED))
    phases.run_submission.side_effect = RuntimeError("browser")
    out = await g.node_submit(state)
    assert out["errors"] == ["Submission failed: browser"]


async def test_node_report(state, phases):
    assert await g.node_report(state) == {"report": "REPORT"}
    phases.send_daily_report.side_effect = RuntimeError("x")
    assert await g.node_report(state) == {"report": "", "errors": ["Reporting failed: x"]}


# ── Compiled graph ─────────────────────────────────────────────────────────

async def test_graph_discover_only(state, phases):
    state["phase"] = "discover"
    result = await g.build_graph().ainvoke(state)
    assert len(result["discovered_jobs"]) == 3
    phases.run_tailoring.assert_not_awaited()


async def test_graph_all_stops_after_approval(state, phases, monkeypatch, make_job):
    """An "all" run must never reach submission (README safety model)."""
    def fake_tailor(jobs, cfg):
        for j in jobs:
            memory.save_job(j.model_copy(update={"status": JobStatus.TAILORED}))
        return [{"job_id": j.job_id} for j in jobs]

    phases.run_tailoring.side_effect = fake_tailor
    memory.save_job(make_job("pre-approved", status=JobStatus.APPROVED))

    result = await g.build_graph().ainvoke(state)

    phases.run_discovery.assert_awaited_once()
    phases.run_tailoring.assert_awaited_once()
    phases.send_approval_requests.assert_awaited_once()
    phases.run_submission.assert_not_awaited()
    phases.send_daily_report.assert_not_awaited()
    assert len(result["approval_results"]) == 3
    assert result["submission_results"] == []


async def test_graph_submit_phase_runs_submit_then_report(state, phases, make_job):
    memory.save_job(make_job("ok", status=JobStatus.APPROVED))
    state["phase"] = "submit"
    result = await g.build_graph().ainvoke(state)
    phases.run_discovery.assert_not_awaited()
    phases.run_submission.assert_awaited_once()
    phases.send_daily_report.assert_awaited_once()
    assert result["report"] == "REPORT"


async def test_graph_report_phase(state, phases):
    state["phase"] = "report"
    result = await g.build_graph().ainvoke(state)
    assert result["report"] == "REPORT"
    phases.run_submission.assert_not_awaited()
