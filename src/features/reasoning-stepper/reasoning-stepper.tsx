'use client';

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Mic, Square, Pencil, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { validateStepResponse } from '@/core/attempt/submission';
import { ReasoningPath, ReasoningStep } from '@/ui/reasoning/reasoning-path';
import type { ReasoningStepState } from '@/ui/reasoning/reasoning-path';
import { Button } from '@/ui/primitives/button';
import { Field, Label, Textarea } from '@/ui/primitives/field';
import { ErrorState } from '@/ui/feedback/states';
import { DraftStore } from './draft-store';
import { useVoiceInput } from './use-voice-input';

/**
 * THE REASONING WORKSPACE.
 *
 * Not a multi-step form. The whole trace stays on screen as a single connected
 * path: the student can see what they have already said, revise any of it, and
 * watch the reasoning accumulate. Steps are revealed one at a time so attention
 * stays on the current question, but nothing is hidden once answered.
 *
 * Draft state lives in a store rather than React state, so responses survive a
 * reload and the component needs no synchronising effects.
 */

export type StepperStep = {
  stepIndex: number;
  label: string;
  prompt: string;
  isAnswerStep: boolean;
};

export type SubmitPayload = {
  problemSlug: string;
  steps: { stepIndex: number; response: string; revisionCount: number }[];
};

export type SubmitResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string };

export interface ReasoningStepperProps {
  problemSlug: string;
  steps: StepperStep[];
  onSubmit: (payload: SubmitPayload) => Promise<SubmitResult>;
}

export function ReasoningStepper({ problemSlug, steps, onSubmit }: ReasoningStepperProps) {
  const router = useRouter();
  const store = useMemo(() => new DraftStore(problemSlug), [problemSlug]);

  const draft = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  /** The step currently being written. Steps beyond it are not yet revealed. */
  const [activeIndex, setActiveIndex] = useState(0);
  /** Set when the student reopens an already-confirmed step. */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const openIndex = editingIndex ?? activeIndex;
  const responses = draft.responses;

  const isAnswered = useCallback(
    (index: number) => (responses[index] ?? '').trim().length > 0,
    [responses],
  );

  const allAnswered = steps.every((step) => isAnswered(step.stepIndex));
  const furthestReached = Math.max(activeIndex, ...steps.filter((s) => isAnswered(s.stepIndex)).map((s) => s.stepIndex));

  const handleChange = useCallback(
    (stepIndex: number, value: string) => {
      store.setResponse(stepIndex, value);
      if (stepError) setStepError(null);
    },
    [store, stepError],
  );

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      const existing = responses[openIndex] ?? '';
      const joined = existing.trim().length > 0 ? `${existing.trim()} ${text}` : text;
      store.setResponse(openIndex, joined);
    },
    [store, responses, openIndex],
  );

  const voice = useVoiceInput(handleVoiceTranscript);

  /** Confirms the open step and moves on, or closes an edit. */
  const confirmStep = useCallback(() => {
    const value = responses[openIndex] ?? '';
    const error = validateStepResponse(value);
    if (error) {
      setStepError(error);
      textareaRef.current?.focus();
      return;
    }

    setStepError(null);

    if (editingIndex !== null) {
      store.markRevised(editingIndex);
      setEditingIndex(null);
      return;
    }

    if (activeIndex < steps.length - 1) {
      setActiveIndex(activeIndex + 1);
    }
  }, [responses, openIndex, editingIndex, activeIndex, steps.length, store]);

  const beginEdit = useCallback((stepIndex: number) => {
    setEditingIndex(stepIndex);
    setStepError(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter confirms without reaching for the mouse. Plain Enter
      // stays available for line breaks inside an explanation.
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        confirmStep();
      }
      if (event.key === 'Escape' && editingIndex !== null) {
        event.preventDefault();
        setEditingIndex(null);
      }
    },
    [confirmStep, editingIndex],
  );

  const handleSubmit = useCallback(async () => {
    const missing = steps.find((step) => !isAnswered(step.stepIndex));
    if (missing) {
      setActiveIndex(missing.stepIndex);
      setStepError('Answer this step before submitting');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const result = await onSubmit({
        problemSlug,
        steps: steps.map((step) => ({
          stepIndex: step.stepIndex,
          response: (responses[step.stepIndex] ?? '').trim(),
          revisionCount: draft.revisions[step.stepIndex] ?? 0,
        })),
      });

      if (result.ok) {
        store.clear();
        router.push(`/attempts/${result.attemptId}`);
        return;
      }

      setSubmitError(result.error);
    } catch {
      setSubmitError(
        'Your reasoning could not be submitted. It is still saved on this device — try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [steps, isAnswered, onSubmit, problemSlug, responses, draft.revisions, store, router]);

  function stepState(stepIndex: number): ReasoningStepState {
    if (stepIndex === openIndex) return 'active';
    if (isAnswered(stepIndex)) return 'complete';
    return 'pending';
  }

  return (
    <div>
      <ReasoningPath>
        {steps.map((step) => {
          const revealed = step.stepIndex <= furthestReached;
          const isOpen = step.stepIndex === openIndex;
          const value = responses[step.stepIndex] ?? '';

          return (
            <ReasoningStep
              key={step.stepIndex}
              index={step.stepIndex}
              label={step.label}
              state={stepState(step.stepIndex)}
              isLast={step.stepIndex === steps.length - 1}
            >
              {!revealed ? (
                <p className="text-sm text-ink-faint">Not yet reached</p>
              ) : isOpen ? (
                <OpenStep
                  ref={textareaRef}
                  prompt={step.prompt}
                  value={value}
                  error={stepError}
                  isAnswerStep={step.isAnswerStep}
                  isEditing={editingIndex !== null}
                  isFinalStep={step.stepIndex === steps.length - 1}
                  voice={voice}
                  onChange={(next) => handleChange(step.stepIndex, next)}
                  onKeyDown={handleKeyDown}
                  onConfirm={confirmStep}
                  onCancelEdit={() => setEditingIndex(null)}
                />
              ) : (
                <AnsweredStep
                  prompt={step.prompt}
                  value={value}
                  revisions={draft.revisions[step.stepIndex] ?? 0}
                  onEdit={() => beginEdit(step.stepIndex)}
                />
              )}
            </ReasoningStep>
          );
        })}
      </ReasoningPath>

      <div className="mt-2 border-t border-line-subtle pt-6">
        {submitError ? (
          <ErrorState
            className="mb-5"
            title="Submission failed"
            description={submitError}
            onRetry={() => void handleSubmit()}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant="primary"
            size="lg"
            disabled={!allAnswered || editingIndex !== null}
            loading={submitting}
            onClick={() => void handleSubmit()}
          >
            Submit reasoning
          </Button>

          <p className="text-xs text-ink-muted" aria-live="polite">
            {editingIndex !== null
              ? 'Confirm your edit to continue.'
              : allAnswered
                ? 'Every step is answered. You can still revise any of them.'
                : `${steps.filter((step) => isAnswered(step.stepIndex)).length} of ${steps.length} steps answered.`}
          </p>
        </div>

        {draft.updatedAt !== null ? (
          <p className="mt-3 text-2xs text-ink-faint">
            Saved on this device. Your reasoning is kept if you close the page.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

const OpenStep = function OpenStep({
  ref,
  prompt,
  value,
  error,
  isAnswerStep,
  isEditing,
  isFinalStep,
  voice,
  onChange,
  onKeyDown,
  onConfirm,
  onCancelEdit,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  prompt: string;
  value: string;
  error: string | null;
  isAnswerStep: boolean;
  isEditing: boolean;
  isFinalStep: boolean;
  voice: ReturnType<typeof useVoiceInput>;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onConfirm: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <div>
      {/* Field owns the label/error/aria wiring, so the workspace cannot drift
          away from the accessibility guarantees the design system provides. */}
      <Field error={error ?? undefined} className="gap-3">
        <Label className="text-base text-ink-strong">{prompt}</Label>
        <Textarea
          ref={ref}
          autoResize
          rows={isAnswerStep ? 1 : 3}
          value={value}
          placeholder={
            isAnswerStep ? 'Your answer' : 'Explain your reasoning for this step…'
          }
          className={cn(isAnswerStep && 'font-mono text-lg')}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </Field>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onConfirm}>
          {isEditing ? 'Save change' : isFinalStep ? 'Done' : 'Next step'}
          <CornerDownLeft className="size-3 opacity-50" strokeWidth={2} />
        </Button>

        {isEditing ? (
          <Button size="sm" variant="ghost" onClick={onCancelEdit}>
            Cancel
          </Button>
        ) : null}

        {voice.supported ? (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={voice.listening}
            aria-label={voice.listening ? 'Stop dictation' : 'Dictate this step'}
            onClick={voice.listening ? voice.stop : voice.start}
          >
            {voice.listening ? (
              <>
                <Square className="size-3 fill-current" strokeWidth={2} />
                Stop
              </>
            ) : (
              <>
                <Mic className="size-3.5" strokeWidth={1.75} />
                Dictate
              </>
            )}
          </Button>
        ) : null}

        <span className="ml-auto hidden text-2xs text-ink-faint sm:inline">
          <kbd className="font-mono">Ctrl</kbd> + <kbd className="font-mono">Enter</kbd>
        </span>
      </div>
    </div>
  );
};

function AnsweredStep({
  prompt,
  value,
  revisions,
  onEdit,
}: {
  prompt: string;
  value: string;
  revisions: number;
  onEdit: () => void;
}) {
  return (
    <div className="group">
      <p className="text-sm text-ink-muted">{prompt}</p>
      <div className="mt-1 flex items-start gap-3">
        <p className="flex-1 whitespace-pre-wrap text-base text-ink">{value}</p>
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5',
            'text-2xs text-ink-faint transition-colors',
            'hover:bg-surface-sunken hover:text-ink-secondary',
            'focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100',
          )}
        >
          <Pencil className="size-3" strokeWidth={1.75} />
          Edit
        </button>
      </div>
      {revisions > 0 ? (
        <p className="mt-1 text-2xs text-ink-faint">
          Revised {revisions} {revisions === 1 ? 'time' : 'times'}
        </p>
      ) : null}
    </div>
  );
}
