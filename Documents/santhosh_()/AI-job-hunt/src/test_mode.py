"""Test mode — returns mock data, no API keys needed."""

import random
from datetime import datetime, timedelta

from src.models import Job, JobStatus, Portal, WorkMode
from src.memory import save_job, init_db

MOCK_JOBS = [
    {
        "job_id": "google-backend-swe-001",
        "company_name": "Google",
        "role_title": "Backend Developer",
        "location": "Chennai, India",
        "work_mode": WorkMode.HYBRID,
        "portal": Portal.LINKEDIN,
        "application_url": "https://careers.google.com/jobs/results/backend-dev-chennai",
        "job_description": "We are looking for a Backend Developer with 3+ years of experience in Python, Django, REST APIs, PostgreSQL, Docker, and Kubernetes. You will build scalable microservices powering Google Pay's fintech platform.",
        "match_score": 92,
    },
    {
        "job_id": "stripe-fullstack-002",
        "company_name": "Stripe",
        "role_title": "Full Stack Developer",
        "location": "Remote",
        "work_mode": WorkMode.REMOTE,
        "portal": Portal.LINKEDIN,
        "application_url": "https://stripe.com/jobs/fullstack-remote",
        "job_description": "Stripe is hiring a Full Stack Developer to work on payment infrastructure. Required skills: React, Node.js, Python, TypeScript, PostgreSQL, AWS. Experience with fintech and payment systems is a strong plus.",
        "match_score": 89,
    },
    {
        "job_id": "razorpay-ai-dev-003",
        "company_name": "Razorpay",
        "role_title": "AI Developer",
        "location": "Bengaluru, India",
        "work_mode": WorkMode.HYBRID,
        "portal": Portal.NAUKRI,
        "application_url": "https://razorpay.com/jobs/ai-developer",
        "job_description": "Build AI-powered fraud detection and risk scoring systems. Requires Python, LangChain, LLM integration, FastAPI, and machine learning. Fintech domain experience preferred. 3-5 years experience.",
        "match_score": 95,
    },
    {
        "job_id": "revolut-backend-004",
        "company_name": "Revolut",
        "role_title": "Backend Developer",
        "location": "London, UK",
        "work_mode": WorkMode.ONSITE,
        "portal": Portal.LINKEDIN,
        "application_url": "https://revolut.com/careers/backend-london",
        "job_description": "Join Revolut's core banking team. Python, Django, FastAPI, Celery, Redis, PostgreSQL required. Build APIs handling millions of transactions daily. Fintech experience mandatory.",
        "match_score": 87,
    },
    {
        "job_id": "grab-agent-dev-005",
        "company_name": "Grab",
        "role_title": "Agent Developer",
        "location": "Singapore",
        "work_mode": WorkMode.HYBRID,
        "portal": Portal.INDEED,
        "application_url": "https://grab.careers/agent-developer-sg",
        "job_description": "Design and build autonomous AI agents using LangGraph, LangChain, and Python. Integrate with APIs, databases, and browser automation tools. Experience with agentic workflows required.",
        "match_score": 93,
    },
    {
        "job_id": "wise-fullstack-006",
        "company_name": "Wise",
        "role_title": "Full Stack Developer",
        "location": "Dubai, UAE",
        "work_mode": WorkMode.ONSITE,
        "portal": Portal.LINKEDIN,
        "application_url": "https://wise.com/careers/fullstack-dubai",
        "job_description": "Full Stack role at Wise. React, Node.js, Python, GraphQL, Docker, AWS. Build cross-border payment features. Fintech background highly valued.",
        "match_score": 85,
    },
    {
        "job_id": "zoho-backend-007",
        "company_name": "Zoho",
        "role_title": "Backend Developer",
        "location": "Chennai, India",
        "work_mode": WorkMode.ONSITE,
        "portal": Portal.NAUKRI,
        "application_url": "https://zoho.com/careers/backend-chennai",
        "job_description": "Backend Developer for Zoho Finance Suite. Java, Python, MySQL, REST APIs, microservices architecture. 2-4 years experience. Chennai office.",
        "match_score": 82,
    },
    {
        "job_id": "freshworks-ai-008",
        "company_name": "Freshworks",
        "role_title": "AI Developer",
        "location": "Chennai, India",
        "work_mode": WorkMode.HYBRID,
        "portal": Portal.NAUKRI,
        "application_url": "https://freshworks.com/careers/ai-dev-chennai",
        "job_description": "Build AI-powered customer support agents. Python, LangChain, OpenAI/Gemini APIs, FastAPI, Redis. NLP experience preferred. Chennai based with hybrid option.",
        "match_score": 90,
    },
    {
        "job_id": "coinbase-backend-009",
        "company_name": "Coinbase",
        "role_title": "Backend Developer",
        "location": "Remote",
        "work_mode": WorkMode.REMOTE,
        "portal": Portal.WELLFOUND,
        "application_url": "https://coinbase.com/careers/backend-remote",
        "job_description": "Remote Backend Developer for crypto exchange platform. Go, Python, PostgreSQL, gRPC, Kubernetes. High-scale distributed systems experience. Fintech/crypto domain.",
        "match_score": 84,
    },
    {
        "job_id": "atlassian-fullstack-010",
        "company_name": "Atlassian",
        "role_title": "Full Stack Developer",
        "location": "Remote",
        "work_mode": WorkMode.REMOTE,
        "portal": Portal.LINKEDIN,
        "application_url": "https://atlassian.com/careers/fullstack",
        "job_description": "Full Stack role on Jira platform. React, TypeScript, Python, Django, PostgreSQL, AWS. Build collaboration tools used by millions. Remote-first culture.",
        "match_score": 81,
    },
]


def mock_discovery(skills=None):
    """Return mock jobs and save to DB."""
    init_db()
    now = datetime.now().isoformat()
    jobs = []

    for data in MOCK_JOBS:
        job = Job(
            job_id=data["job_id"],
            company_name=data["company_name"],
            role_title=data["role_title"],
            location=data["location"],
            work_mode=data["work_mode"],
            date_posted=(datetime.now() - timedelta(days=random.randint(1, 10))).isoformat(),
            application_url=data["application_url"],
            job_description=data["job_description"],
            portal=data["portal"],
            match_score=data["match_score"],
            status=JobStatus.DISCOVERED,
            discovered_at=now,
        )
        save_job(job)
        jobs.append(job)

    return sorted(jobs, key=lambda j: j.match_score, reverse=True)


def mock_tailoring(job):
    """Return mock tailoring result for a job."""
    return {
        "job_id": job.job_id,
        "company": job.company_name,
        "role": job.role_title,
        "resume_path": f"./applications/{job.company_name}_{job.role_title}/resume_v1.pdf",
        "cover_letter_path": f"./applications/{job.company_name}_{job.role_title}/cover_letter.txt",
        "keyword_before": round(random.uniform(45, 60), 1),
        "keyword_after": round(random.uniform(78, 95), 1),
        "ats_before": round(random.uniform(40, 55), 1),
        "ats_after": round(random.uniform(80, 96), 1),
        "missing_keywords_before": random.randint(6, 12),
        "missing_keywords_after": random.randint(0, 3),
    }
