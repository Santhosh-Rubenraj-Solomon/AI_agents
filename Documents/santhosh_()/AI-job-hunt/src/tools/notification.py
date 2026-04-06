"""Notification tools — email, Slack, and WhatsApp alerts for human approval."""

import json
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional

from langchain_core.tools import tool


@tool
def notify_human(subject: str, message: str, channel: Optional[str] = None) -> str:
    """Send a notification to the human user for review/approval.

    Args:
        subject: Subject line of the notification.
        message: Full notification body (supports markdown/plain text).
        channel: Notification channel — 'email', 'slack', or 'whatsapp'.
                 If not specified, uses NOTIFICATION_CHANNEL env var.
    """
    ch = channel or os.getenv("NOTIFICATION_CHANNEL", "email")

    try:
        if ch == "email":
            return _send_email(subject, message)
        elif ch == "slack":
            return _send_slack(subject, message)
        elif ch == "whatsapp":
            return _send_whatsapp(message)
        else:
            return f"Unknown notification channel: {ch}. Supported: email, slack, whatsapp."
    except Exception as e:
        return f"Notification failed ({ch}): {str(e)}"


def _send_email(subject: str, body: str) -> str:
    """Send an email notification via SMTP."""
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "")
    to_email = os.getenv("NOTIFY_EMAIL_TO", "")

    if not all([smtp_user, smtp_pass, to_email]):
        return (
            "Email not configured. Set SMTP_USER, SMTP_PASSWORD, and "
            "NOTIFY_EMAIL_TO in your .env file."
        )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = to_email
    msg.attach(MIMEText(body, "plain"))

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, to_email, msg.as_string())

    return f"Email sent to {to_email}: {subject}"


def _send_slack(subject: str, body: str) -> str:
    """Send a Slack notification via incoming webhook."""
    import httpx

    webhook_url = os.getenv("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        return "Slack not configured. Set SLACK_WEBHOOK_URL in your .env file."

    payload = {
        "text": f"*{subject}*\n\n{body}",
    }
    resp = httpx.post(webhook_url, json=payload, timeout=10)
    if resp.status_code == 200:
        return f"Slack notification sent: {subject}"
    return f"Slack notification failed: {resp.status_code} {resp.text}"


def _send_whatsapp(body: str) -> str:
    """Send a WhatsApp message via Twilio."""
    try:
        from twilio.rest import Client
    except ImportError:
        return "Twilio not installed. Run: pip install twilio"

    account_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN", "")
    from_number = os.getenv("TWILIO_WHATSAPP_FROM", "")
    to_number = os.getenv("TWILIO_WHATSAPP_TO", "")

    if not all([account_sid, auth_token, from_number, to_number]):
        return (
            "WhatsApp not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, "
            "TWILIO_WHATSAPP_FROM, and TWILIO_WHATSAPP_TO in your .env file."
        )

    client = Client(account_sid, auth_token)
    message = client.messages.create(
        body=body,
        from_=from_number,
        to=to_number,
    )
    return f"WhatsApp message sent: {message.sid}"


def format_approval_message(
    role_title: str,
    company_name: str,
    portal: str,
    location: str,
    match_score: int,
    application_url: str,
    resume_version_path: str,
    cover_letter_path: str,
    before_score: float,
    after_score: float,
    job_id: str,
) -> tuple[str, str]:
    """Build the subject and body for the approval notification."""
    subject = f"[JobAgent] Ready to Apply — {role_title} at {company_name}"
    body = f"""Hi,

Your AI Job Agent has prepared an application and is awaiting your approval.

Job Details:
  Role:         {role_title}
  Company:      {company_name}
  Portal:       {portal}
  Location:     {location}
  Match Score:  {match_score}/100
  Job URL:      {application_url}

Resume Version: {resume_version_path}
Cover Letter:   {cover_letter_path}

Keyword match improved from {before_score:.0f}% → {after_score:.0f}%

To APPROVE this application, reply: APPROVE {job_id}
To SKIP this application, reply:    SKIP {job_id}
To STOP all applications, reply:    STOP

The agent will not submit anything until it receives your reply.
"""
    return subject, body
