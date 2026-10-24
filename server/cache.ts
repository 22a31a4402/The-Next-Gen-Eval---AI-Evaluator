/**
 * Cryptographic Evaluation Cache Service for NextGen Eval
 * Provides deterministic SHA-256 fingerprinting for:
 * - Document contents (student script, question paper, answer key, notes)
 * - Evaluation mode
 * - Prompt version & model ID
 *
 * Prevents redundant Gemini calls, minimizes token expenditure, and maintains observability.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { EvaluationReport } from './types';

const PROMPT_VERSION = 'nextgen_eval_engine_v4.0';

export interface CacheEntry {
  cacheKey: string;
  report: EvaluationReport;
  timestamp: number;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostSaved: number;
}

export class EvaluationCacheService {
  private memoryCache = new Map<string, CacheEntry>();
  private cacheDir: string;
  public totalRequests = 0;
  public cacheHits = 0;

  constructor() {
    this.cacheDir = path.join(config.dataDir, 'cache');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[CacheService] Failed creating disk cache dir:', e);
    }
  }

  /**
   * Generates a cryptographic SHA-256 fingerprint
   */
  public generateFingerprint(payload: {
    sourceDoc: { text?: string; base64?: string; name?: string };
    questionPaper?: { text?: string; base64?: string; name?: string };
    answerKey?: { text?: string; base64?: string; name?: string };
    facultyNotes?: { text?: string; base64?: string; name?: string } | null;
    mode: string;
    model: string;
  }): string {
    const hash = crypto.createHash('sha256');
    hash.update(PROMPT_VERSION);
    hash.update(payload.mode || 'with-manual');
    hash.update(payload.model || config.primaryModel);

    // Hash source doc
    hash.update(payload.sourceDoc.name || '');
    if (payload.sourceDoc.text) hash.update(payload.sourceDoc.text);
    if (payload.sourceDoc.base64) {
      // Hash first 1000 and last 1000 bytes + length to be fast and unique
      hash.update(`${payload.sourceDoc.base64.length}:${payload.sourceDoc.base64.slice(0, 1000)}:${payload.sourceDoc.base64.slice(-1000)}`);
    }

    // Hash question paper if present
    if (payload.questionPaper) {
      hash.update(payload.questionPaper.name || '');
      if (payload.questionPaper.text) hash.update(payload.questionPaper.text);
      if (payload.questionPaper.base64) {
        hash.update(`${payload.questionPaper.base64.length}:${payload.questionPaper.base64.slice(0, 500)}`);
      }
    }

    // Hash answer key if present
    if (payload.answerKey) {
      hash.update(payload.answerKey.name || '');
      if (payload.answerKey.text) hash.update(payload.answerKey.text);
      if (payload.answerKey.base64) {
        hash.update(`${payload.answerKey.base64.length}:${payload.answerKey.base64.slice(0, 500)}`);
      }
    }

    // Hash faculty notes if mode is with-manual
    if (payload.mode === 'with-manual' && payload.facultyNotes) {
      hash.update(payload.facultyNotes.name || '');
      if (payload.facultyNotes.text) hash.update(payload.facultyNotes.text);
      if (payload.facultyNotes.base64) {
        hash.update(`${payload.facultyNotes.base64.length}:${payload.facultyNotes.base64.slice(0, 500)}`);
      }
    }

    return hash.digest('hex');
  }

  public get(key: string): CacheEntry | null {
    this.totalRequests++;

    // 1. Check memory cache
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      if (Date.now() - memEntry.timestamp < config.cacheTtlMs) {
        this.cacheHits++;
        return memEntry;
      }
      this.memoryCache.delete(key);
    }

    // 2. Check disk cache
    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(data) as CacheEntry;
        if (Date.now() - entry.timestamp < config.cacheTtlMs) {
          this.memoryCache.set(key, entry);
          this.cacheHits++;
          return entry;
        } else {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.warn('[CacheService] Failed reading disk cache:', e);
    }

    return null;
  }

  public set(entry: CacheEntry): void {
    this.memoryCache.set(entry.cacheKey, entry);
    try {
      const filePath = path.join(this.cacheDir, `${entry.cacheKey}.json`);
      fs.writeFileSync(filePath, JSON.stringify(entry), 'utf-8');
    } catch (e) {
      console.warn('[CacheService] Failed persisting to disk cache:', e);
    }
  }

  public getStats() {
    const hitRate = this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0;
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      hitRatePercent: parseFloat(hitRate.toFixed(2)),
      memoryEntriesCount: this.memoryCache.size,
    };
  }
}

export const evaluationCache = new EvaluationCacheService();
