"""File operation tools — read/write resumes, cover letters, and reports."""

import json
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool

from src.config import BASE_DIR


@tool
def read_file(file_path: str) -> str:
    """Read a text file and return its contents.

    Args:
        file_path: Path to the file (absolute or relative to project root).
    """
    p = Path(file_path)
    if not p.is_absolute():
        p = BASE_DIR / p
    if not p.exists():
        return f"Error: File not found at {p}"
    return p.read_text(encoding="utf-8")


@tool
def write_file(file_path: str, content: str) -> str:
    """Write content to a file. Creates parent directories if needed.

    Args:
        file_path: Path to the file (absolute or relative to project root).
        content: Text content to write.
    """
    p = Path(file_path)
    if not p.is_absolute():
        p = BASE_DIR / p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Written {len(content)} chars to {p}"


@tool
def list_files(directory: str) -> str:
    """List files in a directory.

    Args:
        directory: Directory path (absolute or relative to project root).
    """
    p = Path(directory)
    if not p.is_absolute():
        p = BASE_DIR / p
    if not p.exists():
        return f"Error: Directory not found at {p}"
    files = sorted(p.rglob("*"))
    return "\n".join(str(f.relative_to(p)) for f in files if f.is_file())


def ensure_application_dir(company: str, role: str) -> Path:
    """Create and return the application directory for a specific job."""
    safe_company = company.replace(" ", "_").replace("/", "_")[:50]
    safe_role = role.replace(" ", "_").replace("/", "_")[:50]
    dir_path = BASE_DIR / "applications" / f"{safe_company}_{safe_role}"
    dir_path.mkdir(parents=True, exist_ok=True)
    return dir_path
