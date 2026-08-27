import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReasoningPath, ReasoningStep } from './reasoning-path';

function Trace({ divergenceIndex }: { divergenceIndex?: number | null }) {
  return (
    <ReasoningPath divergenceIndex={divergenceIndex ?? null}>
      <ReasoningStep index={0} label="Starting value" state="valid">
        Starts at −3
      </ReasoningStep>
      <ReasoningStep index={1} label="Operation" state="valid">
        Add 7
      </ReasoningStep>
      <ReasoningStep index={2} label="Why?" state="faultline">
        How far apart they are
      </ReasoningStep>
      <ReasoningStep index={3} label="Result" state="downstream" isLast>
        10
      </ReasoningStep>
    </ReasoningPath>
  );
}

describe('ReasoningPath', () => {
  it('renders the trace as an ordered list, since step order is meaningful', () => {
    render(<Trace divergenceIndex={2} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('numbers steps from 01 so the trace reads as a sequence', () => {
    render(<Trace divergenceIndex={2} />);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('04')).toBeInTheDocument();
  });

  it('exposes each step state on the element for styling and assertions', () => {
    render(<Trace divergenceIndex={2} />);
    const [first, , third, fourth] = screen.getAllByRole('listitem');
    expect(first).toHaveAttribute('data-state', 'valid');
    expect(third).toHaveAttribute('data-state', 'faultline');
    expect(fourth).toHaveAttribute('data-state', 'downstream');
  });

  it('marks at most one step as the faultline', () => {
    render(<Trace divergenceIndex={2} />);
    const faults = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('data-state') === 'faultline');
    expect(faults).toHaveLength(1);
  });

  it('renders a trace with no divergence without a faultline step', () => {
    render(
      <ReasoningPath divergenceIndex={null}>
        <ReasoningStep index={0} label="Starting value" state="valid">
          Starts at −3
        </ReasoningStep>
        <ReasoningStep index={1} label="Result" state="valid" isLast>
          4
        </ReasoningStep>
      </ReasoningPath>,
    );
    const faults = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('data-state') === 'faultline');
    expect(faults).toHaveLength(0);
  });

  it('keeps the rail decorative so screen readers hear reasoning, not geometry', () => {
    const { container } = render(<Trace divergenceIndex={2} />);
    const rails = container.querySelectorAll('[aria-hidden="true"]');
    expect(rails.length).toBeGreaterThan(0);
  });
});
