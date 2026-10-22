"""Shared pytest fixtures for the AI Job Hunt agent.

Isolation guarantees for every test:
  * No real API keys: Adzuna / Gemini env vars are blanked BEFORE any project
    module is imported (src.config calls load_dotenv() at import time, and
    load_dotenv never overrides variables that already exist).
  * No network / LLM: `langchain_google_genai` is replaced by a stub if it is not
    importable (requirements pin >=4.0.0, which needs Python >= 3.10), and tests
    that touch LLM/HTTP code patch those call sites explicitly.
  * No writes into the repo: the SQLite DB path is redirected to a temp dir for
    the whole session (web_server runs init_db() at import) and to a fresh
    tmp_path DB for every test.
"""

import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

for _var in ("ADZUNA_APP_ID", "ADZUNA_APP_KEY", "GOOGLE_API_KEY"):
    os.environ[_var] = ""

try:  # pragma: no cover - depends on interpreter version
    import langchain_google_genai  # noqa: F401
except ImportError:  # Gemini SDK unavailable (e.g. Python 3.9) -> stub it.
    _stub = types.ModuleType("langchain_google_genai")
    _stub.ChatGoogleGenerativeAI = MagicMock(name="ChatGoogleGenerativeAI")
    sys.modules["langchain_google_genai"] = _stub

import src.memory as memory  # noqa: E402

_SESSION_DB_DIR = tempfile.mkdtemp(prefix="jobhunt-tests-")
memory.DB_PATH = Path(_SESSION_DB_DIR) / "session.db"

from src.config import AppConfig  # noqa: E402
from src.models import Job, JobStatus, Portal, WorkMode  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    """Point every memory call at a fresh, initialised SQLite file."""
    db = tmp_path / "jobhunt.db"
    monkeypatch.setattr(memory, "DB_PATH", db)
    memory.init_db()
    return db


@pytest.fixture(autouse=True)
def no_api_keys(monkeypatch):
    for var in ("ADZUNA_APP_ID", "ADZUNA_APP_KEY", "GOOGLE_API_KEY"):
        monkeypatch.setenv(var, "")


@pytest.fixture
def config_dict():
    return {
        "user_profile": {
            "name": "Test User",
            "email": "test@example.com",
            "phone": "+1-555-0100",
            "location": "Chennai, India",
        },
        "target_roles": ["Backend Developer", "AI Developer"],
        "target_companies": [],
        "excluded_companies": ["BadCorp"],
        "preferred_locations": ["Chennai", "Remote"],
        "minimum_match_score": 50,
        "portals_to_use": ["linkedin", "naukri"],
        "agent_settings": {"discovery_result_limit": 5},
    }


@pytest.fixture
def config(config_dict):
    return AppConfig(**config_dict)


@pytest.fixture
def make_job():
    def _make(job_id="job-1", **overrides):
        data = dict(
            job_id=job_id,
            company_name="Acme",
            role_title="Backend Developer",
            location="Chennai, India",
            work_mode=WorkMode.HYBRID,
            portal=Portal.LINKEDIN,
            application_url="https://example.com/jobs/1",
            job_description="Python FastAPI PostgreSQL Docker",
            match_score=80,
            status=JobStatus.DISCOVERED,
        )
        data.update(overrides)
        return Job(**data)

    return _make
