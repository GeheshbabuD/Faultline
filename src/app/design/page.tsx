'use client';

import { useState } from 'react';
import { AppShell, PageHeader, Section } from '@/ui/layout/app-shell';
import { Button } from '@/ui/primitives/button';
import { Field, Label, Input, Textarea } from '@/ui/primitives/field';
import { Tag } from '@/ui/primitives/tag';
import { Callout } from '@/ui/primitives/callout';
import { ConfidenceIndicator } from '@/ui/feedback/confidence';
import { EmptyState, ErrorState, LoadingState, Skeleton } from '@/ui/feedback/states';
import { ReasoningPath, ReasoningStep } from '@/ui/reasoning/reasoning-path';
import type { Tone } from '@/ui/tone';

/**
 * The design system reference.
 *
 * An internal route, but a real one: every element here is the actual component
 * a screen would use, so drift between the reference and the product is
 * impossible. Kept out of the student and teacher navigation.
 */
export default function DesignSystemPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-[1180px] px-5 py-10 sm:px-8 sm:py-14">
        <PageHeader
          eyebrow="Internal reference"
          title="Design system"
          description="The vocabulary Faultline is built from. Colour carries diagnostic meaning; structure comes from rules and spacing rather than cards and shadows."
        />

        <div className="mt-14 flex flex-col gap-14">
          <ColorSection />
          <TypographySection />
          <ControlsSection />
          <DiagnosticSection />
          <ReasoningSection />
          <StatesSection />
        </div>
      </div>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ colour */

const NEUTRAL_RAMP = [
  { name: 'canvas', varName: '--fl-canvas' },
  { name: 'surface', varName: '--fl-surface' },
  { name: 'surface-sunken', varName: '--fl-surface-sunken' },
  { name: 'line-subtle', varName: '--fl-border-subtle' },
  { name: 'line', varName: '--fl-border' },
  { name: 'line-strong', varName: '--fl-border-strong' },
  { name: 'ink-muted', varName: '--fl-ink-muted' },
  { name: 'ink-secondary', varName: '--fl-ink-secondary' },
  { name: 'ink', varName: '--fl-ink' },
  { name: 'ink-strong', varName: '--fl-ink-strong' },
];

const SEMANTIC_TONES: { tone: Tone; varName: string; meaning: string }[] = [
  { tone: 'valid', varName: '--fl-valid', meaning: 'Reasoning matched the reference path' },
  { tone: 'suspect', varName: '--fl-suspect', meaning: 'Possible divergence, unconfirmed' },
  { tone: 'faultline', varName: '--fl-faultline', meaning: 'Confirmed reasoning divergence' },
  { tone: 'repaired', varName: '--fl-repaired', meaning: 'Repair or transfer confirmed' },
  { tone: 'uncertain', varName: '--fl-uncertain', meaning: 'Evidence too thin to conclude' },
  { tone: 'danger', varName: '--fl-danger', meaning: 'Destructive action — not a reasoning state' },
];

function ColorSection() {
  return (
    <Section
      title="Colour"
      description="A warm neutral ground so that the one coloured thing on a screen is the thing that matters. Every tone means exactly one thing."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div>
          <p className="eyebrow mb-3">Neutral ground</p>
          <div className="flex overflow-hidden rounded-md border border-line">
            {NEUTRAL_RAMP.map((swatch) => (
              <div
                key={swatch.name}
                className="group relative h-16 flex-1"
                style={{ backgroundColor: `var(${swatch.varName})` }}
                title={swatch.name}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-2xs text-ink-faint">
            <span>canvas</span>
            <span>ink-strong</span>
          </div>
        </div>

        <div>
          <p className="eyebrow mb-3">Semantic tones</p>
          <dl className="divide-y divide-line-subtle border-y border-line-subtle">
            {SEMANTIC_TONES.map(({ tone, varName, meaning }) => (
              <div key={tone} className="flex items-center gap-4 py-2.5">
                <span
                  className="size-4 shrink-0 rounded-xs"
                  style={{ backgroundColor: `var(${varName})` }}
                  aria-hidden="true"
                />
                <dt className="w-24 shrink-0 font-mono text-xs text-ink">{tone}</dt>
                <dd className="text-sm text-ink-muted">{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- typography */

const TYPE_SCALE = [
  { token: 'text-4xl', cls: 'text-4xl', usage: 'Rare. Marketing surfaces only.' },
  { token: 'text-2xl', cls: 'text-2xl', usage: 'Page title' },
  { token: 'text-lg', cls: 'text-lg', usage: 'Problem statement' },
  { token: 'text-base', cls: 'text-base', usage: 'Body, student reasoning' },
  { token: 'text-sm', cls: 'text-sm', usage: 'Interface text, labels' },
  { token: 'text-xs', cls: 'text-xs', usage: 'Supporting detail' },
];

function TypographySection() {
  return (
    <Section
      title="Typography"
      description="Instrument Sans for the interface. Geist Mono is reserved for identifiers, expressions and figures — never for prose."
    >
      <div className="grid gap-10 lg:grid-cols-2">
        <dl className="divide-y divide-line-subtle border-y border-line-subtle">
          {TYPE_SCALE.map(({ token, cls, usage }) => (
            <div key={token} className="flex items-baseline gap-5 py-3">
              <dt className="w-20 shrink-0 font-mono text-2xs text-ink-faint">{token}</dt>
              <dd className="flex-1 min-w-0">
                <p className={`${cls} truncate text-ink-strong`}>Reasoning diverged here</p>
                <p className="mt-0.5 text-xs text-ink-faint">{usage}</p>
              </dd>
            </div>
          ))}
        </dl>

        <div>
          <p className="eyebrow mb-3">Monospace, used sparingly</p>
          <div className="space-y-3 border-y border-line-subtle py-4">
            <div className="flex items-center gap-3">
              <Tag mono tone="faultline">SUB_002</Tag>
              <span className="text-sm text-ink-muted">Misconception identifier</span>
            </div>
            <div className="flex items-center gap-3">
              <code className="rounded-xs bg-surface-sunken px-1.5 py-0.5 font-mono text-sm text-ink">
                −3 + 7
              </code>
              <span className="text-sm text-ink-muted">Reasoning expression</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm tabular-nums text-ink">0.91</span>
              <span className="text-sm text-ink-muted">Confidence value</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- controls */

function ControlsSection() {
  const [loading, setLoading] = useState(false);

  return (
    <Section
      title="Controls"
      description="The primary action is ink, not colour. Spending colour on buttons would dilute the only signal that matters."
    >
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="space-y-6">
          <div>
            <p className="eyebrow mb-3">Variants</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Submit reasoning</Button>
              <Button variant="secondary">Edit step</Button>
              <Button variant="ghost">Skip</Button>
              <Button variant="danger">Delete attempt</Button>
            </div>
          </div>

          <div>
            <p className="eyebrow mb-3">Sizes and states</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
              <Button
                variant="primary"
                loading={loading}
                onClick={() => {
                  setLoading(true);
                  window.setTimeout(() => setLoading(false), 1600);
                }}
              >
                Run analysis
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <p className="eyebrow">Inputs</p>
          <Field description="Shown to the student above the reasoning input.">
            <Label required>What is the starting value?</Label>
            <Input placeholder="e.g. −3" />
          </Field>

          <Field error="Enter your reasoning before continuing.">
            <Label>Why?</Label>
            <Textarea
              autoResize
              placeholder="Explain what you did and why…"
              defaultValue=""
            />
          </Field>
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- diagnostic */

function DiagnosticSection() {
  return (
    <Section
      title="Diagnostic language"
      description="Confidence is displayed as a reading being taken, not a task completing. Bands are supplied by policy in core/diagnosis — components never decide their own thresholds."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <ConfidenceIndicator value={0.91} band="high" />
          <ConfidenceIndicator value={0.68} band="moderate" />
          <ConfidenceIndicator value={0.42} band="low" />
        </div>

        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Tag tone="valid" dot>Valid</Tag>
            <Tag tone="suspect" dot>Suspect</Tag>
            <Tag tone="faultline" dot>Faultline</Tag>
            <Tag tone="repaired" dot>Repaired</Tag>
            <Tag tone="uncertain" dot>Uncertain</Tag>
            <Tag mono>SUB_001</Tag>
          </div>

          <div className="space-y-4">
            <Callout tone="faultline" title="Reasoning diverged at step 03">
              <p>
                The step treats the distance between the two values as the result, which
                gives 10 rather than −5.
              </p>
            </Callout>
            <Callout tone="uncertain" title="Evidence insufficient">
              <p>
                Not enough reasoning was captured to identify a specific divergence. Routed
                for review rather than labelled.
              </p>
            </Callout>
            <Callout tone="repaired" title="Corrected reasoning transferred">
              <p>The repaired reasoning held in a new context.</p>
            </Callout>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- reasoning */

type Scenario = 'in-progress' | 'faultline' | 'repaired';

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'in-progress', label: 'In progress' },
  { id: 'faultline', label: 'Faultline identified' },
  { id: 'repaired', label: 'After repair' },
];

function ReasoningSection() {
  const [scenario, setScenario] = useState<Scenario>('faultline');

  return (
    <Section
      title="The reasoning path"
      description="The signature interaction. Where reasoning diverges, the rail is displaced rather than reddened — the way strata are offset across a geological fault. Later steps continue on the shifted line, which makes 'downstream of the fault' legible without explanation."
    >
      <div className="mb-8 flex flex-wrap gap-1.5">
        {SCENARIOS.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={scenario === option.id ? 'primary' : 'ghost'}
            onClick={() => setScenario(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <div className="max-w-2xl">
        <div className="mb-8 border-l-2 border-ink-strong pl-4">
          <p className="eyebrow mb-1.5">Problem</p>
          <p className="text-lg text-ink-strong">
            An elevator is on floor −3 and moves up 7 floors. What floor does it reach?
          </p>
        </div>

        {scenario === 'in-progress' ? <InProgressTrace /> : null}
        {scenario === 'faultline' ? <FaultlineTrace /> : null}
        {scenario === 'repaired' ? <RepairedTrace /> : null}
      </div>
    </Section>
  );
}

function StepAnswer({ children }: { children: React.ReactNode }) {
  return <p className="text-base text-ink">{children}</p>;
}

function InProgressTrace() {
  return (
    <ReasoningPath key="in-progress" animate>
      <ReasoningStep index={0} label="Starting value" state="complete">
        <StepAnswer>The elevator starts at −3.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={1} label="Operation" state="active">
        <Textarea autoResize placeholder="What operation should happen?" rows={2} />
      </ReasoningStep>
      <ReasoningStep index={2} label="Why?" state="pending">
        <StepAnswer>
          <span className="text-ink-faint">Not yet answered</span>
        </StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={3} label="Result" state="pending" isLast>
        <StepAnswer>
          <span className="text-ink-faint">Not yet answered</span>
        </StepAnswer>
      </ReasoningStep>
    </ReasoningPath>
  );
}

function FaultlineTrace() {
  return (
    <ReasoningPath key="faultline" divergenceIndex={2} animate>
      <ReasoningStep index={0} label="Starting value" state="valid">
        <StepAnswer>The elevator starts at −3.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={1} label="Operation" state="valid">
        <StepAnswer>It moves up, so I add 7.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep
        index={2}
        label="Why?"
        state="faultline"
        annotation={
          <div className="max-w-lg space-y-4 border-l-2 border-faultline-border py-1 pl-4">
            <div>
              <p className="eyebrow mb-1.5">Expected reasoning</p>
              <p className="text-sm text-ink-secondary">
                Moving up from −3 by 7 means{' '}
                <code className="font-mono text-ink">−3 + 7</code>, counting upward
                through zero.
              </p>
            </div>
            <div>
              <p className="eyebrow mb-1.5">Evidence</p>
              <p className="text-sm text-ink-secondary">
                &ldquo;how far apart&rdquo; treats the two values as a distance, which
                discards the direction of travel.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3 pt-1">
              <ConfidenceIndicator value={0.91} band="high" />
              <Tag mono tone="faultline" className="mb-0.5">
                SUB_002
              </Tag>
            </div>
          </div>
        }
      >
        <StepAnswer>Because I need to find how far apart −3 and 7 are.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={3} label="Result" state="downstream" isLast>
        <StepAnswer>10</StepAnswer>
        <p className="mt-1.5 text-xs text-ink-muted">
          Downstream of the divergence — this step follows from step 03.
        </p>
      </ReasoningStep>
    </ReasoningPath>
  );
}

function RepairedTrace() {
  return (
    <ReasoningPath key="repaired" animate>
      <ReasoningStep index={0} label="Starting value" state="valid">
        <StepAnswer>The elevator starts at −3.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={1} label="Operation" state="valid">
        <StepAnswer>It moves up, so I add 7.</StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={2} label="Why?" state="repaired">
        <StepAnswer>
          Going up means counting forward from −3, not measuring the gap between −3 and 7.
        </StepAnswer>
      </ReasoningStep>
      <ReasoningStep index={3} label="Result" state="valid" isLast>
        <StepAnswer>4</StepAnswer>
      </ReasoningStep>
    </ReasoningPath>
  );
}

/* ------------------------------------------------------------------ states */

function StatesSection() {
  return (
    <Section
      title="Empty, loading and error"
      description="Designed states, not gaps left over when data is missing. Each says what happened and what to do next."
    >
      <div className="grid gap-6 lg:grid-cols-3">
        <EmptyState
          title="No reasoning traces yet"
          description="Once a problem is attempted, its trace and any divergences appear here."
        />
        <div className="rounded-lg border border-line px-5 py-4">
          <LoadingState label="Comparing against the reference path…" />
          <div className="mt-4 space-y-2.5">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-full" />
            <Skeleton className="w-1/2" />
          </div>
        </div>
        <ErrorState
          description="The reasoning comparison did not complete. Your trace has been saved."
          detail="TaskError: reasoning-diff exceeded schema validation retries (2)"
          onRetry={() => undefined}
        />
      </div>
    </Section>
  );
}
