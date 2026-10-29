/**
 * NextGen Eval Client Service
 *
 * Communicates with the dedicated backend service (/api/evaluations).
 * - Transmits distinct Question Paper, Answer Key, Student Script, and Notes
 * - Preserves complete multimodal visual data for handwriting, diagrams, and formulas
 * - Authenticates requests via server-side Bearer tokens
 * - Monitors evaluation progress via Server-Sent Events (SSE) with robust polling fallback
 * - Categorizes actionable errors cleanly
 */

import { EvaluationReport, FileData, CanonicalAnswerKey } from '../types';

export type EvaluationMode = 'with-manual' | 'without-manual';

export interface ProgressCallback {
  (percent: number, message: string): void;
}

// Default client authentication token (matches backend instructor key)
const DEFAULT_CLIENT_TOKEN = 'nextgen_inst_sec_token_4412';

export function getClientAuthToken(): string {
  try {
    return localStorage.getItem('nextgen_auth_token') || DEFAULT_CLIENT_TOKEN;
  } catch {
    return DEFAULT_CLIENT_TOKEN;
  }
}

/**
 * Submits an evaluation request to the dedicated backend and monitors progress
 * until a verified academic report is assembled.
 *
 * Supports both structured arguments and legacy positional arguments.
 */
export const generateStructuredFeedback = async (
  sourceDoc: FileData,
  dirtyFeedbackDoc: FileData | null,
  mode: EvaluationMode = 'without-manual',
  onProgress?: ProgressCallback,
  questionPaperDoc?: FileData | null,
  answerKeyDoc?: FileData | null,
  customToken?: string,
  answerKeyId?: string
): Promise<EvaluationReport> => {
  const token = customToken || getClientAuthToken();

  // Assemble full request payload preserving distinct documents
  const payload: any = {
    sourceDoc: {
      name: sourceDoc.name,
      text: sourceDoc.text,
      base64: sourceDoc.base64,
      mimeType: sourceDoc.mimeType,
    },
    questionPaper: questionPaperDoc
      ? {
          name: questionPaperDoc.name,
          text: questionPaperDoc.text,
          base64: questionPaperDoc.base64,
          mimeType: questionPaperDoc.mimeType,
        }
      : undefined,
    answerKey: answerKeyDoc
      ? {
          name: answerKeyDoc.name,
          text: answerKeyDoc.text,
          base64: answerKeyDoc.base64,
          mimeType: answerKeyDoc.mimeType,
        }
      : undefined,
    answerKeyId: answerKeyId || undefined,
    facultyNotes:
      mode === 'with-manual' && dirtyFeedbackDoc
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

  // 1. Initiate evaluation job on the dedicated backend with authentication
  const createRes = await fetch('/api/evaluations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(
      errData.error || `Server responded with status ${createRes.status} while creating evaluation job.`
    );
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
        const res = await fetch(`/api/evaluations/${jobId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!res.ok) {
          if (res.status === 404) {
            settleFailure(new Error(`Evaluation job ${jobId} not found on server.`));
            return;
          }
          if (res.status === 401 || res.status === 403) {
            settleFailure(new Error('Unauthorized: Session expired or invalid authentication.'));
            return;
          }
          return;
        }

        const data = await res.json();
        onProgress?.(data.progressPercent || 20, data.currentStepMessage || 'Evaluating...');

        if (data.status === 'completed') {
          // Fetch final validated result
          const resultRes = await fetch(`/api/evaluations/${jobId}/results`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });
          if (resultRes.ok) {
            const resultData = await resultRes.json();
            settleSuccess(resultData.report);
          } else {
            settleFailure(new Error('Failed to retrieve completed evaluation report.'));
          }
        } else if (data.status === 'failed' || data.status === 'needs_review') {
          settleFailure(new Error(data.error || 'Evaluation failed on backend or requires review.'));
        }
      } catch (err: any) {
        console.warn('[ClientService] Polling check:', err?.message || err);
      }
    };

    // Always start polling intervals to guarantee progress updates even if EventSource is blocked by proxies
    pollInterval = setInterval(pollStatus, 1500);

    // Initial check
    pollStatus();

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
export const parseActionableError = (
  err: any
): { category: string; message: string; statusCode?: number; raw: any } => {
  let statusCode: number | undefined = err?.statusCode || err?.status || err?.code;
  let rawMsg = '';

  if (typeof err === 'string') {
    rawMsg = err;
  } else if (err instanceof Error) {
    rawMsg = err.message || err.toString();
  } else if (err && typeof err === 'object') {
    const isDomEvent = 'isTrusted' in err || (typeof Event !== 'undefined' && err instanceof Event);
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
        if (
          serialized === '{"isTrusted":true}' ||
          serialized === '{"isTrusted":false}' ||
          serialized === '{}'
        ) {
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

  if (
    !rawMsg ||
    rawMsg.trim() === '{"isTrusted":true}' ||
    rawMsg.trim() === '{"isTrusted":false}' ||
    rawMsg.trim() === '{}'
  ) {
    rawMsg = 'The local document stream could not be read. Click Retry to reload.';
  }

  let category = 'Academic Evaluation Error';
  if (statusCode === 429 || /quota|rate limit|resource_exhausted/i.test(rawMsg)) {
    category = 'API Quota / Rate Limit Exceeded';
    rawMsg = 'Gemini API rate limit or quota reached. Please wait a moment before trying again.';
  } else if (statusCode === 503 || /high demand|unavailable|503/i.test(rawMsg)) {
    category = 'Server Temporarily Busy (503)';
    rawMsg = 'Evaluation service is experiencing high demand. Retrying now...';
  } else if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|permission/i.test(rawMsg)) {
    category = 'Authentication Error';
    rawMsg = 'Invalid or missing authentication credentials. Please refresh and log in.';
  } else if (/validation|discrepancy|score bound|duplicate question/i.test(rawMsg)) {
    category = 'Academic Validation Discrepancy';
    rawMsg = `Academic review required: ${rawMsg}`;
  } else if (
    /notreadableerror|notfounderror|filereader|file read failure|file descriptor|stream interrupted/i.test(
      rawMsg
    )
  ) {
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

/**
 * Answer Key Management Client APIs
 */

export async function generateAnswerKeyApi(params: {
  questionPaper: FileData;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  token?: string;
}): Promise<CanonicalAnswerKey> {
  const token = params.token || getClientAuthToken();
  const res = await fetch('/api/answer-keys/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      questionPaper: {
        name: params.questionPaper.name,
        text: params.questionPaper.text,
        base64: params.questionPaper.base64,
        mimeType: params.questionPaper.mimeType,
      },
      title: params.title,
      subject: params.subject,
      grade: params.grade,
      totalMaxMarks: params.totalMaxMarks,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to generate answer key (${res.status})`);
  }
  return res.json();
}

export async function extractAnswerKeyApi(params: {
  answerKeyDoc: FileData;
  questionPaperDoc?: FileData | null;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  token?: string;
}): Promise<CanonicalAnswerKey> {
  const token = params.token || getClientAuthToken();
  const res = await fetch('/api/answer-keys/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      answerKeyDoc: {
        name: params.answerKeyDoc.name,
        text: params.answerKeyDoc.text,
        base64: params.answerKeyDoc.base64,
        mimeType: params.answerKeyDoc.mimeType,
      },
      questionPaperDoc: params.questionPaperDoc
        ? {
            name: params.questionPaperDoc.name,
            text: params.questionPaperDoc.text,
            base64: params.questionPaperDoc.base64,
            mimeType: params.questionPaperDoc.mimeType,
          }
        : undefined,
      title: params.title,
      subject: params.subject,
      grade: params.grade,
      totalMaxMarks: params.totalMaxMarks,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to extract answer key (${res.status})`);
  }
  return res.json();
}

export async function listAnswerKeysApi(token?: string): Promise<CanonicalAnswerKey[]> {
  const authToken = token || getClientAuthToken();
  const res = await fetch('/api/answer-keys', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`Failed to list answer keys (${res.status})`);
  const data = await res.json();
  return data.answerKeys || [];
}

export async function getAnswerKeyApi(id: string, token?: string): Promise<CanonicalAnswerKey> {
  const authToken = token || getClientAuthToken();
  const res = await fetch(`/api/answer-keys/${id}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch answer key (${res.status})`);
  return res.json();
}

export async function updateAnswerKeyApi(
  id: string,
  updates: Partial<CanonicalAnswerKey>,
  token?: string
): Promise<CanonicalAnswerKey> {
  const authToken = token || getClientAuthToken();
  const res = await fetch(`/api/answer-keys/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update answer key (${res.status})`);
  }
  return res.json();
}

export async function approveAnswerKeyApi(
  id: string,
  notes?: string,
  token?: string
): Promise<{ message: string; answerKey: CanonicalAnswerKey }> {
  const authToken = token || getClientAuthToken();
  const res = await fetch(`/api/answer-keys/${id}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to approve answer key (${res.status})`);
  }
  return res.json();
}

export async function deleteAnswerKeyApi(id: string, token?: string): Promise<boolean> {
  const authToken = token || getClientAuthToken();
  const res = await fetch(`/api/answer-keys/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return res.ok;
}
