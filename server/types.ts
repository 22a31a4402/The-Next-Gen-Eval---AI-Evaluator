/**
 * Backend Data Contracts and Types for NextGen Eval
 */

export type JobStatus =
  | 'queued'
  | 'preprocessing'
  | 'grading'
  | 'validating'
  | 'assembling_report'
  | 'completed'
  | 'failed'
  | 'needs_review';

export type EvaluationMode = 'with-manual' | 'without-manual';

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
}

export interface JobMetrics {
  correlationId: string;
  startTime: number;
  endTime?: number;
  totalLatencyMs?: number;
  preprocessingLatencyMs?: number;
  geminiLatencyMs?: number;
  validationLatencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  cacheHit: boolean;
  retriesCount: number;
  modelUsed?: string;
}

export interface EvaluationJob {
  id: string;
  correlationId: string;
  status: JobStatus;
  progressPercent: number; // 0 - 100
  currentStepMessage: string;
  mode: EvaluationMode;
  studentName: string;
  testTitle?: string;
  createdAt: number;
  updatedAt: number;
  report?: EvaluationReport;
  error?: string;
  metrics: JobMetrics;
  inputPayload: {
    sourceDoc: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    questionPaper?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    answerKey?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    facultyNotes?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    } | null;
  };
}
