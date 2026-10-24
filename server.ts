/**
 * Dedicated Production Backend Entry Point for NextGen Eval
 *
 * Implements:
 * - Express server on port 3000
 * - Protected Gemini API invocation
 * - Correlation ID tracking
 * - Evaluation job routes & SSE streams
 * - Vite middleware integration for seamless AI Studio development
 * - Production static serving
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from './server/config';
import { evaluationsRouter } from './server/routes/evaluations';
import { healthRouter } from './server/routes/health';

const app = express();

// Security: CORS configuration
app.use(cors());

// Parse large JSON payloads for document uploads (up to 50MB for multimodal PDF/visual data)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Correlation ID & non-sensitive operational access logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = Date.now();
  res.on('finish', () => {
    // Log non-sensitive metadata only (path, method, status, duration)
    const duration = Date.now() - start;
    if (!req.path.startsWith('/@') && !req.path.startsWith('/src') && !req.path.includes('.')) {
      console.log(`[HTTP][${correlationId}] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
});

// Mount dedicated backend routes
app.use(healthRouter);
app.use('/api/evaluations', evaluationsRouter);

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server Error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    category: 'Backend Processing Error',
  });
});

async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    // Dynamic import of Vite in development mode
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[NextGen Eval] Vite dev middlewares mounted successfully.');
  } else {
    // Production static file serving
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      console.log(`[NextGen Eval] Serving static production files from: ${distPath}`);
    }
  }

  const PORT = config.port;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` NextGen Eval Dedicated AI Backend Server`);
    console.log(` Port: ${PORT}`);
    console.log(` Mode: ${isDev ? 'Development' : 'Production'}`);
    console.log(` Primary Model: ${config.primaryModel}`);
    console.log(` Fallback Models: ${config.fallbackModels.join(', ')}`);
    console.log(` Concurrency Limit: ${config.maxConcurrentEvaluations}`);
    console.log(` Health: http://localhost:${PORT}/health`);
    console.log(`=======================================================`);
  });
}

startServer().catch((err) => {
  console.error('[Fatal] Failed to start server:', err);
  process.exit(1);
});
