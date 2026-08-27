import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfidenceIndicator } from './confidence';

describe('ConfidenceIndicator', () => {
  it('exposes the reading to assistive technology as a meter', () => {
    render(<ConfidenceIndicator value={0.91} band="high" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '91');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAccessibleName('High confidence, 91 percent');
  });

  it('renders the value as a whole percentage', () => {
    render(<ConfidenceIndicator value={0.684} band="moderate" />);
    expect(screen.getByText('68%')).toBeInTheDocument();
  });

  it('clamps values outside 0..1 rather than overflowing the scale', () => {
    const { rerender } = render(<ConfidenceIndicator value={1.4} band="high" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');

    rerender(<ConfidenceIndicator value={-0.3} band="low" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('states the band in words, so confidence is never a bare number', () => {
    render(<ConfidenceIndicator value={0.42} band="low" />);
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });
});
