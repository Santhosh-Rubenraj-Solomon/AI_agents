"""Configuration loader — reads config.yaml and .env for the job agent."""

import os
from pathlib import Path
from typing import Optional

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


class UserProfile(BaseModel):
    name: str
    email: str
    phone: str
    location: str
    linkedin_url: str = ""
    portfolio_url: str = ""
    notice_period: str = "Immediate"
    expected_salary: str = ""
    willing_to_relocate: bool = True
    preferred_work_mode: str = "Hybrid"


class AgentSettings(BaseModel):
    max_daily_applications: int = 15
    auto_submit: bool = False
    retry_limit: int = 3
    retry_delay_seconds: int = 5
    discovery_result_limit: int = 10
    model: str = "gemini-2.0-flash"
    notification_channel: str = "email"


class Schedule(BaseModel):
    discovery_time: str = "08:00"
    tailoring_time: str = "08:30"
    notification_time: str = "09:00"
    submission_time: str = "12:00"
    report_time: str = "18:00"
    timezone: str = "Asia/Kolkata"


class AppConfig(BaseModel):
    user_profile: UserProfile
    target_roles: list[str] = Field(default_factory=list)
    target_companies: list[str] = Field(default_factory=list)
    excluded_companies: list[str] = Field(default_factory=list)
    preferred_locations: list[str] = Field(default_factory=list)
    minimum_match_score: int = 70
    portals_to_use: list[str] = Field(default_factory=lambda: ["linkedin"])
    base_resume_path: str = "./resume/base_resume.pdf"
    agent_settings: AgentSettings = Field(default_factory=AgentSettings)
    schedule: Schedule = Field(default_factory=Schedule)


def load_config(config_path: Optional[str] = None) -> AppConfig:
    """Load and validate the YAML configuration file."""
    if config_path is None:
        config_path = str(BASE_DIR / "config.yaml")

    with open(config_path, "r") as f:
        raw = yaml.safe_load(f)

    return AppConfig(**raw)


def get_env(key: str, default: str = "") -> str:
    """Safely retrieve an environment variable."""
    return os.getenv(key, default)


def get_gemini_api_key() -> str:
    key = os.getenv("GOOGLE_API_KEY", "")
    if not key:
        raise EnvironmentError("GOOGLE_API_KEY is not set. Add it to your .env file.")
    return key


def get_portal_credentials(portal: str) -> dict[str, str]:
    """Return credentials for a given portal from env vars. Never log these."""
    portal_upper = portal.upper()
    return {
        "email": os.getenv(f"{portal_upper}_EMAIL", ""),
        "password": os.getenv(f"{portal_upper}_PASSWORD", ""),
    }


def resolve_path(relative_path: str) -> Path:
    """Resolve a path relative to the project root."""
    p = Path(relative_path)
    if p.is_absolute():
        return p
    return BASE_DIR / p
