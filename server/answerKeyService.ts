/**
 * Authoritative Canonical Answer Key Service for NextGen Eval
 *
 * Implements Two Explicit Answer-Key Preparation Modes:
 * Mode 1: "Generate Answer Key Using AI" (from Question Paper + Exam Metadata)
 * Mode 2: "Upload Existing Answer Key" (from Model Answer / Marking Scheme Document)
 *
 * Requirements:
 * - Shared canonical data model (CanonicalAnswerKey & CanonicalQuestionKey)
 * - Review and approval workflow (draft / needs_review -> approved)
 * - Strict rejection of unapproved keys in grading pipeline
 * - Bumping version and resetting approval upon editing an approved key
 * - Rejection of invalid/missing/zero maxMarks upon approval
 * - Flagging missing questions and numbering discrepancies
 * - Atomic persistence in .data/evaluations/answer_keys/
 * - Multi-tenant isolation by institutionId
 * - Zero fabricated fallback grades or synthetic 10/10 data
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CanonicalAnswerKey,
  CanonicalQuestionKey,
  AnswerKeySourceMode,
  AnswerKeyStatus,
} from './types';
import { UserContext } from './auth';
import { callGeminiWithFallback } from './geminiClient';
import { config } from './config';

export class AnswerKeyValidationError extends Error {
  public code = 'ANSWER_KEY_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'AnswerKeyValidationError';
  }
}

export interface DocumentPayload {
  name: string;
  text?: string;
  base64?: string;
  mimeType?: string;
}

export interface GenerateFromQpParams {
  questionPaper: DocumentPayload;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  metadata: {
    institutionId: string;
    createdBy: string;
  };
}

export interface ExtractFromUploadedParams {
  answerKeyDoc: DocumentPayload;
  questionPaperDoc?: DocumentPayload;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  metadata: {
    institutionId: string;
    createdBy: string;
  };
}

export class AnswerKeyService {
  private storageDir: string;
  private cache: Map<string, CanonicalAnswerKey> = new Map();

  constructor() {
    this.storageDir = path.join(process.cwd(), '.data', 'evaluations', 'answer_keys');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    this.loadAllFromDisk();
  }

  private loadAllFromDisk(): void {
    try {
      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.storageDir, file);
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed: CanonicalAnswerKey = JSON.parse(raw);
            if (parsed && parsed.id) {
              this.cache.set(parsed.id, parsed);
            }
          } catch (e) {
            console.error(`[AnswerKeyService] Failed to load key file ${file}:`, e);
          }
        }
      }
    } catch (err) {
      console.error('[AnswerKeyService] Error loading answer keys from disk:', err);
    }
  }

  private saveToDisk(key: CanonicalAnswerKey): void {
    this.cache.set(key.id, key);
    const filePath = path.join(this.storageDir, `${key.id}.json`);
    const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(key, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Mode 1: Generate Answer Key Using AI
   * Extracts questions, suggests reference answers, expected concepts, alternatives, and marking criteria.
   * Flags ambiguous questions or missing marks.
   * Starts in 'draft' or 'needs_review' status.
   */
  public async generateFromQuestionPaper(params: GenerateFromQpParams): Promise<CanonicalAnswerKey> {
    const { questionPaper, title, subject, grade, totalMaxMarks, metadata } = params;

    if (!questionPaper || (!questionPaper.text && !questionPaper.base64)) {
      throw new AnswerKeyValidationError('Question paper content (text or visual document) is required.');
    }

    const correlationId = `ak_gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const id = `ak_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Assemble parts for Gemini
    const contentsParts: any[] = [];
    if (questionPaper.text && questionPaper.text.trim().length > 30) {
      contentsParts.push({
        text: `--- OFFICIAL QUESTION PAPER ---\n${questionPaper.text.trim()}\n\n`,
      });
    }
    if (questionPaper.base64 && questionPaper.mimeType) {
      contentsParts.push({ text: `DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)` });
      contentsParts.push({
        inlineData: {
          data: questionPaper.base64,
          mimeType: questionPaper.mimeType,
        },
      });
      contentsParts.push({ text: `DOCUMENT_END: OFFICIAL QUESTION PAPER` });
    }

    contentsParts.push({
      text: `TASK: Generate a comprehensive, structured Answer Key for this Question Paper.
Exam Title: "${title}"
${subject ? `Subject: "${subject}"` : ''}
${grade ? `Grade / Academic Level: "${grade}"` : ''}
${totalMaxMarks ? `Target Total Marks: ${totalMaxMarks}` : ''}

CRITICAL ACADEMIC INSTRUCTIONS:
1. Extract ALL questions and subquestions hierarchically (e.g. "1", "2.a", "2.b", "3").
2. Extract the exact explicit maximum marks (maxMarks) specified for each question.
   - If maximum marks are NOT explicitly provided in the question paper, set maxMarks to 0 or null and set flaggedIssue to "Missing maximum marks in question paper - instructor review required".
   - NEVER invent marks or default missing marks to 1!
3. Provide a suggested comprehensive reference answer for each question.
4. Extract key expected answer concepts (essential points student must cover).
5. Extract acceptable alternative answers or phrasing for fair grading.
6. Formulate granular marking criteria for partial credit allocation.
7. If any question has ambiguous wording, incomplete instructions, or missing information, flag it explicitly in flaggedIssue.

Return ONLY a valid JSON object matching this schema:
{
  "examTitle": "${title}",
  "totalMaxMarks": number,
  "warnings": string[],
  "questions": [
    {
      "questionId": string,
      "subquestionId": string | null,
      "questionText": string,
      "maxMarks": number,
      "referenceAnswer": string,
      "expectedConcepts": string[],
      "acceptableAlternatives": string[],
      "markingCriteria": string[],
      "diagramReferences": string[],
      "confidence": number,
      "flaggedIssue": string | null
    }
  ]
}`,
    });

    const systemInstruction = `You are an expert academic curriculum and examination specialist for Aarshiv AI NextGen Eval.
Your responsibility is to analyze question papers and generate authoritative, rigorous answer keys.
You maintain absolute academic integrity: never fabricate missing marks, and always flag ambiguities for human instructor review.
Output must be strictly raw JSON with no Markdown wrapping.`;

    const geminiResult = await callGeminiWithFallback(
      contentsParts,
      systemInstruction,
      correlationId,
      {
        jobId: id,
        institutionId: metadata.institutionId,
        pipelineStage: 'answer_key_generation',
      }
    );

    let parsedResult: any;
    try {
      const rawReportText = typeof (geminiResult.report as any) === 'string'
        ? (geminiResult.report as any)
        : JSON.stringify(geminiResult.report);

      parsedResult = typeof geminiResult.report === 'object' && geminiResult.report !== null && 'questions' in geminiResult.report
        ? geminiResult.report
        : JSON.parse(rawReportText);
    } catch (e: any) {
      throw new Error(`Failed to parse AI-generated answer key response: ${e.message}`);
    }

    const rawQuestions: any[] = Array.isArray(parsedResult.questions) ? parsedResult.questions : [];
    if (rawQuestions.length === 0) {
      throw new AnswerKeyValidationError('AI model could not identify any questions in the provided question paper.');
    }

    const canonicalQuestions: CanonicalQuestionKey[] = [];
    const warnings: string[] = Array.isArray(parsedResult.warnings) ? parsedResult.warnings : [];
    let hasFlaggedIssues = false;
    let computedSum = 0;

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i];
      const qId = String(q.questionId || q.qNo || `${i + 1}`).trim();
      let maxM = Number(q.maxMarks);

      let flagged = q.flaggedIssue ? String(q.flaggedIssue).trim() : undefined;

      if (!Number.isFinite(maxM) || maxM <= 0) {
        maxM = 0;
        flagged = flagged || 'Missing maximum marks in question paper - instructor review required.';
        hasFlaggedIssues = true;
        warnings.push(`Question ${qId}: Missing explicit maximum marks.`);
      } else {
        computedSum += maxM;
      }

      if (flagged) {
        hasFlaggedIssues = true;
      }

      canonicalQuestions.push({
        questionId: qId,
        subquestionId: q.subquestionId ? String(q.subquestionId).trim() : undefined,
        questionText: q.questionText ? String(q.questionText).trim() : undefined,
        maxMarks: maxM,
        referenceAnswer: String(q.referenceAnswer || q.expectedAnswer || 'Suggested model answer to be reviewed.').trim(),
        expectedConcepts: Array.isArray(q.expectedConcepts) ? q.expectedConcepts.map(String) : [],
        acceptableAlternatives: Array.isArray(q.acceptableAlternatives) ? q.acceptableAlternatives.map(String) : [],
        markingCriteria: Array.isArray(q.markingCriteria) ? q.markingCriteria.map(String) : [],
        diagramReferences: Array.isArray(q.diagramReferences) ? q.diagramReferences.map(String) : [],
        confidence: typeof q.confidence === 'number' ? q.confidence : 0.9,
        flaggedIssue: flagged,
      });
    }

    const calculatedTotal = totalMaxMarks && totalMaxMarks > 0 ? totalMaxMarks : computedSum;

    // Check if metadata total marks mismatches computed sum
    if (totalMaxMarks && totalMaxMarks > 0 && computedSum > 0 && Math.abs(totalMaxMarks - computedSum) > 0.05) {
      warnings.push(`Total marks specified (${totalMaxMarks}) differs from sum of extracted questions (${computedSum}).`);
      hasFlaggedIssues = true;
    }

    const initialStatus: AnswerKeyStatus = hasFlaggedIssues ? 'needs_review' : 'draft';

    const canonicalKey: CanonicalAnswerKey = {
      id,
      examId: `exam_${Date.now()}`,
      title: title || 'Academic Examination Answer Key',
      subject,
      grade,
      sourceMode: 'ai_generated',
      version: 1,
      status: initialStatus,
      totalMaxMarks: calculatedTotal,
      questions: canonicalQuestions,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        institutionId: metadata.institutionId,
        createdBy: metadata.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceDocName: questionPaper.name,
      },
      sourceQuestionPaperDoc: questionPaper,
    };

    this.saveToDisk(canonicalKey);
    return canonicalKey;
  }

  /**
   * Mode 2: Upload Existing Answer Key
   * Parses official answer key document, extracts model answers and marking criteria,
   * cross-references against question paper (if provided), flags discrepancies,
   * starts in 'draft' or 'needs_review' status.
   */
  public async extractFromUploadedKey(params: ExtractFromUploadedParams): Promise<CanonicalAnswerKey> {
    const { answerKeyDoc, questionPaperDoc, title, subject, grade, totalMaxMarks, metadata } = params;

    if (!answerKeyDoc || (!answerKeyDoc.text && !answerKeyDoc.base64)) {
      throw new AnswerKeyValidationError('Answer key document content (text or visual document) is required.');
    }

    const correlationId = `ak_ext_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const id = `ak_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Assemble parts for Gemini
    const contentsParts: any[] = [];

    // Add Answer Key Document
    if (answerKeyDoc.text && answerKeyDoc.text.trim().length > 30) {
      contentsParts.push({
        text: `--- OFFICIAL UPLOADED ANSWER KEY DOCUMENT ---\n${answerKeyDoc.text.trim()}\n\n`,
      });
    }
    if (answerKeyDoc.base64 && answerKeyDoc.mimeType) {
      contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual)` });
      contentsParts.push({
        inlineData: {
          data: answerKeyDoc.base64,
          mimeType: answerKeyDoc.mimeType,
        },
      });
      contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY` });
    }

    // Add optional Question Paper for cross-referencing
    if (questionPaperDoc) {
      if (questionPaperDoc.text && questionPaperDoc.text.trim().length > 30) {
        contentsParts.push({
          text: `--- REFERENCE QUESTION PAPER (FOR CROSS-VALIDATION) ---\n${questionPaperDoc.text.trim()}\n\n`,
        });
      }
      if (questionPaperDoc.base64 && questionPaperDoc.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: REFERENCE QUESTION PAPER (Visual)` });
        contentsParts.push({
          inlineData: {
            data: questionPaperDoc.base64,
            mimeType: questionPaperDoc.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: REFERENCE QUESTION PAPER` });
      }
    }

    contentsParts.push({
      text: `TASK: Extract and validate a structured Canonical Answer Key from the uploaded answer key document.
Exam Title: "${title}"
${subject ? `Subject: "${subject}"` : ''}
${grade ? `Grade / Academic Level: "${grade}"` : ''}
${totalMaxMarks ? `Target Total Marks: ${totalMaxMarks}` : ''}
${questionPaperDoc ? 'NOTE: A question paper was provided. Cross-reference every question number between the Question Paper and the Answer Key!' : ''}

CRITICAL EXTRACTION & VALIDATION RULES:
1. Extract question numbering, subquestions, and sections exactly as defined.
2. Extract the model answer / reference solution for each question.
3. Extract maximum marks for each question. If missing, set maxMarks to 0 and flag in flaggedIssue.
4. Extract expected answer concepts, acceptable alternatives, and marking rubric points.
5. If Question Paper was provided:
   - Identify any questions present in the Question Paper but MISSING from the Answer Key!
   - Identify any question numbering mismatches.
   - If a question is missing an answer or has conflicting numbering, set flaggedIssue with detailed explanation.
6. If any mark allocations are ambiguous or split unclearly, flag them in flaggedIssue.

Return ONLY a valid JSON object matching this schema:
{
  "examTitle": "${title}",
  "totalMaxMarks": number,
  "warnings": string[],
  "questions": [
    {
      "questionId": string,
      "subquestionId": string | null,
      "questionText": string,
      "maxMarks": number,
      "referenceAnswer": string,
      "expectedConcepts": string[],
      "acceptableAlternatives": string[],
      "markingCriteria": string[],
      "diagramReferences": string[],
      "confidence": number,
      "flaggedIssue": string | null
    }
  ]
}`,
    });

    const systemInstruction = `You are an expert academic curriculum parsing specialist for Aarshiv AI NextGen Eval.
Extract and validate structured answer keys with high fidelity.
Flag missing answers, missing marks, or question number discrepancies honestly.
Output must be strictly raw JSON with no Markdown wrapping.`;

    const geminiResult = await callGeminiWithFallback(
      contentsParts,
      systemInstruction,
      correlationId,
      {
        jobId: id,
        institutionId: metadata.institutionId,
        pipelineStage: 'answer_key_extraction',
      }
    );

    let parsedResult: any;
    try {
      const rawReportText = typeof (geminiResult.report as any) === 'string'
        ? (geminiResult.report as any)
        : JSON.stringify(geminiResult.report);

      parsedResult = typeof geminiResult.report === 'object' && geminiResult.report !== null && 'questions' in geminiResult.report
        ? geminiResult.report
        : JSON.parse(rawReportText);
    } catch (e: any) {
      throw new Error(`Failed to parse extracted answer key response: ${e.message}`);
    }

    const rawQuestions: any[] = Array.isArray(parsedResult.questions) ? parsedResult.questions : [];
    if (rawQuestions.length === 0) {
      throw new AnswerKeyValidationError('Could not extract any questions from the uploaded answer key document.');
    }

    const canonicalQuestions: CanonicalQuestionKey[] = [];
    const warnings: string[] = Array.isArray(parsedResult.warnings) ? parsedResult.warnings : [];
    let hasFlaggedIssues = false;
    let computedSum = 0;

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i];
      const qId = String(q.questionId || q.qNo || `${i + 1}`).trim();
      let maxM = Number(q.maxMarks);

      let flagged = q.flaggedIssue ? String(q.flaggedIssue).trim() : undefined;

      if (!Number.isFinite(maxM) || maxM <= 0) {
        maxM = 0;
        flagged = flagged || 'Missing or invalid maximum marks in uploaded answer key.';
        hasFlaggedIssues = true;
        warnings.push(`Question ${qId}: Missing maximum marks.`);
      } else {
        computedSum += maxM;
      }

      if (flagged) {
        hasFlaggedIssues = true;
      }

      canonicalQuestions.push({
        questionId: qId,
        subquestionId: q.subquestionId ? String(q.subquestionId).trim() : undefined,
        questionText: q.questionText ? String(q.questionText).trim() : undefined,
        maxMarks: maxM,
        referenceAnswer: String(q.referenceAnswer || q.expectedAnswer || 'Model answer from uploaded document.').trim(),
        expectedConcepts: Array.isArray(q.expectedConcepts) ? q.expectedConcepts.map(String) : [],
        acceptableAlternatives: Array.isArray(q.acceptableAlternatives) ? q.acceptableAlternatives.map(String) : [],
        markingCriteria: Array.isArray(q.markingCriteria) ? q.markingCriteria.map(String) : [],
        diagramReferences: Array.isArray(q.diagramReferences) ? q.diagramReferences.map(String) : [],
        confidence: typeof q.confidence === 'number' ? q.confidence : 0.95,
        flaggedIssue: flagged,
      });
    }

    const calculatedTotal = totalMaxMarks && totalMaxMarks > 0 ? totalMaxMarks : computedSum;

    if (totalMaxMarks && totalMaxMarks > 0 && computedSum > 0 && Math.abs(totalMaxMarks - computedSum) > 0.05) {
      warnings.push(`Total marks specified (${totalMaxMarks}) differs from sum of extracted questions (${computedSum}).`);
      hasFlaggedIssues = true;
    }

    const initialStatus: AnswerKeyStatus = hasFlaggedIssues ? 'needs_review' : 'draft';

    const canonicalKey: CanonicalAnswerKey = {
      id,
      examId: `exam_${Date.now()}`,
      title: title || 'Academic Examination Answer Key',
      subject,
      grade,
      sourceMode: 'uploaded',
      version: 1,
      status: initialStatus,
      totalMaxMarks: calculatedTotal,
      questions: canonicalQuestions,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        institutionId: metadata.institutionId,
        createdBy: metadata.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceDocName: answerKeyDoc.name,
      },
      sourceQuestionPaperDoc: questionPaperDoc,
      sourceAnswerKeyDoc: answerKeyDoc,
    };

    this.saveToDisk(canonicalKey);
    return canonicalKey;
  }

  /**
   * Retrieves an answer key with multi-tenant access control
   */
  public getAnswerKey(id: string, user?: UserContext): CanonicalAnswerKey | null {
    const key = this.cache.get(id);
    if (!key) return null;

    if (user && user.role !== 'operator' && user.institutionId !== key.metadata.institutionId) {
      return null;
    }
    return key;
  }

  /**
   * Lists all answer keys for a specific institution
   */
  public listAnswerKeys(user: UserContext): CanonicalAnswerKey[] {
    const all = Array.from(this.cache.values());
    if (user.role === 'operator') {
      return all.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
    }
    return all
      .filter((k) => k.metadata.institutionId === user.institutionId)
      .sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
  }

  /**
   * Updates an answer key.
   * If the key was previously 'approved', editing it bumps the version and resets status to 'draft'!
   */
  public updateAnswerKey(
    id: string,
    updates: Partial<CanonicalAnswerKey>,
    user: UserContext
  ): CanonicalAnswerKey {
    const existing = this.getAnswerKey(id, user);
    if (!existing) {
      throw new AnswerKeyValidationError(`Answer key ${id} not found or access denied.`);
    }

    const wasApproved = existing.status === 'approved';
    const newVersion = wasApproved ? existing.version + 1 : existing.version;
    const newStatus: AnswerKeyStatus = wasApproved ? 'draft' : (updates.status || existing.status);

    const updatedQuestions = updates.questions ? [...updates.questions] : existing.questions;

    // Recalculate total if questions changed
    let sum = 0;
    for (const q of updatedQuestions) {
      if (Number.isFinite(q.maxMarks) && q.maxMarks > 0) {
        sum += q.maxMarks;
      }
    }

    const updatedKey: CanonicalAnswerKey = {
      ...existing,
      ...updates,
      id: existing.id,
      version: newVersion,
      status: newStatus,
      totalMaxMarks: updates.totalMaxMarks || sum || existing.totalMaxMarks,
      questions: updatedQuestions,
      metadata: {
        ...existing.metadata,
        updatedAt: Date.now(),
        approvedAt: wasApproved ? undefined : existing.metadata.approvedAt,
        approvedBy: wasApproved ? undefined : existing.metadata.approvedBy,
      },
    };

    this.saveToDisk(updatedKey);
    return updatedKey;
  }

  /**
   * Explicitly approves an answer key.
   * Validates:
   * 1. Questions array is non-empty.
   * 2. Every question has valid questionId and referenceAnswer.
   * 3. Every question has maxMarks > 0 and is a finite number! Rejects missing or 0 marks.
   * 4. Sum consistency.
   * 5. Sets status to 'approved', approvedAt, approvedBy.
   */
  public approveAnswerKey(
    id: string,
    user: UserContext,
    notes?: string
  ): CanonicalAnswerKey {
    const existing = this.getAnswerKey(id, user);
    if (!existing) {
      throw new AnswerKeyValidationError(`Answer key ${id} not found or access denied.`);
    }

    if (!existing.questions || existing.questions.length === 0) {
      throw new AnswerKeyValidationError('Cannot approve an answer key with no questions.');
    }

    let calculatedSum = 0;
    const seenIds = new Set<string>();
    for (let idx = 0; idx < existing.questions.length; idx++) {
      const q = existing.questions[idx];
      const qId = String(q.questionId || '').trim();
      if (!qId) {
        throw new AnswerKeyValidationError(`Cannot approve answer key: Question at index ${idx} is missing a question identifier.`);
      }

      if (seenIds.has(qId)) {
        throw new AnswerKeyValidationError(`Cannot approve answer key: Duplicate question number "${qId}" detected. Every question must have a unique identifier.`);
      }
      seenIds.add(qId);

      const maxM = Number(q.maxMarks);
      if (!Number.isFinite(maxM) || maxM <= 0) {
        throw new AnswerKeyValidationError(
          `Cannot approve answer key: Question ${q.questionId} has invalid or missing maximum marks (${q.maxMarks}). All questions must have positive maximum marks before approval.`
        );
      }

      if (!q.referenceAnswer || !String(q.referenceAnswer).trim()) {
        throw new AnswerKeyValidationError(
          `Cannot approve answer key: Question ${q.questionId} is missing a model/reference answer.`
        );
      }

      calculatedSum += maxM;
    }

    const approvedKey: CanonicalAnswerKey = {
      ...existing,
      status: 'approved',
      totalMaxMarks: calculatedSum,
      warnings: undefined, // Cleared on instructor sign-off
      metadata: {
        ...existing.metadata,
        updatedAt: Date.now(),
        approvedAt: Date.now(),
        approvedBy: user.userId,
      },
    };

    this.saveToDisk(approvedKey);
    return approvedKey;
  }

  /**
   * Deletes an answer key
   */
  public deleteAnswerKey(id: string, user: UserContext): boolean {
    const existing = this.getAnswerKey(id, user);
    if (!existing) return false;

    this.cache.delete(id);
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error(`[AnswerKeyService] Failed to delete file ${filePath}:`, e);
      }
    }
    return true;
  }
}

export const answerKeyService = new AnswerKeyService();
