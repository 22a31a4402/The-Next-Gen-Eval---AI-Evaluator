/**
 * NextGen Eval Client Service
 *
 * Communicates with the dedicated backend service (/api/evaluations).
 * - Credentials and Gemini SDK invocations are strictly executed on the server.
 * - Supports real-time progress events via Server-Sent Events (SSE) with robust polling fallback.
 * - Provides resilient error diagnostics via parseActionableError.
 */

import { EvaluationReport, FileData } from "../types";

export type EvaluationMode = 'with-manual' | 'without-manual';

export interface ProgressCallback {
  (percent: number, message: string): void;
}

/**
 * Submits an evaluation request to the dedicated backend and monitors progress
 * until a verified academic report is assembled.
 */
export const generateStructuredFeedback = async (
  sourceDoc: FileData,
  dirtyFeedbackDoc: FileData | null,
  mode: EvaluationMode = 'with-manual',
  onProgress?: ProgressCallback
): Promise<EvaluationReport> => {
  // Format payload for backend document processor
  const payload = {
    sourceDoc: {
      name: sourceDoc.name,
      text: sourceDoc.text,
      base64: sourceDoc.base64,
      mimeType: sourceDoc.mimeType,
    },
    facultyNotes: (mode === 'with-manual' && dirtyFeedbackDoc)
      ? {
          name: dirtyFeedbackDoc.name,
          text: dirtyFeedbackDoc.text,
          base64: dirtyFeedbackDoc.base64,
          mimeType: dirtyFeedbackDoc.mimeType,
        }
      : null,
    mode,
    studentName: sourceDoc.name,
    testTitle: 'Academic Assessment',
  };

  onProgress?.(5, 'Submitting answer sheet to evaluation backend...');

  // 1. Initiate evaluation job on the dedicated backend
  const createRes = await fetch('/api/evaluations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(errData.error || `Server responded with status ${createRes.status} while creating evaluation job.`);
  }

  const { jobId } = await createRes.json();
  if (!jobId) {
    throw new Error('Invalid server response: No job ID returned by evaluation backend.');
  }

  onProgress?.(10, 'Evaluation job queued on server...');

  // 2. Monitor job status via Server-Sent Events (SSE) with Polling Fallback
  return new Promise<EvaluationReport>((resolve, reject) => {
    let isSettled = false;
    let sseSource: EventSource | null = null;
    let pollInterval: any = null;

    const cleanup = () => {
      if (sseSource) {
        sseSource.close();
        sseSource = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const settleSuccess = (report: EvaluationReport) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve(report);
    };

    const settleFailure = (err: Error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err);
    };

    // Polling function used as fallback or verification
    const pollStatus = async () => {
      try {
        const res = await fetch(`/api/evaluations/${jobId}`);
        if (!res.ok) {
          if (res.status === 404) {
            settleFailure(new Error(`Evaluation job ${jobId} not found on server.`));
            return;
          }
          return;
        }

        const data = await res.json();
        onProgress?.(data.progressPercent || 20, data.currentStepMessage || 'Evaluating...');

        if (data.status === 'completed') {
          // Fetch final result
          const resultRes = await fetch(`/api/evaluations/${jobId}/results`);
          if (resultRes.ok) {
            const resultData = await resultRes.json();
            settleSuccess(resultData.report);
          } else {
            settleFailure(new Error('Failed to retrieve completed evaluation report.'));
          }
        } else if (data.status === 'failed') {
          settleFailure(new Error(data.error || 'Evaluation failed on backend.'));
        }
      } catch (err: any) {
        console.warn('[ClientService] Polling warning:', err);
      }
    };

    // Try EventSource if available in browser
    if (typeof EventSource !== 'undefined') {
      try {
        sseSource = new EventSource(`/api/evaluations/${jobId}/events`);

        sseSource.addEventListener('progress', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            onProgress?.(data.progressPercent, data.currentStepMessage);
          } catch (_) {}
        });

        sseSource.addEventListener('completed', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            settleSuccess(data.report);
          } catch (err) {
            // Fallback to polling to get the result
            pollStatus();
          }
        });

        sseSource.addEventListener('failed', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            settleFailure(new Error(data.error || 'Evaluation failed on server.'));
          } catch (_) {
            settleFailure(new Error('Evaluation failed on server.'));
          }
        });

        sseSource.onerror = () => {
          // SSE connection dropped; activate polling fallback
          if (!isSettled && !pollInterval) {
            console.log('[ClientService] SSE stream closed/interrupted; switching to polling fallback...');
            pollInterval = setInterval(pollStatus, 1200);
            pollStatus();
          }
        };
      } catch (e) {
        // SSE init error; use polling
        pollInterval = setInterval(pollStatus, 1200);
        pollStatus();
      }
    } else {
      // EventSource not supported; use polling
      pollInterval = setInterval(pollStatus, 1200);
      pollStatus();
    }

    // Safety timeout: 120 seconds
    setTimeout(() => {
      if (!isSettled) {
        settleFailure(new Error('Evaluation timed out waiting for backend processing.'));
      }
    }, 120000);
  });
};

/**
 * Diagnostic helper that formats and categorizes error messages for the user.
 */
export const parseActionableError = (err: any): { category: string; message: string; statusCode?: number; raw: any } => {
  let statusCode: number | undefined = err?.statusCode || err?.status || err?.code;
  let rawMsg = '';

  if (typeof err === 'string') {
    rawMsg = err;
  } else if (err instanceof Error) {
    rawMsg = err.message || err.toString();
  } else if (err && typeof err === 'object') {
    const isDomEvent = ('isTrusted' in err) || (typeof Event !== 'undefined' && err instanceof Event);
    if (isDomEvent) {
      const target = (err as any).target;
      const targetError = target?.error;
      const eventError = (err as any).error;
      const eventReason = (err as any).reason;

      if (targetError) {
        rawMsg = targetError.message || targetError.name || String(targetError);
      } else if (eventError) {
        rawMsg = eventError instanceof Error ? eventError.message : String(eventError);
      } else if (eventReason) {
        rawMsg = eventReason instanceof Error ? eventReason.message : String(eventReason);
      } else {
        const evType = (err as any).type || 'browser';
        rawMsg = `Browser ${evType} stream interrupted. The file descriptor or network stream could not be accessed.`;
      }
    } else if (err.message) {
      rawMsg = String(err.message);
    } else if (err.error?.message) {
      rawMsg = String(err.error.message);
    } else if (err.statusText) {
      rawMsg = String(err.statusText);
    } else {
      try {
        const serialized = JSON.stringify(err);
        if (serialized === '{"isTrusted":true}' || serialized === '{"isTrusted":false}' || serialized === '{}') {
          rawMsg = 'Local file or network connection stream was interrupted by browser sandbox.';
        } else {
          rawMsg = serialized;
        }
      } catch (_) {
        rawMsg = String(err);
      }
    }
  }

  try {
    const parsed = JSON.parse(rawMsg);
    if (parsed?.error?.message) {
      rawMsg = parsed.error.message;
      if (parsed.error.code) statusCode = parsed.error.code;
    }
  } catch (_) {}

  if (!rawMsg || rawMsg.trim() === '{"isTrusted":true}' || rawMsg.trim() === '{"isTrusted":false}' || rawMsg.trim() === '{}') {
    rawMsg = 'The local document stream could not be read. Click Retry to reload.';
  }

  let category = 'Academic Evaluation Error';
  if (statusCode === 429 || /quota|rate limit|resource_exhausted/i.test(rawMsg)) {
    category = 'API Quota / Rate Limit Exceeded';
    rawMsg = 'Gemini API rate limit or quota reached. Please wait a moment before trying again.';
  } else if (statusCode === 503 || /high demand|unavailable|503/i.test(rawMsg)) {
    category = 'Gemini Server Temporarily Busy (503)';
    rawMsg = 'Google Gemini service is temporarily experiencing high traffic. Retrying now...';
  } else if (statusCode === 401 || statusCode === 403 || /api key|unauthorized|permission/i.test(rawMsg)) {
    category = 'API Authentication Error';
    rawMsg = 'Gemini API Key is invalid or missing server-side. Please check server configuration.';
  } else if (/notreadableerror|notfounderror|filereader|file read failure|file descriptor|stream interrupted/i.test(rawMsg)) {
    category = 'Document File Access Error';
    rawMsg = `Local file access issue: ${rawMsg}. Click "Retry" to re-read the file.`;
  } else if (/capture target|html2canvas|canvas|jspdf|render/i.test(rawMsg)) {
    category = 'PDF Generation Error';
  } else if (/pdf|docx|mammoth/i.test(rawMsg)) {
    category = 'Document Extraction Error';
  }

  return {
    category,
    message: rawMsg || 'An unknown error occurred during evaluation pipeline.',
    statusCode,
    raw: err,
  };
};
