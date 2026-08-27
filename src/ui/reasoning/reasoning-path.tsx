'use client';

import { createContext, useContext } from 'react';
import { cn } from '@/lib/cn';

/**
 * THE REASONING PATH
 *
 * The signature interaction. A reasoning trace is drawn as a continuous rail
 * running through its steps. Where the student's reasoning diverges from the
 * reference path, the rail does not turn red — it *displaces*, the way strata
 * are offset across a geological fault. Everything below the divergence
 * continues on the shifted line, which is what makes "these later steps are
 * downstream of the fault" legible without a word of explanation.
 *
 * Deliberately not: a red card, a cracked-earth graphic, or an error banner.
 */

export type ReasoningStepState =
  /** Not yet reached. */
  | 'pending'
  /** Currently being answered. */
  | 'active'
  /** Answered, not yet analysed. */
  | 'complete'
  /** Matched the reference path. */
  | 'valid'
  /** Possible divergence, unconfirmed. */
  | 'suspect'
  /** The first divergence. At most one per trace. */
  | 'faultline'
  /** After the divergence: affected by it, not itself the fault. */
  | 'downstream'
  /** Reasoning repaired by the student. */
  | 'repaired';

/** Lateral displacement of the rail below the fault, in pixels. */
const DISPLACEMENT = 15;
const RAIL_CENTER = 20;
const MARKER_SIZE = 18;
const MARKER_TOP = 3;

type PathContextValue = {
  /** Index of the first divergence, or null when the trace has none. */
  divergenceIndex: number | null;
  /** Steps appear in sequence as analysis lands. */
  animate: boolean;
};

const PathContext = createContext<PathContextValue>({
  divergenceIndex: null,
  animate: false,
});

export interface ReasoningPathProps extends React.HTMLAttributes<HTMLOListElement> {
  divergenceIndex?: number | null;
  animate?: boolean;
}

export function ReasoningPath({
  className,
  children,
  divergenceIndex = null,
  animate = false,
  ...props
}: ReasoningPathProps) {
  return (
    <PathContext.Provider value={{ divergenceIndex, animate }}>
      <ol className={cn('flex flex-col', className)} {...props}>
        {children}
      </ol>
    </PathContext.Provider>
  );
}

export interface ReasoningStepProps extends React.HTMLAttributes<HTMLLIElement> {
  /** Zero-based position. Displayed to the student as a padded 01, 02, ... */
  index: number;
  label: string;
  state?: ReasoningStepState;
  isLast?: boolean;
  /** Annotation rendered beneath the step body — evidence, expected reasoning. */
  annotation?: React.ReactNode;
}

export function ReasoningStep({
  className,
  index,
  label,
  state = 'pending',
  isLast = false,
  annotation,
  children,
  ...props
}: ReasoningStepProps) {
  const { divergenceIndex, animate } = useContext(PathContext);

  const hasDivergence = divergenceIndex !== null;
  const isDivergence = hasDivergence && index === divergenceIndex;
  // Everything after the fault sits on the displaced line.
  const displacedAbove = hasDivergence && index > divergenceIndex;
  const displacedBelow = hasDivergence && index >= divergenceIndex;

  const offsetAbove = displacedAbove ? DISPLACEMENT : 0;
  const offsetBelow = displacedBelow ? DISPLACEMENT : 0;
  const markerOffset = displacedAbove ? DISPLACEMENT : 0;

  return (
    <li
      className={cn('relative flex gap-3 sm:gap-4', className)}
      data-state={state}
      style={
        animate
          ? {
              animation: `fl-step-in 320ms var(--ease-out-quart) ${index * 60}ms both`,
            }
          : undefined
      }
      {...props}
    >
      {/* ---- Rail ---------------------------------------------------------- */}
      {/* Fixed width at every breakpoint: RAIL_CENTER + DISPLACEMENT must stay
          inside the column, or the displaced rail bleeds into the step body. */}
      <div className="relative w-10 shrink-0" aria-hidden="true">
        {/* Segment entering this step from above. */}
        {index > 0 ? (
          <span
            className={cn('absolute top-0 w-px', railTone(state, 'incoming'))}
            style={{
              left: RAIL_CENTER + offsetAbove,
              height: MARKER_TOP,
            }}
          />
        ) : null}

        <StepMarker state={state} offset={markerOffset} />

        {/* Segment leaving this step. At the divergence it jogs across to the
            displaced line; elsewhere it runs straight. */}
        {!isLast ? (
          isDivergence ? (
            <FaultJog />
          ) : (
            <span
              className={cn('absolute bottom-0 w-px', railTone(state, 'outgoing'))}
              style={{
                left: RAIL_CENTER + offsetBelow,
                top: MARKER_TOP + MARKER_SIZE,
              }}
            />
          )
        ) : null}
      </div>

      {/* ---- Content ------------------------------------------------------- */}
      <div className={cn('flex-1 min-w-0', isLast ? 'pb-1' : 'pb-7')}>
        <div className="flex items-center gap-2.5 h-6">
          <span
            className={cn(
              'step-index',
              state === 'faultline' ? 'text-faultline' : 'text-ink-faint',
            )}
          >
            {String(index + 1).padStart(2, '0')}
          </span>
          <span
            className={cn(
              'eyebrow',
              state === 'faultline' && 'text-faultline',
              state === 'suspect' && 'text-suspect',
              state === 'repaired' && 'text-repaired',
            )}
          >
            {label}
          </span>
        </div>

        <div className="mt-1.5">{children}</div>

        {annotation ? <div className="mt-3">{annotation}</div> : null}
      </div>
    </li>
  );
}

/**
 * The fault itself: the rail steps across to the displaced line. Drawn as a
 * short offset curve rather than a break, so the path stays readable as one
 * continuous trace that has been shifted.
 */
function FaultJog() {
  const width = DISPLACEMENT + 2;
  const height = 16;

  return (
    <>
      <svg
        className="absolute overflow-visible"
        style={{ left: RAIL_CENTER, top: MARKER_TOP + MARKER_SIZE }}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
      >
        <path
          d={`M 0.5 0 C 0.5 ${height * 0.58}, ${DISPLACEMENT + 0.5} ${height * 0.42}, ${DISPLACEMENT + 0.5} ${height}`}
          stroke="var(--fl-faultline)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      {/* Continues on the displaced line, dashed: downstream of the fault and
          therefore not independently verified. */}
      <span
        className="absolute bottom-0 w-px"
        style={{
          left: RAIL_CENTER + DISPLACEMENT,
          top: MARKER_TOP + MARKER_SIZE + height,
          backgroundImage:
            'repeating-linear-gradient(to bottom, var(--fl-downstream) 0 3px, transparent 3px 6px)',
        }}
      />
    </>
  );
}

function railTone(state: ReasoningStepState, direction: 'incoming' | 'outgoing'): string {
  switch (state) {
    case 'pending':
      return 'bg-line';
    case 'downstream':
      return 'bg-transparent [background-image:repeating-linear-gradient(to_bottom,var(--fl-downstream)_0_3px,transparent_3px_6px)]';
    case 'suspect':
      return direction === 'outgoing' ? 'bg-suspect/45' : 'bg-line-strong';
    case 'repaired':
      return 'bg-repaired/45';
    default:
      return 'bg-line-strong';
  }
}

/**
 * Markers are shape-coded as well as colour-coded — the divergence is the only
 * diamond in the trace — so the fault is findable without relying on colour.
 */
function StepMarker({ state, offset }: { state: ReasoningStepState; offset: number }) {
  const base = 'absolute grid place-items-center transition-colors duration-200';
  const style = {
    left: RAIL_CENTER + offset,
    top: MARKER_TOP,
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    transform: 'translateX(-50%)',
  } as const;

  if (state === 'faultline') {
    return (
      <span
        className={base}
        style={{
          ...style,
          animation: 'fl-fracture-in 260ms var(--ease-out-quart) both',
        }}
      >
        <span className="size-3 rotate-45 rounded-xs bg-faultline ring-4 ring-faultline-bg" />
      </span>
    );
  }

  if (state === 'valid' || state === 'repaired') {
    const tone = state === 'repaired' ? 'text-repaired' : 'text-valid';
    return (
      <span className={base} style={style}>
        <span
          className={cn(
            'size-[18px] grid place-items-center rounded-full border bg-surface',
            state === 'repaired' ? 'border-repaired-border' : 'border-valid-border',
          )}
        >
          <svg viewBox="0 0 10 10" className={cn('size-2.5', tone)} fill="none">
            <path
              d="M2 5.2 4 7.2 8 2.8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
    );
  }

  if (state === 'suspect') {
    return (
      <span className={base} style={style}>
        <span className="size-2.5 rounded-full border-[1.5px] border-suspect bg-suspect-bg ring-4 ring-canvas" />
      </span>
    );
  }

  if (state === 'active') {
    return (
      <span className={base} style={style}>
        <span className="size-3 grid place-items-center rounded-full border-[1.5px] border-ink bg-surface">
          <span className="size-1 rounded-full bg-ink" />
        </span>
      </span>
    );
  }

  if (state === 'complete') {
    return (
      <span className={base} style={style}>
        <span className="size-2 rounded-full bg-ink-faint ring-4 ring-canvas" />
      </span>
    );
  }

  if (state === 'downstream') {
    return (
      <span className={base} style={style}>
        <span className="size-2 rounded-full border border-downstream bg-canvas ring-4 ring-canvas" />
      </span>
    );
  }

  // pending
  return (
    <span className={base} style={style}>
      <span className="size-2 rounded-full border border-line-strong bg-canvas ring-4 ring-canvas" />
    </span>
  );
}
