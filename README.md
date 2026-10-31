# NextGen Eval by Aarshiv AI — High-Performance, Reliable, Cost-Efficient AI Grading Backend

**NextGen Eval** is an enterprise-grade academic answer-sheet evaluation platform engineered for schools, universities, and competitive examination institutions. It automates subjective and objective answer evaluation against question papers, official answer keys, and marking schemes with academic precision, strict partial credit consistency, and discrepancy audit resolution.

---

## 1. Verified Defects Remediated

| Category | Verified Defect | Implemented Solution |
| :--- | :--- | :--- |
| **Security & Auth** | Unauthenticated access to evaluations, listing, and operator metrics | Implemented server-side token/API-key authentication (`server/auth.ts`) with RBAC (`operator`, `admin`, `instructor`, `evaluator`), tenant-scoped institution isolation (`institutionId`), client rate limiting (120 req/min), and protected `/api/metrics` and `/ready`. |
| **CORS Policy** | Unrestricted wildcard CORS | Replaced with explicit configurable allowlist via `ALLOWED_ORIGINS` environment variable, supporting strict origin validation. |
| **Grading Fabrication** | Fallback in `backend/main.py` created 10/10 mock reports on error | Completely removed fabricated fallback. Missing keys, network errors, timeouts, or schema mismatches transition evaluations to `failed` or `needs_review`. Never fabricate marks. |
| **Cache Fingerprinting** | Sampled only first and last 1000 bytes of base64 | Refactored `server/cache.ts` and `backend/cache.py` to digest 100% of document buffers (student script, QP, answer key, notes, MIME types, rubric, prompt version, model, settings) using canonical serialization. Verified middle-byte mutation changes fingerprint. Added authorization check before serving cache. |
| **Academic Validation** | Erroneous scores clamped to maxMarks; invalid maxMarks defaulted to 1 | Implemented strict `EvaluationEngine` validation rejecting NaN/infinite marks, negative marks, marks > maxMarks, invalid maxMarks, duplicate question IDs, and inconsistent aggregate totals. Flags inconsistencies into `needs_review`. |
| **Queue Durability** | Non-atomic writes and missing startup recovery in Python backend | Implemented atomic disk persistence (`.tmp` write + atomic rename), startup recovery for interrupted in-flight jobs, queue capacity limit backpressure (HTTP 503/429 at 50 queued jobs), and job reload on initialization in Python queue. |
| **Input Pipeline** | Frontend concatenated all context into `sourceDoc.text` | Upgraded `generateStructuredFeedback` in `services/geminiService.ts`, `App.tsx`, and `BatchProcessor.tsx` to transmit distinct Question Paper, Answer Key, and Student Script documents while preserving 100% of student visual PDF/image data for multimodal handwriting and diagram analysis. |
| **Reliability & Benchmarks** | Manufactured formulas in `test/benchmark.ts` | Rewrote `test/benchmark.ts` to remove all hardcoded simulation math. Reports strictly empirical measured CPU/wall-clock timings, separates synthetic local throughput from opt-in live Gemini evaluation (`RUN_LIVE_BENCHMARK=true`). |

---

## 2. System Architecture & Request Lifecycle

```
[Student PDF / Key / QP] ──> [Frontend App]
                                  │
                                  ▼ POST /api/evaluations (Bearer Token)
                        [Authentication & RBAC Middleware]
                                  │ (Tenant Scoped: institutionId)
                        [EvaluationQueue] (Bounded concurrency: 4 workers, Max capacity: 50)
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
        [DocumentProcessor]               [EvaluationCache]
        - High-density text detection     - 100% full SHA-256 buffer digest
        - Preserves student visual B64    - Tenant-verified cache hit (<1ms)
        - Delimited academic context      - Zero token spend on hit
                 │
                 ▼ (Cache Miss)
         [GeminiClient]
         - Primary: gemini-3.8-flash (aliases per @google/genai guidelines)
         - Fallbacks: gemini-flash-latest, gemini-3.1-flash-lite
         - Request deadline timeout (90s)
         - Bounded exponential backoff on eligible transient errors (429, 503)
                 │
                 ▼
         [Strict Academic Validation Engine]
         - Rejects NaN, negative marks, marks > maxMarks (NO clamping)
         - Rejects duplicate question IDs & invalid maxMarks
         - Mathematical aggregate totalScore === sum(q.marks)
         - Routes discrepancies to 'needs_review'
                 │
                 ▼
       [Server-Sent Events] ──> Real-Time Progress ──> [FeedbackReport & 4-in-1 PDF Export]
```

---

## 3. Directory Structure & Key Components

```
├── App.tsx                     # Main React evaluation interface with distinct QP/AK passing
├── components/
│   ├── BatchProcessor.tsx      # Batch student evaluator passing multimodal visual scripts
│   ├── FeedbackReport.tsx      # Print-ready evaluation report & unified 4-in-1 booklet
│   └── FileUploader.tsx        # Drag-and-drop file ingestion
├── server/
│   ├── auth.ts                 # Server-side auth, RBAC, tenant isolation & rate limiting
│   ├── cache.ts                # Full-buffer SHA-256 cryptographic cache with tenant auth
│   ├── config.ts               # Central configuration, model chain, pricing, deadlines
│   ├── documentProcessor.ts    # Multimodal context assembly & student handwriting preservation
│   ├── evaluator.ts            # Strict academic validation & bound verification
│   ├── geminiClient.ts         # Resilient server-side Gemini client with deadline & transient retries
│   ├── queue.ts                # Bounded concurrency worker queue with atomic disk recovery
│   ├── types.ts                # Data contracts for jobs, reports, and tenant metadata
│   └── routes/
│       ├── evaluations.ts      # Authenticated evaluation endpoints (enqueue, status, results, retry, events)
│       └── health.ts           # Public /health, protected /ready and /api/metrics
├── server.ts                   # Authoritative Express entrypoint with CORS allowlist & Vite dev server
├── backend/                    # Synchronized Python FastAPI alternative backend
│   ├── main.py                 # FastAPI app with auth, multimodal input, NO fabricated 10/10 fallback
│   ├── cache.py                # Python full-buffer SHA-256 cache
│   ├── evaluator.py            # Python strict score validation
│   ├── queue_manager.py        # Python task queue with disk reload upon startup
│   ├── config.py               # Python backend configuration
│   ├── models.py               # Pydantic schemas
│   └── requirements.txt        # Python dependencies
├── test/
│   ├── test_pipeline.ts        # Comprehensive regression test suite (26 passing tests)
│   └── benchmark.ts            # Empirical measured performance & latency benchmark suite
├── .env.example                # Environment variable documentation (no secrets)
└── Dockerfile                  # Production container definition
```

---

## 4. Verification Evidence & Test Execution

### 4.1. Automated Regression Test Suite (`npm test`)
Executed via `tsx test/test_pipeline.ts`:
```
========================================================================
 Starting NextGen Eval Critical Remediation & Regression Test Suite
========================================================================

--- TEST GROUP 1: Full-Byte SHA-256 Fingerprint & Middle-Byte Invalidation ---
✅ PASS: Deterministic hashing: Identical inputs produce identical fingerprint.
✅ PASS: Verification sanity check: mutated base64 has exact same length as original base64.
✅ PASS: Critical Security: Modifying a byte in the middle of a same-length PDF invalidates the cache fingerprint.
✅ PASS: Tenant Isolation: Identical documents under different institutionId produce distinct cache keys.

--- TEST GROUP 2: Adversarial Academic Score Validation ---
✅ PASS: Valid report successfully passes strict validation.
✅ PASS: Rejects marks > maxMarks (never clamps to hide model discrepancy).
✅ PASS: Rejects NaN marks.
✅ PASS: Rejects infinite marks.
✅ PASS: Rejects negative marks.
✅ PASS: Rejects maxMarks <= 0 (never silently replaces with 1).
✅ PASS: Rejects duplicate question IDs.
✅ PASS: Rejects model aggregate totalScore that fails to match the exact mathematical sum of questions.
✅ PASS: Preserves valid partial credit scores with decimal precision.
✅ PASS: Maintains exact awarded question marks for partial credit.

--- TEST GROUP 3: Authentication & Multi-Tenant Access Control ---
✅ PASS: Unauthenticated request correctly returns null context.
✅ PASS: Recognizes valid instructor Bearer token.
✅ PASS: Binds user to correct tenant institution.
✅ PASS: Recognizes system operator token with operator role.
✅ PASS: Security Isolation: Instructor from Institution B cannot access Job belonging to Institution A (403 Forbidden).
✅ PASS: Authorized Access: Instructor from same institution can access the evaluation job.
✅ PASS: Operator Access: System operator has universal operational access across institutions.

--- TEST GROUP 4: Queue Persistence, Atomic Storage & Capacity Limits ---
✅ PASS: Job successfully enqueued.
✅ PASS: Job records correct institution tenant.
✅ PASS: Job file was durably persisted to disk.
✅ PASS: Atomic writes leave no orphan temporary files on disk.
Testing queue capacity bounds...
✅ PASS: Queue strictly enforces backpressure limit (50 jobs) with QueueCapacityError (HTTP 503).

========================================================================
 ALL REGRESSION TESTS COMPLETED: 26/26 PASSED
========================================================================
```

### 4.2. Measured Benchmark Output (`npx tsx test/benchmark.ts`)
```
================================================================================================
 MEASURED BENCHMARK RESULTS (EMPIRICAL HIGH-RESOLUTION TIMINGS)
------------------------------------------------------------------------------------------------
Pipeline Stage                     | Baseline     | Optimized   | Speedup | Measurement Details
------------------------------------------------------------------------------------------------
SHA-256 Digest (4.5MB Doc)         | 84.72 ms     | 24.15 ms    | 3.51x   | Direct streaming hashing vs naive multi-pass JSON serialization
Cache Retrieval (Warm Hit)         | 25.36 ms     | 0.09 ms     | 290.11x | Hit served in 0.087ms with 100% token cost reduction
Strict Validation (50 Questions)   | 0.29 ms      | 0.09 ms     | 3.20x   | 50 questions validated in 0.091ms (O(N) Set uniqueness + bounds check)
Batch Queue Enqueue (10 Jobs)      | 9.06 ms      | 3.62 ms     | 2.50x   | Atomic disk persistence + queue admission in 3.62ms
------------------------------------------------------------------------------------------------
```

---

## 5. Security & Authentication Model

### 5.1. Authentication Header
All evaluation and operator endpoints require:
```http
Authorization: Bearer <token>
# OR
x-api-key: <token>
```

### 5.2. Configured Roles & Access Permissions
- **`operator`** (`OPERATOR_API_KEY`): System operator authentication. Required for:
  - System operational metrics (`GET /api/metrics`)
  - Detailed diagnostic readiness telemetry (`GET /ready`)
  - Pruning stale evaluation records (`POST /api/evaluations/prune`)
  - Tenant-spanning audit ledger and cost summaries (`GET /api/usage/summary`)
  - Cross-institution inspection to troubleshoot stuck/failed evaluation jobs
  - *Note:* Distinct from `GEMINI_API_KEY`. Evaluated via constant-time comparison to prevent timing attacks.
- **`admin`** (`ADMIN_API_KEY`): Full administrative access over all jobs within their institution.
- **`instructor`** (`INSTRUCTOR_API_KEY`): Create evaluations, stream events, retry failed jobs, view completed reports for institution.
- **`evaluator`** (`EVALUATOR_API_KEY`): Create evaluations and view reports authored by their own user ID.

> **Security Note on Keys:**
> - `GEMINI_API_KEY` is strictly for server-side Google GenAI API communication.
> - `OPERATOR_API_KEY` is strictly for server-side system administration and operator RBAC.
> - Neither key is ever exposed in client-side bundles, browser storage, or HTTP access logs.

### 5.3. Rate Limiting & Backpressure
- In-memory sliding window rate limiter: 120 requests/minute per client context.
- Queue capacity backpressure: Maximum 50 queued evaluations. When exceeded, the system responds with `HTTP 503 Service Unavailable` and a `Retry-After: 30` header.

---

## 6. Deployment Instructions

### 6.1. Environment Variables Configuration
Copy `.env.example` to `.env`:
```bash
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
MAX_CONCURRENT_EVALS=4
REQUEST_TIMEOUT_MS=90000
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
INSTRUCTOR_API_KEY=nextgen_inst_sec_token_4412
OPERATOR_API_KEY=nextgen_op_sec_token_9921
NODE_ENV=production
```

### 6.2. Authoritative Node.js Production Run
```bash
# 1. Compile client assets and backend
npm run build

# 2. Run authoritative server
node server.ts
```

### 6.3. Docker Production Deployment
```bash
docker build -t nextgen-eval:latest .
docker run -p 3000:3000 \
  -e GEMINI_API_KEY="your_production_key" \
  -e NODE_ENV="production" \
  nextgen-eval:latest
```

---

## 7. Rollback Plan

If unexpected regressions occur in production:
1. **Fallback Model Pinning**:
   Switch `GEMINI_MODEL=gemini-flash-latest` in `.env` and restart the process (`npm run start`) without redeploying code.
2. **Cache Bypass**:
   Set `CACHE_TTL_MS=0` to bypass cached evaluation results and force real-time recalculation.
3. **Emergency Container Rollback**:
   Re-deploy the previously tagged Docker image:
   ```bash
   docker stop nextgen-eval-current
   docker run -d --name nextgen-eval-prev -p 3000:3000 <previous-image-sha>
   ```
4. **Git Revert**:
   ```bash
   git revert HEAD
   npm run build
   npm run start
   ```
