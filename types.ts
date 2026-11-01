
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
  ambiguousChoices: string[];
  hasAmbiguousChoices: boolean;
}

export function calculateCanonicalKeyMarks(
  questions: CanonicalQuestionKey[],
  printedMaxMarks?: number
): MarksValidationResult {
  const sectionTotals: Record<string, number> = {};
  const sectionCounts: Record<string, number> = {};
  const offendingQuestions: string[] = [];
  const discrepancyMessages: string[] = [];
  const ambiguousChoices: string[] = [];

  // Map of questions by complete question identifier and questionId for fast lookup
  const qMap = new Map<string, CanonicalQuestionKey>();
  for (const q of questions) {
    const qKey = getCompleteQuestionIdentifier(q);
    if (qKey) {
      qMap.set(qKey, q);
    }
    if (q.questionId && !q.subquestionId) {
      qMap.set(q.questionId.trim(), q);
    }
  }

  // Identify parents that have child sub-questions
  const parentIds = new Set<string>();
  for (const q of questions) {
    if (q.subquestionId && q.questionId) {
      parentIds.add(q.questionId.trim());
    }
    if (q.parentQuestionId) {
      parentIds.add(q.parentQuestionId.trim());
    }
    const qKey = getCompleteQuestionIdentifier(q);
    const match = qKey.match(/^([0-9a-zA-Z]+)[\.\(\_\-]/);
    if (match) {
      const parentCandidate = match[1];
      if (qMap.has(parentCandidate)) {
        parentIds.add(parentCandidate);
      }
    }
  }

  // Helper to determine if a question is a parent container whose children have marks
  const isParentContainerWithChildren = (q: CanonicalQuestionKey): boolean => {
    // If a question is explicitly a subquestion (has subquestionId), it is not a container
    if (q.subquestionId) return false;

    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || "").trim();
    const isContainer = q.isParentHeader || parentIds.has(qId) || parentIds.has(qKey);
    if (!isContainer) return false;

    const children = questions.filter(
      (child) =>
        child !== q && (
          child.parentQuestionId === qId ||
          child.parentQuestionId === qKey ||
          (child.questionId === qId && Boolean(child.subquestionId)) ||
          (child.questionId !== qId && (
            child.questionId.startsWith(qId + ".") ||
            child.questionId.startsWith(qId + "(") ||
            child.questionId.startsWith(qId + "-") ||
            child.questionId.startsWith(qId + "_")
          ))
        )
    );
    return children.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0) > 0;
  };

  // Resolve effective alternative group for every question,
  // handling nested choices (e.g. child inheriting parent's alternative group).
  const getEffectiveAlternativeGroup = (q: CanonicalQuestionKey): string | undefined => {
    if (q.isAlternative && q.alternativeGroup) {
      return q.alternativeGroup.trim();
    }
    if (q.parentQuestionId && qMap.has(q.parentQuestionId.trim())) {
      const parent = qMap.get(q.parentQuestionId.trim())!;
      if (parent.isAlternative && parent.alternativeGroup) {
        return parent.alternativeGroup.trim();
      }
    }
    const qKey = getCompleteQuestionIdentifier(q);
    const match = qKey.match(/^([0-9a-zA-Z]+)[\.\(\_\-]/);
    if (match && qMap.has(match[1])) {
      const parent = qMap.get(match[1])!;
      if (parent.isAlternative && parent.alternativeGroup) {
        return parent.alternativeGroup.trim();
      }
    }
    if (q.questionId && qMap.has(q.questionId.trim())) {
      const parent = qMap.get(q.questionId.trim())!;
      if (parent !== q && parent.isAlternative && parent.alternativeGroup) {
        return parent.alternativeGroup.trim();
      }
    }
    return undefined;
  };

  // Pre-calculate distinct question prefixes per alternative group
  const groupQuestionPrefixes = new Map<string, Set<string>>();
  for (const q of questions) {
    const grp = getEffectiveAlternativeGroup(q);
    if (grp) {
      if (!groupQuestionPrefixes.has(grp)) {
        groupQuestionPrefixes.set(grp, new Set());
      }
      const prefix = (q.parentQuestionId || q.questionId || "").trim();
      if (prefix) {
        groupQuestionPrefixes.get(grp)!.add(prefix);
      }
    }
  }

  // Determine branch ID within an alternative group (to group sub-questions of the same option)
  const getBranchId = (q: CanonicalQuestionKey, grp: string): string => {
    const prefixes = groupQuestionPrefixes.get(grp);
    const isMultiQuestionChoice = prefixes && prefixes.size > 1;

    if (isMultiQuestionChoice) {
      if (q.parentQuestionId && prefixes.has(q.parentQuestionId.trim())) {
        return q.parentQuestionId.trim();
      }
      const qId = (q.questionId || "").trim();
      if (prefixes.has(qId)) {
        return qId;
      }
      const qKey = getCompleteQuestionIdentifier(q);
      const match = qKey.match(/^([0-9a-zA-Z]+)[\.\(\_\-]/);
      if (match && prefixes.has(match[1])) {
        return match[1];
      }
    }

    const qKey = getCompleteQuestionIdentifier(q);
    return qKey || (q.questionId || "").trim();
  };

  // Group questions by alternative group and branch
  const groupBranches = new Map<string, Map<string, CanonicalQuestionKey[]>>();
  const questionGroupMap = new Map<string, string>();

  for (const q of questions) {
    const grp = getEffectiveAlternativeGroup(q);
    if (grp) {
      const qKey = getCompleteQuestionIdentifier(q);
      questionGroupMap.set(qKey, grp);
      if (q.questionId && !q.subquestionId) {
        questionGroupMap.set(q.questionId.trim(), grp);
      }
      if (!groupBranches.has(grp)) {
        groupBranches.set(grp, new Map<string, CanonicalQuestionKey[]>());
      }
      const branches = groupBranches.get(grp)!;
      const branchId = getBranchId(q, grp);
      if (!branches.has(branchId)) {
        branches.set(branchId, []);
      }
      branches.get(branchId)!.push(q);
    }
  }

  // Pre-calculate maximum marks per alternative group across its mutually exclusive branches
  const alternativeGroupMax: Record<string, number> = {};
  for (const [grp, branches] of groupBranches.entries()) {
    let maxBranchMarks = 0;
    const branchMarksList: { branchId: string; marks: number }[] = [];

    for (const [branchId, branchQuestions] of branches.entries()) {
      let branchSum = 0;
      for (const bq of branchQuestions) {
        if (!isParentContainerWithChildren(bq)) {
          branchSum += Number(bq.maxMarks) || 0;
        }
      }
      branchSum = parseFloat(branchSum.toFixed(2));
      branchMarksList.push({ branchId, marks: branchSum });
      if (branchSum > maxBranchMarks) {
        maxBranchMarks = branchSum;
      }
    }

    alternativeGroupMax[grp] = maxBranchMarks;

    // Flag ambiguous choices in alternative groups for faculty review
    if (branches.size < 2) {
      const singleQId = branches.values().next().value?.[0]?.questionId || grp;
      offendingQuestions.push(singleQId);
      const msg = `Alternative group "${grp}" contains only one choice branch (${singleQId}). Missing mutually exclusive partner choice. Flagged for faculty review.`;
      discrepancyMessages.push(msg);
      ambiguousChoices.push(msg);
      const singleQ = qMap.get(singleQId);
      if (singleQ && !singleQ.flaggedIssue) {
        singleQ.flaggedIssue = `Alternative choice in group "${grp}" is missing its mutually exclusive partner.`;
      }
    }

    if (branches.size >= 2) {
      const distinctMarks = new Set(branchMarksList.map((b) => b.marks));
      if (distinctMarks.size > 1) {
        const breakdown = branchMarksList.map((b) => `${b.branchId}: ${b.marks}m`).join(' vs ');
        const msg = `Alternative choices in group "${grp}" have unequal maximum marks (${breakdown}). Counted maximum (${maxBranchMarks}m), faculty review recommended.`;
        discrepancyMessages.push(msg);
        ambiguousChoices.push(msg);
      }
    }
  }

  // Flag ambiguous choice text in non-grouped questions (excluding parent container headers)
  for (const q of questions) {
    if (isParentContainerWithChildren(q)) {
      continue;
    }
    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || "").trim();
    const grp = questionGroupMap.get(qKey) || questionGroupMap.get(qId);
    if (!grp) {
      const text = ((q.questionText || "") + " " + (q.referenceAnswer || "")).toLowerCase();
      if (/\b(or|either|choice|optional|any one)\b/i.test(text) && !q.isAlternative) {
        offendingQuestions.push(qKey || qId);
        const msg = `Ambiguous choice in Question ${qKey || qId}: Question prompt/text suggests an alternative choice ("OR"), but question is not assigned to an alternative group. Flagged for faculty review.`;
        discrepancyMessages.push(msg);
        ambiguousChoices.push(msg);
        if (!q.flaggedIssue) {
          q.flaggedIssue = 'Ambiguous choice: Question text suggests alternative choice (OR) but is not assigned to an alternative group.';
        }
      }
    }
  }

  let calculatedGrandTotal = 0;
  const alternativeGroupSeen = new Set<string>();

  for (const q of questions) {
    const sec = (q.section || "General").trim();
    if (!sectionTotals[sec]) {
      sectionTotals[sec] = 0;
      sectionCounts[sec] = 0;
    }
    sectionCounts[sec]++;

    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || "").trim();
    const marks = Number(q.maxMarks) || 0;

    // Deduplicate parent container headers whose child sub-questions carry marks
    if (isParentContainerWithChildren(q)) {
      continue;
    }

    // Missing marks check for non-container questions
    if (!Number.isFinite(marks) || marks <= 0) {
      offendingQuestions.push(qKey || qId);
      discrepancyMessages.push("Question " + (qKey || qId) + " has missing or unassigned marks.");
    }

    // Alternative (OR) questions: count only one alternative per group
    const grp = questionGroupMap.get(qKey) || questionGroupMap.get(qId);
    if (grp) {
      if (!alternativeGroupSeen.has(grp)) {
        alternativeGroupSeen.add(grp);
        const grpMarks = alternativeGroupMax[grp] !== undefined ? alternativeGroupMax[grp] : marks;
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
    discrepancyMessages: Array.from(new Set(discrepancyMessages)),
    offendingQuestions: Array.from(new Set(offendingQuestions)),
    sectionTotals,
    sections,
    ambiguousChoices: Array.from(new Set(ambiguousChoices)),
    hasAmbiguousChoices: ambiguousChoices.length > 0,
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
  questionId?: string;
  feedbackPoints: string[];
  marks: number;
  maxMarks: number;
  isCorrect: boolean;
  isFlagged?: boolean;
  flaggedComment?: string;
  notes?: string;
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

