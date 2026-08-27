import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, Label, Input, Textarea } from './field';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(
      <Field>
        <Label>What is the starting value?</Label>
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('What is the starting value?')).toBeInTheDocument();
  });

  it('describes the control with its hint text', () => {
    render(
      <Field description="Use the value before any movement.">
        <Label>Starting value</Label>
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Starting value')).toHaveAccessibleDescription(
      'Use the value before any movement.',
    );
  });

  it('marks the control invalid and points at the error when one is present', () => {
    render(
      <Field error="Enter your reasoning before continuing.">
        <Label>Why?</Label>
        <Textarea />
      </Field>,
    );
    const control = screen.getByLabelText('Why?');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription('Enter your reasoning before continuing.');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('suppresses the hint while an error is showing, so only one message is announced', () => {
    render(
      <Field description="A hint" error="An error">
        <Label>Step</Label>
        <Input />
      </Field>,
    );
    expect(screen.queryByText('A hint')).not.toBeInTheDocument();
    expect(screen.getByText('An error')).toBeInTheDocument();
  });

  it('refuses to render a control outside a Field rather than silently losing its label', () => {
    expect(() => render(<Input />)).toThrow(/must be used inside a <Field>/);
  });
});
