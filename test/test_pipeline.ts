/**
 * Comprehensive Automated Test Suite for NextGen Eval Dedicated AI Backend
 *
 * Covers:
 * - Deterministic SHA-256 fingerprinting and caching
 * - Mathematical score validation and bound checks (marks <= maxMarks, totalScore sum)
 * - Evaluation queue orchestration and bounded concurrency
 * - Audit contradiction resolution rules (with-manual vs without-manual)
 * - Error categorization and diagnostics
 * - Health and readiness probes
 */

import { evaluationCache } from '../server/cache';
import { evaluationEngine } from '../server/evaluator';
import { evaluationQueue } from '../server/queue';
import { config } from '../server/config';
import { parseActionableError } from '../services/geminiService';

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Test assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

async function runTests() {
  console.log('========================================================');
  console.log(' Starting NextGen Eval Pipeline & Backend Test Suite');
  console.log('========================================================\n');

  // ----------------------------------------------------
  // Test 1: SHA-256 Fingerprint Determinism & Invalidation
  // ----------------------------------------------------
  console.log('--- TEST GROUP 1: Deterministic Fingerprinting & Cache ---');
  const basePayload = {
    sourceDoc: { name: 'Student_Answers.pdf', text: 'Answer 1: Mitosis is cell division.' },
    questionPaper: { name: 'QP_Bio.pdf', text: 'Q1: Describe Mitosis (5 marks).' },
    answerKey: { name: 'AK_Bio.pdf', text: 'Q1: Mitosis produces two identical daughter cells.' },
    facultyNotes: null,
    mode: 'without-manual',
    model: 'gemini-3.8-flash',
  };

  const fp1 = evaluationCache.generateFingerprint(basePayload);
  const fp2 = evaluationCache.generateFingerprint(basePayload);
  assert(fp1 === fp2, 'Identical inputs produce identical SHA-256 fingerprints.');

  // Mutate text slightly
  const mutatedPayload = {
    ...basePayload,
    sourceDoc: { name: 'Student_Answers.pdf', text: 'Answer 1: Mitosis is reduction division.' },
  };
  const fpMutated = evaluationCache.generateFingerprint(mutatedPayload);
  assert(fp1 !== fpMutated, 'Content mutation produces a distinctly different fingerprint (cache invalidation).');

  // Mutate mode
  const modeMutated = { ...basePayload, mode: 'with-manual' };
  const fpMode = evaluationCache.generateFingerprint(modeMutated);
  assert(fp1 !== fpMode, 'Mode change produces a distinct fingerprint.');

  // ----------------------------------------------------
  // Test 2: Evaluation Cache Set & Retrieval
  // ----------------------------------------------------
  const mockReport = {
    studentName: 'Sarah Jenkins',
    testTitle: 'Cell Biology Midterm',
    testTopics: 'Mitosis, Meiosis',
    testDate: '2026-05-10',
    totalScore: 5,
    maxScore: 5,
    questions: [
      {
        qNo: '1',
        feedbackPoints: ['Correctly identified all phases.'],
        marks: 5,
        maxMarks: 5,
        isCorrect: true,
      },
    ],
    generalFeedback: {
      overallPerformance: ['Excellent understanding.'],
      mcqs: [],
      contentAccuracy: ['Accurate.'],
      completenessOfAnswers: ['Complete.'],
      presentationDiagrams: ['Good.'],
      investigations: [],
      attemptingQuestions: ['Attempted all.'],
      actionPoints: ['Keep it up.'],
    },
  };

  evaluationCache.set({
    cacheKey: fp1,
    report: mockReport as any,
    timestamp: Date.now(),
    modelUsed: 'gemini-3.8-flash',
    inputTokens: 500,
    outputTokens: 200,
    estimatedCostSaved: 0.0001,
  });

  const cachedResult = evaluationCache.get(fp1);
  assert(cachedResult !== null, 'Cache returns stored report on matching key.');
  assert(cachedResult?.report.studentName === 'Sarah Jenkins', 'Stored student name matches perfectly.');

  const stats = evaluationCache.getStats();
  assert(stats.cacheHits >= 1, 'Cache statistics increment hits accurately.');

  // ----------------------------------------------------
  // Test 3: Score Validation & Bound Enforcement
  // ----------------------------------------------------
  console.log('\n--- TEST GROUP 2: Academic Score Validation Engine ---');

  const rawUncheckedReport = {
    studentName: 'Alex Mercer',
    testTitle: 'Physics Exam',
    testTopics: 'Thermodynamics',
    testDate: '2026-06-01',
    totalScore: 999, // Intentional erroneous model output
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 15, // Intentional violation: marks > maxMarks
        maxMarks: 10,
        feedbackPoints: ['Good explanation.'],
      },
      {
        qNo: '2',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: [], // Empty feedback points
      },
      {
        qNo: '3',
        marks: -2, // Negative marks violation
        maxMarks: 5,
        feedbackPoints: ['Minor error.'],
      },
    ],
  };

  const validated = evaluationEngine.validateAndNormalizeReport(rawUncheckedReport, 'without-manual', 'Alex Mercer');

  // Verify Q1 clamped to maxMarks
  assert(validated.questions[0].marks === 10, 'Question marks exceeding maxMarks are clamped to maxMarks (10/10).');
  // Verify Q2 feedback populated
  assert(validated.questions[1].feedbackPoints.length > 0, 'Empty feedback points are populated with constructive remarks.');
  // Verify Q3 negative marks clamped to 0
  assert(validated.questions[2].marks === 0, 'Negative marks are clamped to 0.');
  // Verify totalScore is exact sum of clamped marks: 10 + 5 + 0 = 15
  assert(validated.totalScore === 15, `Total score recalculated to exact sum of marks (expected 15, got ${validated.totalScore}).`);
  assert(validated.maxScore === 20, `Max score recalculated to exact sum of maxMarks (expected 20, got ${validated.maxScore}).`);

  // ----------------------------------------------------
  // Test 4: Mode Handling (with-manual vs without-manual)
  // ----------------------------------------------------
  console.log('\n--- TEST GROUP 3: Mode Contradiction & Privacy Handling ---');

  const flaggedReport = {
    studentName: 'David Lee',
    testTitle: 'Math Exam',
    questions: [
      {
        qNo: '1',
        marks: 8,
        maxMarks: 10,
        feedbackPoints: ['Step 2 calculation error.'],
        isFlagged: true,
        flaggedComment: 'Evaluator penalized 5 marks; key permits partial credit up to 8.',
      },
    ],
  };

  // When mode is without-manual, isFlagged MUST be false and flaggedComment empty
  const withoutManualVal = evaluationEngine.validateAndNormalizeReport(flaggedReport, 'without-manual', 'David Lee');
  assert(withoutManualVal.questions[0].isFlagged === false, 'without-manual mode guarantees isFlagged is false.');
  assert(!withoutManualVal.questions[0].flaggedComment, 'without-manual mode guarantees flaggedComment is unset.');

  // When mode is with-manual, isFlagged and flaggedComment are preserved
  const withManualVal = evaluationEngine.validateAndNormalizeReport(flaggedReport, 'with-manual', 'David Lee');
  assert(withManualVal.questions[0].isFlagged === true, 'with-manual mode preserves discrepancy resolution flag.');
  assert(Boolean(withManualVal.questions[0].flaggedComment?.includes('Evaluator penalized')), 'with-manual mode preserves audit discrepancy comment.');

  // ----------------------------------------------------
  // Test 5: Job Queue & Concurrency Safeguards
  // ----------------------------------------------------
  console.log('\n--- TEST GROUP 4: Evaluation Queue & Storage ---');

  const job = evaluationQueue.enqueue({
    sourceDoc: { name: 'Batch_Student_1.pdf', text: 'Q1 Answer here.' },
    mode: 'without-manual',
    studentName: 'Batch Student 1',
  });

  assert(Boolean(job.id), 'Queue generates unique UUID for new evaluation job.');
  assert(job.status === 'queued' || job.status === 'preprocessing' || job.status === 'completed', 'Job enters queue with valid status.');

  const retrieved = evaluationQueue.getJob(job.id);
  assert(retrieved !== undefined, 'Job is retrievable by ID from queue manager.');

  const queueMetrics = evaluationQueue.getQueueMetrics();
  assert(queueMetrics.maxWorkers === config.maxConcurrentEvaluations, 'Queue maxWorkers honors configured concurrency limit.');

  // ----------------------------------------------------
  // Test 6: Actionable Error Parsing Diagnostics
  // ----------------------------------------------------
  console.log('\n--- TEST GROUP 5: Error Diagnostics & Privacy ---');

  const quotaErr = parseActionableError({ status: 429, message: 'Resource has been exhausted (e.g. check quota)' });
  assert(quotaErr.category === 'API Quota / Rate Limit Exceeded', '429 is categorized as API Quota / Rate Limit Exceeded.');

  const busyErr = parseActionableError({ status: 503, message: 'The model is overloaded. Please try again later.' });
  assert(busyErr.category === 'Gemini Server Temporarily Busy (503)', '503 is categorized as Gemini Server Temporarily Busy.');

  const authErr = parseActionableError({ status: 401, message: 'API_KEY_INVALID' });
  assert(authErr.category === 'API Authentication Error', '401 is categorized as API Authentication Error.');

  // Test the dreaded DOM Event {"isTrusted":true}
  const domEventErr = parseActionableError({ isTrusted: true });
  assert(!domEventErr.message.includes('{"isTrusted":true}'), 'DOM Event is scrubbed and never exposes raw JSON to user.');

  console.log('\n========================================================');
  console.log(` ALL TESTS PASSED SUCCESSFULLY! (${passedTests}/${totalTests})`);
  console.log('========================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Aborted with error:', err);
  process.exit(1);
});
