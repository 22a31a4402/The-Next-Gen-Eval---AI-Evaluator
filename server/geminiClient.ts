/**
 * Resilient Server-Side Gemini Client for NextGen Eval
 *
 * Adheres strictly to @google/genai SDK guidelines:
 * - User-Agent: 'aistudio-build'
 * - Model aliases: gemini-3.8-flash, gemini-flash-latest, gemini-3.1-flash-lite
 * - Server-only execution
 * - Enforces request deadlines (requestTimeoutMs)
 * - Exponential backoff with jitter and bounded retries ONLY for eligible transient errors
 * - Automated fallback chain across compatible Flash models
 * - Zero logging of sensitive documents, prompts, or API credentials
 */

import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config';
import { EvaluationReport } from './types';
import {
  usageLedger,
  PipelineStage,
  UsageSourceType,
  EvaluationUsageSummary,
} from './usageLedger';
import { calculateCallCost, ACTIVE_PRICING_VERSION } from './pricing';

let aiClientInstance: GoogleGenAI | null = null;

export const getGeminiClient = (): GoogleGenAI => {
  if (!aiClientInstance) {
    if (!config.geminiApiKey) {
      console.warn('[GeminiClient] Notice: GEMINI_API_KEY is not defined in process.env');
    }
    aiClientInstance = new GoogleGenAI({
      apiKey: config.geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClientInstance;
};

// Response JSON Schema for academic evaluation report
export const evaluationReportSchema = {
  type: Type.OBJECT,
  properties: {
    studentName: { type: Type.STRING },
    testTitle: { type: Type.STRING },
    testTopics: { type: Type.STRING },
    testDate: { type: Type.STRING },
    totalScore: { type: Type.NUMBER },
    maxScore: { type: Type.NUMBER },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          qNo: { type: Type.STRING },
          feedbackPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          marks: { type: Type.NUMBER },
          maxMarks: { type: Type.NUMBER },
          isCorrect: { type: Type.BOOLEAN },
          isFlagged: { type: Type.BOOLEAN },
          flaggedComment: {
            type: Type.STRING,
            description:
              'If isFlagged is true, provide a brief explanation of the discrepancy or contradiction resolved.',
          },
        },
        required: ['qNo', 'feedbackPoints', 'marks', 'maxMarks', 'isCorrect'],
      },
    },
    generalFeedback: {
      type: Type.OBJECT,
      properties: {
        overallPerformance: { type: Type.ARRAY, items: { type: Type.STRING } },
        mcqs: { type: Type.ARRAY, items: { type: Type.STRING } },
        contentAccuracy: { type: Type.ARRAY, items: { type: Type.STRING } },
        completenessOfAnswers: { type: Type.ARRAY, items: { type: Type.STRING } },
        presentationDiagrams: { type: Type.ARRAY, items: { type: Type.STRING } },
        investigations: { type: Type.ARRAY, items: { type: Type.STRING } },
        attemptingQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
        actionPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: [
        'overallPerformance',
        'mcqs',
        'contentAccuracy',
        'completenessOfAnswers',
        'presentationDiagrams',
        'investigations',
        'attemptingQuestions',
        'actionPoints',
      ],
    },
  },
  required: [
    'studentName',
    'testTitle',
    'testTopics',
    'testDate',
    'totalScore',
    'maxScore',
    'questions',
    'generalFeedback',
  ],
};

/**
 * Identifies if an error is an eligible transient failure suitable for retry
 */
export const isRetryableError = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();

  // Non-retryable client errors
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  if (msg.includes('api_key') || msg.includes('permission_denied') || msg.includes('unauthorized')) return false;

  // Retryable server or network conditions
  if (status === 503 || status === 500 || status === 429 || status === 408) return true;
  if (msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable') || msg.includes('overloaded')) return true;
  if (msg.includes('500') || msg.includes('internal error')) return true;
  if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('quota')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('timeout') || msg.includes('network error') || msg.includes('fetch failed')) return true;

  return false;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiCallOptions {
  jobId?: string;
  institutionId?: string;
  pipelineStage?: PipelineStage;
  pricingVersion?: string;
  customUsdToInrRate?: number;
  dataSourceOverride?: UsageSourceType;
}

export interface GeminiCallResult {
  report: EvaluationReport;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  estimatedCostUsd: number | null;
  estimatedCostInr: number | null;
  pricingVersion: string;
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  usageSource: UsageSourceType;
  retries: number;
  fallbackCallsCount: number;
  latencyMs: number;
  usageSummary?: EvaluationUsageSummary | null;
}

export type MockGeminiGenerateFn = (params: {
  model: string;
  contentsParts: any[];
  systemInstruction: string;
  correlationId: string;
}) => Promise<{
  text: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}>;

let mockGenerateFn: MockGeminiGenerateFn | null = null;

/**
 * Injects a mock Gemini provider for offline testing of retries, timeouts, and fallbacks
 */
export const setMockGeminiProvider = (fn: MockGeminiGenerateFn | null) => {
  mockGenerateFn = fn;
};

/**
 * Invokes Gemini with strict overall request deadline, bounded exponential backoff with jitter,
 * automated model fallback, and granular per-attempt usage ledger recording.
 */
export const callGeminiWithFallback = async (
  contentsParts: any[],
  systemInstruction: string,
  correlationId: string,
  options?: GeminiCallOptions
): Promise<GeminiCallResult> => {
  if (!config.geminiApiKey && !mockGenerateFn) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Academic evaluations cannot proceed without an API key.');
  }

  const ai = !mockGenerateFn ? getGeminiClient() : null;
  const candidateModels = [config.primaryModel, ...config.fallbackModels];
  const jobId = options?.jobId || `job_${correlationId}`;
  const institutionId = options?.institutionId || 'inst_aarshiv_01';
  const pipelineStage = options?.pipelineStage || 'grading';
  const pricingVersion = options?.pricingVersion || ACTIVE_PRICING_VERSION;
  const customUsdToInrRate = options?.customUsdToInrRate;

  let lastError: any = null;
  let totalRetries = 0;
  let fallbackCallsCount = 0;
  const overallStart = Date.now();
  const overallDeadline = overallStart + config.requestTimeoutMs;

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const modelName = candidateModels[modelIdx];
    const isFallback = modelIdx > 0;
    if (isFallback) {
      fallbackCallsCount++;
    }

    for (let attempt = 0; attempt <= config.maxRetriesPerModel; attempt++) {
      const remainingBeforeAttempt = overallDeadline - Date.now();
      if (remainingBeforeAttempt <= 0) {
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: 'timeout',
          errorCategory: 'OVERALL_DEADLINE_EXCEEDED',
          latencyMs: Date.now() - overallStart,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
          pricingVersion,
          customUsdToInrRate,
        });

        throw new Error(
          `Overall evaluation deadline exceeded (${config.requestTimeoutMs}ms) during evaluation of model ${modelName}.`
        );
      }

      if (attempt > 0) {
        totalRetries++;
        // Bounded exponential backoff with random jitter
        const baseBackoff = 1000 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 500;
        const backoffDelay = Math.min(baseBackoff + jitter, 6000);

        if (Date.now() + backoffDelay >= overallDeadline) {
          usageLedger.recordAttempt({
            jobId,
            correlationId,
            institutionId,
            pipelineStage,
            requestedModel: modelName,
            actualModel: modelName,
            attemptNumber: attempt + 1,
            isFallback,
            status: 'timeout',
            errorCategory: 'BACKOFF_DEADLINE_EXCEEDED',
            latencyMs: Date.now() - overallStart,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
            pricingVersion,
            customUsdToInrRate,
          });

          throw new Error(
            `Overall evaluation deadline (${config.requestTimeoutMs}ms) would be exceeded during retry backoff for model ${modelName}.`
          );
        }

        console.warn(
          `[GeminiClient][${correlationId}] Transient error. Retrying attempt ${attempt}/${config.maxRetriesPerModel} for ${modelName} after ${Math.round(backoffDelay)}ms...`
        );
        await delay(backoffDelay);
      }

      const callStart = Date.now();
      try {
        console.log(`[GeminiClient][${correlationId}] Calling ${modelName} (attempt ${attempt + 1})...`);
        const remainingForCall = Math.max(100, overallDeadline - Date.now());

        let timeoutHandle: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Gemini call deadline exceeded (${config.requestTimeoutMs}ms total budget)`));
          }, remainingForCall);
        });

        const executeCall = async () => {
          if (mockGenerateFn) {
            return await mockGenerateFn({
              model: modelName,
              contentsParts,
              systemInstruction,
              correlationId,
            });
          }

          return await ai!.models.generateContent({
            model: modelName,
            contents: [{ parts: contentsParts }],
            config: {
              systemInstruction,
              temperature: 0,
              seed: 42,
              responseMimeType: 'application/json',
              responseSchema: evaluationReportSchema,
            },
          });
        };

        const response = await Promise.race([executeCall(), timeoutPromise]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        });

        const latencyMs = Date.now() - callStart;
        const text = response.text;
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty response received from Gemini model ${modelName}`);
        }

        let parsed: EvaluationReport;
        try {
          parsed = JSON.parse(text) as EvaluationReport;
        } catch (jsonErr: any) {
          throw new Error(`Failed to parse Gemini response as JSON: ${jsonErr?.message}`);
        }

        parsed.evaluatedByModel = modelName;

        // Token usage accounting from API metadata
        const usageMeta = (response as any).usageMetadata;
        const hasPromptTokens = typeof usageMeta?.promptTokenCount === 'number';
        const hasCandidatesTokens = typeof usageMeta?.candidatesTokenCount === 'number';

        const inputTokens = hasPromptTokens ? usageMeta.promptTokenCount : null;
        const outputTokens = hasCandidatesTokens ? usageMeta.candidatesTokenCount : null;
        const cachedInputTokens =
          typeof usageMeta?.cachedContentTokenCount === 'number'
            ? usageMeta.cachedContentTokenCount
            : (hasPromptTokens ? 0 : null);

        let usageSource: UsageSourceType;
        if (options?.dataSourceOverride) {
          usageSource = options.dataSourceOverride;
        } else if (!hasPromptTokens && !hasCandidatesTokens) {
          usageSource = 'UNKNOWN';
        } else if (mockGenerateFn) {
          usageSource = 'SIMULATED_MOCK';
        } else if (hasPromptTokens && hasCandidatesTokens) {
          usageSource = 'ACTUAL_API';
        } else {
          usageSource = 'UNKNOWN';
        }

        // Record attempt in audit ledger
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: 'success',
          latencyMs,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          usageSource,
          pricingVersion,
          customUsdToInrRate,
        });

        // Calculate itemized and total cost
        const costCalc = calculateCallCost({
          model: modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          pricingVersion,
          customUsdToInrRate,
        });

        const summary = usageLedger.getJobUsageSummary(jobId);

        console.log(
          `[GeminiClient][${correlationId}] Successfully evaluated with ${modelName}. Latency: ${latencyMs}ms, Tokens: in=${inputTokens ?? 'N/A'}/out=${outputTokens ?? 'N/A'}/cached=${cachedInputTokens ?? 'N/A'}, EstCost: $${costCalc.totalCostUsd ?? 'N/A'} (₹${costCalc.totalCostInr ?? 'N/A'})`
        );

        return {
          report: parsed,
          modelUsed: modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          estimatedCostUsd: costCalc.totalCostUsd,
          estimatedCostInr: costCalc.totalCostInr,
          pricingVersion,
          usageCompleteness:
            inputTokens !== null && outputTokens !== null ? 'COMPLETE' : 'UNAVAILABLE',
          usageSource,
          retries: totalRetries,
          fallbackCallsCount,
          latencyMs: Date.now() - overallStart,
          usageSummary: summary,
        };
      } catch (err: any) {
        lastError = err;
        const attemptLatency = Date.now() - callStart;
        const retryable = isRetryableError(err);
        const isTimeout =
          String(err?.message || '').toLowerCase().includes('deadline exceeded') ||
          String(err?.message || '').toLowerCase().includes('timeout');

        let errorCategory = 'TRANSIENT_SERVER';
        const msg = String(err?.message || '').toLowerCase();
        if (isTimeout) errorCategory = 'TIMEOUT';
        else if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota'))
          errorCategory = 'RATE_LIMIT';
        else if (msg.includes('json')) errorCategory = 'PARSING_ERROR';
        else if (msg.includes('empty response')) errorCategory = 'EMPTY_RESPONSE';
        else if (msg.includes('400') || msg.includes('invalid')) errorCategory = 'CLIENT_ERROR';

        // Record failed attempt in audit ledger
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: isTimeout ? 'timeout' : 'failed',
          errorCategory,
          latencyMs: attemptLatency,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
          pricingVersion,
          customUsdToInrRate,
        });

        console.warn(
          `[GeminiClient][${correlationId}] Model ${modelName} attempt ${attempt + 1} failed. Retryable: ${retryable}`,
          err?.message || err
        );

        // If error is not retryable or max retries reached for this model, break to try next fallback model
        if (!retryable || attempt === config.maxRetriesPerModel) {
          break;
        }
      }
    }
  }

  throw new Error(
    `Evaluation failed across candidate models (${candidateModels.join(', ')}). Last error: ${lastError?.message || lastError}`
  );
};
