import { GoogleGenAI, Type } from "@google/genai";
import { EvaluationReport, FileData } from "../types";

export type EvaluationMode = 'with-manual' | 'without-manual';

const computeCacheKey = (
  sourceDoc: FileData,
  dirtyFeedbackDoc: FileData | null,
  mode: EvaluationMode
): string => {
  const parts = [
    sourceDoc.name || "",
    sourceDoc.text || "",
    sourceDoc.base64 ? `${sourceDoc.base64.length}_${sourceDoc.base64.substring(0, 200)}` : "",
    dirtyFeedbackDoc?.name || "",
    dirtyFeedbackDoc?.text || "",
    dirtyFeedbackDoc?.base64 ? `${dirtyFeedbackDoc.base64.length}_${dirtyFeedbackDoc.base64.substring(0, 200)}` : "",
    mode
  ];
  const str = parts.join("|||");
  
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `nextgen_eval_v3_${hash}`;
};

export const generateStructuredFeedback = async (
  sourceDoc: FileData,
  dirtyFeedbackDoc: FileData | null,
  mode: EvaluationMode = 'with-manual'
): Promise<EvaluationReport> => {
  const cacheKey = computeCacheKey(sourceDoc, dirtyFeedbackDoc, mode);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      console.log("Loading evaluation report from local cache to save API credits...");
      return JSON.parse(cached) as EvaluationReport;
    }
  } catch (e) {
    console.warn("Failed to read from cache:", e);
  }

  let apiKey = '';
  try {
    apiKey = localStorage.getItem('nextgen_eval_custom_api_key') || '';
  } catch (e) {
    console.warn("localStorage read failed:", e);
  }
  
  if (!apiKey) {
    apiKey = (process.env.API_KEY || process.env.GEMINI_API_KEY || '') as string;
  }
  
  if (!apiKey) {
    throw new Error("NextGen Eval Configuration Error: Gemini API Key is missing. Please ensure GEMINI_API_KEY is configured in the environment or in Settings (refer to Settings page or top toolbar).");
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction = `
    You are NextGen Eval, a rigorous, fair, and reliable AI academic answer-sheet evaluator. You evaluate subjective and objective answers across academic subjects by comparing student responses against the provided question paper, official answer key, marking scheme, rubric, and any permitted human evaluation feedback.

    DOCUMENTS PROVIDED:
    1. STUDENT_ANSWER_SCRIPT_AND_KEY: Contains the Question Paper, the official Answer Key (primary academic source of truth), marking scheme/rubric (if provided), and the Student's actual written answers.
    2. FACULTY_MANUAL_FEEDBACK: Contains marks and comments from a human evaluator pointing out missing elements or errors (applies only in "with-manual" mode).

    EVALUATION PHILOSOPHY & PRINCIPLES:
    1. SUBJECT-AGNOSTIC SOURCE OF TRUTH:
       - You evaluate responses across all academic subjects (e.g., Mathematics, Physics, Chemistry, Biology, Computer Science, Data Science, Engineering, Medicine, Management, Commerce, Humanities, Social Sciences, school, university, and competitive examinations).
       - Never assume any specific subject or standard syllabus.
       - The provided question paper, answer key, and marking scheme constitute the authoritative source of truth.
    2. ANSWER-KEY ALIGNMENT WITHOUT RIGID WORD-MATCHING:
       - The official answer key is the primary academic reference.
       - Do NOT require students to reproduce the answer key word-for-word.
       - Award full credit when a student's answer uses different phrasing, equivalent terminology, demonstrates the same concept, provides a mathematically equivalent solution, applies a valid alternative method, or reaches the correct conclusion through sound reasoning.
       - Do not penalize an answer merely because it does not match the exact wording of the key.
    3. NO KEYWORD-ONLY CREDIT:
       - A student must not receive substantial marks merely for mentioning isolated keywords or echoing terminology from the prompt.
       - Evaluate whether the student actually demonstrates comprehension, reasoning, explanation, calculation, derivation, application, evidence, or conclusion as required by the question.
    4. GENERALIZED DIAGRAM, CALCULATION & CODE HANDLING:
       - If a question requires or strongly expects a diagram, graph, circuit, flowchart, equation, derivation, calculation, proof, algorithm, code, table, labelled illustration, or structured explanation according to the question or answer key, evaluate it for correctness and completeness.
       - If a diagram is optional and the student correctly explains the required concept without it, do not automatically deduct marks.
       - For mathematical/numerical questions: verify the method, intermediate steps and reasoning when visible, calculations, units where relevant, and the final answer.
       - For programming/computer science questions: evaluate logic, correctness, algorithm, code where provided, and explanations.
       - For descriptive/theoretical questions: evaluate completeness, accuracy, relevance, reasoning, and required supporting details.
    5. OBJECTIVE MARKING WITHOUT ARTIFICIAL CAPS:
       - Marks must be determined according to the actual maximum marks (maxMarks), the marking scheme/rubric, and the completeness and correctness of the student's answer.
       - A student MAY receive full marks when the answer genuinely satisfies all requirements of the question and marking criteria.
       - Do not artificially suppress scores or enforce arbitrary mark caps. Award proportional partial marks for partially correct answers based on the missing components.
    6. WITH-MANUAL MODE HANDLING (Only if mode is 'with-manual'):
       - Use the human evaluation as additional evidence alongside the student script and official answer key.
       - Compare the human evaluation against the student's actual answer and the official answer key.
       - Identify genuine discrepancies: if human feedback is clearly inconsistent with the answer key or student response (e.g. awarding marks for incorrect answers or overlooking valid solutions), adjust the marks, set isFlagged = true, and explain the discrepancy in 'flaggedComment'.
       - Do not blindly trust or blindly override the human evaluator; ground the final decision in student evidence and official academic materials.
    7. WITHOUT-MANUAL MODE HANDLING (Only if mode is 'without-manual'):
       - 'isFlagged' MUST ALWAYS be false.
       - 'flaggedComment' MUST ALWAYS be an empty string ("").
       - Do not hallucinate human feedback or grading contradictions when none are provided.

    STRICT WORKFLOW (Follow for EVERY question in the paper):
    1. MODE CHECK: Note the active mode ('with-manual' or 'without-manual').
    2. EXTRACT DETAILS: Read the official Question Paper and Answer Key to extract the exact question number (qNo) and exact maximum marks (maxMarks).
    3. INSPECT STUDENT WORK: Look at the student's actual physical response in STUDENT_ANSWER_SCRIPT_AND_KEY. Only evaluate what is physically present.
    4. EVALUATE AGAINST ANSWER KEY: Compare the student's response against the required points, steps, concepts, or criteria in the Answer Key and rubric.
    5. AUDIT HUMAN FEEDBACK (Only if mode is 'with-manual'): Check the human evaluator's marks and comments against student evidence and the answer key. If a meaningful contradiction is found, set isFlagged = true, adjust marks, and record the explanation in flaggedComment.
    6. FORMULATE FEEDBACK: Write concise, academically useful feedback points reflecting the student's actual response.

    CRITICAL CONSTRAINTS:
    - ACCURATE MARKING SCHEME & MAX MARKS: You MUST thoroughly read the provided Question Paper and Answer Key to extract the EXACT question numbers (e.g., "1", "2a", "MCQ-1", etc.) and their EXACT maximum marks (maxMarks). Never guess, invent, or hardcode maximum marks. The 'maxScore' of the entire test MUST be the exact mathematical sum of these extracted maxMarks.
    - STUDENT MARKS COMPLIANCE: The student score 'marks' assigned for any question must strictly be between 0 and that question's 'maxMarks' (marks <= maxMarks). Student marks must never exceed maximum marks. The 'totalScore' field MUST be the exact mathematical sum of all 'marks' in the 'questions' array.
    - NO HALLUCINATION: Do NOT invent questions, answers, student work, or marking criteria not present in the supplied documents. Do NOT mark a question as unattempted if there is any evidence of an attempt.
    - UNATTEMPTED QUESTIONS: For genuinely unattempted questions, award 0 marks and provide one or two concise points outlining what was expected based on the answer key.
    - INCLUDE ALL QUESTIONS: You MUST include every single question from the paper in the 'questions' array. Do NOT skip any question, whether attempted, partially attempted, or unattempted.
    - MCQ SPECIFIC RULE: For Multiple Choice Questions (MCQs), you MUST include every single one. If correct, provide feedback such as "Correct answer". If incorrect, specify the correct option according to the official answer key. Never leave 'feedbackPoints' empty.
    - NO EMPTY FIELDS: Every question entry must have at least one descriptive point in 'feedbackPoints'.
    - FEEDBACK POINTS STYLE: Feedback must be direct, professional, concise, and academically constructive (e.g., "Correct final answer, but intermediate derivation steps were omitted.", "Method is correct, but calculation contains an arithmetic error.", "Defines the concept correctly but does not explain its application as required."). Avoid generic statements like "Needs improvement." State specifically what is present or missing.
    - CONTRADICTION & AUDIT PRIVACY:
      - In 'feedbackPoints', NEVER mention "faculty", "evaluator", or grading disputes. Feedback points are student-facing.
      - Any audit details or discrepancy explanations MUST be restricted strictly to the 'flaggedComment' field when isFlagged is true.
      - If mode is 'without-manual', isFlagged must be false and flaggedComment must be an empty string ("").
    - GENERAL FEEDBACK GUIDELINES:
      - The 'generalFeedback' object is student-facing. It MUST NOT contain any mention of contradictions, human evaluator errors, or internal audit adjustments.
      - Field definitions:
        * overallPerformance: High-level summary of the student's performance across the entire test.
        * mcqs: Evaluation of objective/MCQ performance and conceptual recognition.
        * contentAccuracy: Correctness and accuracy of subject knowledge, facts, formulas, principles, or theories.
        * completenessOfAnswers: Completeness and coverage of required points, sub-questions, and steps.
        * presentationDiagrams: Presentation, diagrams, graphs, calculations, structure, or formatting where applicable.
        * investigations: Reasoning, methodology, working steps, derivations, or supporting evidence where applicable.
        * attemptingQuestions: Assessment of question-attempt strategy, coverage, and time management.
        * actionPoints: Prioritized, actionable recommendations for student improvement.
    - TYPOGRAPHY: Use **bold** sparingly and ONLY for essential academic terms, key formula names, or core concepts.
    - MODE: ${mode}.

    OUTPUT: Strictly valid JSON only matching the schema.
  `;

  const createPart = (data: FileData | null, label: string) => {
    if (!data) return [{ text: `${label}: Not provided.` }];
    const parts: any[] = [];
    if (data.text) {
      parts.push({ text: `DOCUMENT_START: ${label}\n${data.text}\nDOCUMENT_END: ${label}` });
    }
    if (data.base64 && data.mimeType) {
      parts.push({ text: `DOCUMENT_START: ${label} (Visual/Image Data)` });
      parts.push({ inlineData: { data: data.base64, mimeType: data.mimeType } });
      parts.push({ text: `DOCUMENT_END: ${label}` });
    }
    if (parts.length === 0) {
      return [{ text: `${label}: No usable content found.` }];
    }
    return parts;
  };

  const contentsParts: any[] = [...createPart(sourceDoc, "STUDENT_ANSWER_SCRIPT_AND_KEY")];
  if (mode === 'with-manual' && dirtyFeedbackDoc) {
    contentsParts.push(...createPart(dirtyFeedbackDoc, "FACULTY_MANUAL_FEEDBACK"));
  }
  
  contentsParts.push({ text: `Perform the academic evaluation now. Current mode is: ${mode}. Follow the evaluation workflow. IMPORTANT: INCLUDE ALL QUESTIONS from the paper, especially MCQs. If an MCQ is correct, state 'Correct answer'. Do NOT skip any question. Do NOT mark a question as unattempted if there is any evidence of an attempt. If mode is 'without-manual', ensure isFlagged is false for all questions and flaggedComment is empty. Keep any evaluator contradiction details in 'flaggedComment' only. EXTRACT EXACT MAXIMUM MARKS from the provided Question Paper. Do NOT hallucinate questions, answers, or marks. Student marks for any question must strictly correspond to the criteria, never exceed maxMarks, and totalScore must equal the exact sum of question marks. Generate the JSON report now.` });

  // Candidate models prioritized by reasoning capability, evaluation reliability, and active production availability:
  // 1. gemini-3.7-flash: Flagship reasoning model (deep conceptual comprehension & precision)
  // 2. gemini-3.6-flash: High-precision reasoning fallback
  // 3. gemini-2.5-flash: Fast and reliable analysis model
  // 4. gemini-flash-latest: Stable production Flash fallback
  const candidateModels = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest'
  ];

  let lastError: any = null;
  let lastAttemptedModel = candidateModels[0];
  const MAX_RETRIES_PER_MODEL = 2; // Up to 2 exponential-backoff retries for transient 503/500/429 errors per model

  const isRetryableError = (error: any): boolean => {
    const status = error?.status || error?.code || error?.statusCode;
    const msg = String(error?.message || error || '').toLowerCase();
    if (status === 503 || status === 500 || status === 429 || status === 408) return true;
    if (msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable')) return true;
    if (msg.includes('500') || msg.includes('internal error')) return true;
    if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('quota')) return true;
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network error') || msg.includes('fetch failed')) return true;
    return false;
  };

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const modelName of candidateModels) {
    lastAttemptedModel = modelName;
    
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 5000);
          console.warn(`[NextGen Eval] Retry attempt ${attempt}/${MAX_RETRIES_PER_MODEL} for model ${modelName} after ${Math.round(backoffDelay)}ms backoff...`);
          await delay(backoffDelay);
        } else {
          console.log(`[NextGen Eval] Attempting evaluation using model: ${modelName}`);
        }

        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ parts: contentsParts }],
          config: {
            systemInstruction,
            temperature: 0,
            seed: 42,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                studentName: { type: Type.STRING },
                testTitle: { type: Type.STRING },
                testTopics: { type: Type.STRING },
                testDate: { type: Type.STRING },
                totalScore: { type: Type.NUMBER },
                maxScore: { type: Type.NUMBER },
                questions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      qNo: { type: Type.STRING },
                      feedbackPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                      marks: { type: Type.NUMBER },
                      maxMarks: { type: Type.NUMBER },
                      isCorrect: { type: Type.BOOLEAN },
                      isFlagged: { type: Type.BOOLEAN },
                      flaggedComment: { type: Type.STRING, description: "If isFlagged is true, provide a brief explanation of the discrepancy or contradiction resolved." }
                    },
                    required: ["qNo", "feedbackPoints", "marks", "maxMarks", "isCorrect"]
                  }
                },
                generalFeedback: {
                  type: Type.OBJECT,
                  properties: {
                    overallPerformance: { type: Type.ARRAY, items: { type: Type.STRING } },
                    mcqs: { type: Type.ARRAY, items: { type: Type.STRING } },
                    contentAccuracy: { type: Type.ARRAY, items: { type: Type.STRING } },
                    completenessOfAnswers: { type: Type.ARRAY, items: { type: Type.STRING } },
                    presentationDiagrams: { type: Type.ARRAY, items: { type: Type.STRING } },
                    investigations: { type: Type.ARRAY, items: { type: Type.STRING } },
                    attemptingQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
                    actionPoints: { type: Type.ARRAY, items: { type: Type.STRING } }
                  },
                  required: ["overallPerformance", "mcqs", "contentAccuracy", "completenessOfAnswers", "presentationDiagrams", "investigations", "attemptingQuestions", "actionPoints"]
                }
              },
              required: ["studentName", "testTitle", "testTopics", "testDate", "totalScore", "maxScore", "questions", "generalFeedback"]
            }
          }
        });

        const text = response.text;
        if (!text) {
          throw new Error(`Evaluation failed: Empty response received from model ${modelName}.`);
        }
        const parsed = JSON.parse(text) as EvaluationReport;
        parsed.evaluatedByModel = modelName;
        
        try {
          localStorage.setItem(cacheKey, JSON.stringify(parsed));
        } catch (e: any) {
          if (e.name === 'QuotaExceededError' || e.code === 22) {
            console.warn("localStorage full. Clearing old evaluation caches...");
            try {
              const keysToRemove: string[] = [];
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('nextgen_eval_') || key.startsWith('nextgen_eval_v3_'))) {
                  keysToRemove.push(key);
                }
              }
              keysToRemove.forEach(k => localStorage.removeItem(k));
              localStorage.setItem(cacheKey, JSON.stringify(parsed));
            } catch (retryErr) {
              console.warn("Failed to cache after clear:", retryErr);
            }
          } else {
            console.warn("Failed to write to cache:", e);
          }
        }
        return parsed;
      } catch (error: any) {
        lastError = error;
        const retryable = isRetryableError(error);
        console.warn(`Evaluation attempt on model ${modelName} (attempt ${attempt + 1}/${MAX_RETRIES_PER_MODEL + 1}) failed. Retryable: ${retryable}`, error);

        if (!retryable || attempt === MAX_RETRIES_PER_MODEL) {
          // Break retry loop for this model and advance to next candidate model
          break;
        }
      }
    }
  }

  console.error("Gemini API All Models Failed:", lastError);
  let errorMsg = lastError?.message || `Evaluation failed across all candidate models (Last attempted: ${lastAttemptedModel}).`;
  try {
    const parsedErr = JSON.parse(errorMsg);
    if (parsedErr?.error?.message) {
      errorMsg = parsedErr.error.message;
    }
  } catch (_) {
    // not JSON
  }
  
  const errorObj = new Error(errorMsg);
  (errorObj as any).lastAttemptedModel = lastAttemptedModel;
  (errorObj as any).rawError = lastError;
  (errorObj as any).statusCode = lastError?.status || lastError?.code || (lastError?.message?.includes('503') ? 503 : (lastError?.message?.includes('429') ? 429 : undefined));
  throw errorObj;
};

export const parseActionableError = (err: any): { category: string; message: string; statusCode?: number; raw: any } => {
  let statusCode: number | undefined = err?.statusCode || err?.status || err?.code;
  let rawMsg = '';

  if (typeof err === 'string') {
    rawMsg = err;
  } else if (err instanceof Error) {
    rawMsg = err.message || err.toString();
  } else if (err && typeof err === 'object') {
    // 1. Check if error is a DOM Event (e.g. ProgressEvent from FileReader, ErrorEvent, WebSocket, Image, Worker)
    const isDomEvent = ('isTrusted' in err) || (typeof Event !== 'undefined' && err instanceof Event);
    if (isDomEvent) {
      const target = (err as any).target;
      const targetError = target?.error;
      const eventError = (err as any).error;
      const eventReason = (err as any).reason;

      if (targetError) {
        rawMsg = targetError.message || targetError.name || String(targetError);
      } else if (eventError) {
        rawMsg = eventError instanceof Error ? eventError.message : String(eventError);
      } else if (eventReason) {
        rawMsg = eventReason instanceof Error ? eventReason.message : String(eventReason);
      } else {
        const evType = (err as any).type || 'browser';
        rawMsg = `Browser ${evType} stream interrupted. The file descriptor or network stream could not be accessed.`;
      }
    } else if (err.message) {
      rawMsg = String(err.message);
    } else if (err.error?.message) {
      rawMsg = String(err.error.message);
    } else if (err.statusText) {
      rawMsg = String(err.statusText);
    } else {
      try {
        const serialized = JSON.stringify(err);
        if (serialized === '{"isTrusted":true}' || serialized === '{"isTrusted":false}' || serialized === '{}') {
          rawMsg = 'Local file or network connection stream was interrupted by browser sandbox.';
        } else {
          rawMsg = serialized;
        }
      } catch (_) {
        rawMsg = String(err);
      }
    }
  }

  // Attempt unpacking nested JSON error
  try {
    const parsed = JSON.parse(rawMsg);
    if (parsed?.error?.message) {
      rawMsg = parsed.error.message;
      if (parsed.error.code) statusCode = parsed.error.code;
    }
  } catch (_) {}

  // Extra safety scrubber: NEVER allow literal {"isTrusted":true} or empty strings into the UI
  if (!rawMsg || rawMsg.trim() === '{"isTrusted":true}' || rawMsg.trim() === '{"isTrusted":false}' || rawMsg.trim() === '{}') {
    rawMsg = 'The local document stream could not be read (file handle may have expired or tab was idle). Click Retry to reload.';
  }

  // Determine category and actionable user explanation
  let category = 'Academic Evaluation Error';
  if (statusCode === 429 || /quota|rate limit|resource_exhausted/i.test(rawMsg)) {
    category = 'API Quota / Rate Limit Exceeded';
    rawMsg = 'Gemini API rate limit or quota exceeded. Please wait a moment or verify your API key in Settings.';
  } else if (statusCode === 503 || /high demand|unavailable|503/i.test(rawMsg)) {
    category = 'Gemini Server Temporarily Busy (503)';
    rawMsg = 'Google Gemini service is temporarily experiencing high traffic. Click "Retry" to process this script again.';
  } else if (statusCode === 401 || statusCode === 403 || /api key|unauthorized|permission/i.test(rawMsg)) {
    category = 'API Authentication Error';
    rawMsg = 'Gemini API Key is invalid or missing permissions. Please update your API key in Settings.';
  } else if (/notreadableerror|notfounderror|filereader|file read failure|file descriptor|stream interrupted/i.test(rawMsg)) {
    category = 'Document File Access Error';
    rawMsg = `Local file access issue: ${rawMsg}. Click "Retry" to re-read the file.`;
  } else if (/capture target|html2canvas|canvas|jspdf|render/i.test(rawMsg)) {
    category = 'PDF Generation Error';
  } else if (/pdf|docx|mammoth/i.test(rawMsg)) {
    category = 'Document Extraction Error';
  }

  return {
    category,
    message: rawMsg || 'An unknown error occurred during evaluation pipeline.',
    statusCode,
    raw: err
  };
};
