"""Async Task Queue and Job State Persistence for FastAPI Backend."""

import asyncio
import json
import os
import time
import uuid
from typing import Dict, Optional, List, Callable
from .config import settings
from .models import JobResponse, JobStatus, EvaluationReport, JobMetrics, CreateEvaluationRequest


class QueueManager:
    def __init__(self):
        self.jobs: Dict[str, Dict] = {}
        self.semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_EVALS)
        self.jobs_dir = os.path.join(settings.DATA_DIR, "jobs")
        os.makedirs(self.jobs_dir, exist_ok=True)
        self.subscribers: Dict[str, List[asyncio.Queue]] = {}

    def enqueue(self, req: CreateEvaluationRequest) -> JobResponse:
        job_id = str(uuid.uuid4())
        correlation_id = f"eval_{int(time.time())}_{uuid.uuid4().hex[:6]}"

        now = int(time.time() * 1000)
        job_data = {
            "id": job_id,
            "correlationId": correlation_id,
            "status": "queued",
            "progressPercent": 0,
            "currentStepMessage": "Evaluation job queued",
            "studentName": req.studentName or (req.sourceDoc.name if req.sourceDoc else "Student"),
            "testTitle": req.testTitle or "Academic Assessment",
            "mode": req.mode,
            "createdAt": now,
            "updatedAt": now,
            "error": None,
            "report": None,
            "metrics": {
                "correlationId": correlation_id,
                "startTime": now,
                "cacheHit": False,
                "retriesCount": 0,
            },
            "inputPayload": req.model_dump(),
        }

        self.jobs[job_id] = job_data
        self._persist(job_data)
        return self._to_response(job_data)

    def get_job(self, job_id: str) -> Optional[Dict]:
        return self.jobs.get(job_id)

    def get_response(self, job_id: str) -> Optional[JobResponse]:
        job_data = self.jobs.get(job_id)
        if not job_data:
            return None
        return self._to_response(job_data)

    def update_progress(self, job_id: str, status: JobStatus, percent: int, msg: str):
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = status
            self.jobs[job_id]["progressPercent"] = percent
            self.jobs[job_id]["currentStepMessage"] = msg
            self.jobs[job_id]["updatedAt"] = int(time.time() * 1000)
            self._persist(self.jobs[job_id])
            self._broadcast(job_id, {"event": "progress", "data": self._to_response(self.jobs[job_id]).model_dump()})

    def complete_job(self, job_id: str, report: EvaluationReport, metrics: Dict):
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "completed"
            self.jobs[job_id]["progressPercent"] = 100
            self.jobs[job_id]["currentStepMessage"] = "Evaluation complete"
            self.jobs[job_id]["report"] = report.model_dump()
            self.jobs[job_id]["metrics"] = metrics
            self.jobs[job_id]["updatedAt"] = int(time.time() * 1000)
            self._persist(self.jobs[job_id])
            self._broadcast(job_id, {"event": "completed", "data": {"report": report.model_dump(), "metrics": metrics}})

    def fail_job(self, job_id: str, error_msg: str):
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "failed"
            self.jobs[job_id]["error"] = error_msg
            self.jobs[job_id]["currentStepMessage"] = f"Failed: {error_msg}"
            self.jobs[job_id]["updatedAt"] = int(time.time() * 1000)
            self._persist(self.jobs[job_id])
            self._broadcast(job_id, {"event": "failed", "data": {"error": error_msg}})

    def subscribe(self, job_id: str) -> asyncio.Queue:
        if job_id not in self.subscribers:
            self.subscribers[job_id] = []
        q = asyncio.Queue()
        self.subscribers[job_id].append(q)
        return q

    def unsubscribe(self, job_id: str, q: asyncio.Queue):
        if job_id in self.subscribers and q in self.subscribers[job_id]:
            self.subscribers[job_id].remove(q)

    def _broadcast(self, job_id: str, payload: Dict):
        for q in self.subscribers.get(job_id, []):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _persist(self, job_data: Dict):
        path = os.path.join(self.jobs_dir, f"{job_data['id']}.json")
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(job_data, f)
        except Exception:
            pass

    def _to_response(self, job_data: Dict) -> JobResponse:
        return JobResponse(
            id=job_data["id"],
            correlationId=job_data["correlationId"],
            status=job_data["status"],
            progressPercent=job_data["progressPercent"],
            currentStepMessage=job_data["currentStepMessage"],
            studentName=job_data["studentName"],
            testTitle=job_data.get("testTitle"),
            mode=job_data["mode"],
            createdAt=job_data["createdAt"],
            updatedAt=job_data["updatedAt"],
            error=job_data.get("error"),
            metrics=JobMetrics(**job_data["metrics"]),
            hasReport=bool(job_data.get("report")),
        )


queue_manager = QueueManager()
