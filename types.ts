
export type AnswerKeySourceMode = 'ai_generated' | 'uploaded';
export type AnswerKeyStatus = 'draft' | 'needs_review' | 'approved';

/**
 * Resolves the complete, unique question identifier for a question item.
 * Preserves hierarchical numbering (e.g. "1", "1.1", "1.2", "2.1", "2.a", "Section A - 1.1").
 * Prevents treating sub-questions (e.g. "1.1", "1.2") as their parent number ("1").
 * Allows parent questions ("1") and their sub-questions ("1.1", "1.2") to coexist.
 */
export function getCompleteQuestionIdentifier(q?: {
  questionId?: string | number | null;
  subquestionId?: string | number | null;
  qNo?: string | number | null;
} | null): string {
  if (!q) return '';

  const rawId = q.questionId !== undefined && q.questionId !== null
    ? String(q.questionId).trim()
    : q.qNo !== undefined && q.qNo !== null
    ? String(q.qNo).trim()
    : '';

  const rawSubId = q.subquestionId !== undefined && q.subquestionId !== null
    ? String(q.subquestionId).trim()
    : '';

  if (!rawId && !rawSubId) return '';
  if (!rawSubId) return rawId;
  if (!rawId) return rawSubId;

  // If rawId already includes rawSubId (e.g. rawId = "1.1" and rawSubId = "1" or "1.1")
  if (
    (rawId === rawSubId && /[.\-_\(\)\[\]]/.test(rawId)) ||
    rawId.endsWith(`.${rawSubId}`) ||
    rawId.endsWith(`(${rawSubId})`) ||
    rawId.endsWith(`-${rawSubId}`) ||
    rawId.endsWith(`_${rawSubId}`)
  ) {
    return rawId;
  }

  // If rawSubId already includes rawId as a prefix (e.g. rawId = "1" and rawSubId = "1.1")
  if (
    rawSubId.startsWith(`${rawId}.`) ||
    rawSubId.startsWith(`${rawId}(`) ||
    rawSubId.startsWith(`${rawId}-`) ||
    rawSubId.startsWith(`${rawId}_`)
  ) {
    return rawSubId;
  }

  // Form hierarchical identifier without duplicating delimiters
  if (
    rawSubId.startsWith('.') ||
    rawSubId.startsWith('(') ||
    rawSubId.startsWith('[') ||
    rawSubId.startsWith('-') ||
    rawSubId.startsWith('_')
  ) {
    return `${rawId}${rawSubId}`;
  }

  return `${rawId}.${rawSubId}`;
}

export interface CanonicalQuestionKey {
  questionId: string;
  subquestionId?: string;
  questionText?: string;
  maxMarks: number;
  referenceAnswer: string;
  expectedConcepts: string[];
  acceptableAlternatives: string[];
  markingCriteria: string[];
  diagramReferences?: string[];
  confidence?: number;
  flaggedIssue?: string;
}

export interface CanonicalAnswerKey {
  id: string;
  examId: string;
  title: string;
  subject?: string;
  grade?: string;
  sourceMode: AnswerKeySourceMode;
  version: number;
  status: AnswerKeyStatus;
  totalMaxMarks: number;
  questions: CanonicalQuestionKey[];
  warnings?: string[];
  metadata: {
    institutionId: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    approvedAt?: number;
    approvedBy?: string;
    sourceDocName?: string;
  };
  sourceQuestionPaperDoc?: {
    name: string;
    text?: string;
    base64?: string;
    mimeType?: string;
  };
  sourceAnswerKeyDoc?: {
    name: string;
    text?: string;
    base64?: string;
    mimeType?: string;
  };
}

export interface QuestionFeedback {
  qNo: string;
  feedbackPoints: string[];
  marks: number;
  maxMarks: number;
  isCorrect: boolean;
  isFlagged?: boolean;
  flaggedComment?: string;
}

export interface GeneralFeedbackSection {
  overallPerformance: string[];
  mcqs: string[];
  contentAccuracy: string[];
  completenessOfAnswers: string[];
  presentationDiagrams: string[];
  investigations: string[];
  attemptingQuestions: string[];
  actionPoints: string[];
}

export interface EvaluationReport {
  id?: string;
  studentName: string;
  testTitle: string;
  testTopics: string;
  testDate: string;
  totalScore: number;
  maxScore: number;
  questions: QuestionFeedback[];
  generalFeedback: GeneralFeedbackSection;
  timestamp?: number;
  evaluatedByModel?: string;
  answerKeyId?: string;
  answerKeyVersion?: number;
  answerKeySourceMode?: AnswerKeySourceMode;
}

export interface HistoryItem {
  id: string;
  studentName: string;
  testTitle: string;
  timestamp: number;
  report?: EvaluationReport;
  fingerprint?: string;
}

export interface FileData {
  base64?: string;
  mimeType?: string;
  text?: string;
  name: string;
  isDocx: boolean;
}

export interface StudentExtractedAnswer {
  questionId: string;
  subquestionId?: string;
  studentAnswerText: string;
  diagramDescription?: string;
  formulas?: string[];
  pageReferences?: number[];
  isAttempted: boolean;
  confidence: number;
  flaggedUncertain?: boolean;
  flaggedIssue?: string;
  visualEvidenceBase64?: string;
  visualEvidenceMimeType?: string;
}

export interface StudentExtractedScript {
  studentName: string;
  examTitle?: string;
  answers: StudentExtractedAnswer[];
  unmappedContent?: string[];
  warnings?: string[];
  visualEvidenceRetained: boolean;
  extractedAt: number;
}

