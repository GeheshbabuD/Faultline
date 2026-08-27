import { test, expect, type Page } from '@playwright/test';

/**
 * The guided reasoning flow, end to end against a real database.
 *
 * Uses the elevator problem, whose canonical answer is 4.
 */

const PROBLEM = '/practice/int-sub-elevator-ascent';

const RESPONSES = [
  'The elevator starts at -3.',
  'Moving up means I add 7, so -3 + 7.',
  'Counting up from -3 passes zero after 3 floors, leaving 4 more.',
  '4',
];

/**
 * Types into the open step and confirms it.
 *
 * Real key events rather than `fill()`: WebKit's fill sets the DOM value
 * without triggering React's onChange, so a controlled input silently reverts.
 * Typing is what a student actually does, and it exercises the same path.
 */
async function typeInto(page: Page, text: string) {
  const input = page.getByRole('textbox');
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially(text);
}

async function answerStep(page: Page, text: string) {
  await typeInto(page, text);
  await page.getByRole('button', { name: /Next step|Done/ }).click();
}

async function completeTrace(page: Page, responses: string[] = RESPONSES) {
  for (const response of responses) {
    await answerStep(page, response);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(PROBLEM);
  // Start from a clean draft so runs do not leak into each other.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test('practice list shows the authored problem set', async ({ page }) => {
  await page.goto('/practice');
  const links = page.getByRole('link', { name: /elevator|temperature|submarine|8 − 13/i });
  await expect(links.first()).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(8);
});

test('reveals one step at a time and keeps answered steps visible', async ({ page }) => {
  const steps = page.getByRole('listitem');
  await expect(steps).toHaveCount(4);

  // Only the first step is open; the rest are not yet reached.
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'pending');
  await expect(page.getByText('Not yet reached').first()).toBeVisible();

  await answerStep(page, RESPONSES[0]!);

  // The answered step stays on screen with its response.
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'complete');
  await expect(steps.nth(0)).toContainText(RESPONSES[0]!);
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'active');
});

test('does not advance past an empty step', async ({ page }) => {
  await page.getByRole('button', { name: 'Next step' }).click();
  // Scoped to the field: Next's route announcer also carries role="alert".
  const input = page.getByRole('textbox');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Answer this step before submitting')).toBeVisible();
  await expect(page.getByRole('listitem').nth(0)).toHaveAttribute('data-state', 'active');
});

test('an earlier step can be revised before submitting', async ({ page }) => {
  await answerStep(page, RESPONSES[0]!);
  await answerStep(page, RESPONSES[1]!);

  await page.getByRole('button', { name: 'Edit' }).first().click();
  await typeInto(page, 'Actually it starts at -3, three below ground.');
  await page.getByRole('button', { name: 'Save change' }).click();

  await expect(page.getByRole('listitem').nth(0)).toContainText('three below ground');
  await expect(page.getByRole('listitem').nth(0)).toContainText('Revised 1 time');
});

test('the draft survives a reload', async ({ page }) => {
  await answerStep(page, RESPONSES[0]!);
  await answerStep(page, RESPONSES[1]!);

  // Allow the debounced write to flush.
  await page.waitForTimeout(700);
  await page.reload();

  await expect(page.getByRole('listitem').nth(0)).toContainText(RESPONSES[0]!);
  await expect(page.getByRole('listitem').nth(1)).toContainText(RESPONSES[1]!);
});

test('Ctrl+Enter confirms a step without using the mouse', async ({ page }) => {
  await typeInto(page, RESPONSES[0]!);
  await page.getByRole('textbox').press('ControlOrMeta+Enter');
  await expect(page.getByRole('listitem').nth(0)).toHaveAttribute('data-state', 'complete');
});

test('submitting persists the trace and reports answer and reasoning separately', async ({
  page,
}) => {
  await completeTrace(page);

  await page.getByRole('button', { name: 'Submit reasoning' }).click();
  await page.waitForURL(/\/attempts\/[0-9a-f-]+$/);

  // Two independent readings: the answer is graded, the reasoning is not.
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  await expect(page.getByText('Not yet analysed')).toBeVisible();

  // The full trace is persisted and shown back.
  for (const response of RESPONSES) {
    await expect(page.getByText(response, { exact: false }).first()).toBeVisible();
  }
});

test('a wrong answer is recorded as wrong while reasoning stays unjudged', async ({
  page,
}) => {
  await completeTrace(page, [
    'It starts at -3.',
    'I need the gap between -3 and 7.',
    'The gap between them is 10.',
    '10',
  ]);

  await page.getByRole('button', { name: 'Submit reasoning' }).click();
  await page.waitForURL(/\/attempts\/[0-9a-f-]+$/);

  await expect(page.getByText('Not correct')).toBeVisible();
  await expect(page.getByText('Not yet analysed')).toBeVisible();
});

test('the draft is cleared once the trace is submitted', async ({ page }) => {
  await completeTrace(page);
  await page.getByRole('button', { name: 'Submit reasoning' }).click();
  await page.waitForURL(/\/attempts\/[0-9a-f-]+$/);

  await page.goto(PROBLEM);
  await expect(page.getByRole('listitem').nth(0)).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('textbox')).toHaveValue('');
});

test('canonical reasoning never reaches the browser', async ({ page }) => {
  const html = await page.content();
  // Text that only exists in the authored `expected` / `rationale` fields.
  expect(html).not.toContain('because moving up increases the value');
  expect(html).not.toContain('Upward movement adds');
});
