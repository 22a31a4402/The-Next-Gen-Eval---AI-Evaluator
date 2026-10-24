/**
 * Resilient Server-Side Gemini Client for NextGen Eval
 * Strict adherence to @google/genai SDK guidelines:
 * - User-Agent: 'aistudio-build'
 * - Model aliases: gemini-3.8-flash, gemini-flash-latest, gemini-3.1-flash-lite
 * - Server-only execution
 * - Exponential backoff, jitter, and automated model fallback
 */

import { GoogleGenAI, Type } from "@google/genai";
import { config } from "./config";
import { EvaluationReport } from "./types";

let aiClientInstance: GoogleGenAI | null = null;

export const getGeminiClient = (): GoogleGenAI => {
  if (!aiClientInstance) {
    if (!config.geminiApiKey) {
      console.warn("[GeminiClient] Warning: GEMINI_API_KEY is not defined in process.env");
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
            description: "If isFlagged is true, provide a brief explanation of the discrepancy or contradiction resolved."
          }
        },
        required: ["qNo", "feedbackPoints", "marks", "maxMarks", "isCorrect"]
      }
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
        actionPoints: { type: Type.ARRAY, items: { type: Type.STRING } }
      },
      required: [
        "overallPerformance",
        "mcqs",
        "contentAccuracy",
        "completenessOfAnswers",
        "presentationDiagrams",
        "investigations",
        "attemptingQuestions",
        "actionPoints"
      ]
    }
  },
  required: [
    "studentName",
    "testTitle",
    "testTopics",
    "testDate",
    "totalScore",
    "maxScore",
    "questions",
    "generalFeedback"
  ]
};

const isRetryableError = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();
  if (status === 503 || status === 500 || status === 429 || status === 408) return true;
  if (msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable')) return true;
  if (msg.includes('500') || msg.includes('internal error')) return true;
  if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('quota')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network error') || msg.includes('fetch failed')) return true;
  return false;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiCallResult {
  report: EvaluationReport;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  retries: number;
  latencyMs: number;
}

export const callGeminiWithFallback = async (
  contentsParts: any[],
  systemInstruction: string,
  correlationId: string
): Promise<GeminiCallResult> => {
  const ai = getGeminiClient();
  const candidateModels = [config.primaryModel, ...config.fallbackModels];

  let lastError: any = null;
  let totalRetries = 0;
  const startTime = Date.now();

  for (const modelName of candidateModels) {
    for (let attempt = 0; attempt <= config.maxRetriesPerModel; attempt++) {
      if (attempt > 0) {
        totalRetries++;
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 6000);
        console.warn(`[GeminiClient][${correlationId}] Retry ${attempt}/${config.maxRetriesPerModel} for ${modelName} after ${Math.round(backoffDelay)}ms...`);
        await delay(backoffDelay);
      }

      try {
        console.log(`[GeminiClient][${correlationId}] Invoking model ${modelName} (attempt ${attempt + 1})...`);
        const callStart = Date.now();
        
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ parts: contentsParts }],
          config: {
            systemInstruction,
            temperature: 0,
            seed: 42,
            responseMimeType: "application/json",
            responseSchema: evaluationReportSchema,
          },
        });

        const latencyMs = Date.now() - callStart;
        const text = response.text;
        if (!text) {
          throw new Error(`Empty response received from Gemini model ${modelName}`);
        }

        const parsed = JSON.parse(text) as EvaluationReport;
        parsed.evaluatedByModel = modelName;

        // Extract token usage
        const usage = (response as any).usageMetadata || {};
        const inputTokens = usage.promptTokenCount || 0;
        const outputTokens = usage.candidatesTokenCount || 0;

        // Calculate cost based on configured pricing
        const inputCost = (inputTokens / 1_000_000) * config.pricing.inputPerMillion;
        const outputCost = (outputTokens / 1_000_000) * config.pricing.outputPerMillion;
        const estimatedCostUsd = Number((inputCost + outputCost).toFixed(6));

        console.log(`[GeminiClient][${correlationId}] Success with ${modelName}. Latency: ${latencyMs}ms, InputTokens: ${inputTokens}, OutputTokens: ${outputTokens}, Cost: $${estimatedCostUsd}`);

        return {
          report: parsed,
          modelUsed: modelName,
          inputTokens,
          outputTokens,
          estimatedCostUsd,
          retries: totalRetries,
          latencyMs: Date.now() - startTime,
        };
      } catch (err: any) {
        lastError = err;
        const retryable = isRetryableError(err);
        console.warn(`[GeminiClient][${correlationId}] Model ${modelName} attempt ${attempt + 1} failed. Retryable: ${retryable}`, err?.message || err);

        if (!retryable || attempt === config.maxRetriesPerModel) {
          // Advance to next fallback model
          break;
        }
      }
    }
  }

  throw new Error(`Evaluation failed across all candidate models (${candidateModels.join(', ')}). Last error: ${lastError?.message || lastError}`);
};
