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
  | 'needs_review'
  | 'cancelled';

export type EvaluationMode = 'with-manual' | 'without-manual';

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
  parentQuestionId?: string;
  section?: string;
  isAlternative?: boolean;
  alternativeGroup?: string;
  isParentHeader?: boolean;
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

export interface SectionMarksSummary {
  sectionName: string;
  questionCount: number;
  printedMaxMarks?: number;
  calculatedTotalMarks: number;
}

export interface MarksValidationResult {
  hasDiscrepancy: boolean;
  printedMaxMarks?: number;
  calculatedTotalMarks: number;
  difference: number;
  message?: string;
  discrepancyMessages: string[];
  offendingQuestions: string[];
  sectionTotals: Record<string, number>;
  sections: SectionMarksSummary[];
}

/**
 * Detects and normalizes alternative / choice (OR) questions across academic papers.
 * Identifies alternative questions using explicit indicators:
 * - "OR", "[OR]", "(OR)" in questionId, subquestionId, or question text
 * - "EITHER ... OR", "Answer any one", "Attempt any one", "Internal choice"
 * - Alternative question numbering (e.g. "3" and "3 (OR)", or sibling subquestions)
 * 
 * Assigns isAlternative: true and a shared alternativeGroup.
 * Flags ambiguous choice structures for human review.
 */
export function detectAndNormalizeChoiceGroups<
  T extends {
    questionId: string;
    subquestionId?: string;
    parentQuestionId?: string;
    section?: string;
    questionText?: string;
    referenceAnswer?: string;
    isAlternative?: boolean;
    alternativeGroup?: string;
    isParentHeader?: boolean;
    maxMarks?: number;
    flaggedIssue?: string;
  }
>(inputQuestions: T[]): T[] {
  if (!Array.isArray(inputQuestions) || inputQuestions.length === 0) {
    return [];
  }

  // Shallow copy to preserve input immutability
  const questions: T[] = inputQuestions.map((q) => ({ ...q }));

  // Helper regexes
  const orIdRegex = /(?:^|[\s\._\-\(\[])OR(?:[\s\._\-\)\]]|$)/i;
  const choiceIdRegex = /(?:^|[\s\._\-\(\[])(?:ALTERNATIVE|CHOICE|OPTION\s*[2B])(?:[\s\._\-\)\]]|$)/i;

  const orPrefixRegex = /^[\s\-\*]*(?:(?:EITHER\s+(?:PART\s+)?[A-Z0-9]+|OR|\[OR\]|\(OR\)|--\s*OR\s*--)[\s:\-\.]+|OR\s*$)/i;
  const orStandaloneLineRegex = /(?:^|[\r\n])\s*(?:OR|\[OR\]|\(OR\)|--\s*OR\s*--)\s*(?:[\r\n:\-\.]|$)/i;
  const eitherOrRegex = /\b(?:EITHER\s+.+?\s+OR|ANSWER\s+ANY\s+ONE|INTERNAL\s+CHOICE|ATTEMPT\s+EITHER)\b/i;

  let groupCounter = 1;

  for (let i = 0; i < questions.length; i++) {
    const curr = questions[i];
    const currId = (curr.questionId || '').trim();
    const currSubId = (curr.subquestionId || '').trim();
    const currText = (curr.questionText || '').trim();
    const currSec = (curr.section || 'General').trim();

    // If already properly grouped with an alternativeGroup, normalize
    if (curr.isAlternative && curr.alternativeGroup) {
      curr.alternativeGroup = curr.alternativeGroup.trim();
      continue;
    }

    // Check 1: Sibling / paired question ID indicator: e.g. "3" and "3 (OR)" or "3_OR" or "3.OR"
    const hasOrInId = orIdRegex.test(currId) || orIdRegex.test(currSubId) || choiceIdRegex.test(currId);
    if (hasOrInId) {
      const baseClean = currId
        .replace(/[\s\._\-\(\[]*OR[\s\._\-\)\]]*/gi, '')
        .replace(/[\s\._\-\(\[]*ALTERNATIVE[\s\._\-\)\]]*/gi, '')
        .replace(/[\s\._\-\(\[]*CHOICE[\s\._\-\)\]]*/gi, '')
        .trim();

      const companionIdx = questions.findIndex(
        (other, idx) =>
          idx !== i &&
          ((curr.section && other.section ? other.section.trim() === currSec : true) &&
            ((baseClean && other.questionId.trim() === baseClean) ||
              other.questionId.trim().startsWith(baseClean + '.') ||
              other.questionId.trim() === `${baseClean} (Option 1)` ||
              other.questionId.trim() === `${baseClean}A` ||
              idx === i - 1))
      );

      const grpName = `choice_group_${baseClean || currSec.replace(/\s+/g, '_')}_${groupCounter++}`;
      curr.isAlternative = true;
      curr.alternativeGroup = grpName;

      if (companionIdx !== -1) {
        const companion = questions[companionIdx];
        companion.isAlternative = true;
        if (!companion.alternativeGroup) {
          companion.alternativeGroup = grpName;
        } else {
          curr.alternativeGroup = companion.alternativeGroup;
        }
      } else {
        curr.flaggedIssue = curr.flaggedIssue
          ? `${curr.flaggedIssue} | Question indicates OR choice but companion question was not found.`
          : 'Question indicates OR choice but companion question was not found. Faculty review required.';
      }
      continue;
    }

    // Check 2: Explicit OR prefix or standalone OR in question text (e.g. "OR: Describe...", "(OR) Explain...")
    const hasOrPrefix = orPrefixRegex.test(currText) || orStandaloneLineRegex.test(currText);
    if (hasOrPrefix) {
      let companionIdx = -1;
      for (let prevIdx = i - 1; prevIdx >= 0; prevIdx--) {
        const prevSec = (questions[prevIdx].section || 'General').trim();
        if (prevSec === currSec && !questions[prevIdx].isParentHeader) {
          companionIdx = prevIdx;
          break;
        }
      }

      if (companionIdx !== -1) {
        const companion = questions[companionIdx];
        const baseKey = companion.alternativeGroup || `choice_group_${companion.questionId}_${curr.questionId}`;
        companion.isAlternative = true;
        companion.alternativeGroup = baseKey;
        curr.isAlternative = true;
        curr.alternativeGroup = baseKey;
      } else {
        curr.flaggedIssue = curr.flaggedIssue
          ? `${curr.flaggedIssue} | Question has OR prefix but no preceding companion question found in section.`
          : 'Question has OR prefix but no preceding companion question found in section. Faculty review required.';
      }
      continue;
    }

    // Check 3: "EITHER ... OR" within question text or previous question text
    if (eitherOrRegex.test(currText)) {
      if (i + 1 < questions.length) {
        const nextQ = questions[i + 1];
        const nextSec = (nextQ.section || 'General').trim();
        const nextText = (nextQ.questionText || '').trim();
        if (
          nextSec === currSec &&
          (orPrefixRegex.test(nextText) || orIdRegex.test(nextQ.questionId) || nextText.toLowerCase().includes('or '))
        ) {
          const grpName = `choice_group_${curr.questionId}_${nextQ.questionId}`;
          curr.isAlternative = true;
          curr.alternativeGroup = grpName;
          nextQ.isAlternative = true;
          nextQ.alternativeGroup = grpName;
          continue;
        }
      }
    }
  }

  // Audit choice groups for integrity & flag mismatched marks
  const groups: Record<string, T[]> = {};
  for (const q of questions) {
    if (q.isAlternative && q.alternativeGroup) {
      const g = q.alternativeGroup.trim();
      if (!groups[g]) groups[g] = [];
      groups[g].push(q);
    }
  }

  for (const [grpName, members] of Object.entries(groups)) {
    if (members.length < 2) {
      for (const m of members) {
        if (!m.flaggedIssue?.includes('choice')) {
          m.flaggedIssue = m.flaggedIssue
            ? `${m.flaggedIssue} | Single-option choice group flagged. Review choice configuration.`
            : `Single-option choice group (${grpName}) flagged. Faculty review required.`;
        }
      }
    } else {
      const marks = members.map((m) => Number(m.maxMarks) || 0);
      const firstMark = marks[0];
      const hasMismatch = marks.some((mk) => Math.abs(mk - firstMark) > 0.05);
      if (hasMismatch) {
        for (const m of members) {
          const warn = `Ambiguous choice structure: options in choice group ${grpName} have unequal maximum marks (${marks.join(' vs ')}). Faculty review required.`;
          if (!m.flaggedIssue?.includes('unequal maximum marks')) {
            m.flaggedIssue = m.flaggedIssue ? `${m.flaggedIssue} | ${warn}` : warn;
          }
        }
      }
    }
  }

  return questions;
}

/**
 * Deterministically calculates question totals, section totals, and flags any discrepancy
 * against explicitly printed maximum marks.
 * 
 * Rules:
 * 1. Alternative (OR) questions in the same alternativeGroup contribute only ONE permitted alternative (max of choices), not their sum.
 * 2. Parent questions whose child sub-questions have marks assigned do NOT have their header marks counted twice.
 * 3. Never invents or force-clamps marks to match.
 */
export function calculateCanonicalKeyMarks(
  rawQuestions: CanonicalQuestionKey[],
  printedMaxMarks?: number
): MarksValidationResult {
  // Normalize alternative choice groups from explicit indicators ("OR", "EITHER / OR", layout/numbering)
  const questions = detectAndNormalizeChoiceGroups(rawQuestions);

  const sectionTotals: Record<string, number> = {};
  const sectionCounts: Record<string, number> = {};
  const alternativeGroupMax: Record<string, number> = {};
  const alternativeGroupSeen: Set<string> = new Set();
  const offendingQuestions: string[] = [];
  const discrepancyMessages: string[] = [];

  // Identify parents that have sub-questions
  const parentIds = new Set<string>();
  for (const q of questions) {
    if (q.parentQuestionId) {
      parentIds.add(q.parentQuestionId.trim());
    }
    const qId = q.questionId || "";
    const match = qId.match(/^([0-9a-zA-Z]+)[\.\(\_\-]/);
    if (match) {
      const parentCandidate = match[1];
      if (questions.some((other) => other.questionId === parentCandidate)) {
        parentIds.add(parentCandidate);
      }
    }
  }

  // Pre-scan alternative groups to find maximum marks per alternative choice group
  for (const q of questions) {
    if (q.isAlternative && q.alternativeGroup) {
      const grp = q.alternativeGroup.trim();
      const m = Number(q.maxMarks) || 0;
      alternativeGroupMax[grp] = Math.max(alternativeGroupMax[grp] || 0, m);
    }
    if (q.flaggedIssue && q.flaggedIssue.includes('Ambiguous choice structure')) {
      if (!discrepancyMessages.includes(q.flaggedIssue)) {
        discrepancyMessages.push(q.flaggedIssue);
      }
      offendingQuestions.push(q.questionId);
    }
  }

  let calculatedGrandTotal = 0;

  for (const q of questions) {
    const sec = (q.section || "General").trim();
    if (!sectionTotals[sec]) {
      sectionTotals[sec] = 0;
      sectionCounts[sec] = 0;
    }
    sectionCounts[sec]++;

    const qId = (q.questionId || "").trim();
    const marks = Number(q.maxMarks) || 0;

    // Check if this question is a parent container header whose child sub-questions carry marks
    const isParentContainer = q.isParentHeader || parentIds.has(qId);
    if (isParentContainer) {
      const childQuestions = questions.filter(
        (child) =>
          child.parentQuestionId === qId ||
          (child.questionId !== qId && (
            child.questionId.startsWith(qId + ".") ||
            child.questionId.startsWith(qId + "(") ||
            child.questionId.startsWith(qId + "-") ||
            child.questionId.startsWith(qId + "_")
          ))
      );
      const childMarksSum = childQuestions.reduce((s, c) => s + (Number(c.maxMarks) || 0), 0);
      if (childMarksSum > 0) {
        // Child questions contribute their marks; parent container header marks are not counted twice!
        continue;
      }
    }

    // Missing marks check for non-parent header questions
    if (!Number.isFinite(marks) || marks <= 0) {
      offendingQuestions.push(qId);
      discrepancyMessages.push("Question " + qId + " has missing or unassigned marks.");
    }

    // Check if question is an OR alternative
    if (q.isAlternative && q.alternativeGroup) {
      const grp = q.alternativeGroup.trim();
      if (!alternativeGroupSeen.has(grp)) {
        alternativeGroupSeen.add(grp);
        const grpMarks = alternativeGroupMax[grp] || marks;
        sectionTotals[sec] = parseFloat((sectionTotals[sec] + grpMarks).toFixed(2));
        calculatedGrandTotal = parseFloat((calculatedGrandTotal + grpMarks).toFixed(2));
      }
      continue;
    }

    // Standard compulsory question
    sectionTotals[sec] = parseFloat((sectionTotals[sec] + marks).toFixed(2));
    calculatedGrandTotal = parseFloat((calculatedGrandTotal + marks).toFixed(2));
  }

  const sections: SectionMarksSummary[] = Object.keys(sectionTotals).map((name) => ({
    sectionName: name,
    questionCount: sectionCounts[name] || 0,
    calculatedTotalMarks: sectionTotals[name],
  }));

  let hasDiscrepancy = discrepancyMessages.length > 0;
  let difference = 0;
  let message = undefined;

  if (typeof printedMaxMarks === "number" && printedMaxMarks > 0) {
    difference = parseFloat((calculatedGrandTotal - printedMaxMarks).toFixed(2));
    if (Math.abs(difference) > 0.05) {
      hasDiscrepancy = true;
      if (difference > 0) {
        for (const q of questions) {
          const text = ((q.questionText || "") + " " + (q.referenceAnswer || "")).toLowerCase();
          if ((text.includes(" or ") || text.includes("either") || text.includes("choice")) && !q.isAlternative) {
            offendingQuestions.push(q.questionId);
          }
          if (parentIds.has(q.questionId) && Number(q.maxMarks) > 0 && !q.isParentHeader) {
            offendingQuestions.push(q.questionId);
          }
        }
        message = "Question paper explicitly states " + printedMaxMarks + " maximum marks, but extracted questions total " + calculatedGrandTotal + " marks (+" + difference + " discrepancy). Check alternative (OR) choices or parent sub-questions.";
        discrepancyMessages.unshift(message);
      } else {
        for (const q of questions) {
          if (!q.maxMarks || Number(q.maxMarks) <= 0) {
            offendingQuestions.push(q.questionId);
          }
        }
        message = "Question paper explicitly states " + printedMaxMarks + " maximum marks, but extracted questions total only " + calculatedGrandTotal + " marks (" + difference + " discrepancy). Check for missing questions or unassigned marks.";
        discrepancyMessages.unshift(message);
      }
    }
  }

  return {
    hasDiscrepancy,
    printedMaxMarks,
    calculatedTotalMarks: calculatedGrandTotal,
    difference,
    message,
    discrepancyMessages,
    offendingQuestions: Array.from(new Set(offendingQuestions)),
    sectionTotals,
    sections,
  };
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
  printedMaxMarks?: number;
  marksValidation?: MarksValidationResult;
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

export interface JobMetrics {
  correlationId: string;
  startTime: number;
  endTime?: number;
  totalLatencyMs?: number;
  preprocessingLatencyMs?: number;
  geminiLatencyMs?: number;
  validationLatencyMs?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  estimatedCostUsd?: number | null;
  estimatedCostInr?: number | null;
  pricingVersion?: string;
  usageCompleteness?: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  usageSource?: string;
  usageSummary?: any;
  cacheHit: boolean;
  retriesCount: number;
  fallbackCallsCount?: number;
  modelUsed?: string;
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

export interface EvaluationJob {
  id: string;
  correlationId: string;
  studentName: string;
  testTitle?: string;
  status: JobStatus;
  progressPercent: number;
  currentStepMessage: string;
  mode: EvaluationMode;
  institutionId?: string;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  report?: EvaluationReport;
  draftReport?: any;
  extractedScript?: StudentExtractedScript;
  error?: string;
  errorCategory?: string;
  statusCode?: number;
  isRetryable?: boolean;
  metrics: JobMetrics;
  answerKeyId?: string;
  answerKeyVersion?: number;
  answerKeySourceMode?: AnswerKeySourceMode;
  canonicalAnswerKey?: CanonicalAnswerKey;
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
    answerKeyId?: string;
    canonicalAnswerKey?: CanonicalAnswerKey;
    facultyNotes?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    } | null;
  };
}
