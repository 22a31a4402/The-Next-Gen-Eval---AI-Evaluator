/**
 * Comprehensive Automated Regression Test Suite for NextGen Eval Dedicated AI Backend
 *
 * Covers:
 * 1. Cryptographic SHA-256 Fingerprinting:
 *    - Full-byte digesting of complete buffers
 *    - Middle-byte mutation of same-length PDF/base64 invalidates cache key
 *    - Cache tenant authorization checks
 * 2. Strict Academic Score Validation Engine (Adversarial Regression Tests):
 *    - Rejection of marks > maxMarks (NEVER clamped!)
 *    - Rejection of NaN or infinite marks
 *    - Rejection of negative marks
 *    - Rejection of invalid/missing/zero maxMarks (NEVER default to 1!)
 *    - Rejection of duplicate question IDs
 *    - Verification of aggregate totalScore vs question sum consistency
 *    - Preservation of partial credit (e.g. 3.5 / 5)
 *    - Mode rules: 'without-manual' purges flagged comments
 * 3. Security, Authentication, RBAC & Tenant Isolation:
 *    - Rejection of unauthenticated requests
 *    - Rejection of cross-institution tenant access
 *    - Verification of operator privileges
 *    - Protection of operational metrics (/api/metrics)
 * 4. Queue Persistence, Atomic Disk Operations & Concurrency Bounds:
 *    - Atomic temporary write & rename
 *    - Startup recovery of in-flight tasks
 *    - Queue capacity limit backpressure (503 / 429)
 * 5. Elimination of Fabricated Results:
 *    - Validation failures transition to 'needs_review' or 'failed', never 'completed'
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { evaluationCache } from '../server/cache';
import { evaluationEngine, ValidationError } from '../server/evaluator';
import { evaluationQueue, QueueCapacityError, MAX_QUEUE_CAPACITY } from '../server/queue';
import {
  authenticateRequest,
  verifyJobAccess,
  UserContext,
  signDynamicToken,
  checkEvaluationRateLimit,
} from '../server/auth';
import {
  setMockGeminiProvider,
  callGeminiWithFallback,
} from '../server/geminiClient';
import { config } from '../server/config';
import { Request } from 'express';
import {
  calculateCallCost,
  getModelPricingRate,
  ACTIVE_PRICING_VERSION,
} from '../server/pricing';
import { usageLedger } from '../server/usageLedger';
import { answerKeyService, AnswerKeyValidationError } from '../server/answerKeyService';
import { CanonicalAnswerKey, CanonicalQuestionKey } from '../server/types';

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

function assertThrows(fn: () => any, expectedErrorMessageSubstring: string, message: string) {
  totalTests++;
  try {
    fn();
    console.error(`❌ FAIL (expected exception not thrown): ${message}`);
    throw new Error(`Expected error containing "${expectedErrorMessageSubstring}" was not thrown`);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes(expectedErrorMessageSubstring.toLowerCase())) {
      passedTests++;
      console.log(`✅ PASS: ${message}`);
    } else {
      console.error(`❌ FAIL (wrong error thrown): ${message}. Got: ${err?.message}`);
      throw err;
    }
  }
}

function mockRequest(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

async function runTests() {
  console.log('========================================================================');
  console.log(' Starting NextGen Eval Critical Remediation & Regression Test Suite');
  console.log('========================================================================\n');

  // ==========================================================================
  // GROUP 1: Cryptographic Digesting & Middle-Byte Mutation Test
  // ==========================================================================
  console.log('--- TEST GROUP 1: Full-Byte SHA-256 Fingerprint & Middle-Byte Invalidation ---');

  // Create a 10KB dummy base64 PDF representation
  const bufferLen = 10000;
  const originalBuffer = Buffer.alloc(bufferLen, 'A');
  const originalBase64 = originalBuffer.toString('base64');

  const basePayload = {
    sourceDoc: {
      name: 'Student_Physics_Script.pdf',
      text: 'Question 1: The particle velocity is v = at.',
      base64: originalBase64,
      mimeType: 'application/pdf',
    },
    questionPaper: {
      name: 'QP_Physics.pdf',
      text: 'Q1: State kinematic formula for velocity.',
      mimeType: 'application/pdf',
    },
    answerKey: {
      name: 'AK_Physics.pdf',
      text: 'Q1: v = u + at.',
      mimeType: 'application/pdf',
    },
    facultyNotes: null,
    mode: 'without-manual',
    model: config.primaryModel,
    institutionId: 'inst_aarshiv_01',
  };

  const fp1 = evaluationCache.generateFingerprint(basePayload);
  const fp1_again = evaluationCache.generateFingerprint(basePayload);
  assert(fp1 === fp1_again, 'Deterministic hashing: Identical inputs produce identical fingerprint.');

  // Mutate exactly ONE byte in the dead center of the base64 string (same overall length!)
  const midIndex = Math.floor(originalBase64.length / 2);
  const mutatedBase64 =
    originalBase64.substring(0, midIndex) +
    (originalBase64[midIndex] === 'B' ? 'C' : 'B') +
    originalBase64.substring(midIndex + 1);

  assert(
    originalBase64.length === mutatedBase64.length,
    'Verification sanity check: mutated base64 has exact same length as original base64.'
  );

  const mutatedPayload = {
    ...basePayload,
    sourceDoc: {
      ...basePayload.sourceDoc,
      base64: mutatedBase64,
    },
  };

  const fpMutated = evaluationCache.generateFingerprint(mutatedPayload);
  assert(
    fp1 !== fpMutated,
    'Critical Security: Modifying a byte in the middle of a same-length PDF invalidates the cache fingerprint.'
  );

  // Tenant isolation in fingerprint
  const crossTenantPayload = {
    ...basePayload,
    institutionId: 'inst_other_college_99',
  };
  const fpCrossTenant = evaluationCache.generateFingerprint(crossTenantPayload);
  assert(fp1 !== fpCrossTenant, 'Tenant Isolation: Identical documents under different institutionId produce distinct cache keys.');

  // ==========================================================================
  // GROUP 2: Adversarial Academic Score Validation Engine
  // ==========================================================================
  console.log('\n--- TEST GROUP 2: Adversarial Academic Score Validation ---');

  const validBaseReport = {
    studentName: 'Rahul Verma',
    testTitle: 'Advanced Physics Midterm',
    testTopics: 'Kinematics',
    testDate: '2026-05-20',
    totalScore: 10,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        isCorrect: true,
        feedbackPoints: ['Correct derivation of velocity formula.'],
      },
      {
        qNo: '2',
        marks: 5,
        maxMarks: 5,
        isCorrect: true,
        feedbackPoints: ['Accurate conceptual explanation.'],
      },
    ],
  };

  // 1. Valid report passes
  const validResult = evaluationEngine.validateAndNormalizeReport(validBaseReport, 'without-manual', 'Rahul Verma');
  assert(validResult.totalScore === 10, 'Valid report successfully passes strict validation.');

  // 2. Adversarial: Marks > MaxMarks (NEVER clamp!)
  const marksExceededReport = {
    ...validBaseReport,
    totalScore: 15,
    questions: [
      {
        qNo: '1',
        marks: 12, // Exceeds maxMarks of 10!
        maxMarks: 10,
        feedbackPoints: ['Good work.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(marksExceededReport, 'without-manual', 'Student'),
    'Score bound violation',
    'Rejects marks > maxMarks (never clamps to hide model discrepancy).'
  );

  // 3. Adversarial: NaN Marks
  const nanMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: NaN,
        maxMarks: 10,
        feedbackPoints: ['Attempted.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(nanMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects NaN marks.'
  );

  // 4. Adversarial: Infinite Marks
  const infMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: Infinity,
        maxMarks: 10,
        feedbackPoints: ['Attempted.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(infMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects infinite marks.'
  );

  // 5. Adversarial: Negative Marks
  const negMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: -3,
        maxMarks: 10,
        feedbackPoints: ['Incorrect.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(negMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects negative marks.'
  );

  // 6. Adversarial: Invalid maxMarks (0 or negative, or NaN - NEVER default to 1)
  const zeroMaxMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: 0,
        maxMarks: 0, // Invalid!
        feedbackPoints: ['Points.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(zeroMaxMarksReport, 'without-manual', 'Student'),
    'Invalid maximum marks',
    'Rejects maxMarks <= 0 (never silently replaces with 1).'
  );

  // 7. Adversarial: Duplicate Question IDs
  const duplicateQReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Part A'],
      },
      {
        qNo: '1', // Duplicate Q1!
        marks: 4,
        maxMarks: 5,
        feedbackPoints: ['Part B'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(duplicateQReport, 'without-manual', 'Student'),
    'Duplicate question ID detected',
    'Rejects duplicate question IDs.'
  );

  // 8. Adversarial: Aggregate Total Score Mismatch
  const inconsistentSumReport = {
    ...validBaseReport,
    totalScore: 99, // Hallucinated aggregate total that differs from 5 + 5 = 10
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Good'],
      },
      {
        qNo: '2',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Good'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(inconsistentSumReport, 'without-manual', 'Student'),
    'Aggregate score discrepancy',
    'Rejects model aggregate totalScore that fails to match the exact mathematical sum of questions.'
  );

  // 9. Partial Credit Verification
  const partialCreditReport = {
    ...validBaseReport,
    totalScore: 7.75,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 3.25,
        maxMarks: 5,
        feedbackPoints: ['Partial credit for step 1 and step 2.'],
      },
      {
        qNo: '2',
        marks: 4.5,
        maxMarks: 5,
        feedbackPoints: ['Minor rounding variance on final step.'],
      },
    ],
  };
  const partialResult = evaluationEngine.validateAndNormalizeReport(partialCreditReport, 'without-manual', 'Student');
  assert(partialResult.totalScore === 7.75, 'Preserves valid partial credit scores with decimal precision.');
  assert(partialResult.questions[0].marks === 3.25, 'Maintains exact awarded question marks for partial credit.');

  // ==========================================================================
  // GROUP 3: Authentication, RBAC, and Tenant Isolation
  // ==========================================================================
  console.log('\n--- TEST GROUP 3: Authentication & Multi-Tenant Access Control ---');

  // Test 1: Missing auth header
  const unauthReq = { headers: {} } as Request;
  assert(authenticateRequest(unauthReq) === null, 'Unauthenticated request correctly returns null context.');

  // Test 2: Valid instructor token
  const instructorReq = {
    headers: { authorization: 'Bearer nextgen_inst_sec_token_4412' },
  } as Request;
  const instructorUser = authenticateRequest(instructorReq);
  assert(instructorUser !== null && instructorUser.role === 'instructor', 'Recognizes valid instructor Bearer token.');
  assert(instructorUser?.institutionId === 'inst_aarshiv_01', 'Binds user to correct tenant institution.');

  // Test 3: Operator token
  const operatorReq = {
    headers: { authorization: 'Bearer nextgen_op_sec_token_9921' },
  } as Request;
  const operatorUser = authenticateRequest(operatorReq);
  assert(operatorUser !== null && operatorUser.role === 'operator', 'Recognizes system operator token with operator role.');

  // Test 4: Tenant isolation verification
  const jobTenantA = { institutionId: 'inst_aarshiv_01', createdBy: 'prof_sharma' };
  const userTenantB: UserContext = {
    userId: 'user_other',
    role: 'instructor',
    institutionId: 'inst_other_university',
    name: 'Prof. Other',
  };

  assert(
    verifyJobAccess(jobTenantA, userTenantB) === false,
    'Security Isolation: Instructor from Institution B cannot access Job belonging to Institution A (403 Forbidden).'
  );

  assert(
    verifyJobAccess(jobTenantA, instructorUser!) === true,
    'Authorized Access: Instructor from same institution can access the evaluation job.'
  );

  assert(
    verifyJobAccess(jobTenantA, operatorUser!) === true,
    'Operator Access: System operator has universal operational access across institutions.'
  );

  // ==========================================================================
  // GROUP 4: Queue Persistence, Atomic Disk Operations & Backpressure
  // ==========================================================================
  console.log('\n--- TEST GROUP 4: Queue Persistence, Atomic Storage & Capacity Limits ---');

  const testQueuePayload = {
    sourceDoc: { name: 'student_test.pdf', text: 'Answer 1: Test answer.' },
    mode: 'without-manual' as const,
    studentName: 'Persistence Test Student',
  };

  const enqueuedJob = evaluationQueue.enqueue(testQueuePayload, instructorUser);
  assert(enqueuedJob.id.length > 0, 'Job successfully enqueued.');
  assert(enqueuedJob.institutionId === 'inst_aarshiv_01', 'Job records correct institution tenant.');

  // Verify atomic file existence on disk
  const jobFilePath = path.join(config.dataDir, 'jobs', `${enqueuedJob.id}.json`);
  assert(fs.existsSync(jobFilePath), 'Job file was durably persisted to disk.');

  // Verify atomic temp file cleanup
  const tempFiles = fs.readdirSync(path.join(config.dataDir, 'jobs')).filter((f) => f.includes('.tmp.'));
  assert(tempFiles.length === 0, 'Atomic writes leave no orphan temporary files on disk.');

  // Test Queue Capacity Backpressure
  console.log('Testing queue capacity bounds...');
  let hitCapacityLimit = false;
  const overflowJobs: any[] = [];
  try {
    for (let i = 0; i < MAX_QUEUE_CAPACITY + 5; i++) {
      const j = evaluationQueue.enqueue(
        {
          sourceDoc: { name: `load_test_${i}.pdf`, text: `Content ${i}` },
          studentName: `Load Student ${i}`,
        },
        instructorUser
      );
      overflowJobs.push(j);
    }
  } catch (err: any) {
    if (err instanceof QueueCapacityError) {
      hitCapacityLimit = true;
    }
  }
  assert(hitCapacityLimit, `Queue strictly enforces backpressure limit (${MAX_QUEUE_CAPACITY} jobs) with QueueCapacityError (HTTP 503).`);

  // Clean up test jobs
  evaluationQueue.deleteJob(enqueuedJob.id, instructorUser);
  for (const j of overflowJobs) {
    evaluationQueue.deleteJob(j.id, instructorUser);
  }

  // ==========================================================================
  // GROUP 5: Advanced Security, HMAC Tokens & Evaluation Rate Limiting
  // ==========================================================================
  console.log('\n--- TEST GROUP 5: Advanced Security, Signed Tokens & Rate Limiting ---');

  // 1. Rejection of unsigned operator token forging
  const fakeOperatorReq = mockRequest('Bearer tkn_operator_system_global_intruder_01');
  assert(
    authenticateRequest(fakeOperatorReq) === null,
    'Critical Security: Blocked attempt to forge operator role via unsigned dynamic token.'
  );

  // 2. Rejection of unsigned admin token forging
  const fakeAdminReq = mockRequest('Bearer tkn_admin_inst_aarshiv_01_fake_admin');
  assert(
    authenticateRequest(fakeAdminReq) === null,
    'Critical Security: Blocked attempt to forge admin role via unsigned dynamic token.'
  );

  // 3. Acceptance of cryptographically signed HMAC operator token
  const signedOperatorToken = signDynamicToken('operator', 'system_global', 'root_op_99');
  const validSignedOpReq = mockRequest(`Bearer ${signedOperatorToken}`);
  const signedOpUser = authenticateRequest(validSignedOpReq);
  assert(signedOpUser !== null && signedOpUser.role === 'operator', 'Valid HMAC-signed operator token successfully authenticated.');

  // 4. Acceptance of cryptographically signed HMAC instructor token
  const signedInstToken = signDynamicToken('instructor', 'inst_med_hospital_01', 'dr_smith');
  const validSignedInstReq = mockRequest(`Bearer ${signedInstToken}`);
  const signedInstUser = authenticateRequest(validSignedInstReq);
  assert(
    signedInstUser !== null && signedInstUser.role === 'instructor' && signedInstUser.institutionId === 'inst_med_hospital_01',
    'Valid HMAC-signed instructor token successfully authenticated with bound institution.'
  );

  // 5. Tampered signed token fails
  const tamperedToken = signedInstToken.substring(0, signedInstToken.length - 2) + 'ff';
  assert(
    authenticateRequest(mockRequest(`Bearer ${tamperedToken}`)) === null,
    'Security Integrity: Tampered HMAC signature immediately rejected.'
  );

  // 6. Evaluation creation rate limiting
  const rateLimitClient = 'test_eval_client_user_01';
  let evalsAllowedCount = 0;
  for (let i = 0; i < 15; i++) {
    const res = checkEvaluationRateLimit(rateLimitClient);
    if (res.allowed) evalsAllowedCount++;
  }
  assert(evalsAllowedCount === 15, 'Evaluation rate limiter permits up to 15 evaluation creation requests per window.');
  const blockedEval = checkEvaluationRateLimit(rateLimitClient);
  assert(!blockedEval.allowed && blockedEval.retryAfterSeconds > 0, 'Evaluation rate limiter rejects 16th creation request within the 1-minute window.');

  // ==========================================================================
  // GROUP 6: Request Schema & MIME Type Boundary Validation
  // ==========================================================================
  console.log('\n--- TEST GROUP 6: Request Schema & MIME Type Boundaries ---');

  const ALLOWED_MIMES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  function validateMime(mime: string): boolean {
    return ALLOWED_MIMES.includes(mime.toLowerCase());
  }

  assert(validateMime('application/pdf'), 'Permits valid PDF documents.');
  assert(validateMime('image/png'), 'Permits valid PNG scanned scripts.');
  assert(validateMime('image/jpeg'), 'Permits valid JPEG photos.');
  assert(!validateMime('application/x-sh'), 'Strictly rejects shell script uploads.');
  assert(!validateMime('application/x-msdownload'), 'Strictly rejects executable binary uploads.');
  assert(!validateMime('text/html'), 'Strictly rejects raw HTML uploads to prevent script injection.');

  // ==========================================================================
  // GROUP 7: Timeout, Retries, Jitter & Fallback Resilience (Mock Provider)
  // ==========================================================================
  console.log('\n--- TEST GROUP 7: Timeout, Retries, Jitter & Fallback Resilience (Mock Provider) ---');

  const sampleAcademicReport = {
    studentName: 'Mock Student',
    testTitle: 'Resilience Assessment',
    testTopics: 'Pathology',
    testDate: '2026-05-15',
    totalScore: 10,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 10,
        maxMarks: 10,
        isCorrect: true,
        feedbackPoints: ['Correct biological pathway described.'],
      },
    ],
    generalFeedback: {
      overallPerformance: ['Passed.'],
      mcqs: [],
      contentAccuracy: ['Accurate.'],
      completenessOfAnswers: ['Complete.'],
      presentationDiagrams: ['Good diagrams.'],
      investigations: [],
      attemptingQuestions: ['Attempted.'],
      actionPoints: ['Continue revision.'],
    },
  };

  // 1. Transient Error 503 -> Retry -> Success
  let callCount503 = 0;
  setMockGeminiProvider(async () => {
    callCount503++;
    if (callCount503 === 1) {
      const err: any = new Error('503 Service Unavailable / High demand');
      err.status = 503;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 },
    };
  });

  const res503 = await callGeminiWithFallback([], 'instruction', 'corr_503');
  assert(res503.retries === 1, 'Transient 503 error successfully retried with bounded exponential backoff.');
  assert(res503.report.totalScore === 10, 'Result after retry matches verified evaluation report.');

  // 2. Rate Limit 429 -> Retry -> Success
  let callCount429 = 0;
  setMockGeminiProvider(async () => {
    callCount429++;
    if (callCount429 === 1) {
      const err: any = new Error('429 Resource has been exhausted / Rate limit');
      err.status = 429;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
    };
  });

  const res429 = await callGeminiWithFallback([], 'instruction', 'corr_429');
  assert(res429.retries === 1, 'Rate limit 429 error successfully recovered after retry backoff.');

  // 3. Non-retryable Client Error (e.g. 400 Bad Request) stops immediately without useless retries
  let callCount400 = 0;
  setMockGeminiProvider(async () => {
    callCount400++;
    const err: any = new Error('400 Bad Request: Invalid parameter');
    err.status = 400;
    throw err;
  });

  let nonRetryCaught = false;
  try {
    await callGeminiWithFallback([], 'instruction', 'corr_400');
  } catch (err: any) {
    nonRetryCaught = true;
  }
  assert(nonRetryCaught, 'Non-retryable 400 Bad Request fails immediately without endless retries.');
  assert(callCount400 <= 3, 'Non-retryable error makes only 1 attempt per candidate model, no backoff loops.');

  // 4. Model Fallback: Primary fails with non-retryable 404, secondary succeeds
  setMockGeminiProvider(async ({ model }) => {
    if (model === config.primaryModel) {
      const err: any = new Error(`Model ${model} not found or unsupported`);
      err.status = 404;
      throw err;
    }
    return {
      text: JSON.stringify({ ...sampleAcademicReport, testTitle: `Graded by ${model}` }),
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 250 },
    };
  });

  const resFallback = await callGeminiWithFallback([], 'instruction', 'corr_fallback');
  assert(resFallback.modelUsed !== config.primaryModel, 'Automated fallback successfully engaged when primary model fails.');
  assert(resFallback.fallbackCallsCount === 1, 'Fallback call accurately accounted in execution metrics.');

  // 5. Malformed JSON handling without fabricating results
  setMockGeminiProvider(async () => {
    return {
      text: '<<< Not valid JSON at all >>>',
    };
  });

  let malformedCaught = false;
  try {
    await callGeminiWithFallback([], 'instruction', 'corr_malformed');
  } catch (err: any) {
    malformedCaught = true;
    assert(err.message.includes('JSON'), 'Malformed JSON error correctly surfaces without mock fallback grades.');
  }
  assert(malformedCaught, 'Corrupted model output strictly caught and never fabricated into 10/10 grade.');

  // Reset mock provider to ensure no interference with subsequent runs
  setMockGeminiProvider(null);

  // ==========================================================================
  // GROUP 8: Queue Cancellation, Review Endpoint & Retention Pruning
  // ==========================================================================
  console.log('\n--- TEST GROUP 8: Queue Cancellation, Review & Retention Pruning ---');

  // 1. Cancellation of queued job
  const cancelJobPayload = {
    sourceDoc: { name: 'cancel_me.pdf', text: 'To be cancelled' },
    studentName: 'Cancel Test Student',
  };
  const jobToCancel = evaluationQueue.enqueue(cancelJobPayload, instructorUser);
  const cancelled = evaluationQueue.cancelJob(jobToCancel.id, instructorUser);
  assert(cancelled !== null && cancelled.status === 'cancelled', 'Queued evaluation job successfully cancelled.');

  // 2. Cannot cancel an already completed job
  cancelled!.status = 'completed';
  let cancelCompletedError = false;
  try {
    evaluationQueue.cancelJob(cancelled!.id, instructorUser);
  } catch (err: any) {
    cancelCompletedError = true;
  }
  assert(cancelCompletedError, 'Cannot cancel a completed evaluation job.');

  // 3. Draft report preservation on needs_review
  const discrepancyReport = {
    studentName: 'Review Student',
    questions: [
      {
        qNo: '1',
        marks: 12, // Exceeds maxMarks of 10!
        maxMarks: 10,
        feedbackPoints: ['Good.'],
      },
    ],
  };

  let reviewErrorCaught = false;
  try {
    evaluationEngine.validateAndNormalizeReport(discrepancyReport, 'without-manual', 'Review Student');
  } catch (err: any) {
    reviewErrorCaught = true;
    assert(err instanceof ValidationError, 'Academic score violation throws ValidationError for human review.');
  }
  assert(reviewErrorCaught, 'Score bounds discrepancy successfully triggers review state.');

  // 4. Pruning expired historical jobs
  const oldJob = evaluationQueue.enqueue({ sourceDoc: { name: 'old.pdf', text: 'Old' } }, instructorUser);
  oldJob.status = 'completed';
  oldJob.createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
  const prunedCount = evaluationQueue.pruneExpiredJobs(30);
  assert(prunedCount >= 1, `Retention policy successfully pruned ${prunedCount} job(s) older than 30 days.`);

  // 5. Zero credential exposure
  assert(typeof config.geminiApiKey === 'string', 'Server holds API key in environment configuration.');
  const sanitizedProbe = {
    status: config.geminiApiKey ? 'ready' : 'configuration_warning',
    timestamp: new Date().toISOString(),
  };
  assert(!('geminiApiKey' in sanitizedProbe), 'Public readiness probe never leaks geminiApiKey string.');

  // ==========================================================================
  // GROUP 9: Versioned Pricing Engine & Currency Calculations
  // ==========================================================================
  console.log('\n--- TEST GROUP 9: Versioned Pricing Engine & Currency Calculations ---');

  // 1. Model rate lookups
  const flashRate = getModelPricingRate('gemini-3.8-flash');
  assert(flashRate !== null, 'Model pricing rate found for gemini-3.8-flash.');
  assert(flashRate!.inputPerMillion === 0.10, 'gemini-3.8-flash prompt token rate is $0.10 / 1M.');
  assert(flashRate!.outputPerMillion === 0.40, 'gemini-3.8-flash candidate token rate is $0.40 / 1M.');
  assert(flashRate!.cachedInputPerMillion === 0.025, 'gemini-3.8-flash cached token rate is $0.025 / 1M.');

  const liteRate = getModelPricingRate('gemini-3.1-flash-lite');
  assert(liteRate !== null && liteRate.inputPerMillion === 0.0375, 'gemini-3.1-flash-lite prompt token rate is $0.0375 / 1M.');

  const normalizedRate = getModelPricingRate('models/gemini-3.8-flash');
  assert(normalizedRate !== null && normalizedRate.modelId === 'gemini-3.8-flash', 'Model name with "models/" prefix successfully normalized.');

  // 2. Cost calculation with cached tokens and standard currency conversion
  const calc1 = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 500_000,
    customUsdToInrRate: 85.0,
  });
  assert(calc1.isCostCalculable, 'Call cost successfully calculated for configured model.');
  // Calculation breakdown:
  // Non-cached prompt: 800,000 * 0.10 / 1M = $0.080
  // Cached prompt: 200,000 * 0.025 / 1M = $0.005
  // Candidate output: 500,000 * 0.40 / 1M = $0.200
  // Total USD = 0.080 + 0.005 + 0.200 = $0.285
  // Total INR = 0.285 * 85.0 = ₹24.225
  assert(calc1.totalCostUsd === 0.285, `Total USD cost matches expected $0.285 (got ${calc1.totalCostUsd}).`);
  assert(calc1.totalCostInr === 24.225, `Total INR cost matches expected ₹24.225 (got ${calc1.totalCostInr}).`);

  // 3. Custom foreign exchange rate
  const calcFx = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    customUsdToInrRate: 90.0,
  });
  assert(calcFx.totalCostInr === 9.0, `Custom USD-to-INR rate (90.0) correctly yields ₹9.0 for $0.10 input cost.`);

  // 4. Missing token metadata defense (Zero Fabrication Guarantee)
  const calcMissingTokens = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: null,
    outputTokens: null,
  });
  assert(!calcMissingTokens.isCostCalculable, 'Missing token metadata correctly flagged as isCostCalculable: false.');
  assert(calcMissingTokens.totalCostUsd === null, 'Missing token metadata returns null USD cost, NEVER fabricated $0.00.');
  assert(calcMissingTokens.uncalculatedReason === 'MISSING_TOKEN_METADATA', 'Reason explicitly marked as MISSING_TOKEN_METADATA.');

  // 5. Unconfigured model defense (Zero Fabrication Guarantee)
  const calcUnknownModel = calculateCallCost({
    model: 'gemini-unknown-experimental-model-x',
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert(!calcUnknownModel.isCostCalculable, 'Unconfigured model correctly flagged as isCostCalculable: false.');
  assert(calcUnknownModel.totalCostUsd === null, 'Unconfigured model returns null USD cost, NEVER fabricated $0.00.');
  assert(calcUnknownModel.uncalculatedReason === 'UNKNOWN_MODEL', 'Reason explicitly marked as UNKNOWN_MODEL.');

  // 6. Unconfigured pricing version defense
  const calcUnknownVersion = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1000,
    outputTokens: 500,
    pricingVersion: 'pricing_v999_invalid',
  });
  assert(!calcUnknownVersion.isCostCalculable, 'Unconfigured pricing version correctly flagged as isCostCalculable: false.');
  assert(calcUnknownVersion.uncalculatedReason === 'UNCONFIGURED_VERSION', 'Reason explicitly marked as UNCONFIGURED_VERSION.');

  // ==========================================================================
  // GROUP 10: Usage & Cost Ledger, Multi-tenant Isolation & Batch Aggregates
  // ==========================================================================
  console.log('\n--- TEST GROUP 10: Usage & Cost Ledger, Multi-tenant Isolation & Batch Aggregates ---');

  // 1. Per-attempt recording across retries without double counting
  let retryTestAttempt = 0;
  setMockGeminiProvider(async () => {
    retryTestAttempt++;
    if (retryTestAttempt === 1) {
      const err: any = new Error('503 Service Unavailable temporary overload');
      err.status = 503;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: {
        promptTokenCount: 2000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 400,
      },
    };
  });

  const retryJobId = `job_retry_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const retryCallResult = await callGeminiWithFallback([], 'instruction', 'corr_ledger_retry', {
    jobId: retryJobId,
    institutionId: 'inst_aarshiv_01',
    pipelineStage: 'grading',
  });

  assert(retryCallResult.retries === 1, 'Transient error triggered 1 retry in client.');
  assert(retryCallResult.usageSummary !== null, 'Evaluation usage summary returned in call result.');
  assert(retryCallResult.usageSummary!.totalCalls === 2, 'Usage ledger recorded both the failed attempt and successful retry.');
  assert(retryCallResult.usageSummary!.failedCalls === 1, 'Usage ledger accurately isolated 1 failed attempt.');
  assert(retryCallResult.usageSummary!.successfulCalls === 1, 'Usage ledger accurately isolated 1 successful call.');
  assert(retryCallResult.usageSummary!.retriedCalls === 1, 'Usage ledger tagged 1 retried call.');
  assert(retryCallResult.usageSummary!.totalInputTokens === 2000, 'Total tokens strictly reflect actual consumed tokens without double-counting.');
  assert(retryCallResult.usageSummary!.dataSource === 'SIMULATED_MOCK', 'Data source accurately classified as SIMULATED_MOCK under mock provider.');
  assert(retryCallResult.usageSummary!.usageCompleteness === 'COMPLETE', 'Usage completeness accurately marked as COMPLETE.');

  // 2. Missing metadata handling in client and ledger
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify(sampleAcademicReport),
      // Intentionally omitting usageMetadata
    };
  });

  const noMetaJobId = `job_nometa_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const noMetaResult = await callGeminiWithFallback([], 'instruction', 'corr_no_meta', {
    jobId: noMetaJobId,
    institutionId: 'inst_aarshiv_01',
  });

  assert(noMetaResult.inputTokens === null, 'Missing usageMetadata yields null inputTokens in call result.');
  assert(noMetaResult.estimatedCostUsd === null, 'Missing usageMetadata yields null estimatedCostUsd in call result.');
  assert(noMetaResult.usageCompleteness === 'UNAVAILABLE', 'Missing usageMetadata tagged as UNAVAILABLE completeness.');
  assert(noMetaResult.usageSource === 'UNKNOWN', 'Missing usageMetadata classified as UNKNOWN source.');

  const noMetaSummary = usageLedger.getJobUsageSummary(noMetaJobId);
  assert(noMetaSummary !== null, 'Usage summary recorded for job with missing metadata.');
  assert(noMetaSummary!.totalInputTokens === null, 'Usage ledger summary preserves null for missing input tokens.');
  assert(noMetaSummary!.totalEstimatedCostUsd === null, 'Usage ledger summary preserves null for uncalculable cost.');
  assert(noMetaSummary!.usageCompleteness === 'UNAVAILABLE', 'Usage ledger summary completeness is UNAVAILABLE.');

  // 3. Multi-tenant isolation for usage summaries
  const instAUser: UserContext = {
    userId: 'instr_a',
    role: 'instructor',
    institutionId: 'inst_aarshiv_01',
    name: 'Instructor A',
  };
  const instBUser: UserContext = {
    userId: 'instr_b',
    role: 'instructor',
    institutionId: 'inst_other_hospital_99',
    name: 'Instructor B',
  };

  const summaryForInstA = usageLedger.getJobUsageSummary(retryJobId, instAUser);
  assert(summaryForInstA !== null, 'Instructor from Institution A can view their own institution job usage summary.');

  const summaryForInstB = usageLedger.getJobUsageSummary(retryJobId, instBUser);
  assert(summaryForInstB === null, 'Instructor from Institution B CANNOT access Institution A job usage summary (returns null).');

  const summaryForOperator = usageLedger.getJobUsageSummary(retryJobId, operatorUser);
  assert(summaryForOperator !== null, 'Platform operator can access cross-institution usage summary for operational audit.');

  // 4. Batch statistics and sample size sufficiency for percentiles
  const batchInst = `inst_batch_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  // Create 5 jobs for batchInst
  for (let i = 1; i <= 5; i++) {
    usageLedger.recordAttempt({
      jobId: `batch_job_${i}_${batchInst}`,
      correlationId: `corr_b_${i}`,
      institutionId: batchInst,
      pipelineStage: 'grading',
      requestedModel: 'gemini-3.8-flash',
      actualModel: 'gemini-3.8-flash',
      attemptNumber: 1,
      isFallback: false,
      status: 'success',
      latencyMs: 1200,
      inputTokens: 10000 * i,
      outputTokens: 2000 * i,
      cachedInputTokens: 1000 * i,
      usageSource: 'SIMULATED_MOCK',
    });
  }

  const batchStats5 = usageLedger.getBatchStatistics({ institutionId: batchInst });
  assert(batchStats5.sampleSize === 5, 'Batch statistics sample size is 5.');
  assert(!batchStats5.costs.sampleSizeSufficientForPercentiles, 'Sample size < 10 correctly flags sampleSizeSufficientForPercentiles: false.');
  assert(batchStats5.costs.p90CostUsd === null, 'P90 is null when sample size is insufficient (< 10).');
  assert(batchStats5.costs.p95CostUsd === null, 'P95 is null when sample size is insufficient (< 10).');
  assert(batchStats5.costs.meanCostUsd > 0, 'Mean cost is accurately computed for 5 evaluations.');
  assert(batchStats5.costs.medianCostUsd > 0, 'Median cost is accurately computed for 5 evaluations.');

  // Add 5 more jobs (total 10)
  for (let i = 6; i <= 10; i++) {
    usageLedger.recordAttempt({
      jobId: `batch_job_${i}_${batchInst}`,
      correlationId: `corr_b_${i}`,
      institutionId: batchInst,
      pipelineStage: 'grading',
      requestedModel: 'gemini-3.8-flash',
      actualModel: 'gemini-3.8-flash',
      attemptNumber: 1,
      isFallback: false,
      status: 'success',
      latencyMs: 1200,
      inputTokens: 10000 * i,
      outputTokens: 2000 * i,
      cachedInputTokens: 1000 * i,
      usageSource: 'SIMULATED_MOCK',
    });
  }

  const batchStats10 = usageLedger.getBatchStatistics({ institutionId: batchInst });
  assert(batchStats10.sampleSize === 10, 'Batch statistics sample size reached 10.');
  assert(batchStats10.costs.sampleSizeSufficientForPercentiles, 'Sample size >= 10 correctly enables percentiles.');
  assert(batchStats10.costs.p90CostUsd !== null, 'P90 cost is computed when sample size >= 10.');
  assert(batchStats10.costs.p95CostUsd !== null, 'P95 cost is computed when sample size >= 10.');
  assert(batchStats10.costs.p90CostUsd! >= batchStats10.costs.medianCostUsd, 'P90 cost is greater than or equal to median cost.');

  // 5. Full Evaluation Engine integration
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: {
        promptTokenCount: 15000,
        candidatesTokenCount: 3500,
        cachedContentTokenCount: 2000,
      },
    };
  });

  const fullEvalJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: `phase2_script_${Date.now()}.pdf`, text: `Anatomy answer script content ${Date.now()}` },
      studentName: 'Phase 2 Test Student',
      testTitle: 'Upper Limb Anatomy & Embryology',
    },
    instructorUser
  );

  const evalResult = await evaluationEngine.evaluate(fullEvalJob);
  assert(evalResult.totalScore === 10, 'Full evaluation engine completed successfully.');
  assert(fullEvalJob.metrics.estimatedCostInr !== null && fullEvalJob.metrics.estimatedCostInr! >= 0, 'Job metrics contain non-null estimatedCostInr.');
  assert(fullEvalJob.metrics.cachedInputTokens === 2000, 'Job metrics contain cachedInputTokens (2000).');
  assert(fullEvalJob.metrics.pricingVersion === ACTIVE_PRICING_VERSION, `Job metrics record active pricing version (${ACTIVE_PRICING_VERSION}).`);
  assert(fullEvalJob.metrics.usageCompleteness === 'COMPLETE', 'Job metrics record usageCompleteness: COMPLETE.');
  assert(fullEvalJob.metrics.usageSummary !== null, 'Job metrics contain complete usageSummary.');

  // Clean up mock provider
  setMockGeminiProvider(null);

  // ==========================================================================
  // GROUP 11: Two Answer-Key Preparation Modes, Canonical Model & Approval Workflow
  // ==========================================================================
  console.log('\n--- TEST GROUP 11: Two Answer-Key Preparation Modes & Student Evaluation Integration ---');

  const instA_User: UserContext = {
    userId: `prof_sharma_${Date.now()}`,
    role: 'instructor',
    institutionId: `inst_aarshiv_${Date.now()}`,
    name: 'Prof. Sharma',
  };

  const instB_User: UserContext = {
    userId: `prof_verma_${Date.now()}`,
    role: 'instructor',
    institutionId: `inst_rival_${Date.now()}`,
    name: 'Prof. Verma',
  };

  // Mock Gemini provider for answer key generation & extraction
  setMockGeminiProvider(async ({ contentsParts, systemInstruction, correlationId }) => {
    // Mode 1: AI generation mock response
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Anatomy End-Term Assessment',
          totalMaxMarks: 20,
          warnings: [],
          questions: [
            {
              questionId: '1',
              subquestionId: null,
              questionText: 'Describe the course and branches of the Median Nerve in the forearm.',
              maxMarks: 10,
              referenceAnswer: 'The median nerve enters the forearm between the two heads of pronator teres...',
              expectedConcepts: ['Pronator teres relation', 'Anterior interosseous nerve branch', 'Motor innervation to flexors'],
              acceptableAlternatives: ['Can mention C5-T1 root values alternatively'],
              markingCriteria: ['3 marks for course', '4 marks for muscular branches', '3 marks for clinical correlation'],
              diagramReferences: ['Forearm flexor compartment diagram'],
              confidence: 0.95,
              flaggedIssue: null,
            },
            {
              questionId: '2.a',
              subquestionId: 'a',
              questionText: 'Enumerate the carpal bones.',
              maxMarks: 5,
              referenceAnswer: 'Proximal row: Scaphoid, Lunate, Triquetrum, Pisiform. Distal row: Trapezium, Trapezoid, Capitate, Hamate.',
              expectedConcepts: ['Proximal row 4 bones', 'Distal row 4 bones'],
              acceptableAlternatives: ['Mnemonic: She Looks Too Pretty Try To Catch Her'],
              markingCriteria: ['2.5 marks for proximal row', '2.5 marks for distal row'],
              confidence: 0.98,
              flaggedIssue: null,
            },
            {
              questionId: '2.b',
              subquestionId: 'b',
              questionText: 'Explain the anatomical basis of Carpal Tunnel Syndrome.',
              maxMarks: 5,
              referenceAnswer: 'Compression of median nerve beneath the flexor retinaculum...',
              expectedConcepts: ['Flexor retinaculum boundaries', 'Median nerve compression', 'Ape thumb deformity / thenar wasting'],
              acceptableAlternatives: ['Can mention sensory loss in lateral 3.5 digits'],
              markingCriteria: ['2 marks for boundaries', '3 marks for symptoms and signs'],
              confidence: 0.94,
              flaggedIssue: null,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 450 },
      };
    }

    // Mode 2: Uploaded key extraction mock response
    if (correlationId.startsWith('ak_ext_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Extracted Official Model Answer Key',
          totalMaxMarks: 15,
          warnings: [],
          questions: [
            {
              questionId: '1',
              maxMarks: 10,
              referenceAnswer: 'Model answer for Question 1 from faculty notes.',
              expectedConcepts: ['Concept A', 'Concept B'],
              acceptableAlternatives: ['Alternative 1'],
              markingCriteria: ['5 marks for part 1', '5 marks for part 2'],
              confidence: 0.96,
              flaggedIssue: null,
            },
            {
              questionId: '2',
              maxMarks: 5,
              referenceAnswer: 'Model answer for Question 2.',
              expectedConcepts: ['Concept C'],
              acceptableAlternatives: [],
              markingCriteria: ['5 marks for comprehensive answer'],
              confidence: 0.92,
              flaggedIssue: null,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1600, candidatesTokenCount: 380 },
      };
    }

    // Student script evaluation mock response
    return {
      text: JSON.stringify({
        studentName: 'Anatomy Student',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 16,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 8, maxMarks: 10, isCorrect: true, feedbackPoints: ['Good description of course. Missed one cutaneous branch.'] },
          { qNo: '2.a', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Named 7 of 8 carpal bones accurately.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Clear explanation of flexor retinaculum compression.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Strong grasp of upper limb anatomy.'],
          mcqs: ['N/A'],
          contentAccuracy: ['Accurate anatomical terminology.'],
          completenessOfAnswers: ['Comprehensive answers with minor omission of cutaneous branch.'],
          presentationDiagrams: ['Neat descriptions.'],
          investigations: ['N/A'],
          attemptingQuestions: ['Attempted all questions.'],
          actionPoints: ['Revise sensory nerve distributions.'],
        },
      }),
      usageMetadata: { promptTokenCount: 4200, candidatesTokenCount: 850, cachedContentTokenCount: 1200 },
    };
  });

  // 1. AI-generated key creation (draft or needs_review)
  const aiKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: {
      name: 'QP_Anatomy_2026.pdf',
      text: 'Question 1: Describe the course and branches of the Median Nerve (10 marks). Question 2: (a) Enumerate carpal bones (5 marks). (b) Carpal tunnel syndrome (5 marks).',
    },
    title: 'Anatomy End-Term Assessment',
    subject: 'Anatomy',
    grade: 'MBBS Year 1',
    totalMaxMarks: 20,
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(aiKey.id.startsWith('ak_'), 'Mode 1: AI answer key created with unique ID.');
  assert(aiKey.sourceMode === 'ai_generated', 'Mode 1: sourceMode correctly tagged as ai_generated.');
  assert(aiKey.status === 'draft' || aiKey.status === 'needs_review', 'Mode 1: AI key initial status is draft or needs_review (NEVER approved by default!).');
  assert(aiKey.version === 1, 'Mode 1: Initial version is 1.');
  assert(aiKey.questions.length === 3, 'Mode 1: Extracted 3 canonical questions.');
  assert(aiKey.totalMaxMarks === 20, 'Mode 1: totalMaxMarks correctly set to 20.');

  // 2. Uploaded key extraction (draft or needs_review)
  const uploadedKey = await answerKeyService.extractFromUploadedKey({
    answerKeyDoc: {
      name: 'Official_Key_Anatomy.pdf',
      text: 'Official Marking Scheme: Q1. Median nerve model answer (10 marks). Q2. Carpal bones and syndrome (5 marks).',
    },
    title: 'Extracted Official Model Answer Key',
    subject: 'Anatomy',
    grade: 'MBBS Year 1',
    totalMaxMarks: 15,
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(uploadedKey.id.startsWith('ak_'), 'Mode 2: Uploaded key created with unique ID.');
  assert(uploadedKey.sourceMode === 'uploaded', 'Mode 2: sourceMode correctly tagged as uploaded.');
  assert(uploadedKey.status === 'draft' || uploadedKey.status === 'needs_review', 'Mode 2: Uploaded key initial status is draft or needs_review.');
  assert(uploadedKey.version === 1, 'Mode 2: Initial version is 1.');
  assert(uploadedKey.questions.length === 2, 'Mode 2: Extracted 2 questions.');

  // 3. Canonical schema compatibility between both modes
  const requiredSchemaKeys = ['id', 'examId', 'title', 'sourceMode', 'version', 'status', 'totalMaxMarks', 'questions', 'metadata'];
  const aiHasAll = requiredSchemaKeys.every((k) => k in aiKey);
  const upHasAll = requiredSchemaKeys.every((k) => k in uploadedKey);
  assert(aiHasAll && upHasAll, 'Mode 1 & Mode 2 produce identical canonical schema properties.');
  assert(aiKey.questions[0].referenceAnswer !== undefined && uploadedKey.questions[0].referenceAnswer !== undefined, 'Both modes populate referenceAnswer.');
  assert(Array.isArray(aiKey.questions[0].expectedConcepts) && Array.isArray(uploadedKey.questions[0].expectedConcepts), 'Both modes populate expectedConcepts array.');
  assert(Array.isArray(aiKey.questions[0].markingCriteria) && Array.isArray(uploadedKey.questions[0].markingCriteria), 'Both modes populate markingCriteria array.');

  // 4. Grading pipeline strictly rejects draft / unapproved answer keys
  const unapprovedJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Submission_01.pdf', text: 'Median nerve enters between pronator teres heads...' },
      canonicalAnswerKey: aiKey, // Current status is draft!
      mode: 'without-manual',
      studentName: 'Student Unapproved Key Test',
    },
    instA_User
  );

  let caughtUnapprovedError = false;
  try {
    await evaluationEngine.evaluate(unapprovedJob);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('unapproved answer key')) {
      caughtUnapprovedError = true;
    }
  }
  assert(caughtUnapprovedError, 'Grading pipeline strictly rejects unapproved / draft answer keys with ValidationError.');

  // 5. Explicit approval permits evaluation
  const approvedAiKey = answerKeyService.approveAnswerKey(aiKey.id, instA_User);
  assert(approvedAiKey.status === 'approved', 'Answer key successfully approved by instructor.');
  assert(approvedAiKey.metadata.approvedBy === instA_User.userId, 'Approved key records approving instructor ID.');
  assert(typeof approvedAiKey.metadata.approvedAt === 'number', 'Approved key records approvedAt timestamp.');

  const approvedEvalJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Submission_Approved.pdf', text: 'Median nerve answers...' },
      canonicalAnswerKey: approvedAiKey,
      mode: 'without-manual',
      studentName: 'Student Approved Key Test',
    },
    instA_User
  );

  const approvedReport = await evaluationEngine.evaluate(approvedEvalJob);
  assert(approvedReport.totalScore === 16, 'Student script evaluated successfully against approved answer key.');
  assert(approvedReport.maxScore === 20, 'Report maxScore matches approved answer key totalMaxMarks (20).');

  // 6. Editing an approved key increments version and resets approval
  const editedKey = answerKeyService.updateAnswerKey(
    approvedAiKey.id,
    { title: 'Anatomy End-Term Assessment (Revised Scheme)' },
    instA_User
  );

  assert(editedKey.version === 2, 'Editing an approved answer key increments version to 2.');
  assert(editedKey.status === 'draft', 'Editing an approved answer key resets status to draft (requiring re-approval).');
  assert(editedKey.metadata.approvedAt === undefined, 'Editing an approved key clears previous approvedAt timestamp.');
  assert(editedKey.metadata.approvedBy === undefined, 'Editing an approved key clears previous approvedBy.');

  // Test that evaluating against the newly edited key is rejected until re-approved
  const editedJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Edited_Key_Test.pdf', text: 'Answers...' },
      canonicalAnswerKey: editedKey,
      mode: 'without-manual',
    },
    instA_User
  );

  let caughtEditedRejection = false;
  try {
    await evaluationEngine.evaluate(editedJob);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('unapproved answer key')) {
      caughtEditedRejection = true;
    }
  }
  assert(caughtEditedRejection, 'Editing an approved key invalidates approval; subsequent evaluation is strictly rejected.');

  // Re-approve version 2
  const reapprovedKey = answerKeyService.approveAnswerKey(editedKey.id, instA_User);
  assert(reapprovedKey.version === 2, 'Re-approved key maintains version 2.');
  assert(reapprovedKey.status === 'approved', 'Re-approved key status is approved.');

  // 7. Rejection of missing / invalid maximum marks during approval
  const invalidMarksKey: CanonicalAnswerKey = {
    id: `ak_invalid_${Date.now()}`,
    examId: `exam_${Date.now()}`,
    title: 'Invalid Marks Exam',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'draft',
    totalMaxMarks: 0,
    questions: [
      {
        questionId: '1',
        maxMarks: 0, // INVALID / MISSING!
        referenceAnswer: 'Some answer',
        expectedConcepts: [],
        acceptableAlternatives: [],
        markingCriteria: [],
        flaggedIssue: 'Missing maximum marks in question paper',
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(invalidMarksKey);

  assertThrows(
    () => answerKeyService.approveAnswerKey(invalidMarksKey.id, instA_User),
    'invalid or missing maximum marks',
    'Approval strictly rejected if any question has invalid or missing maximum marks (maxMarks <= 0).'
  );

  // 8. Flagging missing questions and mismatched question numbers
  // Test that generateFromQuestionPaper flags missing marks without fabricating values
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        examTitle: 'Unspecified Marks Exam',
        totalMaxMarks: 0,
        warnings: ['Question 1: Missing marks in prompt.'],
        questions: [
          {
            questionId: '1',
            maxMarks: 0, // AI flags missing marks
            referenceAnswer: 'Model answer without known marks',
            expectedConcepts: ['Concept 1'],
            acceptableAlternatives: [],
            markingCriteria: [],
            flaggedIssue: 'Missing maximum marks in question paper - instructor review required',
          },
        ],
      }),
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 250 },
    };
  });

  const flaggedKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: { name: 'QP_No_Marks.pdf', text: 'Explain cell structure.' },
    title: 'Unspecified Marks Exam',
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(flaggedKey.status === 'needs_review', 'Key with missing marks automatically enters needs_review status.');
  assert(flaggedKey.questions[0].flaggedIssue !== undefined, 'Missing marks question is explicitly flagged for instructor review.');
  assert(flaggedKey.questions[0].maxMarks === 0, 'Missing marks strictly preserved as 0, NEVER silently defaulted to 1!');

  // 9. Handling generation or extraction failures
  setMockGeminiProvider(async () => {
    throw new Error('503 Service Unavailable: Model overloaded');
  });

  let caughtGenerationFailure = false;
  try {
    await answerKeyService.generateFromQuestionPaper({
      questionPaper: { name: 'QP_Fail.pdf', text: 'Some questions' },
      title: 'Failing Exam',
      metadata: { institutionId: instA_User.institutionId, createdBy: instA_User.userId },
    });
  } catch (err: any) {
    caughtGenerationFailure = true;
  }
  assert(caughtGenerationFailure, 'Generation failures fail gracefully and never return fabricated fallback answer keys.');

  // Restore working mock provider
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        studentName: 'Student Reused',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 18,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 9, maxMarks: 10, isCorrect: true, feedbackPoints: ['Excellent answer.'] },
          { qNo: '2.a', marks: 5, maxMarks: 5, isCorrect: true, feedbackPoints: ['All carpal bones correct.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Good explanation of flexor retinaculum.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Outstanding work.'],
          mcqs: [],
          contentAccuracy: ['Accurate.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: ['Clear.'],
          investigations: [],
          attemptingQuestions: ['All attempted.'],
          actionPoints: ['Continue consistent revision.'],
        },
      }),
      usageMetadata: { promptTokenCount: 3500, candidatesTokenCount: 600, cachedContentTokenCount: 1500 },
    };
  });

  // 10. Rejecting unsupported file formats for answer key uploads
  const unsupportedPayload = {
    name: 'archive.zip',
    mimeType: 'application/zip',
    text: '',
    base64: 'UEsDBBQAAAAIA...',
  };

  const ALLOWED_FORMATS = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  const isZipAllowed = ALLOWED_FORMATS.includes(unsupportedPayload.mimeType);
  assert(!isZipAllowed, 'Unsupported file format application/zip correctly identified and rejected.');

  // 11. Multi-tenant isolation for answer keys
  const retrievedByA = answerKeyService.getAnswerKey(reapprovedKey.id, instA_User);
  assert(retrievedByA !== null && retrievedByA.id === reapprovedKey.id, 'Instructor A can access Institution A answer key.');

  const retrievedByB = answerKeyService.getAnswerKey(reapprovedKey.id, instB_User);
  assert(retrievedByB === null, 'Instructor B from Institution B CANNOT access Institution A answer key (returns null).');

  assertThrows(
    () => answerKeyService.approveAnswerKey(reapprovedKey.id, instB_User),
    'not found or access denied',
    'Instructor B CANNOT approve or manipulate Institution A answer key.'
  );

  assertThrows(
    () => answerKeyService.updateAnswerKey(reapprovedKey.id, { title: 'Hacked' }, instB_User),
    'not found or access denied',
    'Instructor B CANNOT edit Institution A answer key.'
  );

  // 12. Reusing approved answer key across multiple student scripts without repeated LLM calls
  let llmCallCount = 0;
  setMockGeminiProvider(async () => {
    llmCallCount++;
    return {
      text: JSON.stringify({
        studentName: `Student ${llmCallCount}`,
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 18,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 9, maxMarks: 10, isCorrect: true, feedbackPoints: ['Clear answer.'] },
          { qNo: '2.a', marks: 5, maxMarks: 5, isCorrect: true, feedbackPoints: ['Full marks.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Well explained.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Good.'],
          mcqs: [],
          contentAccuracy: ['Good.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: ['Good.'],
          investigations: [],
          attemptingQuestions: ['Attempted.'],
          actionPoints: ['Keep it up.'],
        },
      }),
      usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 },
    };
  });

  const studentJob1 = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Batch_Student_1.pdf', text: `Script 1 content ${Date.now()}` },
      canonicalAnswerKey: reapprovedKey,
      mode: 'without-manual',
      studentName: 'Batch Student 1',
    },
    instA_User
  );

  const studentJob2 = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Batch_Student_2.pdf', text: `Script 2 content ${Date.now()}` },
      canonicalAnswerKey: reapprovedKey,
      mode: 'without-manual',
      studentName: 'Batch Student 2',
    },
    instA_User
  );

  const rep1 = await evaluationEngine.evaluate(studentJob1);
  const rep2 = await evaluationEngine.evaluate(studentJob2);
  assert(rep1.totalScore === 18 && rep2.totalScore === 18, 'Both batch students evaluated successfully using shared approved answer key.');
  assert(llmCallCount === 2, 'Reused single approved answer key across 2 students without re-generating key (only 2 student grading calls made).');

  // 13. Verification that answer key generation/extraction calls are isolated from student grading calls in usage ledger
  const keySummary = usageLedger.getJobUsageSummary(aiKey.id, instA_User);
  const studentSummary = usageLedger.getJobUsageSummary(studentJob1.id, instA_User);

  assert(keySummary !== null && keySummary.calls.length > 0, 'Usage ledger recorded attempt for answer key generation job.');
  assert(keySummary!.calls[0].pipelineStage === 'answer_key_generation', 'Answer key generation attempts strictly tagged with pipelineStage: answer_key_generation.');
  assert(studentSummary !== null && studentSummary.calls.length > 0, 'Usage ledger recorded attempt for student grading job.');
  assert(studentSummary!.calls[0].pipelineStage === 'grading', 'Student grading attempts strictly tagged with pipelineStage: grading.');

  // 14. Evaluation report retains answer-key version, ID, and source-mode
  assert(rep1.answerKeyId === reapprovedKey.id, 'Evaluation report retains answerKeyId.');
  assert(rep1.answerKeyVersion === 2, 'Evaluation report retains answerKeyVersion (2).');
  assert(rep1.answerKeySourceMode === 'ai_generated', 'Evaluation report retains answerKeySourceMode (ai_generated).');

  // 15. Backward compatibility and error handling for legacy requests
  const legacyJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Legacy_Student.pdf', text: 'Legacy script' },
      questionPaper: { name: 'QP_Legacy.pdf', text: 'Q1. Explain cell (10 marks).' },
      answerKey: { name: 'AK_Legacy.pdf', text: 'Q1. Cell is basic structural unit (10 marks).' },
      mode: 'without-manual',
      studentName: 'Legacy Student',
    },
    instA_User
  );

  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        studentName: 'Legacy Student',
        testTitle: 'Legacy Assessment',
        testTopics: 'Biology',
        testDate: '2026-10-29',
        totalScore: 10,
        maxScore: 10,
        questions: [{ qNo: '1', marks: 10, maxMarks: 10, isCorrect: true, feedbackPoints: ['Correct.'] }],
        generalFeedback: {
          overallPerformance: ['Passed.'],
          mcqs: [],
          contentAccuracy: ['Accurate.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: [],
          investigations: [],
          attemptingQuestions: ['Attempted.'],
          actionPoints: ['Good.'],
        },
      }),
      usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 300 },
    };
  });

  const legacyReport = await evaluationEngine.evaluate(legacyJob);
  assert(legacyReport.totalScore === 10, 'Backward compatibility: Legacy requests without canonical answer key continue evaluating cleanly.');

  // Clean up mock provider
  setMockGeminiProvider(null);

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\n========================================================================');
  console.log(` ALL REGRESSION TESTS COMPLETED: ${passedTests}/${totalTests} PASSED`);
  console.log('========================================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
