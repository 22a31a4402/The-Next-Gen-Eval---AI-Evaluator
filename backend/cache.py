"""Deterministic Cryptographic Cache for Python Backend."""

import hashlib
import json
import os
import time
from typing import Optional, Dict, Any
from .config import settings
from .models import EvaluationReport


class EvaluationCache:
    def __init__(self):
        self.memory: Dict[str, Dict[str, Any]] = {}
        self.cache_dir = os.path.join(settings.DATA_DIR, "cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.total_requests = 0
        self.cache_hits = 0

    def generate_fingerprint(self, payload: Dict[str, Any], mode: str, model: str) -> str:
        h = hashlib.sha256()
        h.update(b"nextgen_eval_py_v4")
        h.update(mode.encode("utf-8"))
        h.update(model.encode("utf-8"))

        src = payload.get("sourceDoc", {})
        h.update((src.get("name") or "").encode("utf-8"))
        if src.get("text"):
            h.update(src["text"].encode("utf-8"))
        if src.get("base64"):
            b64 = src["base64"]
            h.update(f"{len(b64)}:{b64[:1000]}:{b64[-1000:]}".encode("utf-8"))

        qp = payload.get("questionPaper")
        if qp:
            h.update((qp.get("name") or "").encode("utf-8"))
            if qp.get("text"):
                h.update(qp["text"].encode("utf-8"))

        ak = payload.get("answerKey")
        if ak:
            h.update((ak.get("name") or "").encode("utf-8"))
            if ak.get("text"):
                h.update(ak["text"].encode("utf-8"))

        fn = payload.get("facultyNotes")
        if mode == "with-manual" and fn:
            h.update((fn.get("name") or "").encode("utf-8"))
            if fn.get("text"):
                h.update(fn["text"].encode("utf-8"))

        return h.hexdigest()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        self.total_requests += 1

        # Memory check
        if key in self.memory:
            entry = self.memory[key]
            if time.time() - entry["timestamp"] < settings.CACHE_TTL_SECONDS:
                self.cache_hits += 1
                return entry
            del self.memory[key]

        # Disk check
        disk_path = os.path.join(self.cache_dir, f"{key}.json")
        if os.path.exists(disk_path):
            try:
                with open(disk_path, "r", encoding="utf-8") as f:
                    entry = json.load(f)
                if time.time() - entry["timestamp"] < settings.CACHE_TTL_SECONDS:
                    self.memory[key] = entry
                    self.cache_hits += 1
                    return entry
                os.remove(disk_path)
            except Exception:
                pass
        return None

    def set(self, key: str, entry: Dict[str, Any]):
        entry["timestamp"] = time.time()
        self.memory[key] = entry
        disk_path = os.path.join(self.cache_dir, f"{key}.json")
        try:
            with open(disk_path, "w", encoding="utf-8") as f:
                json.dump(entry, f)
        except Exception:
            pass

    def stats(self) -> Dict[str, Any]:
        hit_rate = (self.cache_hits / self.total_requests * 100) if self.total_requests > 0 else 0
        return {
            "totalRequests": self.total_requests,
            "cacheHits": self.cache_hits,
            "hitRatePercent": round(hit_rate, 2),
            "memorySize": len(self.memory),
        }


evaluation_cache = EvaluationCache()
