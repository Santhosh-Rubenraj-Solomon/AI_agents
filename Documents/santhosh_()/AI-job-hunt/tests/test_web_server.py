import time
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import web_server as ws
from src import memory
from src.test_mode import MOCK_JOBS


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(ws, "RESUME_DIR", tmp_path / "resume")
    (tmp_path / "resume").mkdir()
    monkeypatch.setattr(time, "sleep", lambda s: None)  # execute_agent sleeps in test mode
    monkeypatch.setitem(ws.agent_status, "running", False)
    monkeypatch.setitem(ws.agent_status, "phase", None)
    monkeypatch.setitem(ws.agent_status, "message", "Idle")
    return TestClient(ws.app)


def test_module_starts_in_test_mode_without_keys():
    assert ws.TEST_MODE is True
    assert ws.REAL_DATA is False


def test_index_serves_dashboard(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "<html" in r.text.lower()


def test_index_inline_fallback(client, monkeypatch, tmp_path):
    monkeypatch.setattr(ws, "BASE_DIR", tmp_path)  # no frontend/index.html here
    r = client.get("/")
    assert r.status_code == 200
    assert "AI Job Hunt Agent" in r.text


def test_status_initial(client):
    assert client.get("/status").json() == {"running": False, "phase": None, "message": "Idle"}


def test_mode_reports_test_mode(client):
    assert client.get("/mode").json() == {"test_mode": True, "live": False, "source": "Mock data · test mode"}


def test_mode_reports_live(client, monkeypatch):
    monkeypatch.setattr(ws, "TEST_MODE", False)
    monkeypatch.setattr(ws, "REAL_DATA", True)
    assert client.get("/mode").json() == {"test_mode": False, "live": True, "source": "Adzuna · live jobs"}


def test_jobs_empty(client):
    assert client.get("/jobs").json() == {"jobs": []}


def test_jobs_lists_persisted_jobs(client, make_job):
    memory.save_job(make_job("x", match_score=10))
    memory.save_job(make_job("y", match_score=90))
    jobs = client.get("/jobs").json()["jobs"]
    assert [j["job_id"] for j in jobs] == ["y", "x"]
    assert jobs[0]["portal"] == "linkedin" and jobs[0]["status"] == "discovered"


def test_jobs_500_on_db_error(client, monkeypatch):
    def boom():
        raise RuntimeError("db locked")
    monkeypatch.setattr(ws, "get_all_jobs", boom)
    r = client.get("/jobs")
    assert r.status_code == 500
    assert r.json()["detail"] == "db locked"


def test_tailoring_unknown_job_404(client):
    r = client.get("/tailoring/ghost")
    assert r.status_code == 404
    assert r.json()["detail"] == "Job not found"


def test_tailoring_known_job(client, make_job):
    memory.save_job(make_job("abc", company_name="Acme", role_title="Dev"))
    body = client.get("/tailoring/abc").json()
    assert body["job_id"] == "abc"
    assert body["keyword_after"] > body["keyword_before"]


@pytest.mark.parametrize("name", ["cv.pdf", "cv.docx"])
def test_upload_resume_accepts_pdf_and_docx(client, name):
    r = client.post("/upload-resume", files={"file": (name, b"%PDF-1.4 data", "application/octet-stream")})
    assert r.status_code == 200
    assert r.json()["message"] == f"Resume uploaded successfully: {name}"
    saved = ws.RESUME_DIR / "base_resume.pdf"
    assert saved.read_bytes() == b"%PDF-1.4 data"
    assert r.json()["path"] == str(saved)


@pytest.mark.parametrize("name", ["cv.txt", "cv.pdf.exe", "cv"])
def test_upload_resume_rejects_other_types(client, name):
    r = client.post("/upload-resume", files={"file": (name, b"x", "text/plain")})
    assert r.status_code == 400
    assert r.json()["detail"] == "Only PDF and DOCX files are supported"
    assert not (ws.RESUME_DIR / "base_resume.pdf").exists()


def test_upload_resume_requires_file(client):
    assert client.post("/upload-resume").status_code == 422


def test_upload_resume_500_when_write_fails(client, monkeypatch, tmp_path):
    monkeypatch.setattr(ws, "RESUME_DIR", tmp_path / "does-not-exist")
    r = client.post("/upload-resume", files={"file": ("cv.pdf", b"x", "application/pdf")})
    assert r.status_code == 500
    assert r.json()["detail"].startswith("Failed to save file")


def test_run_agent_requires_phase(client):
    assert client.post("/run-agent", json={}).status_code == 422


def test_run_agent_test_mode_runs_mock_discovery(client):
    r = client.post("/run-agent", json={"phase": "discover", "skills": ["python"]})
    assert r.status_code == 200
    assert r.json() == {"message": "Agent started in discover mode"}
    # TestClient runs background tasks before returning.
    st = client.get("/status").json()
    assert st == {
        "running": False,
        "phase": "discover",
        "message": f"[TEST MODE] Discovery complete: {len(MOCK_JOBS)} mock jobs",
    }
    assert len(client.get("/jobs").json()["jobs"]) == len(MOCK_JOBS)


def test_run_agent_rejects_while_running(client, monkeypatch):
    monkeypatch.setitem(ws.agent_status, "running", True)
    r = client.post("/run-agent", json={"phase": "discover"})
    assert r.status_code == 400
    assert r.json()["detail"] == "Agent is already running"


def test_run_agent_live_mode_forwards_filters(client, monkeypatch, config, make_job):
    monkeypatch.setattr(ws, "TEST_MODE", False)
    monkeypatch.setattr(ws, "load_config", lambda: config)
    fake = AsyncMock(return_value=[make_job("adzuna-1")])
    monkeypatch.setattr(ws, "run_discovery", fake)
    client.post("/run-agent", json={
        "phase": "discover", "skills": ["go"], "role": "AI Developer",
        "location": "Chennai", "work_type": "remote",
    })
    fake.assert_awaited_once_with(
        config, resume_skills=["go"], role="AI Developer", location="Chennai", work_type="remote",
    )
    assert client.get("/status").json()["message"] == "[LIVE · Adzuna] Discovery complete: 1 real jobs"


def test_run_agent_error_is_reported_and_running_reset(client, monkeypatch):
    def boom(skills=None):
        raise RuntimeError("disk full")
    monkeypatch.setattr(ws, "mock_discovery", boom)
    client.post("/run-agent", json={"phase": "discover"})
    st = client.get("/status").json()
    assert st["message"] == "Error: disk full"
    assert st["running"] is False


def test_web_server_never_exposes_submission(client):
    """Safety model: no route can trigger submission."""
    paths = {r.path for r in ws.app.routes}
    assert not any("submit" in p for p in paths)


# Minor bug: web_server.py:463 calls the blocking time.sleep(1) inside the
# `async def execute_agent` coroutine, which freezes the whole event loop
# (including /status polling) for a second on every test-mode run. It should be
# `await asyncio.sleep(1)`.
@pytest.mark.xfail(reason="web_server.py:463 blocks the event loop with time.sleep in async code", strict=True)
async def test_execute_agent_does_not_block_event_loop(monkeypatch):
    calls = []
    monkeypatch.setattr(time, "sleep", lambda s: calls.append(s))
    monkeypatch.setattr(ws, "mock_discovery", lambda skills=None: [])
    await ws.execute_agent("discover", None, None)
    assert calls == []
