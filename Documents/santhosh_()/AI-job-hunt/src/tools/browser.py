"""Browser automation tools using Playwright for job application submission."""

import asyncio
import base64
import time
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from playwright.async_api import async_playwright, Browser, Page


_browser: Optional[Browser] = None
_page: Optional[Page] = None

SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent.parent / "screenshots"


async def _ensure_browser() -> Page:
    """Launch or reuse a browser instance and return the active page."""
    global _browser, _page
    if _browser is None or not _browser.is_connected():
        pw = await async_playwright().start()
        _browser = await pw.chromium.launch(headless=False)
        context = await _browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        _page = await context.new_page()
    return _page


def _run_async(coro):
    """Run an async coroutine from sync LangChain tool context."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(asyncio.run, coro).result()
        return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)


@tool
def browser_navigate(url: str) -> str:
    """Navigate the automation browser to the given URL.

    Args:
        url: The full URL to navigate to.
    """
    async def _nav():
        page = await _ensure_browser()
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        return f"Navigated to: {page.url}"
    return _run_async(_nav())


@tool
def browser_fill(selector: str, value: str) -> str:
    """Fill a form field on the current page.

    Args:
        selector: CSS selector for the input field.
        value: Value to type into the field.
    """
    async def _fill():
        page = await _ensure_browser()
        await page.fill(selector, value, timeout=10000)
        return f"Filled '{selector}' with value."
    return _run_async(_fill())


@tool
def browser_click(selector: str) -> str:
    """Click a button or link on the current page.

    Args:
        selector: CSS selector for the element to click.
    """
    async def _click():
        page = await _ensure_browser()
        await page.click(selector, timeout=10000)
        await page.wait_for_timeout(1500)
        return f"Clicked '{selector}'."
    return _run_async(_click())


@tool
def browser_upload(selector: str, file_path: str) -> str:
    """Upload a file to a form input on the current page.

    Args:
        selector: CSS selector for the file input element.
        file_path: Absolute path to the file to upload.
    """
    async def _upload():
        page = await _ensure_browser()
        await page.set_input_files(selector, file_path, timeout=10000)
        return f"Uploaded '{file_path}' to '{selector}'."
    return _run_async(_upload())


@tool
def browser_screenshot(description: str = "") -> str:
    """Take a screenshot of the current page and save it.

    Args:
        description: Optional description to include in the filename.
    """
    async def _screenshot():
        page = await _ensure_browser()
        SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        slug = description.replace(" ", "_")[:30] if description else "page"
        filename = f"{ts}_{slug}.png"
        path = SCREENSHOTS_DIR / filename
        await page.screenshot(path=str(path), full_page=False)
        title = await page.title()
        url = page.url
        return (
            f"Screenshot saved: {path}\n"
            f"Page title: {title}\n"
            f"Current URL: {url}"
        )
    return _run_async(_screenshot())


@tool
def browser_get_page_text() -> str:
    """Extract all visible text content from the current page."""
    async def _text():
        page = await _ensure_browser()
        text = await page.inner_text("body")
        return text[:5000]  # Truncate to avoid huge outputs
    return _run_async(_text())


async def close_browser() -> None:
    """Shutdown the browser gracefully."""
    global _browser, _page
    if _browser and _browser.is_connected():
        await _browser.close()
    _browser = None
    _page = None
