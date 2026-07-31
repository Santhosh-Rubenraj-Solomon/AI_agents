"""FastAPI web server for AI Job Hunt Agent — handles resume upload and agent control."""

import asyncio
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.config import load_config
from src.memory import init_db, get_all_jobs

# Data source: real Adzuna jobs when credentials are configured, else mock.
# Test mode auto-disables the moment ADZUNA_APP_ID / ADZUNA_APP_KEY are set.
from src.tools.adzuna import adzuna_configured

REAL_DATA = adzuna_configured()
TEST_MODE = not REAL_DATA

# Mock generators stay importable (no-key fallback + the tailoring preview).
from src.test_mode import mock_discovery, mock_tailoring
# Real discovery — uses Adzuna internally when configured.
from src.phases.discovery import run_discovery

app = FastAPI(title="AI Job Hunt Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
RESUME_DIR = BASE_DIR / "resume"
RESUME_DIR.mkdir(exist_ok=True)

init_db()

agent_status = {
    "running": False,
    "phase": None,
    "message": "Idle",
}


class RunAgentRequest(BaseModel):
    phase: str
    skills: Optional[list[str]] = None
    max_jobs: Optional[int] = None
    role: Optional[str] = None
    location: Optional[str] = None
    work_type: Optional[str] = None


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the frontend HTML."""
    html_path = BASE_DIR / "frontend" / "index.html"
    if html_path.exists():
        return html_path.read_text()
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Job Hunt Agent</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: white;
                border-radius: 16px;
                padding: 40px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            h1 {
                color: #333;
                margin-bottom: 10px;
                font-size: 32px;
            }
            .subtitle {
                color: #666;
                margin-bottom: 30px;
                font-size: 16px;
            }
            .section {
                margin-bottom: 30px;
                padding: 20px;
                background: #f8f9fa;
                border-radius: 8px;
            }
            .section h2 {
                color: #667eea;
                margin-bottom: 15px;
                font-size: 20px;
            }
            .upload-area {
                border: 2px dashed #667eea;
                border-radius: 8px;
                padding: 40px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s;
            }
            .upload-area:hover {
                background: #f0f4ff;
                border-color: #764ba2;
            }
            .upload-area.dragover {
                background: #e8edff;
                border-color: #764ba2;
            }
            input[type="file"] {
                display: none;
            }
            .btn {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                padding: 12px 30px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                transition: transform 0.2s;
            }
            .btn:hover {
                transform: translateY(-2px);
            }
            .btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .status {
                padding: 15px;
                border-radius: 6px;
                margin-top: 15px;
            }
            .status.success {
                background: #d4edda;
                color: #155724;
            }
            .status.error {
                background: #f8d7da;
                color: #721c24;
            }
            .status.info {
                background: #d1ecf1;
                color: #0c5460;
            }
            .jobs-list {
                margin-top: 20px;
            }
            .job-card {
                background: white;
                padding: 15px;
                margin-bottom: 10px;
                border-radius: 6px;
                border-left: 4px solid #667eea;
            }
            .job-card h3 {
                color: #333;
                margin-bottom: 5px;
            }
            .job-card p {
                color: #666;
                font-size: 14px;
            }
            .controls {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 15px;
                margin-top: 20px;
            }
            @media (max-width: 600px) {
                .controls {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 AI Job Hunt Agent</h1>
            <p class="subtitle">Upload your resume and let AI find & apply to jobs for you</p>
            
            <div class="section">
                <h2>📄 Upload Resume</h2>
                <div class="upload-area" id="uploadArea">
                    <input type="file" id="fileInput" accept=".pdf,.docx" />
                    <p>📎 Drag & drop your resume here or click to browse</p>
                    <p style="color: #999; font-size: 14px; margin-top: 10px;">Supports PDF and DOCX</p>
                </div>
                <div id="uploadStatus"></div>
            </div>
            
            <div class="section">
                <h2>🚀 Run Agent</h2>
                <div class="controls">
                    <button class="btn" onclick="runDiscovery()">🔍 Discover Jobs</button>
                    <button class="btn" onclick="runFullPipeline()">⚡ Full Pipeline</button>
                </div>
                <div id="agentStatus"></div>
            </div>
            
            <div class="section">
                <h2>💼 Discovered Jobs</h2>
                <div id="jobsList">
                    <p style="color: #999;">No jobs discovered yet. Run discovery phase first.</p>
                </div>
            </div>
        </div>
        
        <script>
            const uploadArea = document.getElementById('uploadArea');
            const fileInput = document.getElementById('fileInput');
            const uploadStatus = document.getElementById('uploadStatus');
            const agentStatus = document.getElementById('agentStatus');
            const jobsList = document.getElementById('jobsList');
            
            uploadArea.addEventListener('click', () => fileInput.click());
            
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });
            
            uploadArea.addEventListener('dragleave', () => {
                uploadArea.classList.remove('dragover');
            });
            
            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    handleFileUpload(files[0]);
                }
            });
            
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    handleFileUpload(e.target.files[0]);
                }
            });
            
            async function handleFileUpload(file) {
                const formData = new FormData();
                formData.append('file', file);
                
                uploadStatus.innerHTML = '<div class="status info">⏳ Uploading...</div>';
                
                try {
                    const response = await fetch('/upload-resume', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        uploadStatus.innerHTML = `<div class="status success">✅ ${data.message}</div>`;
                    } else {
                        uploadStatus.innerHTML = `<div class="status error">❌ ${data.detail}</div>`;
                    }
                } catch (error) {
                    uploadStatus.innerHTML = `<div class="status error">❌ Upload failed: ${error.message}</div>`;
                }
            }
            
            async function runDiscovery() {
                agentStatus.innerHTML = '<div class="status info">🔍 Running job discovery (TEST MODE)...</div>';
                
                try {
                    const response = await fetch('/run-agent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            phase: 'discover',
                            skills: ['python', 'django', 'react', 'nodejs', 'ai', 'langchain']
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        agentStatus.innerHTML = `<div class="status info">⏳ ${data.message} — processing...</div>`;
                        setTimeout(async () => {
                            const st = await (await fetch('/status')).json();
                            agentStatus.innerHTML = `<div class="status success">✅ ${st.message}</div>`;
                            loadJobs();
                        }, 3000);
                    } else {
                        agentStatus.innerHTML = `<div class="status error">❌ ${data.detail}</div>`;
                    }
                } catch (error) {
                    agentStatus.innerHTML = `<div class="status error">❌ Failed: ${error.message}</div>`;
                }
            }
            
            async function runFullPipeline() {
                agentStatus.innerHTML = '<div class="status info">⚡ Running full pipeline (TEST MODE)...</div>';
                
                try {
                    const response = await fetch('/run-agent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            phase: 'full',
                            skills: ['python', 'django', 'react', 'nodejs', 'ai', 'langchain']
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        agentStatus.innerHTML = `<div class="status info">⏳ ${data.message} — processing...</div>`;
                        setTimeout(async () => {
                            const st = await (await fetch('/status')).json();
                            agentStatus.innerHTML = `<div class="status success">✅ ${st.message}</div>`;
                            loadJobs();
                        }, 3000);
                    } else {
                        agentStatus.innerHTML = `<div class="status error">❌ ${data.detail}</div>`;
                    }
                } catch (error) {
                    agentStatus.innerHTML = `<div class="status error">❌ Failed: ${error.message}</div>`;
                }
            }
            
            function scoreColor(score) {
                if (score >= 90) return '#28a745';
                if (score >= 80) return '#667eea';
                return '#ffc107';
            }
            
            function portalBadge(portal) {
                const colors = { linkedin: '#0077b5', naukri: '#4a67ff', indeed: '#2164f3', wellfound: '#333' };
                return `<span style="background:${colors[portal]||'#666'};color:white;padding:2px 8px;border-radius:4px;font-size:12px;">${portal}</span>`;
            }
            
            function workModeBadge(mode) {
                const icons = { remote: '🌍', hybrid: '🏢', 'on-site': '📍', unknown: '❓' };
                return `${icons[mode]||'❓'} ${mode}`;
            }
            
            async function tailorJob(jobId) {
                const el = document.getElementById('tailor-' + jobId);
                el.innerHTML = '<em>Generating...</em>';
                try {
                    const resp = await fetch('/tailoring/' + jobId);
                    const d = await resp.json();
                    el.innerHTML = `
                        <table style="width:100%;font-size:13px;margin-top:8px;border-collapse:collapse;">
                            <tr><th style="text-align:left;padding:4px;border-bottom:1px solid #ddd;">Metric</th><th style="padding:4px;border-bottom:1px solid #ddd;">Before</th><th style="padding:4px;border-bottom:1px solid #ddd;">After</th></tr>
                            <tr><td style="padding:4px;">Keyword Match</td><td style="text-align:center;color:#dc3545;">${d.keyword_before}%</td><td style="text-align:center;color:#28a745;">${d.keyword_after}%</td></tr>
                            <tr><td style="padding:4px;">ATS Score</td><td style="text-align:center;color:#dc3545;">${d.ats_before}</td><td style="text-align:center;color:#28a745;">${d.ats_after}</td></tr>
                            <tr><td style="padding:4px;">Missing Keywords</td><td style="text-align:center;color:#dc3545;">${d.missing_keywords_before}</td><td style="text-align:center;color:#28a745;">${d.missing_keywords_after}</td></tr>
                        </table>`;
                } catch(e) { el.innerHTML = '<span style="color:red;">Failed</span>'; }
            }
            
            async function loadJobs() {
                try {
                    const response = await fetch('/jobs');
                    const data = await response.json();
                    
                    if (data.jobs && data.jobs.length > 0) {
                        jobsList.innerHTML = data.jobs.map((job, i) => `
                            <div class="job-card">
                                <div style="display:flex;justify-content:space-between;align-items:center;">
                                    <h3 style="margin:0;">${job.role_title}</h3>
                                    <span style="background:${scoreColor(job.match_score)};color:white;padding:4px 12px;border-radius:20px;font-weight:bold;font-size:14px;">${job.match_score}/100</span>
                                </div>
                                <p style="margin:5px 0;font-size:15px;"><strong>${job.company_name}</strong></p>
                                <p style="margin:4px 0;font-size:13px;color:#555;">
                                    📍 ${job.location} &nbsp; ${workModeBadge(job.work_mode)} &nbsp; ${portalBadge(job.portal)}
                                </p>
                                <p style="font-size:13px;color:#777;margin:8px 0;">${job.job_description.substring(0, 150)}...</p>
                                <div style="display:flex;gap:8px;margin-top:8px;">
                                    <a href="${job.application_url}" target="_blank" style="background:#667eea;color:white;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:13px;">View Job</a>
                                    <button onclick="tailorJob('${job.job_id}')" style="background:#28a745;color:white;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;">Tailor Resume</button>
                                </div>
                                <div id="tailor-${job.job_id}"></div>
                            </div>
                        `).join('');
                    } else {
                        jobsList.innerHTML = '<p style="color: #999;">No jobs found yet. Click "Discover Jobs" to start.</p>';
                    }
                } catch (error) {
                    console.error('Failed to load jobs:', error);
                }
            }
            
            loadJobs();
        </script>
    </body>
    </html>
    """


@app.post("/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    """Handle resume file upload."""
    if not file.filename.endswith(('.pdf', '.docx')):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are supported")
    
    file_path = RESUME_DIR / "base_resume.pdf"
    
    try:
        content = await file.read()
        file_path.write_bytes(content)
        return {"message": f"Resume uploaded successfully: {file.filename}", "path": str(file_path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")


@app.post("/run-agent")
async def run_agent(request: RunAgentRequest, background_tasks: BackgroundTasks):
    """Trigger agent execution in background."""
    if agent_status["running"]:
        raise HTTPException(status_code=400, detail="Agent is already running")
    
    background_tasks.add_task(
        execute_agent, request.phase, request.skills, request.max_jobs,
        request.role, request.location, request.work_type,
    )

    return {"message": f"Agent started in {request.phase} mode"}


async def execute_agent(
    phase: str,
    skills: Optional[list[str]],
    max_jobs: Optional[int],
    role: Optional[str] = None,
    location: Optional[str] = None,
    work_type: Optional[str] = None,
):
    """Execute the agent workflow."""
    global agent_status

    try:
        agent_status["running"] = True
        agent_status["phase"] = phase

        if TEST_MODE:
            import time
            time.sleep(1)
            jobs = mock_discovery(skills)
            agent_status["message"] = f"[TEST MODE] Discovery complete: {len(jobs)} mock jobs"
        else:
            config = load_config()
            jobs = await run_discovery(
                config, resume_skills=skills or [],
                role=role, location=location, work_type=work_type,
            )
            agent_status["message"] = f"[LIVE · Adzuna] Discovery complete: {len(jobs)} real jobs"
    except Exception as e:
        agent_status["message"] = f"Error: {str(e)}"
    finally:
        agent_status["running"] = False


@app.get("/jobs")
async def get_jobs():
    """Get all discovered jobs."""
    try:
        jobs = get_all_jobs()
        return {"jobs": [job.dict() for job in jobs]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tailoring/{job_id}")
async def get_tailoring(job_id: str):
    """Get mock tailoring result for a job."""
    from src.memory import get_job
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return mock_tailoring(job)


@app.get("/status")
async def get_status():
    """Get current agent status."""
    return agent_status


@app.get("/mode")
async def get_mode():
    """Report whether the app is serving live (Adzuna) or mock data."""
    return {
        "test_mode": TEST_MODE,
        "live": REAL_DATA,
        "source": "Adzuna · live jobs" if REAL_DATA else "Mock data · test mode",
    }


if __name__ == "__main__":
    import uvicorn
    # Dashboard runs on http://localhost:4200
    uvicorn.run(app, host="127.0.0.1", port=4200)
