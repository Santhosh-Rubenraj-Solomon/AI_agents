"""LangGraph workflow — orchestrates all 5 phases of the job application agent."""

import json
import operator
from typing import Annotated, TypedDict, Optional

from langgraph.graph import StateGraph, END

from src.config import AppConfig, load_config
from src.models import Job, JobStatus
from src.memory import init_db, get_jobs_by_status
from src.phases.discovery import run_discovery, format_discovery_table
from src.phases.tailoring import run_tailoring, format_tailoring_table
from src.phases.approval import (
    send_approval_requests,
    get_approved_jobs,
    format_approval_summary,
)
from src.phases.submission import run_submission
from src.phases.reporting import build_daily_report, format_daily_report, send_daily_report


# ── State Definition ──────────────────────────────────────────────────────

class AgentState(TypedDict):
    config: AppConfig
    phase: str
    discovered_jobs: list[Job]
    tailoring_results: list[dict]
    approval_results: list[dict]
    submission_results: list[dict]
    report: str
    resume_skills: list[str]
    errors: list[str]
    max_jobs: int
    target_job_id: Optional[str]


# ── Node Functions ────────────────────────────────────────────────────────

async def node_init(state: AgentState) -> dict:
    """Initialize the database and validate configuration."""
    init_db()
    return {"errors": []}


async def node_discover(state: AgentState) -> dict:
    """Phase 1: Search portals and discover matching jobs."""
    config = state["config"]
    resume_skills = state.get("resume_skills", [])

    try:
        jobs = await run_discovery(config, resume_skills)
        max_jobs = state.get("max_jobs", config.agent_settings.discovery_result_limit)
        jobs = jobs[:max_jobs]

        table = format_discovery_table(jobs)
        print("\n" + table + "\n")

        return {"discovered_jobs": jobs}
    except Exception as e:
        return {"discovered_jobs": [], "errors": [f"Discovery failed: {str(e)}"]}


async def node_tailor(state: AgentState) -> dict:
    """Phase 2: Tailor resumes and cover letters for discovered jobs."""
    config = state["config"]
    jobs = state.get("discovered_jobs", [])

    # If targeting a specific job, filter
    target_id = state.get("target_job_id")
    if target_id:
        jobs = [j for j in jobs if j.job_id == target_id]
        if not jobs:
            # Try loading from DB
            from src.memory import get_job
            job = get_job(target_id)
            if job:
                jobs = [job]

    if not jobs:
        return {"tailoring_results": [], "errors": ["No jobs to tailor."]}

    try:
        results = await run_tailoring(jobs, config)

        for r in results:
            print(format_tailoring_table(r))

        return {"tailoring_results": results}
    except Exception as e:
        return {"tailoring_results": [], "errors": [f"Tailoring failed: {str(e)}"]}


async def node_approve(state: AgentState) -> dict:
    """Phase 3: Send approval notifications and wait for human response."""
    config = state["config"]

    # Get tailored jobs from DB
    tailored_jobs = get_jobs_by_status(JobStatus.TAILORED)

    if not tailored_jobs:
        return {"approval_results": [], "errors": ["No tailored jobs to approve."]}

    try:
        results = await send_approval_requests(tailored_jobs, config)
        summary = format_approval_summary(results)
        print("\n" + summary + "\n")
        return {"approval_results": results}
    except Exception as e:
        return {"approval_results": [], "errors": [f"Approval failed: {str(e)}"]}


async def node_submit(state: AgentState) -> dict:
    """Phase 4: Submit applications for approved jobs."""
    config = state["config"]

    # Safety check: auto_submit must be false
    if config.agent_settings.auto_submit:
        return {
            "submission_results": [],
            "errors": ["SAFETY: auto_submit is true. Set to false in config.yaml."],
        }

    approved_jobs = get_approved_jobs()

    if not approved_jobs:
        return {"submission_results": [], "errors": ["No approved jobs to submit."]}

    try:
        results = await run_submission(approved_jobs, config)
        return {"submission_results": results}
    except Exception as e:
        return {"submission_results": [], "errors": [f"Submission failed: {str(e)}"]}


async def node_report(state: AgentState) -> dict:
    """Phase 5: Generate and send the daily summary report."""
    try:
        report_text = await send_daily_report(state.get("config"))
        print("\n" + report_text + "\n")
        return {"report": report_text}
    except Exception as e:
        return {"report": "", "errors": [f"Reporting failed: {str(e)}"]}


# ── Routing Logic ─────────────────────────────────────────────────────────

def route_after_init(state: AgentState) -> str:
    """Determine which phase to run based on the --phase argument."""
    phase = state.get("phase", "all")

    if phase == "discover":
        return "discover"
    elif phase == "tailor":
        return "tailor"
    elif phase == "approve":
        return "approve"
    elif phase == "submit":
        return "submit"
    elif phase == "report":
        return "report"
    else:  # "all"
        return "discover"


def route_after_discover(state: AgentState) -> str:
    phase = state.get("phase", "all")
    if phase == "discover":
        return END
    return "tailor"


def route_after_tailor(state: AgentState) -> str:
    phase = state.get("phase", "all")
    if phase == "tailor":
        return END
    return "approve"


def route_after_approve(state: AgentState) -> str:
    phase = state.get("phase", "all")
    if phase == "approve":
        return END
    # In "all" mode, we stop after approve — user must come back to submit
    # This enforces the human-in-the-loop gate
    return END


def route_after_submit(state: AgentState) -> str:
    phase = state.get("phase", "all")
    if phase == "submit":
        return "report"
    return "report"


# ── Graph Construction ────────────────────────────────────────────────────

def build_graph() -> StateGraph:
    """Build and compile the LangGraph workflow."""
    graph = StateGraph(AgentState)

    # Add nodes
    graph.add_node("init", node_init)
    graph.add_node("discover", node_discover)
    graph.add_node("tailor", node_tailor)
    graph.add_node("approve", node_approve)
    graph.add_node("submit", node_submit)
    graph.add_node("report", node_report)

    # Entry point
    graph.set_entry_point("init")

    # Conditional routing from init
    graph.add_conditional_edges("init", route_after_init, {
        "discover": "discover",
        "tailor": "tailor",
        "approve": "approve",
        "submit": "submit",
        "report": "report",
    })

    # Conditional routing between phases
    graph.add_conditional_edges("discover", route_after_discover, {
        "tailor": "tailor",
        END: END,
    })

    graph.add_conditional_edges("tailor", route_after_tailor, {
        "approve": "approve",
        END: END,
    })

    graph.add_conditional_edges("approve", route_after_approve, {
        END: END,
    })

    graph.add_conditional_edges("submit", route_after_submit, {
        "report": "report",
    })

    graph.add_edge("report", END)

    return graph.compile()
