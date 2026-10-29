"""Academic Evaluation Engine with Strict Schema and Bound Validation for Python Backend."""

from typing import Dict, Any, List
import time
from .models import EvaluationReport, QuestionFeedback, GeneralFeedbackSection
from .config import settings


class AcademicValidationError(ValueError):
    """Raised when academic score validation, bounds, or question rules fail."""
    pass


class EvaluationEngine:
    def validate_and_normalize(self, raw: Dict[str, Any], mode: str, student_name: str) -> EvaluationReport:
        if not raw or not isinstance(raw, dict):
            raise AcademicValidationError("Malformed report: Expected structured dictionary.")

        name = (raw.get("studentName") or student_name or "Student").strip()
        title = (raw.get("testTitle") or "Academic Assessment").strip()
        topics = (raw.get("testTopics") or "General Assessment Syllabus").strip()
        date = (raw.get("testDate") or time.strftime("%Y-%m-%d")).strip()

        questions_raw = raw.get("questions")
        if not isinstance(questions_raw, list) or len(questions_raw) == 0:
            raise AcademicValidationError("Evaluation validation failed: No evaluated questions array in report.")

        seen_qnos = set()
        calculated_total = 0.0
        calculated_max = 0.0
        validated_questions: List[QuestionFeedback] = []

        for idx, q in enumerate(questions_raw):
            if not isinstance(q, dict):
                raise AcademicValidationError(f"Question at index {idx} is malformed.")

            q_no = str(q.get("qNo") or "").strip()
            if not q_no:
                raise AcademicValidationError(f"Question at index {idx} has an empty question number.")

            if q_no in seen_qnos:
                raise AcademicValidationError(f"Duplicate question ID detected: Question '{q_no}' appears multiple times.")
            seen_qnos.add(q_no)

            # Strict maxMarks validation (never default to 1.0)
            raw_max = q.get("maxMarks")
            if not isinstance(raw_max, (int, float)) or raw_max <= 0:
                raise AcademicValidationError(f"Invalid maximum marks on Question {q_no}: received {raw_max}.")
            max_m = round(float(raw_max), 2)

            # Strict marks validation (never clamp to maxMarks)
            raw_marks = q.get("marks")
            if not isinstance(raw_marks, (int, float)) or raw_marks < 0:
                raise AcademicValidationError(f"Invalid marks awarded on Question {q_no}: received {raw_marks}.")
            m = round(float(raw_marks), 2)

            if m > max_m:
                raise AcademicValidationError(
                    f"Score bound violation on Question {q_no}: Awarded marks ({m}) exceed maximum marks ({max_m})."
                )

            pts_raw = q.get("feedbackPoints")
            if not isinstance(pts_raw, list) or len(pts_raw) == 0:
                raise AcademicValidationError(f"Question {q_no} is missing required feedbackPoints.")
            pts = [str(p).strip() for p in pts_raw if str(p).strip()]
            if not pts:
                raise AcademicValidationError(f"Question {q_no} has empty feedbackPoints.")

            is_flagged = bool(q.get("isFlagged", False)) if mode == "with-manual" else False
            flagged_comment = (str(q.get("flaggedComment")).strip() if q.get("flaggedComment") else None) if is_flagged else None

            calculated_total += m
            calculated_max += max_m

            validated_questions.append(
                QuestionFeedback(
                    qNo=q_no,
                    feedbackPoints=pts,
                    marks=m,
                    maxMarks=max_m,
                    isCorrect=m >= max_m,
                    isFlagged=is_flagged,
                    flaggedComment=flagged_comment,
                )
            )

        rounded_total = round(calculated_total, 2)
        rounded_max = round(calculated_max, 2)

        # Mathematical sum consistency verification
        if "totalScore" in raw and isinstance(raw["totalScore"], (int, float)):
            diff = abs(float(raw["totalScore"]) - rounded_total)
            if diff > 0.05:
                raise AcademicValidationError(
                    f"Score sum discrepancy: Model reported totalScore={raw['totalScore']}, but question sum is {rounded_total}."
                )

        if "maxScore" in raw and isinstance(raw["maxScore"], (int, float)):
            diff = abs(float(raw["maxScore"]) - rounded_max)
            if diff > 0.05:
                raise AcademicValidationError(
                    f"Max score sum discrepancy: Model reported maxScore={raw['maxScore']}, but question sum is {rounded_max}."
                )

        gf = raw.get("generalFeedback") or {}
        general_feedback = GeneralFeedbackSection(
            overallPerformance=gf.get("overallPerformance") or ["Completed evaluation assessment."],
            mcqs=gf.get("mcqs") or ["Objective questions evaluated."],
            contentAccuracy=gf.get("contentAccuracy") or ["Subject concepts evaluated against official key."],
            completenessOfAnswers=gf.get("completenessOfAnswers") or ["Answer depth reviewed."],
            presentationDiagrams=gf.get("presentationDiagrams") or ["Formatting and structure reviewed."],
            investigations=gf.get("investigations") or ["Methodology steps reviewed."],
            attemptingQuestions=gf.get("attemptingQuestions") or ["Question attempts reviewed."],
            actionPoints=gf.get("actionPoints") or ["Review points for continuous improvement."],
        )

        return EvaluationReport(
            studentName=name,
            testTitle=title,
            testTopics=topics,
            testDate=date,
            totalScore=rounded_total,
            maxScore=rounded_max,
            questions=validated_questions,
            generalFeedback=general_feedback,
            evaluatedByModel=raw.get("evaluatedByModel", settings.PRIMARY_MODEL),
            timestamp=int(time.time() * 1000),
        )


evaluation_engine = EvaluationEngine()
