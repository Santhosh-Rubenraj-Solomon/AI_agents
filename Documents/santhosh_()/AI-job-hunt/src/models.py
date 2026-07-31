"""Data models for jobs, applications, and resume versions."""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    DISCOVERED = "discovered"
    TAILORED = "tailored"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    SKIPPED = "skipped"
    APPLIED = "applied"
    FAILED = "failed"
    REJECTED = "rejected"
    INTERVIEW = "interview"


class WorkMode(str, Enum):
    REMOTE = "remote"
    ONSITE = "on-site"
    HYBRID = "hybrid"
    UNKNOWN = "unknown"


class Portal(str, Enum):
    LINKEDIN = "linkedin"
    NAUKRI = "naukri"
    INDEED = "indeed"
    WELLFOUND = "wellfound"
    ADZUNA = "adzuna"


class Job(BaseModel):
    job_id: str
    company_name: str
    role_title: str
    location: str = ""
    work_mode: WorkMode = WorkMode.UNKNOWN
    date_posted: Optional[str] = None
    application_url: str = ""
    job_description: str = ""
    portal: Portal = Portal.LINKEDIN
    match_score: int = 0
    status: JobStatus = JobStatus.DISCOVERED
    resume_version: Optional[str] = None
    cover_letter_path: Optional[str] = None
    keyword_match_before: float = 0.0
    keyword_match_after: float = 0.0
    ats_score_before: float = 0.0
    ats_score_after: float = 0.0
    discovered_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    applied_at: Optional[str] = None
    error_description: Optional[str] = None


class JDAnalysis(BaseModel):
    """Parsed result from a job description."""
    hard_skills: list[str] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    seniority_level: str = "mid"
    key_responsibilities: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)


class ResumeAnalysis(BaseModel):
    """Comparison of resume keywords vs JD."""
    keywords_present: list[str] = Field(default_factory=list)
    keywords_missing: list[str] = Field(default_factory=list)
    weak_bullets: list[str] = Field(default_factory=list)
    keyword_match_pct: float = 0.0
    ats_score_estimate: float = 0.0


class MatchScoreBreakdown(BaseModel):
    skills_match: int = 0       # out of 40
    role_title_match: int = 0   # out of 20
    location_match: int = 0     # out of 20
    recency: int = 0            # out of 10
    company_pref: int = 0       # out of 10
    total: int = 0              # out of 100


class ApplicationRecord(BaseModel):
    """A single row in the application tracker."""
    job_id: str
    company: str
    role_title: str
    portal: str
    match_score: int
    resume_version: str
    status: JobStatus
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())


class DailyReport(BaseModel):
    date: str
    jobs_discovered: int = 0
    resumes_tailored: int = 0
    applications_submitted: int = 0
    pending_approval: int = 0
    failed_submissions: int = 0
    avg_keyword_before: float = 0.0
    avg_keyword_after: float = 0.0
    applied_jobs: list[Job] = Field(default_factory=list)
    pending_jobs: list[Job] = Field(default_factory=list)
    failed_jobs: list[Job] = Field(default_factory=list)
