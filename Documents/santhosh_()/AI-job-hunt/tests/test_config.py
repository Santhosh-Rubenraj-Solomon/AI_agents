from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from src import config as cfg


def test_load_bundled_config_template():
    """The shipped config.yaml must validate and keep auto_submit off."""
    c = cfg.load_config()
    assert c.user_profile.name
    assert c.agent_settings.auto_submit is False
    assert c.minimum_match_score == 70
    assert c.agent_settings.model.startswith("gemini")
    assert set(c.portals_to_use) <= {"linkedin", "naukri", "indeed", "wellfound"}
    assert c.schedule.timezone == "Asia/Kolkata"


def test_load_config_from_explicit_path_applies_defaults(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text(yaml.safe_dump({"user_profile": {"name": "N", "email": "e", "phone": "p", "location": "l"}}))
    c = cfg.load_config(str(p))
    assert c.target_roles == []
    assert c.portals_to_use == ["linkedin"]
    assert c.minimum_match_score == 70
    assert c.agent_settings.auto_submit is False
    assert c.agent_settings.discovery_result_limit == 10
    assert c.user_profile.preferred_work_mode == "Hybrid"
    assert c.base_resume_path == "./resume/base_resume.pdf"


def test_load_config_missing_user_profile_fails(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("target_roles: [Dev]\n")
    with pytest.raises(ValidationError):
        cfg.load_config(str(p))


def test_load_config_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        cfg.load_config(str(tmp_path / "missing.yaml"))


def test_overrides_from_yaml(tmp_path, config_dict):
    config_dict["agent_settings"] = {"auto_submit": True, "model": "gemini-x"}
    p = tmp_path / "c.yaml"
    p.write_text(yaml.safe_dump(config_dict))
    c = cfg.load_config(str(p))
    assert c.agent_settings.auto_submit is True
    assert c.agent_settings.model == "gemini-x"
    assert c.agent_settings.retry_limit == 3  # untouched default


def test_get_env(monkeypatch):
    monkeypatch.setenv("JOBHUNT_X", "1")
    assert cfg.get_env("JOBHUNT_X") == "1"
    monkeypatch.delenv("JOBHUNT_X")
    assert cfg.get_env("JOBHUNT_X", "d") == "d"


def test_get_gemini_api_key(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    with pytest.raises(EnvironmentError):
        cfg.get_gemini_api_key()
    monkeypatch.setenv("GOOGLE_API_KEY", "fake-key")
    assert cfg.get_gemini_api_key() == "fake-key"


def test_get_portal_credentials(monkeypatch):
    monkeypatch.setenv("NAUKRI_EMAIL", "a@b.c")
    monkeypatch.setenv("NAUKRI_PASSWORD", "pw")
    assert cfg.get_portal_credentials("naukri") == {"email": "a@b.c", "password": "pw"}
    monkeypatch.delenv("INDEED_EMAIL", raising=False)
    monkeypatch.delenv("INDEED_PASSWORD", raising=False)
    assert cfg.get_portal_credentials("indeed") == {"email": "", "password": ""}


def test_resolve_path(tmp_path):
    assert cfg.resolve_path(str(tmp_path)) == tmp_path
    assert cfg.resolve_path("resume/x.pdf") == cfg.BASE_DIR / "resume/x.pdf"
    assert cfg.BASE_DIR == Path(__file__).resolve().parent.parent
