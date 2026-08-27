import Link from 'next/link';
import { AppShell, PageHeader } from '@/ui/layout/app-shell';
import { Tag } from '@/ui/primitives/tag';
import { EmptyState } from '@/ui/feedback/states';
import { listProblems } from '@/server/services/problems';

/** Rendered per request: this data is database-backed and scoped to the acting user. */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Practice' };

/** Difficulty reads as a progression, so it is ordered rather than colour-coded. */
const DIFFICULTY_LABEL: Record<string, string> = {
  foundational: 'Foundational',
  developing: 'Developing',
  proficient: 'Proficient',
  advanced: 'Advanced',
};

export default async function PracticePage() {
  const problems = await listProblems();

  return (
    <AppShell>
      <div className="mx-auto max-w-[860px] px-5 py-10 sm:px-8 sm:py-14">
        <PageHeader
          eyebrow="Integer subtraction"
          title="Practice"
          description="Work through the reasoning, not just the answer. Each problem asks for your thinking one step at a time."
        />

        {problems.length === 0 ? (
          <EmptyState
            className="mt-10"
            title="No problems available"
            description="Authored content has not been seeded into this database yet."
          />
        ) : (
          <ul className="mt-10 divide-y divide-line-subtle border-y border-line-subtle">
            {problems.map((problem) => (
              <li key={problem.slug}>
                <Link
                  href={`/practice/${problem.slug}`}
                  className="group flex flex-col gap-2 py-5 transition-colors sm:flex-row sm:items-baseline sm:gap-6"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-ink-strong group-hover:text-ink">
                      {problem.statement}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {problem.primaryConcept ? (
                        <span className="text-xs text-ink-muted">
                          {problem.primaryConcept}
                        </span>
                      ) : null}
                      <span className="font-mono text-2xs text-ink-faint">
                        {problem.stepCount} steps
                      </span>
                    </div>
                  </div>
                  <Tag className="self-start whitespace-nowrap">
                    {DIFFICULTY_LABEL[problem.difficulty] ?? problem.difficulty}
                  </Tag>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
