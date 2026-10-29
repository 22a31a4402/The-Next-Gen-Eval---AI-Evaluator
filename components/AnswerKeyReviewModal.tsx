import React, { useState } from 'react';
import { CanonicalAnswerKey, CanonicalQuestionKey } from '../types';
import { 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  Plus, 
  Trash2, 
  Save, 
  X, 
  Sparkles, 
  FileText, 
  Check, 
  ShieldCheck,
  Edit2
} from 'lucide-react';

interface AnswerKeyReviewModalProps {
  isOpen: boolean;
  answerKey: CanonicalAnswerKey;
  onClose: () => void;
  onSave: (updated: CanonicalAnswerKey) => Promise<void>;
  onApprove: (keyId: string) => Promise<void>;
  isLoading?: boolean;
}

export const AnswerKeyReviewModal: React.FC<AnswerKeyReviewModalProps> = ({
  isOpen,
  answerKey,
  onClose,
  onSave,
  onApprove,
  isLoading = false,
}) => {
  const [editedKey, setEditedKey] = useState<CanonicalAnswerKey>(() => JSON.parse(JSON.stringify(answerKey)));
  const [activeTab, setActiveTab] = useState<'questions' | 'metadata'>('questions');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const questions = editedKey.questions || [];

  const handleQuestionChange = (idx: number, field: keyof CanonicalQuestionKey, value: any) => {
    const nextQuestions = [...questions];
    nextQuestions[idx] = {
      ...nextQuestions[idx],
      [field]: value,
    };

    // If maxMarks changed, clear invalid mark flag if now valid
    if (field === 'maxMarks' && Number(value) > 0 && nextQuestions[idx].flaggedIssue?.includes('maximum marks')) {
      nextQuestions[idx].flaggedIssue = undefined;
    }

    // Recalculate total
    const newTotal = nextQuestions.reduce((acc, q) => acc + (Number(q.maxMarks) || 0), 0);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: newTotal,
    });
  };

  const handleAddConcept = (qIdx: number) => {
    const nextQuestions = [...questions];
    const concepts = [...(nextQuestions[qIdx].expectedConcepts || []), 'New key concept'];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleRemoveConcept = (qIdx: number, cIdx: number) => {
    const nextQuestions = [...questions];
    const concepts = nextQuestions[qIdx].expectedConcepts.filter((_, idx) => idx !== cIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleConceptChange = (qIdx: number, cIdx: number, val: string) => {
    const nextQuestions = [...questions];
    const concepts = [...nextQuestions[qIdx].expectedConcepts];
    concepts[cIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAddCriteria = (qIdx: number) => {
    const nextQuestions = [...questions];
    const criteria = [...(nextQuestions[qIdx].markingCriteria || []), '1 mark for correct definition/step'];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleRemoveCriteria = (qIdx: number, crIdx: number) => {
    const nextQuestions = [...questions];
    const criteria = nextQuestions[qIdx].markingCriteria.filter((_, idx) => idx !== crIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleCriteriaChange = (qIdx: number, crIdx: number, val: string) => {
    const nextQuestions = [...questions];
    const criteria = [...nextQuestions[qIdx].markingCriteria];
    criteria[crIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAddQuestion = () => {
    const nextQId = String(questions.length + 1);
    const newQuestion: CanonicalQuestionKey = {
      questionId: nextQId,
      maxMarks: 5,
      referenceAnswer: 'Enter standard reference answer here...',
      expectedConcepts: ['Key concept 1', 'Key concept 2'],
      acceptableAlternatives: ['Alternative phrasing or method'],
      markingCriteria: ['Award full marks for thorough explanation', 'Award partial marks for relevant concepts'],
    };
    const nextQuestions = [...questions, newQuestion];
    const newTotal = nextQuestions.reduce((acc, q) => acc + (Number(q.maxMarks) || 0), 0);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: newTotal,
    });
  };

  const handleRemoveQuestion = (idx: number) => {
    if (questions.length <= 1) {
      alert('Answer key must contain at least one question.');
      return;
    }
    const nextQuestions = questions.filter((_, i) => i !== idx);
    const newTotal = nextQuestions.reduce((acc, q) => acc + (Number(q.maxMarks) || 0), 0);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: newTotal,
    });
  };

  const handleSaveInternal = async () => {
    setErrorMsg(null);
    setSaveStatus('Saving changes...');
    try {
      await onSave(editedKey);
      setSaveStatus('Changes saved! (If previously approved, status is now Draft pending re-approval)');
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save changes.');
      setSaveStatus(null);
    }
  };

  const handleApproveInternal = async () => {
    setErrorMsg(null);
    // Client-side pre-validation
    const invalidQ = questions.find((q) => !Number.isFinite(q.maxMarks) || q.maxMarks <= 0);
    if (invalidQ) {
      setErrorMsg(`Cannot approve: Question ${invalidQ.questionId} has invalid or missing maximum marks (${invalidQ.maxMarks}). All questions must have positive maximum marks.`);
      return;
    }

    try {
      // Save changes first if modified
      await onSave(editedKey);
      await onApprove(editedKey.id);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to approve answer key.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden animate-scale-in">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
                {editedKey.sourceMode === 'ai_generated' ? (
                  <Sparkles className="w-5 h-5 text-purple-600" />
                ) : (
                  <FileText className="w-5 h-5 text-emerald-600" />
                )}
                Review & Approve Answer Key
              </h2>

              {/* Status Badge */}
              {editedKey.status === 'approved' ? (
                <span className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-100 text-emerald-800 text-xs font-black rounded-full border border-emerald-200">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                  Approved v{editedKey.version}
                </span>
              ) : editedKey.status === 'needs_review' ? (
                <span className="inline-flex items-center gap-1 px-3 py-1 bg-orange-100 text-orange-800 text-xs font-black rounded-full border border-orange-200">
                  <AlertTriangle className="w-3.5 h-3.5 text-orange-600" />
                  Needs Review (v{editedKey.version})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-3 py-1 bg-amber-100 text-amber-800 text-xs font-black rounded-full border border-amber-200">
                  <Clock className="w-3.5 h-3.5 text-amber-600" />
                  Draft (v{editedKey.version})
                </span>
              )}
            </div>

            <p className="text-xs text-slate-500 mt-1 font-medium">
              Source: <strong className="text-slate-700">{editedKey.sourceMode === 'ai_generated' ? 'AI Generated from Question Paper' : 'Extracted from Uploaded Key'}</strong> • Total Marks: <strong className="text-slate-700">{editedKey.totalMaxMarks}</strong> • Questions: <strong className="text-slate-700">{questions.length}</strong>
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status / Warnings Banner */}
        {editedKey.warnings && editedKey.warnings.length > 0 && (
          <div className="bg-orange-50 border-b border-orange-100 p-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0 mt-0.5" />
              <div className="text-xs text-orange-800">
                <span className="font-bold">Extraction Warnings requiring human review:</span>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  {editedKey.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Global Notifications */}
        {saveStatus && (
          <div className="bg-blue-50 border-b border-blue-100 px-6 py-2.5 text-xs font-bold text-blue-700 flex items-center gap-2">
            <Check className="w-4 h-4 text-blue-600" />
            <span>{saveStatus}</span>
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-50 border-b border-red-100 px-6 py-2.5 text-xs font-bold text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Body content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editedKey.title}
                onChange={(e) => setEditedKey({ ...editedKey, title: e.target.value })}
                className="text-base font-extrabold text-slate-800 border-b border-dashed border-slate-300 hover:border-slate-500 focus:border-blue-500 focus:outline-none px-1 py-0.5"
                placeholder="Exam Title"
              />
              {editedKey.subject && (
                <span className="text-xs text-slate-400 font-medium">({editedKey.subject})</span>
              )}
            </div>

            <button
              onClick={handleAddQuestion}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Question
            </button>
          </div>

          {/* Question Cards List */}
          <div className="space-y-4">
            {questions.map((q, qIdx) => (
              <div 
                key={qIdx}
                className={`p-5 rounded-2xl border transition-all ${
                  q.flaggedIssue 
                    ? 'border-orange-300 bg-orange-50/30' 
                    : q.maxMarks <= 0 
                      ? 'border-red-300 bg-red-50/30'
                      : 'border-slate-200 bg-white hover:border-slate-300 shadow-sm'
                }`}
              >
                {/* Question Header */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-center gap-3">
                    <span className="px-2.5 py-1 bg-slate-900 text-white text-xs font-black rounded-lg">
                      Q {q.questionId}
                    </span>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                      <span>Max Marks:</span>
                      <input
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={q.maxMarks || ''}
                        onChange={(e) => handleQuestionChange(qIdx, 'maxMarks', parseFloat(e.target.value) || 0)}
                        className={`w-16 px-2 py-1 text-center font-black rounded-lg border focus:outline-none text-xs ${
                          q.maxMarks <= 0 ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-200'
                        }`}
                        placeholder="Marks"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemoveQuestion(qIdx)}
                    className="p-1.5 text-slate-300 hover:text-red-500 transition-colors rounded-lg cursor-pointer"
                    title="Remove question"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Flagged Issue Warning */}
                {q.flaggedIssue && (
                  <div className="bg-orange-100/70 border border-orange-200 text-orange-800 text-xs px-3 py-2 rounded-xl mb-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Flagged for review:</span> {q.flaggedIssue}
                    </div>
                  </div>
                )}

                {/* Question Prompt / Text */}
                {q.questionText !== undefined && (
                  <div className="mb-3">
                    <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                      Question Text (Optional)
                    </label>
                    <input
                      type="text"
                      value={q.questionText || ''}
                      onChange={(e) => handleQuestionChange(qIdx, 'questionText', e.target.value)}
                      className="w-full text-xs text-slate-700 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
                      placeholder="Prompt text as printed on question paper"
                    />
                  </div>
                )}

                {/* Model / Reference Answer */}
                <div className="mb-3">
                  <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                    Standard Reference / Model Answer
                  </label>
                  <textarea
                    rows={2}
                    value={q.referenceAnswer}
                    onChange={(e) => handleQuestionChange(qIdx, 'referenceAnswer', e.target.value)}
                    className="w-full text-xs text-slate-800 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500 bg-slate-50/50 leading-relaxed font-sans"
                    placeholder="Enter the official or suggested model answer..."
                  />
                </div>

                {/* Concepts & Marking Criteria Grid */}
                <div className="grid md:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                  {/* Expected Concepts */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                        Expected Answer Concepts
                      </span>
                      <button
                        type="button"
                        onClick={() => handleAddConcept(qIdx)}
                        className="text-[10px] font-bold text-blue-600 hover:text-blue-800 cursor-pointer"
                      >
                        + Add Concept
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {(q.expectedConcepts || []).map((concept, cIdx) => (
                        <div key={cIdx} className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={concept}
                            onChange={(e) => handleConceptChange(qIdx, cIdx, e.target.value)}
                            className="flex-1 text-xs px-2.5 py-1 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveConcept(qIdx, cIdx)}
                            className="text-slate-300 hover:text-red-500 p-1 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Marking Criteria */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                        Marking Rubric (Partial Credit)
                      </span>
                      <button
                        type="button"
                        onClick={() => handleAddCriteria(qIdx)}
                        className="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 cursor-pointer"
                      >
                        + Add Rubric Point
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {(q.markingCriteria || []).map((criterion, crIdx) => (
                        <div key={crIdx} className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={criterion}
                            onChange={(e) => handleCriteriaChange(qIdx, crIdx, e.target.value)}
                            className="flex-1 text-xs px-2.5 py-1 rounded-lg border border-slate-200 focus:outline-none focus:border-emerald-500 bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveCriteria(qIdx, crIdx)}
                            className="text-slate-300 hover:text-red-500 p-1 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

              </div>
            ))}
          </div>

        </div>

        {/* Footer Actions */}
        <div className="p-6 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
          <div className="text-xs text-slate-500 font-medium">
            {editedKey.status === 'approved' ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> Approved by instructor. Ready to evaluate student scripts.
              </span>
            ) : (
              <span className="text-amber-700 font-bold flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> Key is unapproved. Grading pipeline requires approval.
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveInternal}
              disabled={isLoading}
              className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-bold rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              Save Draft
            </button>

            <button
              onClick={handleApproveInternal}
              disabled={isLoading}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black rounded-xl shadow-lg shadow-emerald-600/20 transition-all flex items-center gap-1.5 cursor-pointer hover:-translate-y-0.5"
            >
              <ShieldCheck className="w-4 h-4" />
              Approve Answer Key
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
