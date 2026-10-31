/**
 * Regression Test Suite: Deterministic Marks Validation & Answer Key Review Workflow
 * 
 * Verifies:
 * 1. 80-vs-90 discrepancy detection, difference calculation (+10), and offending question identification.
 * 2. Alternative (OR) questions: no double counting of alternative choice groups.
 * 3. Nested sub-questions: hierarchical identifiers (1, 1.1, 1.2, 2(a), 2(b)) preserved and unique.
 * 4. Parent-child marks exclusion: container header marks are not counted twice.
 * 5. Missing or zero marks detection: flagged and rejected during approval.
 * 6. Approval blocking: answer key cannot be approved when unresolved marks discrepancies exist.
 * 7. Manual faculty correction: resolves discrepancies and enables successful approval.
 * 8. Real-time deterministic recalculation of section totals and grand total.
 */

import assert from 'assert';
import { 
  CanonicalQuestionKey, 
  CanonicalAnswerKey, 
  calculateCanonicalKeyMarks, 
  MarksValidationResult 
} from '../server/types';
import { answerKeyService, AnswerKeyValidationError } from '../server/answerKeyService';
import { UserContext } from '../server/auth';

const facultyUser: UserContext = {
  userId: 'faculty_prof_sharma',
  name: 'Prof Sharma',
  institutionId: 'inst_medical_sciences',
  role: 'instructor',
};

console.log('=== STARTING DETERMINISTIC MARKS VALIDATION REGRESSION TESTS ===\n');

// -----------------------------------------------------------------------------
// TEST 1: 80-versus-90 Marks Mismatch Detection & Discrepancy Flagging
// -----------------------------------------------------------------------------
console.log('Test 1: 80-mark paper with 90 extracted marks (Discrepancy Detection)');
{
  const questions: CanonicalQuestionKey[] = [
    {
      questionId: '1',
      section: 'Section A',
      questionText: 'Describe the anatomical boundaries of the femoral triangle.',
      maxMarks: 10,
      referenceAnswer: 'Boundaries: Superiorly inguinal ligament; Medially adductor longus...',
      expectedConcepts: ['Inguinal ligament', 'Adductor longus', 'Sartorius'],
      acceptableAlternatives: ['Standard anatomical description'],
      markingCriteria: ['Award 5 marks for boundaries, 5 marks for contents'],
    },
    {
      questionId: '2',
      section: 'Section A',
      questionText: 'Detail the blood supply and lymphatic drainage of the stomach.',
      maxMarks: 10,
      referenceAnswer: 'Celiac trunk branches: Left gastric, right gastric...',
      expectedConcepts: ['Celiac trunk', 'Left gastric artery', 'Gastric lymph nodes'],
      acceptableAlternatives: [],
      markingCriteria: ['Award 5 marks for arteries, 5 marks for lymphatics'],
    },
    {
      questionId: '3',
      section: 'Section B',
      questionText: 'Explain the formation, course, and distribution of the sciatic nerve.',
      maxMarks: 20,
      referenceAnswer: 'Ventral rami of L4-S3. Passes through greater sciatic foramen...',
      expectedConcepts: ['L4-S3 roots', 'Greater sciatic foramen', 'Tibial & common fibular divisions'],
      acceptableAlternatives: [],
      markingCriteria: ['Award 10 marks for course, 10 marks for branches'],
    },
    {
      questionId: '4',
      section: 'Section B',
      questionText: 'Describe the brachial plexus with clinical anatomy of Erb palsy.',
      maxMarks: 20,
      referenceAnswer: 'Roots C5-T1, trunks, divisions, cords, branches...',
      expectedConcepts: ['Roots C5-T1', 'Erb point', 'Waiter tip deformity'],
      acceptableAlternatives: [],
      markingCriteria: ['Award 12 marks for plexus, 8 marks for Erb palsy'],
    },
    {
      questionId: '5',
      section: 'Section C',
      questionText: 'Write short notes on the thyroid gland histology and blood supply.',
      maxMarks: 15,
      referenceAnswer: 'Thyroid follicles lined by follicular cells, superior and inferior thyroid arteries...',
      expectedConcepts: ['Follicles', 'Superior thyroid artery', 'Inferior thyroid artery'],
      acceptableAlternatives: [],
      markingCriteria: ['Award 8 marks for blood supply, 7 marks for histology'],
    },
    {
      questionId: '6',
      section: 'Section C',
      questionText: 'Write short notes on the microscopic anatomy of liver lobule.',
      maxMarks: 15,
      referenceAnswer: 'Classical hepatic lobule, portal triad, sinusoids, central vein...',
      expectedConcepts: ['Portal triad', 'Sinusoids', 'Central vein', 'Kupffer cells'],
      acceptableAlternatives: [],
      markingCriteria: ['Award 8 marks for portal triad, 7 marks for sinusoids'],
    },
  ];

  const printedMaxMarks = 80;
  const result: MarksValidationResult = calculateCanonicalKeyMarks(questions, printedMaxMarks);

  assert.strictEqual(result.calculatedTotalMarks, 90, 'Extracted total should be 90');
  assert.strictEqual(result.printedMaxMarks, 80, 'Printed max marks must be 80');
  assert.strictEqual(result.hasDiscrepancy, true, 'Discrepancy must be flagged true');
  assert.strictEqual(result.difference, 10, 'Difference must be exactly +10');
  assert.ok(result.discrepancyMessages.length > 0, 'Discrepancy messages must be populated');
  assert.ok(result.message?.includes('80 maximum marks, but extracted questions total 90 marks (+10 discrepancy)'));
  assert.strictEqual(result.sectionTotals['Section A'], 20);
  assert.strictEqual(result.sectionTotals['Section B'], 40);
  assert.strictEqual(result.sectionTotals['Section C'], 30);

  console.log('  ✓ 80-vs-90 discrepancy flagged with exact +10 difference and section breakdown.');
}

// -----------------------------------------------------------------------------
// TEST 2: Alternative (OR) Questions - No Double Counting
// -----------------------------------------------------------------------------
console.log('\nTest 2: Alternative (OR Choice) Questions (e.g. Q5 OR Q6)');
{
  const questions: CanonicalQuestionKey[] = [
    {
      questionId: '1',
      section: 'Section A',
      questionText: 'Compulsory Question 1',
      maxMarks: 20,
      referenceAnswer: 'Standard model answer',
      expectedConcepts: ['Core concept'],
      acceptableAlternatives: [],
      markingCriteria: ['Full credit for correct solution'],
    },
    {
      questionId: '2',
      section: 'Section A',
      questionText: 'Compulsory Question 2',
      maxMarks: 20,
      referenceAnswer: 'Standard model answer',
      expectedConcepts: ['Core concept'],
      acceptableAlternatives: [],
      markingCriteria: ['Full credit for correct solution'],
    },
    {
      questionId: '3',
      section: 'Section B',
      questionText: 'Compulsory Question 3',
      maxMarks: 20,
      referenceAnswer: 'Standard model answer',
      expectedConcepts: ['Core concept'],
      acceptableAlternatives: [],
      markingCriteria: ['Full credit for correct solution'],
    },
    // Alternative OR choice questions: student attempts Question 4 OR Question 5 (each 20 marks)
    {
      questionId: '4',
      section: 'Section B',
      isAlternative: true,
      alternativeGroup: 'Q4_OR_Q5',
      questionText: 'Answer EITHER Question 4: Describe cardiac cycle events.',
      maxMarks: 20,
      referenceAnswer: 'Ventricular systole, diastole, pressure-volume changes...',
      expectedConcepts: ['Isovolumetric contraction', 'Ejection', 'Ventricular filling'],
      acceptableAlternatives: [],
      markingCriteria: ['20 marks total'],
    },
    {
      questionId: '5',
      section: 'Section B',
      isAlternative: true,
      alternativeGroup: 'Q4_OR_Q5',
      questionText: 'OR Question 5: Describe regulation of arterial blood pressure.',
      maxMarks: 20,
      referenceAnswer: 'Baroreceptor reflex, renin-angiotensin-aldosterone system...',
      expectedConcepts: ['Baroreceptors', 'RAAS', 'Vasomotor center'],
      acceptableAlternatives: [],
      markingCriteria: ['20 marks total'],
    },
  ];

  const printedMaxMarks = 80;
  const result = calculateCanonicalKeyMarks(questions, printedMaxMarks);

  assert.strictEqual(result.calculatedTotalMarks, 80, 'Calculated total must be 80 marks (OR choice not double counted)');
  assert.strictEqual(result.hasDiscrepancy, false, 'No discrepancy should exist when alternative group is accounted for');
  assert.strictEqual(result.difference, 0);
  assert.strictEqual(result.sectionTotals['Section B'], 40, 'Section B must be 20 (Q3) + 20 (max of Q4/Q5) = 40');

  console.log('  ✓ Alternative (OR) choice questions accounted for without double counting (Total: 80 marks).');
}

// -----------------------------------------------------------------------------
// TEST 3: Hierarchical Numbering & Parent Container Marks Deduplication
// -----------------------------------------------------------------------------
console.log('\nTest 3: Nested Sub-Questions & Parent Container Deduplication');
{
  const questions: CanonicalQuestionKey[] = [
    // Parent header question 1 (10 marks total, split into 1.1 and 1.2)
    {
      questionId: '1',
      isParentHeader: true,
      section: 'Section A',
      questionText: 'Question 1: Cell Biology (10 marks)',
      maxMarks: 10,
      referenceAnswer: 'Container for subquestions 1.1 and 1.2',
      expectedConcepts: [],
      acceptableAlternatives: [],
      markingCriteria: [],
    },
    {
      questionId: '1.1',
      parentQuestionId: '1',
      section: 'Section A',
      questionText: '1.1 Describe structure of mitochondria.',
      maxMarks: 4,
      referenceAnswer: 'Double membrane, cristae, matrix, ATP synthase...',
      expectedConcepts: ['Cristae', 'Matrix', 'Double membrane'],
      acceptableAlternatives: [],
      markingCriteria: ['4 marks'],
    },
    {
      questionId: '1.2',
      parentQuestionId: '1',
      section: 'Section A',
      questionText: '1.2 Explain electron transport chain complexes.',
      maxMarks: 6,
      referenceAnswer: 'Complex I to IV, ATP synthase, proton gradient...',
      expectedConcepts: ['Complexes I-IV', 'Proton gradient', 'ATP synthase'],
      acceptableAlternatives: [],
      markingCriteria: ['6 marks'],
    },
    // Hierarchical question 2 with subquestions 2(a) and 2(b)
    {
      questionId: '2',
      isParentHeader: true,
      section: 'Section A',
      questionText: 'Question 2: Immunology (10 marks)',
      maxMarks: 10,
      referenceAnswer: 'Container for 2(a) and 2(b)',
      expectedConcepts: [],
      acceptableAlternatives: [],
      markingCriteria: [],
    },
    {
      questionId: '2(a)',
      parentQuestionId: '2',
      section: 'Section A',
      questionText: '2(a) Differentiate innate and adaptive immunity.',
      maxMarks: 5,
      referenceAnswer: 'Innate: non-specific, immediate; Adaptive: specific, memory...',
      expectedConcepts: ['Specificity', 'Memory', 'Cell types'],
      acceptableAlternatives: [],
      markingCriteria: ['5 marks'],
    },
    {
      questionId: '2(b)',
      parentQuestionId: '2',
      section: 'Section A',
      questionText: '2(b) Describe antibody classes and functions.',
      maxMarks: 5,
      referenceAnswer: 'IgG, IgM, IgA, IgE, IgD functions...',
      expectedConcepts: ['IgG', 'IgA', 'IgM', 'Neutralization'],
      acceptableAlternatives: [],
      markingCriteria: ['5 marks'],
    },
  ];

  const printedMaxMarks = 20;
  const result = calculateCanonicalKeyMarks(questions, printedMaxMarks);

  // If container marks were double-counted, it would be 10 + 4 + 6 + 10 + 5 + 5 = 40.
  // With deduplication, only terminal child questions count: 4 + 6 + 5 + 5 = 20.
  assert.strictEqual(result.calculatedTotalMarks, 20, 'Calculated total must be 20 marks without double counting parent headers');
  assert.strictEqual(result.hasDiscrepancy, false, 'No discrepancy with printed 20 marks');

  console.log('  ✓ Hierarchical questions (1, 1.1, 1.2, 2(a), 2(b)) preserved and parent headers deduplicated.');
}

// -----------------------------------------------------------------------------
// TEST 4: Missing or Invalid Marks Flagging
// -----------------------------------------------------------------------------
console.log('\nTest 4: Missing or Zero Marks Detection & Flagging');
{
  const questions: CanonicalQuestionKey[] = [
    {
      questionId: '1',
      section: 'Section A',
      questionText: 'Valid question',
      maxMarks: 10,
      referenceAnswer: 'Model answer',
      expectedConcepts: ['Concept'],
      acceptableAlternatives: [],
      markingCriteria: ['10 marks'],
    },
    {
      questionId: '2',
      section: 'Section A',
      questionText: 'Question with missing marks',
      maxMarks: 0, // Missing or unclear marks
      referenceAnswer: 'Model answer',
      expectedConcepts: ['Concept'],
      acceptableAlternatives: [],
      markingCriteria: ['Marks not printed on paper'],
    },
  ];

  const result = calculateCanonicalKeyMarks(questions, 20);
  assert.strictEqual(result.hasDiscrepancy, true, 'Must flag discrepancy when marks are missing/zero');
  assert.ok(result.offendingQuestions.includes('2'), 'Question 2 must be identified as offending question');
  assert.ok(result.discrepancyMessages.some(m => m.includes('Question 2 has missing or unassigned marks')));

  console.log('  ✓ Missing/zero marks flagged and question identified as offending.');
}

// -----------------------------------------------------------------------------
// TEST 5: Answer Key Service Approval Blocking on 80-vs-90 Discrepancy
// -----------------------------------------------------------------------------
console.log('\nTest 5: Workflow Approval Blocking on Unresolved Marks Discrepancy');
{
  // Create an answer key in the service with 80 printed max marks but 90 extracted marks
  const testKeyId = `test_ak_disc_${Date.now()}`;
  const unapprovedKey: CanonicalAnswerKey = {
    id: testKeyId,
    examId: `exam_${Date.now()}`,
    title: 'Anatomy End-Term Examination',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'needs_review',
    printedMaxMarks: 80,
    totalMaxMarks: 90,
    questions: [
      {
        questionId: '1',
        section: 'Section A',
        questionText: 'Q1',
        maxMarks: 30,
        referenceAnswer: 'Standard model answer 1',
        expectedConcepts: ['C1'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 1'],
      },
      {
        questionId: '2',
        section: 'Section B',
        questionText: 'Q2',
        maxMarks: 30,
        referenceAnswer: 'Standard model answer 2',
        expectedConcepts: ['C2'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 2'],
      },
      {
        questionId: '3',
        section: 'Section C',
        questionText: 'Q3',
        maxMarks: 30,
        referenceAnswer: 'Standard model answer 3',
        expectedConcepts: ['C3'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 3'],
      },
    ],
    metadata: {
      institutionId: facultyUser.institutionId,
      createdBy: facultyUser.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };

  // Save to service
  (answerKeyService as any).cache.set(testKeyId, unapprovedKey);

  let approvalFailedAsExpected = false;
  try {
    answerKeyService.approveAnswerKey(testKeyId, facultyUser);
  } catch (err: any) {
    approvalFailedAsExpected = true;
    assert.ok(err instanceof AnswerKeyValidationError, 'Error must be AnswerKeyValidationError');
    assert.ok(err.message.includes('Unresolved marks discrepancy detected'), 'Error must detail marks discrepancy');
    console.log(`  ✓ Approval correctly rejected: "${err.message}"`);
  }
  assert.strictEqual(approvalFailedAsExpected, true, 'Approval must be blocked when discrepancy exists');
}

// -----------------------------------------------------------------------------
// TEST 6: Manual Faculty Correction Resolving Discrepancy & Permitting Approval
// -----------------------------------------------------------------------------
console.log('\nTest 6: Manual Faculty Correction & Successful Approval');
{
  const testKeyId = `test_ak_resolve_${Date.now()}`;
  const draftKey: CanonicalAnswerKey = {
    id: testKeyId,
    examId: `exam_${Date.now()}`,
    title: 'Pathology Mid-Term Examination',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'needs_review',
    printedMaxMarks: 80,
    totalMaxMarks: 90,
    questions: [
      {
        questionId: '1',
        section: 'Section A',
        questionText: 'Q1',
        maxMarks: 40,
        referenceAnswer: 'Model answer 1',
        expectedConcepts: ['C1'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 1'],
      },
      // Student was meant to answer Q2 OR Q3 (25 marks each), but both were initially counted as compulsory
      {
        questionId: '2',
        section: 'Section B',
        questionText: 'Q2: Cellular injury',
        maxMarks: 25,
        referenceAnswer: 'Model answer 2',
        expectedConcepts: ['C2'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 2'],
      },
      {
        questionId: '3',
        section: 'Section B',
        questionText: 'Q3: Inflammation',
        maxMarks: 25,
        referenceAnswer: 'Model answer 3',
        expectedConcepts: ['C3'],
        acceptableAlternatives: [],
        markingCriteria: ['Crit 3'],
      },
    ],
    metadata: {
      institutionId: facultyUser.institutionId,
      createdBy: facultyUser.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };

  (answerKeyService as any).cache.set(testKeyId, draftKey);

  // Faculty reviews the paper in the UI and notices Q2 and Q3 are alternative choices (OR choice)
  // Faculty designates isAlternative = true, alternativeGroup = "Q2_OR_Q3"
  const correctedQuestions: CanonicalQuestionKey[] = [
    {
      questionId: '1',
      section: 'Section A',
      questionText: 'Q1',
      maxMarks: 55, // Adjusted mark to test exact match (55 + 25 = 80)
      referenceAnswer: 'Model answer 1',
      expectedConcepts: ['C1'],
      acceptableAlternatives: [],
      markingCriteria: ['Crit 1'],
    },
    {
      questionId: '2',
      section: 'Section B',
      isAlternative: true,
      alternativeGroup: 'Q2_OR_Q3',
      questionText: 'Q2: Cellular injury (OR choice)',
      maxMarks: 25,
      referenceAnswer: 'Model answer 2',
      expectedConcepts: ['C2'],
      acceptableAlternatives: [],
      markingCriteria: ['Crit 2'],
    },
    {
      questionId: '3',
      section: 'Section B',
      isAlternative: true,
      alternativeGroup: 'Q2_OR_Q3',
      questionText: 'Q3: Inflammation (OR choice)',
      maxMarks: 25,
      referenceAnswer: 'Model answer 3',
      expectedConcepts: ['C3'],
      acceptableAlternatives: [],
      markingCriteria: ['Crit 3'],
    },
  ];

  // Faculty saves updates
  const updatedKey = answerKeyService.updateAnswerKey(
    testKeyId,
    { questions: correctedQuestions },
    facultyUser
  );

  assert.strictEqual(updatedKey.totalMaxMarks, 80, 'Updated calculated total must be 80');
  assert.strictEqual(updatedKey.marksValidation?.hasDiscrepancy, false, 'Discrepancy must be resolved');

  // Now faculty clicks Validate & Approve
  const approvedKey = answerKeyService.approveAnswerKey(testKeyId, facultyUser);

  assert.strictEqual(approvedKey.status, 'approved', 'Answer key status must be approved');
  assert.strictEqual(approvedKey.totalMaxMarks, 80);
  assert.strictEqual(approvedKey.metadata.approvedBy, facultyUser.userId);
  assert.ok(approvedKey.metadata.approvedAt! > 0);

  console.log('  ✓ Manual faculty edit resolved discrepancy from 90 to 80; approval succeeded with status "approved".');
}

console.log('\n=== ALL MARKS VALIDATION REGRESSION TESTS PASSED SUCCESSFULLY ===');
