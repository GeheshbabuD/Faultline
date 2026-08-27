import type { ProblemInput } from '@/core/content/schema';

/**
 * Integer subtraction and signed-number reasoning.
 *
 * The set is built so that different problems can surface different failures,
 * rather than repeating one shape with new numbers:
 *
 *   - bare arithmetic with no story to lean on
 *   - contexts where "up"/"down" must be mapped onto sign
 *   - a two-value difference, where distance and signed difference disagree
 *   - subtracting a negative, where a sign flip is required
 *   - a problem whose answer is zero, so crossing zero cannot be dodged
 *   - a problem where the common wrong rule produces the RIGHT answer, which
 *     is what makes reasoning-level analysis worth doing at all
 *
 * Misconception ids below are provisional. The curated taxonomy is authored in
 * Phase 4; these ids follow the product specification (SUB_001 commutativity,
 * SUB_002 absolute difference, SUB_003 sign reversal, SUB_004 direction
 * confusion) and must be reconciled against the real taxonomy then.
 */

const STEP_LABELS = {
  start: 'Starting value',
  operation: 'Operation',
  why: 'Why?',
  result: 'Result',
} as const;

export const integerSubtractionProblems = [
  {
    slug: 'int-sub-elevator-ascent',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'foundational',
    statement:
      'An elevator is on floor −3 and moves up 7 floors. What floor does it reach?',
    canonicalAnswer: '4',
    acceptedAnswers: ['+4', 'floor 4', '4th floor'],
    conceptKeys: [
      'signed_number_position',
      'signed_number_direction',
      'crossing_zero',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'signed_number_direction',
    misconceptionIds: ['SUB_002', 'SUB_004'],
    authorNote:
      'Students who read this as "the gap between −3 and 7" answer 10. Students who treat the minus sign as a barrier answer 7 or stop at 0.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What value does the elevator start at?',
          conceptKey: 'signed_number_position',
          expected: '−3, three floors below ground level.',
          rationale:
            'The starting value is a position on the number line, not a distance from zero.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'What calculation does "moves up 7 floors" describe?',
          conceptKey: 'signed_number_direction',
          expected: '−3 + 7, because moving up increases the value.',
          rationale:
            'Upward movement adds, regardless of whether the starting value is negative.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'Why does that calculation match the situation?',
          conceptKey: 'crossing_zero',
          expected:
            'Counting up 7 from −3 passes through 0 after 3 floors, leaving 4 more to climb.',
          rationale:
            'Zero is a position the count passes through, not a boundary where counting restarts.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What floor does the elevator reach?',
          conceptKey: 'signed_result_interpretation',
          expected: '4',
          rationale: 'The result is positive, so the elevator ends above ground level.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-temperature-drop',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'foundational',
    statement:
      'At noon the temperature was 5 °C. By midnight it had fallen 13 degrees. What was the temperature at midnight?',
    canonicalAnswer: '-8',
    acceptedAnswers: ['−8', '-8 °C', '-8 degrees', '8 below zero'],
    conceptKeys: [
      'signed_number_position',
      'signed_number_direction',
      'subtraction_order',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'subtraction_order',
    misconceptionIds: ['SUB_001', 'SUB_002'],
    authorNote:
      'The commutativity error (13 − 5) and the absolute-difference error both produce 8, so the answer alone cannot separate them. The reasoning steps can.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What temperature does the day start at?',
          conceptKey: 'signed_number_position',
          expected: '5 °C.',
          rationale: 'The starting value is the noon temperature.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'What calculation does "fell 13 degrees" describe?',
          conceptKey: 'subtraction_order',
          expected: '5 − 13, starting from 5 and removing 13.',
          rationale:
            'The starting value comes first. 13 − 5 describes a different situation and gives the opposite sign.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'Why is the result below zero?',
          conceptKey: 'signed_number_direction',
          expected:
            'Only 5 degrees can be removed before reaching 0; the remaining 8 continue below zero.',
          rationale:
            'When the amount removed exceeds the starting value, the result passes below zero.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What was the temperature at midnight?',
          conceptKey: 'signed_result_interpretation',
          expected: '−8 °C',
          rationale: 'A negative result means a temperature below zero.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-bare-expression',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'foundational',
    statement: 'Work out 8 − 13.',
    canonicalAnswer: '-5',
    acceptedAnswers: ['−5'],
    conceptKeys: ['subtraction_order', 'crossing_zero', 'signed_result_interpretation'],
    primaryConceptKey: 'subtraction_order',
    misconceptionIds: ['SUB_001', 'SUB_002'],
    authorNote:
      'No story to lean on. Isolates whether the student can order operands and cross zero without contextual scaffolding.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'Which number is the starting value, and which is being removed?',
          conceptKey: 'subtraction_order',
          expected: '8 is the starting value; 13 is being removed from it.',
          rationale:
            'In a − b the first operand is the starting value. Swapping them changes the sign of the result.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'What happens when you remove 13 from 8?',
          conceptKey: 'crossing_zero',
          expected:
            'Removing 8 reaches 0, and the remaining 5 continue below zero.',
          rationale: 'The count continues past zero into negative values.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What is 8 − 13?',
          conceptKey: 'signed_result_interpretation',
          expected: '−5',
          rationale:
            'The answer is negative because more was removed than the starting value held.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-submarine-descent',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'developing',
    statement:
      'A submarine is at −120 m. It descends a further 80 m. What is its new depth?',
    canonicalAnswer: '-200',
    acceptedAnswers: ['−200', '-200 m', '200 m below sea level'],
    conceptKeys: [
      'signed_number_position',
      'signed_number_direction',
      'subtraction_operation',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'signed_number_direction',
    misconceptionIds: ['SUB_003', 'SUB_004'],
    authorNote:
      'Descending from an already negative value. Students who treat "descend" as subtract-the-magnitude answer −40.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What depth does the submarine start at?',
          conceptKey: 'signed_number_position',
          expected: '−120 m, which is 120 m below sea level.',
          rationale: 'Depth below sea level is represented by a negative value.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'What calculation does "descends a further 80 m" describe?',
          conceptKey: 'signed_number_direction',
          expected: '−120 − 80, because descending decreases the value.',
          rationale:
            'Descending always decreases the value, so the magnitude of a negative depth grows.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'Why does the value become more negative rather than less?',
          conceptKey: 'subtraction_operation',
          expected:
            'The submarine is moving further from the surface, so it moves further along the negative direction.',
          rationale:
            'Moving away from zero on the negative side increases depth and decreases the signed value.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What is the new depth?',
          conceptKey: 'signed_result_interpretation',
          expected: '−200 m',
          rationale: 'The submarine is now 200 m below sea level.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-subtracting-a-negative',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'proficient',
    statement: 'Work out −4 − (−9).',
    canonicalAnswer: '5',
    acceptedAnswers: ['+5'],
    conceptKeys: [
      'subtraction_operation',
      'signed_number_direction',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'subtraction_operation',
    misconceptionIds: ['SUB_003'],
    authorNote:
      'Subtracting a negative. The common errors are −13 (treating it as −4 − 9) and −5 (flipping the wrong sign).',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What is the starting value, and what is being removed from it?',
          conceptKey: 'subtraction_operation',
          expected: 'Starting at −4, and removing −9.',
          rationale: 'The amount being removed is itself negative.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'How can removing −9 be rewritten?',
          conceptKey: 'signed_number_direction',
          expected: '−4 + 9, because subtracting a negative adds.',
          rationale:
            'Removing a debt of 9 leaves you 9 better off; the two minus signs combine into an addition.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What is −4 − (−9)?',
          conceptKey: 'signed_result_interpretation',
          expected: '5',
          rationale: 'Counting up 9 from −4 passes zero and reaches 5.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-elevation-change',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'proficient',
    statement:
      'A hiker starts at an elevation of 340 m and finishes at −12 m. What is the change in elevation from start to finish?',
    canonicalAnswer: '-352',
    acceptedAnswers: ['−352', '-352 m', 'a decrease of 352 m'],
    conceptKeys: [
      'subtraction_order',
      'signed_difference_vs_distance',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'signed_difference_vs_distance',
    misconceptionIds: ['SUB_001', 'SUB_002'],
    authorNote:
      'Change is finish minus start, so the order is fixed by the question. 352 (the distance travelled) is the seductive wrong answer.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'Which value is the start and which is the finish?',
          conceptKey: 'subtraction_order',
          expected: 'Start is 340 m; finish is −12 m.',
          rationale: 'A change is measured from the start to the finish, in that order.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'What calculation gives the change in elevation?',
          conceptKey: 'subtraction_order',
          expected: '−12 − 340, which is finish minus start.',
          rationale:
            'Change is always finish minus start. Reversing it reports the change of the return journey.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'Why is the change negative rather than 352?',
          conceptKey: 'signed_difference_vs_distance',
          expected:
            'The hiker ended lower than they started, so the change is a decrease. 352 m is the distance moved, not the change.',
          rationale:
            'Distance is unsigned; a change carries a direction and therefore a sign.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What is the change in elevation?',
          conceptKey: 'signed_result_interpretation',
          expected: '−352 m',
          rationale: 'A negative change means the elevation decreased.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-account-overdraft',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'developing',
    statement:
      'A bank account holds −45 pounds. A payment of 60 pounds is deposited. What is the new balance?',
    canonicalAnswer: '15',
    acceptedAnswers: ['+15', '15 pounds', '£15'],
    conceptKeys: [
      'signed_number_position',
      'crossing_zero',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'crossing_zero',
    misconceptionIds: ['SUB_002', 'SUB_004'],
    authorNote:
      'Clearing a debt and finishing in credit. Students who stop counting at zero answer 0 or 45.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What is the starting balance?',
          conceptKey: 'signed_number_position',
          expected: '−45 pounds, meaning the account is overdrawn by 45.',
          rationale: 'A negative balance represents money owed.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'What happens to the balance as the 60 pounds is deposited?',
          conceptKey: 'crossing_zero',
          expected:
            'The first 45 clears the debt and brings the balance to 0; the remaining 15 goes into credit.',
          rationale:
            'The deposit does not stop at zero — the remainder continues into positive values.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What is the new balance?',
          conceptKey: 'signed_result_interpretation',
          expected: '15 pounds',
          rationale: 'The account finishes in credit by 15.',
          isAnswerStep: true,
        },
      ],
    },
  },

  {
    slug: 'int-sub-symmetric-trap',
    subject: 'mathematics',
    topic: 'Integer subtraction',
    difficulty: 'developing',
    statement:
      'The temperature at dawn was −6 °C. By noon it had risen 6 degrees. What was the temperature at noon?',
    canonicalAnswer: '0',
    acceptedAnswers: ['0 °C', 'zero', '0 degrees'],
    conceptKeys: [
      'signed_number_position',
      'signed_difference_vs_distance',
      'crossing_zero',
      'signed_result_interpretation',
    ],
    primaryConceptKey: 'signed_difference_vs_distance',
    misconceptionIds: ['SUB_001', 'SUB_002'],
    authorNote:
      'THE CORRECT-ANSWER TRAP. Because the two magnitudes are equal, the absolute-difference rule (|−6 − 6| ... or "the gap between them") and the commutativity error both still land on 0. Only the reasoning trace can distinguish a student who understands this from one who is applying a rule that will fail on the very next problem.',
    reference: {
      version: 1,
      steps: [
        {
          label: STEP_LABELS.start,
          prompt: 'What temperature does the day start at?',
          conceptKey: 'signed_number_position',
          expected: '−6 °C.',
          rationale: 'Six degrees below zero.',
        },
        {
          label: STEP_LABELS.operation,
          prompt: 'What calculation does "risen 6 degrees" describe?',
          conceptKey: 'signed_difference_vs_distance',
          expected: '−6 + 6, because a rise increases the value.',
          rationale:
            'A rise is an increase applied to the starting value, not a comparison between two temperatures.',
        },
        {
          label: STEP_LABELS.why,
          prompt: 'Why does the temperature reach exactly zero?',
          conceptKey: 'crossing_zero',
          expected:
            'Rising 6 from −6 covers exactly the distance back to zero, with nothing left over.',
          rationale:
            'The rise happens to equal the starting distance from zero, so the result lands on zero.',
        },
        {
          label: STEP_LABELS.result,
          prompt: 'What was the temperature at noon?',
          conceptKey: 'signed_result_interpretation',
          expected: '0 °C',
          rationale: 'The temperature reached freezing point exactly.',
          isAnswerStep: true,
        },
      ],
    },
  },
] as const satisfies readonly ProblemInput[];
