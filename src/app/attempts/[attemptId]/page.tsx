import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { AppShell } from '@/ui/layout/app-shell';
import { Button } from '@/ui/primitives/button';
import { ReasoningPath, ReasoningStep } from '@/ui/reasoning/reasoning-path';
import { getCurrentActor } from '@/server/auth/actor';
import { getAttemptForActor } from '@/server/services/attempts';

type PageProps = { params: Promise<{ attemptId: string }> };

/** Rendered per request: this data is database-backed and scoped to the acting user. */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Reasoning recorded' };

/**
 * What the student sees immediately after submitting.
 *
 * Answer correctness and reasoning state are shown as two separate readings,
 * side by side, from the very first screen. That separation is the product
 * thesis made visible: a tick on the answer is not a verdict on the thinking,
 * and the reasoning column says plainly that it has not been assessed yet
 * rather than implying approval by silence.
 */
export default async function AttemptPage({ params }: PageProps) {
  const { attemptId } = await params;
  const actor = await getCurrentActor();
  const attempt = await getAttemptForActor(actor, attemptId);

  // Covers both "does not exist" and "belongs to someone else" — a student
  // must not be able to tell those two cases apart.
  if (!attempt) {
    notFound();
  }

  const answerCorrect = attempt.answerCorrect === true;

  return (
    <AppShell>
      <div className="mx-auto max-w-[760px] px-5 py-8 sm:px-8 sm:py-12">
        <p className="eyebrow">Reasoning recorded</p>

        <div className="mt-5 border-l-2 border-line pl-4 sm:pl-5">
          <p className="text-lg text-ink-strong">{attempt.problemStatement}</p>
        </div>

        {/* Two independent readings. Never one derived from the other. */}
        <dl className="mt-8 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
          <div className="bg-surface px-5 py-4">
            <dt className="eyebrow">Answer</dt>
            <dd className="mt-2 flex items-center gap-2">
              <span
                className={
                  answerCorrect
                    ? 'grid size-4 place-items-center rounded-full bg-repaired-bg text-repaired'
                    : 'grid size-4 place-items-center rounded-full bg-surface-sunken text-ink-muted'
                }
                aria-hidden="true"
              >
                {answerCorrect ? (
                  <Check className="size-3" strokeWidth={2.5} />
                ) : (
                  <X className="size-3" strokeWidth={2.5} />
                )}
              </span>
              <span className="text-base text-ink-strong">
                {answerCorrect ? 'Correct' : 'Not correct'}
              </span>
              {attempt.submittedAnswer ? (
                <span className="font-mono text-sm text-ink-muted">
                  {attempt.submittedAnswer}
                </span>
              ) : null}
            </dd>
          </div>

          <div className="bg-surface px-5 py-4">
            <dt className="eyebrow">Reasoning</dt>
            <dd className="mt-2 flex items-center gap-2">
              <span
                className="size-1.5 rounded-full bg-ink-faint"
                aria-hidden="true"
              />
              <span className="text-base text-ink-strong">Not yet analysed</span>
            </dd>
            <p className="mt-1.5 text-xs text-ink-muted">
              Your reasoning trace has been saved. Comparison against the reference
              path is not available yet.
            </p>
          </div>
        </dl>

        <div className="mt-12">
          <p className="eyebrow mb-6">Your reasoning trace</p>
          <ReasoningPath>
            {attempt.steps.map((step, position) => (
              <ReasoningStep
                key={step.stepIndex}
                index={step.stepIndex}
                label={step.label}
                state="complete"
                isLast={position === attempt.steps.length - 1}
              >
                <p className="text-sm text-ink-muted">{step.prompt}</p>
                <p className="mt-1 whitespace-pre-wrap text-base text-ink">
                  {step.response}
                </p>
              </ReasoningStep>
            ))}
          </ReasoningPath>
        </div>

        <div className="mt-10 flex flex-wrap gap-3 border-t border-line-subtle pt-6">
          <Button variant="primary" asChild>
            <Link href="/practice">Back to practice</Link>
          </Button>
          <Button variant="secondary" asChild>
            <Link href={`/practice/${attempt.problemSlug}`}>Try this problem again</Link>
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
