/**
 * Centralized Server Configuration for NextGen Eval Dedicated Backend
 */

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || '',
  // Primary model and fallback chain
  primaryModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  fallbackModels: ['gemini-flash-latest', 'gemini-3.1-flash-lite'],
  // Concurrency & Rate Limiting
  maxConcurrentEvaluations: parseInt(process.env.MAX_CONCURRENT_EVALS || '4', 10),
  maxRetriesPerModel: 2,
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '90000', 10), // 90s
  // Token Pricing per 1M tokens (Gemini 2.5 / 3.x Flash tier)
  pricing: {
    inputPerMillion: 0.075,  // $0.075 per 1M input tokens
    outputPerMillion: 0.30,  // $0.30 per 1M output tokens
  },
  // Cache TTL: 7 days
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  // Persistent data directory
  dataDir: process.env.DATA_DIR || './.data/evaluations',
  // Environment
  isProduction: process.env.NODE_ENV === 'production',
};
