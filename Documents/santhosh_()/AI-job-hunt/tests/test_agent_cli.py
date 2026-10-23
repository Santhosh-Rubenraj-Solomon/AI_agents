import sys
from argparse import Namespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml

import agent
from src import memory
from src.models import JobStatus


def ns(**kw):
    base = dict(phase="all", max_jobs=10, job_id=None, config=None, response=None, skills=[])
    base.update(kw)
    return Namespace(**base)


@pytest.fixture
def config_file(tmp_path, config_dict):
    def _write(**agent_settings):
        config_dict["agent_settings"].update(agent_settings)
        p = tmp_path / "config.yaml"
        p.write_text(yaml.safe_dump(config_dict))
        return str(p)
    return _write


def test_parse_args_defaults(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["agent.py"])
    a = agent.parse_args()
    assert (a.phase, a.max_jobs, a.job_id, a.config, a.response, a.skills) == ("all", 10, None, None, None, [])


def test_parse_args_all_flags(monkeypatch):
    monkeypatch.setattr(sys, "argv", [
        "agent.py", "--phase", "tailor", "--max-jobs", "3", "--job-id", "j1",
        "--config", "c.yaml", "--response", "STOP", "--skills", "python", "go",
    ])
    a = agent.parse_args()
    assert (a.phase, a.max_jobs, a.job_id, a.config, a.response, a.skills) == ("tailor", 3, "j1", "c.yaml", "STOP", ["python", "go"])


def test_parse_args_rejects_unknown_phase(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["agent.py", "--phase", "apply-everywhere"])
    with pytest.raises(SystemExit):
        agent.parse_args()


async def test_run_agent_refuses_auto_submit(config_file, monkeypatch):
    """Safety guard #2 (CLI side): exits before the graph is even built."""
    build = MagicMock()
    monkeypatch.setattr(agent, "build_graph", build)
    with pytest.raises(SystemExit) as exc:
        await agent.run_agent(ns(config=config_file(auto_submit=True), phase="submit"))
    assert exc.value.code == 1
    build.assert_not_called()


async def test_run_agent_status_phase(config_file, monkeypatch, make_job):
    memory.save_job(make_job())
    build = MagicMock()
    monkeypatch.setattr(agent, "build_graph", build)
    printed = []
    monkeypatch.setattr(agent.console, "print", lambda *a, **k: printed.append(a[0] if a else ""))
    await agent.run_agent(ns(config=config_file(), phase="status"))
    build.assert_not_called()
    assert any("Full Application Status Report" in str(p) for p in printed)


async def test_run_agent_approve_with_response(config_file, monkeypatch, make_job):
    memory.save_job(make_job("JOB1", status=JobStatus.PENDING_APPROVAL))
    monkeypatch.setattr(agent, "build_graph", MagicMock())
    await agent.run_agent(ns(config=config_file(), phase="approve", response="SKIP JOB1"))
    assert memory.get_job("JOB1").status is JobStatus.SKIPPED


async def test_run_agent_builds_and_invokes_graph(config_file, monkeypatch):
    graph = MagicMock()
    graph.ainvoke = AsyncMock(return_value={"errors": ["warn"], "discovered_jobs": [1, 2],
                                            "submission_results": [{"status": "applied"}], "report": "r"})
    monkeypatch.setattr(agent, "build_graph", MagicMock(return_value=graph))
    await agent.run_agent(ns(config=config_file(), phase="discover", max_jobs=4, job_id="x", skills=["py"]))
    state = graph.ainvoke.await_args.args[0]
    assert state["phase"] == "discover"
    assert state["max_jobs"] == 4 and state["target_job_id"] == "x" and state["resume_skills"] == ["py"]
    assert state["discovered_jobs"] == [] and state["errors"] == []
    assert state["config"].agent_settings.auto_submit is False
