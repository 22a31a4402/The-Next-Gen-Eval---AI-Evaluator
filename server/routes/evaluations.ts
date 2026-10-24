/**
 * Evaluation API Routes for NextGen Eval
 *
 * Provides:
 * - POST /api/evaluations: Enqueue evaluation job
 * - GET  /api/evaluations/:id: Query job status and progress
 * - GET  /api/evaluations/:id/results: Retrieve validated evaluation report
 * - POST /api/evaluations/:id/retry: Retry failed evaluation
 * - GET  /api/evaluations/:id/events: Server-Sent Events (SSE) real-time streaming
 * - POST /api/evaluations/sync: Synchronous evaluation for backward compatibility
 * - GET  /api/evaluations: List all jobs
 * - GET  /api/metrics: System performance and cost metrics
 */

import { Router, Request, Response } from 'express';
import { evaluationQueue } from '../queue';
import { evaluationCache } from '../cache';
import { EvaluationJob, EvaluationMode } from '../types';

export const evaluationsRouter = Router();

/**
 * POST /api/evaluations
 * Create & enqueue a new evaluation job
 */
evaluationsRouter.post('/', (req: Request, res: Response): void => {
  try {
    const {
      sourceDoc,
      questionPaper,
      answerKey,
      facultyNotes,
      mode = 'with-manual',
      studentName,
      testTitle,
    } = req.body;

    if (!sourceDoc || (!sourceDoc.text && !sourceDoc.base64)) {
      res.status(400).json({
        error: 'Invalid request: sourceDoc (with text or visual base64) is required.',
      });
      return;
    }

    if (mode === 'with-manual' && !facultyNotes) {
      res.status(400).json({
        error: 'Invalid request: facultyNotes is required for with-manual mode.',
      });
      return;
    }

    const job = evaluationQueue.enqueue({
      sourceDoc,
      questionPaper,
      answerKey,
      facultyNotes,
      mode: mode as EvaluationMode,
      studentName,
      testTitle,
    });

    res.status(202).json({
      jobId: job.id,
      correlationId: job.correlationId,
      status: job.status,
      message: 'Evaluation job accepted and queued for processing.',
      links: {
        status: `/api/evaluations/${job.id}`,
        results: `/api/evaluations/${job.id}/results`,
        events: `/api/evaluations/${job.id}/events`,
      },
    });
  } catch (err: any) {
    console.error('[evaluationsRouter] Error creating job:', err);
    res.status(500).json({ error: err?.message || 'Internal server error creating evaluation job' });
  }
});

/**
 * GET /api/evaluations/:id
 * Retrieve job status, progress, and execution metrics
 */
evaluationsRouter.get('/:id', (req: Request, res: Response): void => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);
  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  res.json({
    id: job.id,
    correlationId: job.correlationId,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStepMessage: job.currentStepMessage,
    studentName: job.studentName,
    testTitle: job.testTitle,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    metrics: job.metrics,
    hasReport: Boolean(job.report),
  });
});

/**
 * GET /api/evaluations/:id/results
 * Retrieve final validated evaluation report
 */
evaluationsRouter.get('/:id/results', (req: Request, res: Response): void => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);
  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  if (job.status !== 'completed' || !job.report) {
    res.status(409).json({
      error: `Report is not ready. Current job status: ${job.status}`,
      progressPercent: job.progressPercent,
      currentStepMessage: job.currentStepMessage,
    });
    return;
  }

  res.json({
    id: job.id,
    report: job.report,
    metrics: job.metrics,
  });
});

/**
 * POST /api/evaluations/:id/retry
 * Safe retry of eligible failed tasks
 */
evaluationsRouter.post('/:id/retry', (req: Request, res: Response): void => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.retryJob(id);
  if (!job) {
    res.status(404).json({ error: `Evaluation job not found or ineligible for retry: ${id}` });
    return;
  }

  res.json({
    id: job.id,
    status: job.status,
    message: 'Evaluation job queued for retry.',
  });
});

/**
 * GET /api/evaluations/:id/events
 * Real-time Server-Sent Events (SSE) stream for status and progress
 */
evaluationsRouter.get('/:id/events', (req: Request, res: Response): void => {
  const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${jobId}` });
    return;
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial state
  sendEvent('status', {
    id: job.id,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStepMessage: job.currentStepMessage,
  });

  if (job.status === 'completed') {
    sendEvent('completed', { report: job.report, metrics: job.metrics });
    res.end();
    return;
  }

  if (job.status === 'failed') {
    sendEvent('failed', { error: job.error });
    res.end();
    return;
  }

  // Listeners for progress
  const onProgress = (updatedJob: EvaluationJob) => {
    if (updatedJob.id === jobId) {
      sendEvent('progress', {
        id: updatedJob.id,
        status: updatedJob.status,
        progressPercent: updatedJob.progressPercent,
        currentStepMessage: updatedJob.currentStepMessage,
      });
    }
  };

  const onCompleted = (completedJob: EvaluationJob) => {
    if (completedJob.id === jobId) {
      sendEvent('completed', {
        id: completedJob.id,
        report: completedJob.report,
        metrics: completedJob.metrics,
      });
      cleanup();
      res.end();
    }
  };

  const onFailed = (failedJob: EvaluationJob) => {
    if (failedJob.id === jobId) {
      sendEvent('failed', {
        id: failedJob.id,
        error: failedJob.error,
      });
      cleanup();
      res.end();
    }
  };

  const cleanup = () => {
    evaluationQueue.off('job:progress', onProgress);
    evaluationQueue.off('job:completed', onCompleted);
    evaluationQueue.off('job:failed', onFailed);
  };

  evaluationQueue.on('job:progress', onProgress);
  evaluationQueue.on('job:completed', onCompleted);
  evaluationQueue.on('job:failed', onFailed);

  req.on('close', cleanup);
});

/**
 * POST /api/evaluations/sync
 * Synchronous direct evaluation endpoint (useful for tests or immediate evaluation)
 */
evaluationsRouter.post('/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      sourceDoc,
      questionPaper,
      answerKey,
      facultyNotes,
      mode = 'with-manual',
      studentName,
      testTitle,
    } = req.body;

    if (!sourceDoc || (!sourceDoc.text && !sourceDoc.base64)) {
      res.status(400).json({ error: 'sourceDoc is required.' });
      return;
    }

    const job = evaluationQueue.enqueue({
      sourceDoc,
      questionPaper,
      answerKey,
      facultyNotes,
      mode: mode as EvaluationMode,
      studentName,
      testTitle,
    });

    // Wait for completion or timeout
    const timeoutMs = 95000;
    const startTime = Date.now();

    const waitForJob = new Promise<EvaluationJob>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const current = evaluationQueue.getJob(job.id);
        if (!current) {
          clearInterval(checkInterval);
          reject(new Error('Job lost'));
          return;
        }

        if (current.status === 'completed') {
          clearInterval(checkInterval);
          resolve(current);
        } else if (current.status === 'failed') {
          clearInterval(checkInterval);
          reject(new Error(current.error || 'Evaluation failed'));
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error('Evaluation timed out'));
        }
      }, 500);
    });

    const finishedJob = await waitForJob;
    res.json({
      report: finishedJob.report,
      metrics: finishedJob.metrics,
      jobId: finishedJob.id,
    });
  } catch (err: any) {
    console.error('[evaluationsRouter] Sync evaluation failed:', err);
    res.status(500).json({ error: err?.message || 'Sync evaluation failed' });
  }
});

/**
 * GET /api/evaluations
 * List recent evaluations
 */
evaluationsRouter.get('/', (_req: Request, res: Response): void => {
  const jobs = evaluationQueue.getAllJobs().map((j) => ({
    id: j.id,
    studentName: j.studentName,
    testTitle: j.testTitle,
    status: j.status,
    progressPercent: j.progressPercent,
    currentStepMessage: j.currentStepMessage,
    createdAt: j.createdAt,
    metrics: j.metrics,
  }));
  res.json(jobs);
});
