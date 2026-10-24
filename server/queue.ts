/**
 * Bounded Concurrency Job Queue and Durable Storage for NextGen Eval
 *
 * Implements Stage E (Concurrency & Scheduling):
 * - Bounded worker pool preventing Gemini rate limits & quota exhaustion
 * - Durable JSON file persistence so server restarts do not lose jobs
 * - Event-driven progress broadcasts for SSE and polling
 * - Graceful retry capability
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { config } from './config';
import { evaluationEngine } from './evaluator';
import { EvaluationJob, EvaluationMode, EvaluationReport, JobStatus } from './types';

export class EvaluationQueue extends EventEmitter {
  private jobs = new Map<string, EvaluationJob>();
  private activeWorkers = 0;
  private queueDir: string;

  constructor() {
    super();
    this.queueDir = path.join(config.dataDir, 'jobs');
    try {
      if (!fs.existsSync(this.queueDir)) {
        fs.mkdirSync(this.queueDir, { recursive: true });
      }
      this.loadSavedJobs();
    } catch (e) {
      console.warn('[EvaluationQueue] Failed initializing storage directory:', e);
    }
  }

  /**
   * Load existing jobs from disk to survive server restarts
   */
  private loadSavedJobs() {
    try {
      const files = fs.readdirSync(this.queueDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const raw = fs.readFileSync(path.join(this.queueDir, file), 'utf-8');
          const job = JSON.parse(raw) as EvaluationJob;
          // If a job was running when server restarted, reset it to queued
          if (job.status === 'grading' || job.status === 'preprocessing' || job.status === 'validating') {
            job.status = 'queued';
            job.currentStepMessage = 'Recovered after restart; queued for processing.';
          }
          this.jobs.set(job.id, job);
        }
      }
      console.log(`[EvaluationQueue] Recovered ${this.jobs.size} jobs from durable storage.`);
    } catch (e) {
      console.warn('[EvaluationQueue] Error recovering jobs:', e);
    }
  }

  private persistJob(job: EvaluationJob) {
    try {
      const filePath = path.join(this.queueDir, `${job.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(job, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`[EvaluationQueue] Failed persisting job ${job.id}:`, e);
    }
  }

  /**
   * Enqueue a new evaluation job
   */
  public enqueue(payload: {
    sourceDoc: { name: string; text?: string; base64?: string; mimeType?: string };
    questionPaper?: { name: string; text?: string; base64?: string; mimeType?: string };
    answerKey?: { name: string; text?: string; base64?: string; mimeType?: string };
    facultyNotes?: { name: string; text?: string; base64?: string; mimeType?: string } | null;
    mode?: EvaluationMode;
    studentName?: string;
    testTitle?: string;
  }): EvaluationJob {
    const id = crypto.randomUUID();
    const correlationId = `eval_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const mode = payload.mode || 'with-manual';

    const job: EvaluationJob = {
      id,
      correlationId,
      status: 'queued',
      progressPercent: 0,
      currentStepMessage: 'Job queued for evaluation',
      mode,
      studentName: payload.studentName || 'Student',
      testTitle: payload.testTitle || 'Academic Assessment',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metrics: {
        correlationId,
        startTime: Date.now(),
        cacheHit: false,
        retriesCount: 0,
      },
      inputPayload: {
        sourceDoc: payload.sourceDoc,
        questionPaper: payload.questionPaper,
        answerKey: payload.answerKey,
        facultyNotes: payload.facultyNotes,
      },
    };

    this.jobs.set(id, job);
    this.persistJob(job);
    this.emit('job:created', job);

    // Schedule queue check
    setImmediate(() => this.processNext());

    return job;
  }

  public getJob(id: string): EvaluationJob | undefined {
    return this.jobs.get(id);
  }

  public getAllJobs(): EvaluationJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public retryJob(id: string): EvaluationJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (job.status !== 'failed' && job.status !== 'needs_review') {
      return job; // Only retry failed or needs_review jobs
    }

    job.status = 'queued';
    job.progressPercent = 0;
    job.error = undefined;
    job.currentStepMessage = 'Retrying evaluation job...';
    job.updatedAt = Date.now();
    job.metrics.retriesCount++;

    this.persistJob(job);
    this.emit('job:updated', job);

    setImmediate(() => this.processNext());
    return job;
  }

  /**
   * Process jobs with bounded worker concurrency
   */
  private async processNext() {
    if (this.activeWorkers >= config.maxConcurrentEvaluations) {
      return; // Concurrency limit reached; backpressure active
    }

    // Find next queued job
    const nextJob = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
    if (!nextJob) return;

    this.activeWorkers++;
    const job = nextJob;

    try {
      console.log(`[EvaluationQueue] Starting job ${job.id} (${job.studentName}). Active workers: ${this.activeWorkers}/${config.maxConcurrentEvaluations}`);

      const report = await evaluationEngine.evaluate(job, (percent, msg) => {
        job.progressPercent = percent;
        job.currentStepMessage = msg;
        job.updatedAt = Date.now();
        this.persistJob(job);
        this.emit('job:progress', job);
      });

      job.report = report;
      job.status = 'completed';
      job.progressPercent = 100;
      job.currentStepMessage = 'Evaluation complete and verified';
      job.updatedAt = Date.now();
      this.persistJob(job);
      this.emit('job:completed', job);

    } catch (err: any) {
      console.error(`[EvaluationQueue] Job ${job.id} failed:`, err);
      job.status = 'failed';
      job.error = err?.message || 'Unknown evaluation failure';
      job.currentStepMessage = `Failed: ${job.error}`;
      job.updatedAt = Date.now();
      this.persistJob(job);
      this.emit('job:failed', job);
    } finally {
      this.activeWorkers--;
      // Process next in queue
      setImmediate(() => this.processNext());
    }
  }

  public getQueueMetrics() {
    const jobs = Array.from(this.jobs.values());
    const completed = jobs.filter((j) => j.status === 'completed');
    const failed = jobs.filter((j) => j.status === 'failed');
    const queued = jobs.filter((j) => j.status === 'queued');
    const running = jobs.filter((j) => ['preprocessing', 'grading', 'validating', 'assembling_report'].includes(j.status));

    const totalCost = completed.reduce((acc, j) => acc + (j.metrics.estimatedCostUsd || 0), 0);
    const totalLatency = completed.reduce((acc, j) => acc + (j.metrics.totalLatencyMs || 0), 0);
    const avgLatencyMs = completed.length > 0 ? Math.round(totalLatency / completed.length) : 0;

    return {
      activeWorkers: this.activeWorkers,
      maxWorkers: config.maxConcurrentEvaluations,
      totalJobs: jobs.length,
      queued: queued.length,
      running: running.length,
      completed: completed.length,
      failed: failed.length,
      avgLatencyMs,
      totalEstimatedCostUsd: parseFloat(totalCost.toFixed(4)),
    };
  }
}

export const evaluationQueue = new EvaluationQueue();
