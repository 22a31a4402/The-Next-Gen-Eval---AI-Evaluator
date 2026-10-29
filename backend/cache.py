"""Deterministic Cryptographic Cache for Python Backend.

Digests 100% of all document buffers, question paper, answer key, and notes.
"""

import hashlib
import json
import os
import time
from typing import Optional, Dict, Any
from .config import settings

CACHE_PROMPT_VERSION = "nextgen_eval_py_v4.1_hardened"


class EvaluationCache:
    def __init__(self):
        self.memory: Dict[str, Dict[str, Any]] = {}
        self.cache_dir = os.path.join(settings.DATA_DIR, "cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.total_requests = 0
        self.cache_hits = 0

    def generate_fingerprint(
        self,
        payload: Dict[str, Any],
        mode: str,
        model: str,
        institution_id: str = "inst_aarshiv_01",
    ) -> str:
        h = hashlib.sha256()
        h.update(f"PROMPT_VERSION:{CACHE_PROMPT_VERSION}\n".encode("utf-8"))
        h.update(f"MODE:{mode or 'with-manual'}\n".encode("utf-8"))
        h.update(f"MODEL:{model or settings.PRIMARY_MODEL}\n".encode("utf-8"))
        h.update(f"INSTITUTION:{institution_id}\n".encode("utf-8"))

        # 1. Source Document (Student Script) - Full Digest
        src = payload.get("sourceDoc") or {}
        h.update(f"SRC_NAME:{src.get('name') or ''}\n".encode("utf-8"))
        h.update(f"SRC_MIME:{src.get('mimeType') or ''}\n".encode("utf-8"))
        if src.get("text"):
            h.update(f"SRC_TEXT_LEN:{len(src['text'])}\n".encode("utf-8"))
            h.update(src["text"].encode("utf-8"))
            h.update(b"\n")
        if src.get("base64"):
            b64 = src["base64"]
            # Complete digest of all base64 data to detect any byte modification
            h.update(f"SRC_B64_LEN:{len(b64)}\n".encode("utf-8"))
            h.update(b64.encode("utf-8"))
            h.update(b"\n")

        # 2. Question Paper - Full Digest
        qp = payload.get("questionPaper")
        if qp:
            h.update(f"QP_NAME:{qp.get('name') or ''}\n".encode("utf-8"))
            h.update(f"QP_MIME:{qp.get('mimeType') or ''}\n".encode("utf-8"))
            if qp.get("text"):
                h.update(f"QP_TEXT_LEN:{len(qp['text'])}\n".encode("utf-8"))
                h.update(qp["text"].encode("utf-8"))
                h.update(b"\n")
            if qp.get("base64"):
                h.update(f"QP_B64_LEN:{len(qp['base64'])}\n".encode("utf-8"))
                h.update(qp["base64"].encode("utf-8"))
                h.update(b"\n")

        # 3. Answer Key - Full Digest
        ak = payload.get("answerKey")
        if ak:
            h.update(f"AK_NAME:{ak.get('name') or ''}\n".encode("utf-8"))
            h.update(f"AK_MIME:{ak.get('mimeType') or ''}\n".encode("utf-8"))
            if ak.get("text"):
                h.update(f"AK_TEXT_LEN:{len(ak['text'])}\n".encode("utf-8"))
                h.update(ak["text"].encode("utf-8"))
                h.update(b"\n")
            if ak.get("base64"):
                h.update(f"AK_B64_LEN:{len(ak['base64'])}\n".encode("utf-8"))
                h.update(ak["base64"].encode("utf-8"))
                h.update(b"\n")

        # 4. Faculty Notes - Full Digest (mode == 'with-manual')
        fn = payload.get("facultyNotes")
        if mode == "with-manual" and fn:
            h.update(f"FN_NAME:{fn.get('name') or ''}\n".encode("utf-8"))
            h.update(f"FN_MIME:{fn.get('mimeType') or ''}\n".encode("utf-8"))
            if fn.get("text"):
                h.update(f"FN_TEXT_LEN:{len(fn['text'])}\n".encode("utf-8"))
                h.update(fn["text"].encode("utf-8"))
                h.update(b"\n")
            if fn.get("base64"):
                h.update(f"FN_B64_LEN:{len(fn['base64'])}\n".encode("utf-8"))
                h.update(fn["base64"].encode("utf-8"))
                h.update(b"\n")

        return h.hexdigest()

    def get(self, key: str, institution_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        self.total_requests += 1

        def is_valid(entry: Dict[str, Any]) -> bool:
            if time.time() - entry.get("timestamp", 0) > settings.CACHE_TTL_SECONDS:
                return False
            if institution_id and entry.get("institutionId") and entry["institutionId"] != institution_id:
                return False
            return True

        # Memory check
        if key in self.memory:
            entry = self.memory[key]
            if is_valid(entry):
                self.cache_hits += 1
                return entry
            del self.memory[key]

        # Disk check
        disk_path = os.path.join(self.cache_dir, f"{key}.json")
        if os.path.exists(disk_path):
            try:
                with open(disk_path, "r", encoding="utf-8") as f:
                    entry = json.load(f)
                if is_valid(entry):
                    self.memory[key] = entry
                    self.cache_hits += 1
                    return entry
                os.remove(disk_path)
            except Exception:
                pass
        return None

    def set(self, key: str, entry: Dict[str, Any], institution_id: str = "inst_aarshiv_01"):
        entry["timestamp"] = time.time()
        entry["institutionId"] = institution_id
        self.memory[key] = entry

        disk_path = os.path.join(self.cache_dir, f"{key}.json")
        temp_path = os.path.join(self.cache_dir, f"{key}.tmp.{int(time.time()*1000)}")
        try:
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(entry, f, indent=2)
            os.replace(temp_path, disk_path)
        except Exception:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
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
