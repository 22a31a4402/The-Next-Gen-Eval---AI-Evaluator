# NextGen Eval — Standalone Python FastAPI Backend

This directory contains a modular, production-ready Python FastAPI backend for NextGen Eval. It can be deployed independently or alongside the unified Node/TypeScript service.

## Features
- **FastAPI with async task execution**: Non-blocking request lifecycle.
- **Async Bounded Concurrency Queue**: `asyncio.Semaphore` prevents Gemini quota exhaustion.
- **SHA-256 Deterministic Caching**: Avoids redundant evaluations.
- **Server-Sent Events (SSE)**: Streams real-time grading progress.
- **Health & Readiness Endpoints**: Kubernetes and Cloud Run ready (`/health`, `/ready`, `/api/metrics`).

## Local Setup
```bash
# 1. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Export environment variables
export GEMINI_API_KEY="your-gemini-api-key"
export PORT=8000

# 4. Run the server
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

## Docker Deployment
```bash
docker build -t nextgen-eval-python:latest -f Dockerfile .
docker run -p 8000:8000 -e GEMINI_API_KEY="your_api_key" nextgen-eval-python:latest
```
