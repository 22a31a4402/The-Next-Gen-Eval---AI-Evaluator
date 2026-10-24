"""Pydantic data schemas for NextGen Eval."""

from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field

JobStatus = Literal[
    "queued",
    "preprocessing",
    "grading",
    "validating",
    "assembling_report",
    "completed",
    "failed",
    "needs_review",
]
EvaluationMode = Literal["with-manual", "without-manual"]


class QuestionFeedback(BaseModel):
    qNo: str
    feedbackPoints: List[str]
    marks: float
    maxMarks: float
    isCorrect: bool
    isFlagged: Optional[bool] = False
    flaggedComment: Optional[str] = None


class GeneralFeedbackSection(BaseModel):
    overallPerformance: List[str] = Field(default_factory=list)
    mcqs: List[str] = Field(default_factory=list)
    contentAccuracy: List[str] = Field(default_factory=list)
    completenessOfAnswers: List[str] = Field(default_factory=list)
    presentationDiagrams: List[str] = Field(default_factory=list)
    investigations: List[str] = Field(default_factory=list)
    attemptingQuestions: List[str] = Field(default_factory=list)
    actionPoints: List[str] = Field(default_factory=list)


class EvaluationReport(BaseModel):
    id: Optional[str] = None
    studentName: str
    testTitle: str
    testTopics: str
    testDate: str
    totalScore: float
    maxScore: float
    questions: List[QuestionFeedback]
    generalFeedback: GeneralFeedbackSection
    timestamp: Optional[int] = None
    evaluatedByModel: Optional[str] = None


class FilePayload(BaseModel):
    name: str = "document"
    text: Optional[str] = None
    base64: Optional[str] = None
    mimeType: Optional[str] = "application/pdf"


class CreateEvaluationRequest(BaseModel):
    sourceDoc: FilePayload
    questionPaper: Optional[FilePayload] = None
    answerKey: Optional[FilePayload] = None
    facultyNotes: Optional[FilePayload] = None
    mode: EvaluationMode = "with-manual"
    studentName: Optional[str] = None
    testTitle: Optional[str] = "Academic Assessment"


class JobMetrics(BaseModel):
    correlationId: str
    startTime: int
    endTime: Optional[int] = None
    totalLatencyMs: Optional[int] = None
    preprocessingLatencyMs: Optional[int] = None
    geminiLatencyMs: Optional[int] = None
    validationLatencyMs: Optional[int] = None
    inputTokens: Optional[int] = None
    outputTokens: Optional[int] = None
    estimatedCostUsd: Optional[float] = None
    cacheHit: bool = False
    retriesCount: int = 0
    modelUsed: Optional[str] = None


class JobResponse(BaseModel):
    id: str
    correlationId: str
    status: JobStatus
    progressPercent: int
    currentStepMessage: str
    studentName: str
    testTitle: Optional[str] = None
    mode: EvaluationMode
    createdAt: int
    updatedAt: int
    error: Optional[str] = None
    metrics: JobMetrics
    hasReport: bool = False
