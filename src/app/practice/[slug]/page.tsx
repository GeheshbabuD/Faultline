import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppShell } from '@/ui/layout/app-shell';
import { getProblemWorkspace } from '@/server/services/problems';
import { ReasoningStepper } from '@/features/reasoning-stepper/reasoning-stepper';
import { submitReasoningTrace } from '../actions';

type PageProps = { params: Promise<{ slug: string }> };

/** Rendered per request: this data is database-backed and scoped to the acting user. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const workspace = await getProblemWorkspace(slug);
  return { title: workspace ? workspace.topic : 'Problem' };
}

export default async function ProblemPage({ params }: PageProps) {
  const { slug } = await params;
  const workspace = await getProblemWorkspace(slug);

  if (!workspace) {
    notFound();
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-[760px] px-5 py-8 sm:px-8 sm:py-12">
        <Link
          href="/practice"
          className="inline-flex items-center gap-1.5 rounded-sm text-xs text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Practice
        </Link>

        {/* The problem anchors the page: a single strong rule, then the trace. */}
        <div className="mt-6 border-l-2 border-ink-strong pl-4 sm:pl-5">
          <p className="eyebrow mb-2">Problem</p>
          <p className="text-lg text-ink-strong sm:text-xl">{workspace.statement}</p>
        </div>

        <div className="mt-10">
          <ReasoningStepper
            problemSlug={workspace.slug}
            steps={workspace.steps}
            onSubmit={submitReasoningTrace}
          />
        </div>
      </div>
    </AppShell>
  );
}
