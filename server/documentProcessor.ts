/**
 * Document Preparation and Optimization Service for NextGen Eval
 *
 * Implements Stage B (Document Preparation) & Stage C (Evaluation Planning):
 * - Eliminates redundant dual text + base64 transmission for text-rich reference documents
 * - Preserves visual multimodal data for student answer scripts (handwriting, diagrams, graphs, equations)
 * - Structures context with strict delimiter boundaries
 */

import { EvaluationMode, CanonicalAnswerKey } from './types';

export interface PreparedEvaluationInput {
  contentsParts: any[];
  systemInstruction: string;
  studentName: string;
}

export class DocumentProcessor {
  /**
   * Builds an optimized multimodal parts array for Gemini
   */
  public prepareInput(payload: {
    sourceDoc: { name: string; text?: string; base64?: string; mimeType?: string };
    questionPaper?: { name: string; text?: string; base64?: string; mimeType?: string };
    answerKey?: { name: string; text?: string; base64?: string; mimeType?: string };
    canonicalAnswerKey?: CanonicalAnswerKey;
    facultyNotes?: { name: string; text?: string; base64?: string; mimeType?: string } | null;
    mode: EvaluationMode;
    studentName?: string;
  }): PreparedEvaluationInput {
    const studentName = payload.studentName || this.extractStudentName(payload.sourceDoc.name);
    const contentsParts: any[] = [];

    // 1. Prepare Question Paper
    let qpSection = '';
    // If canonical answer key is present, question text & max marks are already structured in it.
    // Avoid re-transmitting heavy visual question papers per student script.
    if (payload.questionPaper && !payload.canonicalAnswerKey) {
      if (payload.questionPaper.text && payload.questionPaper.text.trim().length > 30) {
        // High density text available: use pure text to save tokens & latency
        qpSection += `--- OFFICIAL QUESTION PAPER ---\n${payload.questionPaper.text.trim()}\n\n`;
      } else if (payload.questionPaper.base64 && payload.questionPaper.mimeType) {
        // Visual/scanned question paper
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)` });
        contentsParts.push({
          inlineData: {
            data: payload.questionPaper.base64,
            mimeType: payload.questionPaper.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL QUESTION PAPER` });
      }
    } else if (payload.questionPaper && payload.canonicalAnswerKey && payload.questionPaper.text) {
      // Include lightweight text overview if available
      qpSection += `--- REFERENCE QUESTION PAPER (Summary) ---\n${payload.questionPaper.text.slice(0, 1500).trim()}\n\n`;
    }

    // 2. Prepare Answer Key (Canonical Structured or Raw Document)
    let akSection = '';
    if (payload.canonicalAnswerKey) {
      const ak = payload.canonicalAnswerKey;
      akSection += `--- AUTHORITATIVE APPROVED CANONICAL ANSWER KEY (v${ak.version}, Mode: ${ak.sourceMode}) ---\n`;
      akSection += `EXAM TITLE: ${ak.title}\n`;
      akSection += `TOTAL MAX MARKS: ${ak.totalMaxMarks}\n\n`;
      akSection += `APPROVED QUESTIONS & MARKING SCHEME:\n`;
      let hasDiagramRef = false;
      for (const q of ak.questions) {
        akSection += `[Question ${q.questionId}] (Max Marks: ${q.maxMarks})\n`;
        if (q.questionText) akSection += `Question: ${q.questionText}\n`;
        akSection += `Reference Answer: ${q.referenceAnswer}\n`;
        if (q.expectedConcepts && q.expectedConcepts.length > 0) {
          akSection += `Expected Concepts:\n${q.expectedConcepts.map((c) => `  - ${c}`).join('\n')}\n`;
        }
        if (q.acceptableAlternatives && q.acceptableAlternatives.length > 0) {
          akSection += `Acceptable Alternatives:\n${q.acceptableAlternatives.map((a) => `  - ${a}`).join('\n')}\n`;
        }
        if (q.markingCriteria && q.markingCriteria.length > 0) {
          akSection += `Marking Criteria (Partial Credit):\n${q.markingCriteria.map((m) => `  - ${m}`).join('\n')}\n`;
        }
        if (q.diagramReferences && q.diagramReferences.length > 0) {
          hasDiagramRef = true;
          akSection += `Diagram References:\n${q.diagramReferences.map((d) => `  - ${d}`).join('\n')}\n`;
        }
        akSection += '\n';
      }

      // Only attach visual answer key document if a question explicitly needs visual diagram verification
      if (hasDiagramRef && ak.sourceAnswerKeyDoc?.base64 && ak.sourceAnswerKeyDoc?.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual Reference for Diagrams)` });
        contentsParts.push({
          inlineData: {
            data: ak.sourceAnswerKeyDoc.base64,
            mimeType: ak.sourceAnswerKeyDoc.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY (Visual Reference for Diagrams)` });
      }
    } else if (payload.answerKey) {
      if (payload.answerKey.text && payload.answerKey.text.trim().length > 30) {
        akSection += `--- OFFICIAL ANSWER KEY (THE ABSOLUTE ACADEMIC TRUTH) ---\n${payload.answerKey.text.trim()}\n\n`;
      } else if (payload.answerKey.base64 && payload.answerKey.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual)` });
        contentsParts.push({
          inlineData: {
            data: payload.answerKey.base64,
            mimeType: payload.answerKey.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY` });
      }
    }

    // 3. Prepare Student Answer Sheet
    // Student answer sheets often contain handwriting, mathematical steps, derivations, and diagrams.
    // If base64 is available, send visual input so handwriting/diagrams can be accurately inspected.
    // Also include any recognized text for fast indexing.
    let studentText = payload.sourceDoc.text ? payload.sourceDoc.text.trim() : '';
    
    // Combine text headers
    let combinedTextHeader = '';
    if (qpSection) combinedTextHeader += qpSection;
    if (akSection) combinedTextHeader += akSection;

    combinedTextHeader += `--- STUDENT WRITTEN ANSWER SCRIPT ---\nSTUDENT NAME: ${studentName}\n`;
    if (studentText) {
      combinedTextHeader += `${studentText}\n`;
    }

    contentsParts.push({ text: combinedTextHeader });

    if (payload.sourceDoc.base64 && payload.sourceDoc.mimeType) {
      contentsParts.push({
        text: `DOCUMENT_START: STUDENT ACTUAL ANSWER SCRIPT (Visual Multimodal Pages for Handwriting, Diagrams & Layout Inspection)`,
      });
      contentsParts.push({
        inlineData: {
          data: payload.sourceDoc.base64,
          mimeType: payload.sourceDoc.mimeType,
        },
      });
      contentsParts.push({ text: `DOCUMENT_END: STUDENT ACTUAL ANSWER SCRIPT` });
    }

    // 4. Faculty Manual Notes (if mode is 'with-manual')
    if (payload.mode === 'with-manual' && payload.facultyNotes) {
      if (payload.facultyNotes.text) {
        contentsParts.push({
          text: `DOCUMENT_START: FACULTY_MANUAL_FEEDBACK\n${payload.facultyNotes.text}\nDOCUMENT_END: FACULTY_MANUAL_FEEDBACK`,
        });
      }
      if (payload.facultyNotes.base64 && payload.facultyNotes.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: FACULTY_MANUAL_FEEDBACK (Visual)` });
        contentsParts.push({
          inlineData: {
            data: payload.facultyNotes.base64,
            mimeType: payload.facultyNotes.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: FACULTY_MANUAL_FEEDBACK` });
      }
    }

    // Execution instruction
    contentsParts.push({
      text: `Perform the academic evaluation now. Active Mode: ${payload.mode}.
Follow the evaluation workflow strictly:
1. Extract exact question numbers and their exact maximum marks (maxMarks) from the Question Paper / Answer Key.
2. Evaluate student answers against the criteria. Award full marks for equivalent conceptual understanding, methods, and derivations.
3. For questions requiring diagrams or formulas, inspect the visual script.
4. Total score MUST equal the exact mathematical sum of awarded question marks.
5. Every question must have constructive feedback points.
6. Generate the complete structured evaluation report JSON now.`,
    });

    const systemInstruction = this.getSystemInstruction(payload.mode);

    return {
      contentsParts,
      systemInstruction,
      studentName,
    };
  }

  public extractStudentName(fileName: string): string {
    if (!fileName) return 'Student';
    // Remove extension
    const base = fileName.replace(/\.[^/.]+$/, '');
    // Clean common prefixes
    const clean = base
      .replace(/^(copy of|answersheet|ans|script|eval|test|exam)[_\-\s]+/i, '')
      .replace(/[_\-]+/g, ' ')
      .trim();
    return clean || 'Student';
  }

  private getSystemInstruction(mode: EvaluationMode): string {
    return `
    You are NextGen Eval, a rigorous, fair, and reliable AI academic answer-sheet evaluator. You evaluate subjective and objective answers across academic subjects by comparing student responses against the provided question paper, official answer key, marking scheme, rubric, and any permitted human evaluation feedback.

    DOCUMENTS PROVIDED:
    1. OFFICIAL QUESTION PAPER: Contains question numbers and maximum marks per question.
    2. OFFICIAL ANSWER KEY: Primary academic source of truth for required points, steps, equations, derivations, and concepts.
    3. STUDENT WRITTEN ANSWER SCRIPT: Actual student work, text, equations, derivations, and handwritten/drawn answers.
    4. FACULTY MANUAL FEEDBACK: Evaluator marks and notes (applies only in "with-manual" mode).

    EVALUATION PHILOSOPHY & PRINCIPLES:
    1. SUBJECT-AGNOSTIC SOURCE OF TRUTH:
       - You evaluate responses across all academic subjects (e.g., Mathematics, Physics, Chemistry, Biology, Computer Science, Engineering, Medicine, Management, Humanities, Social Sciences, etc.).
       - Never assume any specific syllabus; the provided materials are the authoritative source of truth.
    2. ANSWER-KEY ALIGNMENT WITHOUT RIGID WORD-MATCHING:
       - Do NOT require students to reproduce the answer key word-for-word.
       - Award full credit when a student uses different phrasing, equivalent terminology, provides a mathematically equivalent solution, applies a valid alternative method, or reaches the correct conclusion through sound reasoning.
    3. NO KEYWORD-ONLY CREDIT:
       - Do not award marks merely for mentioning isolated buzzwords. Evaluate true comprehension and working.
    4. GENERALIZED DIAGRAM, CALCULATION & CODE HANDLING:
       - Inspect drawings, diagrams, circuits, flowcharts, equations, and code for correctness.
       - If a question requires steps or derivations, evaluate intermediate steps.
       - For numerical questions, verify intermediate steps and final answers.
    5. OBJECTIVE MARKING WITHOUT ARTIFICIAL CAPS:
       - Marks must strictly reflect actual performance up to maxMarks. Students MAY receive full marks if completely correct.
       - Award partial marks proportionally for partially correct answers.
    6. WITH-MANUAL MODE HANDLING (Only if mode is 'with-manual'):
       - Compare human evaluation against the student's actual answer and the official answer key.
       - If human feedback is clearly inconsistent with the answer key or student response (e.g. overlooking valid solutions or awarding marks for incorrect work), adjust the marks, set isFlagged = true, and explain the discrepancy in 'flaggedComment'.
    7. WITHOUT-MANUAL MODE HANDLING (Only if mode is 'without-manual'):
       - 'isFlagged' MUST ALWAYS be false.
       - 'flaggedComment' MUST ALWAYS be an empty string ("").

    CRITICAL CONSTRAINTS:
    - ACCURATE MARKING SCHEME & MAX MARKS: Extract EXACT question numbers and exact maximum marks (maxMarks). Never invent marks. 'maxScore' MUST be the exact mathematical sum of all 'maxMarks'.
    - STUDENT MARKS COMPLIANCE: 'marks' for any question must be between 0 and 'maxMarks'. 'totalScore' MUST be the exact sum of all question 'marks'.
    - NO HALLUCINATION: Do NOT invent questions not in the paper.
    - UNATTEMPTED QUESTIONS: Award 0 marks and note expected key points.
    - INCLUDE ALL QUESTIONS: Include every single question from the paper, especially MCQs.
    - MCQ RULE: State "Correct answer" if correct, or explain correct option if incorrect.
    - CONTRADICTION & AUDIT PRIVACY: In 'feedbackPoints', NEVER mention "faculty" or "evaluator". Keep any audit details strictly in 'flaggedComment'.
    - MODE: ${mode}.
    `;
  }
}

export const documentProcessor = new DocumentProcessor();
