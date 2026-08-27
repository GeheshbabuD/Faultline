import type { ConceptInput } from '@/core/content/schema';

/**
 * The concept registry.
 *
 * Concepts are shared across problems so that concept-health reporting
 * aggregates correctly and labels cannot drift between problems.
 */
export const concepts = [
  {
    key: 'signed_number_position',
    label: 'Position on the number line',
    subject: 'mathematics',
    description:
      'Reading a signed value as a position, including values below zero.',
  },
  {
    key: 'signed_number_direction',
    label: 'Direction of change',
    subject: 'mathematics',
    description:
      'Interpreting increase and decrease as movement along the number line, independent of the sign of the starting value.',
  },
  {
    key: 'subtraction_operation',
    label: 'Subtraction as an operation',
    subject: 'mathematics',
    description:
      'Translating a described change into a subtraction or addition expression in the correct order.',
  },
  {
    key: 'subtraction_order',
    label: 'Order of operands',
    subject: 'mathematics',
    description:
      'Recognising that subtraction is not commutative: a − b and b − a differ in sign.',
  },
  {
    key: 'signed_difference_vs_distance',
    label: 'Difference versus distance',
    subject: 'mathematics',
    description:
      'Distinguishing a signed difference from the unsigned distance between two values.',
  },
  {
    key: 'crossing_zero',
    label: 'Crossing zero',
    subject: 'mathematics',
    description:
      'Counting continuously through zero rather than treating it as a boundary or a stopping point.',
  },
  {
    key: 'signed_result_interpretation',
    label: 'Interpreting a signed result',
    subject: 'mathematics',
    description:
      'Stating the result with the correct sign and relating it back to the situation described.',
  },
] as const satisfies readonly ConceptInput[];
