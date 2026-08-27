import Link from 'next/link';
import { AppShell } from '@/ui/layout/app-shell';
import { Button } from '@/ui/primitives/button';
import { FaultlineMark } from '@/ui/layout/brand';

/**
 * Phase 1 places a deliberate marker rather than a product screen. The student
 * and teacher surfaces arrive in later phases; inventing them here would mean
 * building screens against a domain model that does not exist yet.
 */
export default function HomePage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-[1180px] px-5 py-20 sm:px-8 sm:py-28">
        <div className="max-w-2xl">
          <FaultlineMark className="size-7 text-ink-strong" />
          <h1 className="mt-7 text-3xl font-semibold tracking-[-0.022em] text-ink-strong sm:text-4xl">
            Don&rsquo;t grade the answer.
            <br />
            Debug the reasoning.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-secondary">
            A correct answer can hide a broken rule, and a wrong answer usually has a
            precise cause. Faultline compares a student&rsquo;s reasoning against a
            canonical path, finds where it first diverged, and tests whether the
            correction actually transfers.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" asChild>
              <Link href="/design">View the design system</Link>
            </Button>
            <span className="font-mono text-xs text-ink-faint">
              Phase 1 · foundation
            </span>
          </div>
        </div>

        <dl className="mt-24 grid gap-x-10 gap-y-8 border-t border-line-subtle pt-10 sm:grid-cols-3">
          {[
            {
              term: 'Reasoning trace',
              detail:
                'Guided steps capture how a student got there, not just where they landed.',
            },
            {
              term: 'First divergence',
              detail:
                'Compared against an authored reference path to find the earliest step that broke.',
            },
            {
              term: 'Transfer check',
              detail:
                'A genuinely new context tests whether the repair held. Correctness alone is not understanding.',
            },
          ].map(({ term, detail }) => (
            <div key={term}>
              <dt className="text-sm font-medium text-ink-strong">{term}</dt>
              <dd className="mt-1.5 text-sm text-ink-muted">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </AppShell>
  );
}
