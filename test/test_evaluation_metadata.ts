/**
 * Focused Test Suite for Developer-Only Evaluation Cost Metadata (Anatomy Guru)
 *
 * Verifies:
 * 1. Automatic generation of metadata.json in private backend directory (.data/evaluations/metadata/)
 * 2. Exact recording of actual Gemini tokens (input, output, cached, total)
 * 3. Exact recording of model, extraction cost, grading cost, total cost (USD and INR)
 * 4. Tracking of retries, total API calls, and latency
 * 5. Preservation of partial usage data for failed/aborted evaluations
 * 6. Strict zero-fabrication guarantees (never fabricating missing token counts or costs)
 * 7. Server-side isolation (developer-only logs, zero exposure to faculty/student views)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { evaluationEngine } from '../server/evaluator';
import { evaluationQueue } from '../server/queue';
import { setMockGeminiProvider } from '../server/geminiClient';
import { evaluationMetadataService } from '../server/evaluationMetadata';
import { config } from '../server/config';
import { CanonicalAnswerKey, EvaluationJob } from '../server/types';

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

async function runMetadataTests() {
  console.log('\n========================================================================');
  console.log(' STARTING DEVELOPER EVALUATION COST METADATA TEST SUITE');
  console.log('========================================================================\n');

  const metadataDir = path.join(config.dataDir, 'metadata');

  // Sample canonical exam key (Anatomy Guru MBBS Phase 1)
  const anatomyCanonicalKey: CanonicalAnswerKey = {
    id: `ak_meta_${Date.now()}_anatomy`,
    subject: 'Human Anatomy',
    examId: 'exam_anatomy_01',
    title: 'Anatomy Guru Gross Anatomy Final Assessment',
    totalMaxMarks: 15,
    version: 1,
    status: 'approved',
    sourceMode: 'ai_generated',
    questions: [
      {
        questionId: '1',
        questionText: 'Describe the anatomical relations and blood supply of the Thyroid Gland.',
        maxMarks: 10,
        referenceAnswer: 'Thyroid gland relations: pretracheal fascia, recurrent laryngeal nerve, superior/inferior thyroid arteries.',
        expectedConcepts: ['pretracheal fascia', 'recurrent laryngeal nerve', 'superior thyroid artery', 'inferior thyroid artery'],
        acceptableAlternatives: ['external laryngeal nerve relation'],
        markingCriteria: ['Relations and blood supply accurate (10 marks)'],
      },
      {
        questionId: '2',
        questionText: 'MCQ: Which nerve provides motor innervation to the vocal cords (except cricothyroid)?',
        maxMarks: 5,
        referenceAnswer: 'Recurrent laryngeal nerve',
        expectedConcepts: ['Recurrent laryngeal nerve'],
        acceptableAlternatives: ['RLN'],
        markingCriteria: ['Identifies RLN (5 marks)'],
      },
    ],
    metadata: {
      createdBy: 'dr_sharma',
      institutionId: 'inst_anatomy_guru',
      createdAt: Date.now(),
      approvedBy: 'dr_sharma',
      approvedAt: Date.now(),
      updatedAt: Date.now(),
    },
  };

  // ---------------------------------------------------------------------------
  // TEST GROUP 1: Successful Two-Stage Evaluation Generates Complete metadata.json
  // ---------------------------------------------------------------------------
  console.log('--- Test Group 1: Two-Stage Successful Evaluation Metadata ---');

  const jobId1 = `eval_test_meta_1_${Date.now()}`;
  const job1: EvaluationJob = {
    id: jobId1,
    correlationId: `meta_corr_1_${Date.now()}`,
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Aarathi Sree',
    testTitle: 'Anatomy Guru Gross Anatomy Assessment',
    institutionId: 'inst_anatomy_guru',
    createdBy: 'dr_sharma',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canonicalAnswerKey: anatomyCanonicalKey,
    metrics: {
      correlationId: `meta_corr_1_${Date.now()}`,
      startTime: Date.now(),
      cacheHit: false,
      retriesCount: 0,
    },
    inputPayload: {
      sourceDoc: { name: 'student_script_1.pdf', text: `Run 1 ${Date.now()}: Thyroid gland relations: enveloped in pretracheal fascia, intimately related to recurrent laryngeal nerve. Blood supply: superior and inferior thyroid arteries. 2. Recurrent laryngeal nerve.` },
      canonicalAnswerKey: anatomyCanonicalKey,
    },
  };

  // Mock Gemini responses for Stage 1 (Extraction) and Stage 2 (Grading)
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          examTitle: 'Anatomy End-Term Assessment',
          answers: [
            {
              questionId: '1',
              subquestionId: null,
              studentAnswerText: 'Thyroid relations: enveloped in pretracheal fascia, relates to recurrent laryngeal nerve. Blood supply from superior and inferior thyroid arteries.',
              diagramDescription: 'Clear anatomical neck schematic.',
              formulas: [],
              pageReferences: [1],
              isAttempted: true,
              confidence: 0.98,
              flaggedUncertain: false,
            },
            {
              questionId: '2',
              subquestionId: null,
              studentAnswerText: 'Recurrent laryngeal nerve',
              diagramDescription: null,
              formulas: [],
              pageReferences: [2],
              isAttempted: true,
              confidence: 0.99,
              flaggedUncertain: false,
            },
          ],
          unmappedContent: [],
          warnings: [],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 250 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Aarathi Sree',
        testTitle: 'Anatomy Guru Gross Anatomy Assessment',
        testTopics: 'Head and Neck Anatomy',
        testDate: '2026-10-31',
        totalScore: 15,
        maxScore: 15,
        questions: [
          {
            qNo: '1',
            feedbackPoints: ['Flawless anatomical relations and arterial blood supply detailed.'],
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
          },
          {
            qNo: '2',
            feedbackPoints: ['Correct answer: Recurrent laryngeal nerve.'],
            marks: 5,
            maxMarks: 5,
            isCorrect: true,
          },
        ],
        generalFeedback: {
          overallPerformance: ['Outstanding medical anatomical comprehension.'],
          mcqs: ['Perfect MCQ response.'],
          contentAccuracy: ['Comprehensive coverage of arterial and nerve relations.'],
          completenessOfAnswers: ['Answers meet gold standard.'],
          presentationDiagrams: ['Adequate written anatomical description.'],
          investigations: ['N/A'],
          attemptingQuestions: ['All questions attempted.'],
          actionPoints: ['Maintain this high level of clinical accuracy.'],
        },
      }),
      usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 400 },
    };
  });

  const report1 = await evaluationEngine.evaluate(job1);
  assert(Boolean(report1), 'Evaluation completed successfully.');
  assert(report1.totalScore === 15, 'Grading logic correctly evaluated student.');

  // Verify file existence in private backend directory
  const primaryMetaPath1 = path.join(metadataDir, jobId1, 'metadata.json');
  const flatMetaPath1 = path.join(metadataDir, `${jobId1}.json`);
  const latestMetaPath = path.join(metadataDir, 'metadata.json');

  assert(fs.existsSync(primaryMetaPath1), `Generated metadata.json in private directory (${primaryMetaPath1}).`);
  assert(fs.existsSync(flatMetaPath1), `Generated flat jobId.json in private directory (${flatMetaPath1}).`);
  assert(fs.existsSync(latestMetaPath), `Updated latest metadata.json in private directory (${latestMetaPath}).`);

  // Verify metadata contents
  const meta1 = JSON.parse(fs.readFileSync(primaryMetaPath1, 'utf8'));
  assert(meta1.evaluationId === jobId1, 'Metadata evaluationId matches evaluation job.');
  assert(meta1.evaluationStatus === 'completed', 'Metadata evaluationStatus is completed.');
  assert(meta1.studentName === 'Aarathi Sree', 'Metadata records studentName.');
  assert(meta1.testTitle === 'Anatomy Guru Gross Anatomy Assessment', 'Metadata records testTitle.');
  assert(Boolean(meta1.model), `Metadata records model (${meta1.model}).`);
  assert(meta1.apiCalls === 2, 'Metadata records 2 API calls (1 extraction + 1 grading).');
  assert(meta1.retries === 0, 'Metadata records 0 retries.');
  assert(meta1.latencyMs >= 0, 'Metadata records latency.');

  // Token accuracy (Extraction: 1200+250, Grading: 2000+400)
  assert(meta1.tokens.inputTokens === 3200, `Input tokens recorded accurately (expected 3200, got ${meta1.tokens.inputTokens}).`);
  assert(meta1.tokens.outputTokens === 650, `Output tokens recorded accurately (expected 650, got ${meta1.tokens.outputTokens}).`);
  assert(meta1.tokens.totalTokens === 3850, `Total tokens recorded accurately (expected 3850, got ${meta1.tokens.totalTokens}).`);

  // Stage breakdown
  assert(meta1.stages.extraction.status === 'success', 'Extraction stage status is success.');
  assert(meta1.stages.extraction.inputTokens === 1200, 'Extraction input tokens is 1200.');
  assert(meta1.stages.extraction.outputTokens === 250, 'Extraction output tokens is 250.');
  assert(meta1.extractionCost.usd !== null && meta1.extractionCost.usd > 0, 'Extraction USD cost is calculated.');
  assert(meta1.extractionCost.inr !== null && meta1.extractionCost.inr > 0, 'Extraction INR cost is calculated.');

  assert(meta1.stages.grading.status === 'success', 'Grading stage status is success.');
  assert(meta1.stages.grading.inputTokens === 2000, 'Grading input tokens is 2000.');
  assert(meta1.stages.grading.outputTokens === 400, 'Grading output tokens is 400.');
  assert(meta1.gradingCost.usd !== null && meta1.gradingCost.usd > 0, 'Grading USD cost is calculated.');
  assert(meta1.gradingCost.inr !== null && meta1.gradingCost.inr > 0, 'Grading INR cost is calculated.');

  // Total cost matches sum of stages
  const sumUsd = parseFloat(((meta1.extractionCost.usd || 0) + (meta1.gradingCost.usd || 0)).toFixed(6));
  assert(meta1.totalCost.usd === sumUsd, `Total USD cost equals sum of stages ($${meta1.totalCost.usd}).`);
  assert(meta1.zeroFabrication.isCostCalculable === true, 'isCostCalculable is true.');
  assert(meta1.zeroFabrication.isPartial === false, 'isPartial is false for complete evaluation.');

  // ---------------------------------------------------------------------------
  // TEST GROUP 2: Retries and Fallback Telemetry Preservation
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 2: Retries and Fallback Telemetry ---');

  const jobId2 = `eval_test_meta_2_${Date.now()}`;
  const job2: EvaluationJob = {
    ...job1,
    id: jobId2,
    correlationId: `meta_corr_2_${Date.now()}`,
    metrics: { ...job1.metrics, correlationId: `meta_corr_2_${Date.now()}`, startTime: Date.now() },
    inputPayload: {
      sourceDoc: { name: 'student_script_2_retry.pdf', text: `Unique text for retry test ${Date.now()}: Q1 Relations of thyroid.` },
      canonicalAnswerKey: anatomyCanonicalKey,
    },
  };

  let gradingAttempts = 0;
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          examTitle: 'Test',
          answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Answer 1', isAttempted: true, confidence: 0.9 }],
          unmappedContent: [],
          warnings: [],
        }),
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
      };
    }

    gradingAttempts++;
    if (gradingAttempts === 1) {
      // First grading attempt fails with transient 503
      const err: any = new Error('503 Service Unavailable: High load');
      err.status = 503;
      throw err;
    }
    // Retry succeeds
    return {
      text: JSON.stringify({
        studentName: 'Aarathi Sree',
        testTitle: 'Test',
        testTopics: 'Anatomy',
        testDate: '2026-10-31',
        totalScore: 10,
        maxScore: 15,
        questions: [
          { qNo: '1', feedbackPoints: ['Good'], marks: 10, maxMarks: 10, isCorrect: true },
          { qNo: '2', feedbackPoints: ['Unattempted'], marks: 0, maxMarks: 5, isCorrect: false },
        ],
        generalFeedback: {
          overallPerformance: ['Good'], mcqs: ['None'], contentAccuracy: ['Accurate'],
          completenessOfAnswers: ['Complete'], presentationDiagrams: ['None'],
          investigations: ['None'], attemptingQuestions: ['Partial'], actionPoints: ['Review'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 300 },
    };
  });

  const report2 = await evaluationEngine.evaluate(job2);
  assert(Boolean(report2), 'Evaluation completed despite transient retry.');

  const meta2 = evaluationMetadataService.getMetadata(jobId2);
  assert(Boolean(meta2), 'Retrieved metadata for evaluation with retries.');
  assert(meta2!.retries === 1, `Metadata recorded exactly 1 retry (got ${meta2!.retries}).`);
  assert(meta2!.apiCalls === 3, `Metadata recorded 3 total API calls (got ${meta2!.apiCalls}).`);
  assert(meta2!.stages.grading.retries === 1, 'Grading stage records 1 retry.');
  assert(meta2!.stages.grading.calls === 2, 'Grading stage records 2 attempts.');
  assert(meta2!.tokens.inputTokens === 2800, `Tokens from successful calls counted without duplication (got ${meta2!.tokens.inputTokens}).`);

  // ---------------------------------------------------------------------------
  // TEST GROUP 3: Failed Evaluation Preserves Partial Usage Data
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 3: Failed Evaluation Partial Usage Preservation ---');

  const jobId3 = `eval_test_meta_3_${Date.now()}`;
  const job3: EvaluationJob = {
    ...job1,
    id: jobId3,
    correlationId: `meta_corr_3_${Date.now()}`,
    metrics: { ...job1.metrics, correlationId: `meta_corr_3_${Date.now()}`, startTime: Date.now() },
    inputPayload: {
      sourceDoc: { name: 'student_script_3_fail.pdf', text: `Unique text for failed test ${Date.now()}: Q1 Relations of thyroid.` },
      canonicalAnswerKey: anatomyCanonicalKey,
    },
  };

  // Stage 1 succeeds, Stage 2 grading repeatedly fails with fatal 500 error
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          examTitle: 'Test',
          answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Answer 1', isAttempted: true, confidence: 0.9 }],
          unmappedContent: [],
          warnings: [],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 350 },
      };
    }

    const err: any = new Error('Fatal Gemini internal failure (500)');
    err.status = 500;
    throw err;
  });

  let threwError = false;
  try {
    await evaluationEngine.evaluate(job3);
  } catch (e: any) {
    threwError = true;
    job3.status = 'failed';
    job3.error = e.message;
    evaluationMetadataService.generateMetadata(job3);
  }

  assert(threwError, 'Evaluation threw error as expected on fatal grading failure.');

  const meta3 = evaluationMetadataService.getMetadata(jobId3);
  assert(Boolean(meta3), 'Metadata generated for failed evaluation.');
  assert(meta3!.evaluationStatus === 'failed', `Status is recorded as failed (got ${meta3!.evaluationStatus}).`);
  assert(meta3!.error !== null && meta3!.error.includes('500'), 'Error message preserved in metadata.');
  assert(meta3!.zeroFabrication.isPartial === true, 'isPartial is true for failed evaluation.');

  // Extraction data was preserved!
  assert(meta3!.stages.extraction.status === 'success', 'Extraction stage status was preserved as success.');
  assert(meta3!.stages.extraction.inputTokens === 1500, 'Extraction input tokens preserved (1500).');
  assert(meta3!.extractionCost.usd !== null && meta3!.extractionCost.usd > 0, 'Extraction cost preserved.');

  // Grading stage is marked failed with null costs
  assert(meta3!.stages.grading.status === 'failed', 'Grading stage status is failed.');
  assert(meta3!.gradingCost.usd === null, 'Grading cost is strictly null (not fabricated).');
  assert(meta3!.totalCost.usd === meta3!.extractionCost.usd, 'Total cost reflects partial extraction spend.');

  // ---------------------------------------------------------------------------
  // TEST GROUP 4: Zero Fabrication on Missing Token Metadata
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 4: Zero-Fabrication on Missing Metadata ---');

  const jobId4 = `eval_test_meta_4_${Date.now()}`;
  const job4: EvaluationJob = {
    ...job1,
    id: jobId4,
    correlationId: `meta_corr_4_${Date.now()}`,
    metrics: { ...job1.metrics, correlationId: `meta_corr_4_${Date.now()}`, startTime: Date.now() },
    inputPayload: {
      sourceDoc: { name: 'student_script_4_missing.pdf', text: `Unique text missing metadata ${Date.now()}: Q1 Relations of thyroid.` },
      canonicalAnswerKey: anatomyCanonicalKey,
    },
  };

  // Mock Gemini returning null usageMetadata
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          examTitle: 'Test',
          answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Thyroid', isAttempted: true, confidence: 0.9 }],
          unmappedContent: [],
          warnings: [],
        }),
        usageMetadata: null as any, // Missing metadata
      };
    }
    return {
      text: JSON.stringify({
        studentName: 'Aarathi Sree',
        testTitle: 'Test',
        testTopics: 'Anatomy',
        testDate: '2026-10-31',
        totalScore: 10,
        maxScore: 15,
        questions: [
          { qNo: '1', feedbackPoints: ['Good'], marks: 10, maxMarks: 10, isCorrect: true },
          { qNo: '2', feedbackPoints: ['MCQ'], marks: 0, maxMarks: 5, isCorrect: false },
        ],
        generalFeedback: {
          overallPerformance: ['Good'], mcqs: ['None'], contentAccuracy: ['Accurate'],
          completenessOfAnswers: ['Complete'], presentationDiagrams: ['None'],
          investigations: ['None'], attemptingQuestions: ['Partial'], actionPoints: ['Review'],
        },
      }),
      usageMetadata: null as any, // Missing metadata
    };
  });

  await evaluationEngine.evaluate(job4);

  const meta4 = evaluationMetadataService.getMetadata(jobId4);
  assert(Boolean(meta4), 'Metadata generated when API metadata was null.');
  assert(meta4!.tokens.inputTokens === null, 'Input tokens is strictly null (NEVER fabricated to 0).');
  assert(meta4!.tokens.outputTokens === null, 'Output tokens is strictly null (NEVER fabricated to 0).');
  assert(meta4!.tokens.totalTokens === null, 'Total tokens is strictly null.');
  assert(meta4!.totalCost.usd === null, 'Total cost USD is strictly null.');
  assert(meta4!.totalCost.inr === null, 'Total cost INR is strictly null.');
  assert(meta4!.zeroFabrication.isCostCalculable === false, 'isCostCalculable is false.');
  assert(meta4!.zeroFabrication.uncalculatedReason !== null, 'uncalculatedReason is specified.');

  // ---------------------------------------------------------------------------
  // TEST GROUP 5: Academic Validation Discrepancy (needs_review) Generates Metadata
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 5: Academic Validation Discrepancy (needs_review) ---');

  const jobId5 = `eval_test_meta_5_${Date.now()}`;
  const job5: EvaluationJob = {
    ...job1,
    id: jobId5,
    correlationId: `meta_corr_5_${Date.now()}`,
    metrics: { ...job1.metrics, correlationId: `meta_corr_5_${Date.now()}`, startTime: Date.now() },
    inputPayload: {
      sourceDoc: { name: 'student_script_5_discrepancy.pdf', text: `Unique text for discrepancy test ${Date.now()}: Q1 Relations of thyroid.` },
      canonicalAnswerKey: anatomyCanonicalKey,
    },
  };

  // Mock Gemini producing inconsistent score sum (totalScore: 15, but sum is 8)
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          examTitle: 'Test',
          answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Thyroid', isAttempted: true, confidence: 0.9 }],
          unmappedContent: [],
          warnings: [],
        }),
        usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 200 },
      };
    }
    return {
      text: JSON.stringify({
        studentName: 'Aarathi Sree',
        testTitle: 'Test',
        testTopics: 'Anatomy',
        testDate: '2026-10-31',
        totalScore: 15, // Inconsistent with 8 + 0 = 8
        maxScore: 15,
        questions: [
          { qNo: '1', feedbackPoints: ['Good'], marks: 8, maxMarks: 10, isCorrect: true },
          { qNo: '2', feedbackPoints: ['Wrong'], marks: 0, maxMarks: 5, isCorrect: false },
        ],
        generalFeedback: {
          overallPerformance: ['Good'], mcqs: ['None'], contentAccuracy: ['Accurate'],
          completenessOfAnswers: ['Complete'], presentationDiagrams: ['None'],
          investigations: ['None'], attemptingQuestions: ['Partial'], actionPoints: ['Review'],
        },
      }),
      usageMetadata: { promptTokenCount: 1900, candidatesTokenCount: 350 },
    };
  });

  let discrepancyThrown = false;
  try {
    await evaluationEngine.evaluate(job5);
  } catch (e: any) {
    discrepancyThrown = true;
    assert(job5.status === 'needs_review', 'Job status transitioned to needs_review.');
  }

  assert(discrepancyThrown, 'Academic validation discrepancy was thrown.');
  const meta5 = evaluationMetadataService.getMetadata(jobId5);
  assert(Boolean(meta5), 'Metadata generated for needs_review job.');
  assert(meta5!.evaluationStatus === 'needs_review', 'Metadata status recorded as needs_review.');
  assert(meta5!.tokens.inputTokens === 3000, `Both stage tokens preserved (got ${meta5!.tokens.inputTokens}).`);
  assert(meta5!.totalCost.usd !== null && meta5!.totalCost.usd > 0, 'Cost was preserved for audited evaluation.');

  // ---------------------------------------------------------------------------
  // TEST GROUP 6: Strict Server-Side Isolation and Logging
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 6: Strict Privacy & Server-Side Isolation ---');

  // Verify that report1 doesn't have any developer cost metadata attached
  assert(!('tokens' in report1), 'report1 does NOT expose developer tokens object.');
  assert(!('extractionCost' in report1), 'report1 does NOT expose extractionCost.');
  assert(!('gradingCost' in report1), 'report1 does NOT expose gradingCost.');
  assert(!('totalCost' in report1), 'report1 does NOT expose totalCost.');
  assert(!('zeroFabrication' in report1), 'report1 does NOT expose zeroFabrication.');

  // Clean up mock provider
  setMockGeminiProvider(null);

  console.log('\n========================================================================');
  console.log(` ALL FOCUSED METADATA TESTS COMPLETED: ${passedTests}/${totalTests} PASSED`);
  console.log('========================================================================\n');
}

runMetadataTests().catch((err) => {
  console.error('\n❌ METADATA TEST SUITE FAILED:', err);
  process.exit(1);
});
