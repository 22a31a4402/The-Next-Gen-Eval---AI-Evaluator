"""Async Task Queue and Durable State Persistence for Python FastAPI Backend."""

import asyncio
import json
import os
import time
import uuid
from typing import Dict, Optional, List
from .config import settings
from .models import JobResponse, JobStatus, EvaluationReport, JobMetrics, CreateEvaluationRequest

MAX_QUEUE_CAPACITY = 50


class QueueManager:
    def __init__(self):
        self.jobs: Dict[str, Dict] = {}
        self.semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_EVALS)
        self.jobs_dir = os.path.join(settings.DATA_DIR, "jobs")
        os.makedirs(self.jobs_dir, exist_ok=True)
        self.subscribers: Dict[str, List[asyncio.Queue]] = {}
        self._load_saved_jobs()

    def _load_saved_jobs(self):
        """Durable recovery of saved jobs from disk upon service startup."""
        try:
            files = os.listdir(self.jobs_dir)
            recovered = 0
            for file in files:
                if file.endswith(".json") and not file.startswith(".tmp."):
                    path = os.path.join(self.jobs_dir, file)
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            job_data = json.load(f)

                        # Recovery for in-flight tasks interrupted during server restart
                        if job_data.get("status") in [
                            "preprocessing",
                            "grading",
                            "validating",
                            "assembling_report",
                        ]:
                            job_data["status"] = "queued"
                            job_data["currentStepMessage"] = "Recovered after restart; queued for processing."
                            job_data["updatedAt"] = int(time.time() * 1000)
                            self._persist(job_data)
                            recovered += 1

                        self.jobs[job_data["id"]] = job_data
                    except Exception as err:
                        print(f"[PythonQueue] Skipped corrupted job file {file}: {err}")

            print(f"[PythonQueue] Loaded {len(self.jobs)} persisted jobs from disk ({recovered} recovered).")
        except Exception as ex:
            print(f"[PythonQueue] Initialization recovery note: {ex}")

    def enqueue(self, req: CreateEvaluationRequest, institution_id: str = "inst_aarshiv_01", user_id: str = "anonymous") -> JobResponse:
        queued_count = sum(1 for j in self.jobs.values() if j.get("status") == "queued")
        if queued_count >= MAX_QUEUE_CAPACITY:
            raise RuntimeError(f"Queue capacity limit reached ({queued_count}/{MAX_QUEUE_CAPACITY}). Please retry shortly.")

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
            "institutionId": institution_id,
            "createdBy": user_id,
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
            self.jobs[job_id]["currentStepMessage"] = "Evaluation complete and verified"
            self.jobs[job_id]["report"] = report.model_dump()
            self.jobs[job_id]["metrics"] = metrics
            self.jobs[job_id]["updatedAt"] = int(time.time() * 1000)
            self._persist(self.jobs[job_id])
            self._broadcast(job_id, {"event": "completed", "data": {"report": report.model_dump(), "metrics": metrics}})

    def fail_job(self, job_id: str, error_msg: str, status: str = "failed"):
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = status
            self.jobs[job_id]["error"] = error_msg
            self.jobs[job_id]["currentStepMessage"] = f"Failed: {error_msg}"
            self.jobs[job_id]["updatedAt"] = int(time.time() * 1000)
            self._persist(self.jobs[job_id])
            self._broadcast(job_id, {"event": "failed", "data": {"error": error_msg, "status": status}})

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
        """Atomic write using temporary file and atomic rename."""
        target_path = os.path.join(self.jobs_dir, f"{job_data['id']}.json")
        temp_path = os.path.join(self.jobs_dir, f"{job_data['id']}.tmp.{int(time.time()*1000)}")
        try:
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(job_data, f, indent=2)
            os.replace(temp_path, target_path)
        except Exception as e:
            print(f"[PythonQueue] Failed persisting job {job_data['id']}: {e}")
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
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
