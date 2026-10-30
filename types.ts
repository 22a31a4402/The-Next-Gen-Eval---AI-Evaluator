
export type AnswerKeySourceMode = 'ai_generated' | 'uploaded';
export type AnswerKeyStatus = 'draft' | 'needs_review' | 'approved';

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

