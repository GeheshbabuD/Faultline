import { test, expect } from '@playwright/test';

/**
 * Phase 1 smoke coverage: the shell renders, the design system route is real,
 * and the theme switch actually reaches the document. Product flows arrive with
 * the features that own them.
 */

test('home page states the product thesis', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Debug the reasoning');
});

test('design system route renders the reasoning path', async ({ page }) => {
  await page.goto('/design');
  await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();

  // The faultline scenario is the default; the trace must render as a list.
  const steps = page.getByRole('listitem').filter({ hasText: 'Why?' });
  await expect(steps.first()).toHaveAttribute('data-state', 'faultline');
});

test('theme toggle switches the document theme and persists it', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', /light|dark/);

  const initial = await html.getAttribute('data-theme');
  await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
  await expect(html).not.toHaveAttribute('data-theme', initial!);

  await page.reload();
  await expect(html).not.toHaveAttribute('data-theme', initial!);
});

test('reasoning scenarios switch the trace state', async ({ page }) => {
  await page.goto('/design');
  await page.getByRole('button', { name: 'After repair' }).click();
  const repaired = page.getByRole('listitem').filter({ hasText: 'Why?' });
  await expect(repaired.first()).toHaveAttribute('data-state', 'repaired');
});
