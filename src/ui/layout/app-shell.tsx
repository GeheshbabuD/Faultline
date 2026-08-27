'use client';

import Link from 'next/link';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTheme } from '@/ui/theme';
import { Wordmark } from '@/ui/layout/brand';

/**
 * A single hairline rule separates the shell from the work. No sidebar until
 * there is genuinely somewhere to navigate to (Phase 7 onward) — an empty
 * sidebar is a promise the product cannot keep yet.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line-subtle bg-canvas/85 backdrop-blur-sm">
        <div className="mx-auto flex h-13 max-w-[1180px] items-center gap-6 px-5 sm:px-8">
          <Link href="/" className="rounded-xs">
            <Wordmark />
          </Link>
          <div className="flex-1" />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      className={cn(
        'grid size-7 place-items-center rounded-sm text-ink-muted',
        'transition-colors duration-150 hover:bg-surface-sunken hover:text-ink',
        className,
      )}
    >
      {theme === 'dark' ? (
        <Sun className="size-4" strokeWidth={1.75} />
      ) : (
        <Moon className="size-4" strokeWidth={1.75} />
      )}
    </button>
  );
}

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold text-ink-strong tracking-[-0.018em]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A labelled band of a page. Sections are separated by rules, not stacked cards. */
export function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-t border-line-subtle pt-8', className)}>
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-ink-strong tracking-[-0.006em]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
