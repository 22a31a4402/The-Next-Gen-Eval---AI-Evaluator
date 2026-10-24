/**
 * Health, Readiness, and System Metrics Router for NextGen Eval
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { evaluationQueue } from '../queue';
import { evaluationCache } from '../cache';

export const healthRouter = Router();

/**
 * GET /health
 * Liveness probe
 */
healthRouter.get('/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: '2.0.0',
    service: 'nextgen-eval-backend',
  });
});

/**
 * GET /ready
 * Readiness probe
 */
healthRouter.get('/ready', (_req: Request, res: Response): void => {
  const isKeyConfigured = Boolean(config.geminiApiKey);

  res.json({
    status: isKeyConfigured ? 'ready' : 'configuration_warning',
    geminiApiKeyConfigured: isKeyConfigured,
    primaryModel: config.primaryModel,
    fallbackModels: config.fallbackModels,
    maxConcurrentEvaluations: config.maxConcurrentEvaluations,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/metrics
 * System metrics, throughput, latency, cache efficiency, and token costs
 */
healthRouter.get('/api/metrics', (_req: Request, res: Response): void => {
  const queueMetrics = evaluationQueue.getQueueMetrics();
  const cacheStats = evaluationCache.getStats();

  res.json({
    service: 'nextgen-eval',
    timestamp: new Date().toISOString(),
    queue: queueMetrics,
    cache: cacheStats,
    models: {
      primary: config.primaryModel,
      fallbacks: config.fallbackModels,
    },
    pricingTier: config.pricing,
  });
});
