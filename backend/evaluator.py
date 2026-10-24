"""Academic Evaluation Engine with Schema Validation and Score Verification."""

from typing import Dict, Any, Tuple
import json
import time
from .models import EvaluationReport, QuestionFeedback, GeneralFeedbackSection, JobMetrics
from .config import settings
from .cache import evaluation_cache


class EvaluationEngine:
    def validate_and_normalize(self, raw: Dict[str, Any], mode: str, student_name: str) -> EvaluationReport:
        name = (raw.get("studentName") or student_name or "Student").strip()
        title = (raw.get("testTitle") or "Academic Assessment").strip()
        topics = (raw.get("testTopics") or "General Assessment Syllabus").strip()
        date = (raw.get("testDate") or time.strftime("%Y-%m-%d")).strip()

        questions_raw = raw.get("questions") or []
        if not questions_raw:
            raise ValueError("No questions found in evaluation report.")

        calculated_total = 0.0
        calculated_max = 0.0
        validated_questions = []

        for idx, q in enumerate(questions_raw):
            q_no = str(q.get("qNo") or (idx + 1)).strip()
            try:
                max_m = float(q.get("maxMarks", 1.0))
            except (ValueError, TypeError):
                max_m = 1.0
            if max_m <= 0:
                max_m = 1.0

            try:
                m = float(q.get("marks", 0.0))
            except (ValueError, TypeError):
                m = 0.0
            if m < 0:
                m = 0.0
            if m > max_m:
                m = max_m

            pts = [str(p).strip() for p in (q.get("feedbackPoints") or []) if str(p).strip()]
            if not pts:
                pts = ["Correct and complete answer."] if m >= max_m else ["Incomplete response according to marking scheme."]

            is_flagged = bool(q.get("isFlagged", False)) if mode == "with-manual" else False
            flagged_comment = (q.get("flaggedComment") or None) if is_flagged else None

            calculated_total += m
            calculated_max += max_m

            validated_questions.append(
                QuestionFeedback(
                    qNo=q_no,
                    feedbackPoints=pts,
                    marks=round(m, 2),
                    maxMarks=round(max_m, 2),
                    isCorrect=m >= max_m,
                    isFlagged=is_flagged,
                    flaggedComment=flagged_comment,
                )
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
            totalScore=round(calculated_total, 2),
            maxScore=round(calculated_max, 2),
            questions=validated_questions,
            generalFeedback=general_feedback,
            evaluatedByModel=raw.get("evaluatedByModel", settings.PRIMARY_MODEL),
            timestamp=int(time.time() * 1000),
        )


evaluation_engine = EvaluationEngine()
