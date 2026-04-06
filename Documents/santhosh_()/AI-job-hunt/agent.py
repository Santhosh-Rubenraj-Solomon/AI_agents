#!/usr/bin/env python3
"""AI Job Application Agent — main entry point.

Usage:
    python agent.py --phase all --max-jobs 10
    python agent.py --phase discover
    python agent.py --phase tailor --job-id "linkedin_job_12345"
    python agent.py --phase submit
    python agent.py --phase report
    python agent.py --phase approve --response "APPROVE linkedin_job_12345"
"""

import argparse
import asyncio
import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.config import load_config, AppConfig
from src.memory import init_db
from src.graph import build_graph, AgentState
from src.phases.approval import process_approval_response
from src.phases.reporting import get_full_status_report

console = Console()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AI Job Application Agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--phase",
        choices=["all", "discover", "tailor", "approve", "submit", "report", "status"],
        default="all",
        help="Which phase to run (default: all)",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=10,
        help="Maximum number of jobs to process (default: 10)",
    )
    parser.add_argument(
        "--job-id",
        type=str,
        default=None,
        help="Target a specific job by ID (for tailor/submit phases)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to config.yaml (default: ./config.yaml)",
    )
    parser.add_argument(
        "--response",
        type=str,
        default=None,
        help='Approval response, e.g. "APPROVE job_123" or "SKIP job_123" or "STOP"',
    )
    parser.add_argument(
        "--skills",
        nargs="*",
        default=[],
        help="List of your skills for better matching (space-separated)",
    )
    return parser.parse_args()


async def run_agent(args: argparse.Namespace) -> None:
    """Run the job agent pipeline."""

    # Load config
    config = load_config(args.config)

    # Initialize database
    init_db()

    console.print(Panel(
        f"[bold cyan]AI Job Application Agent[/bold cyan]\n"
        f"Phase: [green]{args.phase}[/green] | "
        f"Max jobs: [yellow]{args.max_jobs}[/yellow] | "
        f"Model: [magenta]{config.agent_settings.model}[/magenta]",
        title="JobAgent",
        border_style="blue",
    ))

    # Handle special phases that don't use the graph
    if args.phase == "status":
        report = get_full_status_report()
        console.print(report)
        return

    if args.phase == "approve" and args.response:
        updates = process_approval_response(args.response)
        for u in updates:
            console.print(f"  {u['job_id']}: {u['action']}")
        return

    # Safety check
    if config.agent_settings.auto_submit:
        console.print(
            "[bold red]ERROR:[/bold red] auto_submit is set to true in config.yaml. "
            "This is unsafe. Set it to false before running the agent.",
            style="red",
        )
        sys.exit(1)

    # Build and run the LangGraph workflow
    graph = build_graph()

    initial_state: AgentState = {
        "config": config,
        "phase": args.phase,
        "discovered_jobs": [],
        "tailoring_results": [],
        "approval_results": [],
        "submission_results": [],
        "report": "",
        "resume_skills": args.skills or [],
        "errors": [],
        "max_jobs": args.max_jobs,
        "target_job_id": args.job_id,
    }

    console.print(f"\n[dim]Running phase: {args.phase}...[/dim]\n")

    result = await graph.ainvoke(initial_state)

    # Print results summary
    if result.get("errors"):
        console.print("\n[bold yellow]Warnings / Errors:[/bold yellow]")
        for err in result["errors"]:
            console.print(f"  [red]• {err}[/red]")

    if result.get("discovered_jobs"):
        console.print(f"\n[green]✓ Discovered {len(result['discovered_jobs'])} jobs[/green]")

    if result.get("tailoring_results"):
        success = [r for r in result["tailoring_results"] if "error" not in r]
        console.print(f"[green]✓ Tailored {len(success)} resumes[/green]")

    if result.get("approval_results"):
        console.print(
            f"[green]✓ Sent {len(result['approval_results'])} approval requests[/green]"
        )

    if result.get("submission_results"):
        applied = [r for r in result["submission_results"] if r.get("status") == "applied"]
        console.print(f"[green]✓ Submitted {len(applied)} applications[/green]")

    if result.get("report"):
        console.print("[green]✓ Daily report generated[/green]")

    console.print("\n[dim]Done.[/dim]")


def main():
    args = parse_args()
    asyncio.run(run_agent(args))


if __name__ == "__main__":
    main()
