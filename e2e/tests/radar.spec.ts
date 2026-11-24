import { expect, type Page, test } from '@playwright/test';

/** Tier order of the API ranking (most urgent first). */
const TIER_ORDER = ['open_window', 'upcoming_vote', 'standstill', 'in_procedure', 'adopted', 'information'];

/** Picks options from the country select and the NACE autocomplete. */
const select = async (
  page: Page,
  countries: readonly string[],
  naceCodes: readonly string[],
): Promise<void> => {
  await page.getByTestId('country-select').click();
  for (const c of countries) {
    const option = page.getByTestId(`country-option-${c}`);
    if ((await option.getAttribute('aria-selected')) !== 'true') await option.click();
  }
  await page.keyboard.press('Escape');
  for (const code of naceCodes) {
    if ((await page.getByTestId(`nace-chip-${code}`).count()) > 0) continue;
    await page.getByTestId('nace-input').fill(code);
    await page.getByTestId(`nace-option-${code}`).click();
  }
};

test('shows the offline / no-API-key warning banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('system-warning')).toBeVisible();
});

test('metals desk in Austria sees climate items, ranked by actionability, with why-relevant and source trail', async ({
  page,
}) => {
  await page.goto('/');
  await select(page, ['AT'], ['C24']);
  await expect(page.getByTestId('denominator')).toContainText('hits out of');
  const entries = page.getByTestId('radar-entry');
  await expect(entries.first()).toBeVisible();
  await expect(
    page
      .getByTestId('entry-title')
      .filter({ hasText: /emission|carbon/i })
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('why-relevant').first()).not.toBeEmpty();

  const tiers = await entries.evaluateAll((els) => els.map((el) => el.getAttribute('data-tier') ?? ''));
  const ranks = tiers.map((t) => TIER_ORDER.indexOf(t));
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(ranks[0]).toBeLessThan(TIER_ORDER.indexOf('adopted'));
});

test('the selection persists across reloads (stored in Postgres)', async ({ page }) => {
  await page.goto('/');
  await select(page, ['AT'], ['C25']);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/api/v1/profile')).json()) as { naceCodes: string[] }).naceCodes,
    )
    .toContain('C25');
  await page.reload();
  await expect(page.getByTestId('nace-chip-C25')).toBeVisible();
});

test('sources page shows the file source as healthy', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.getByTestId('health-file')).toHaveText('ok');
});

test('raw imports list the seed items in the common schema', async ({ page }) => {
  await page.goto('/findings');
  await expect(page.getByTestId('findings-total')).toContainText(/\d+ findings/);
  const total = Number((await page.getByTestId('findings-total').textContent())?.match(/\d+/)?.[0]);
  expect(total).toBeGreaterThanOrEqual(53);
  await expect(page.getByTestId('finding-row').first()).toBeVisible();
});

/** Subset of the API's profile and preset shapes used here. */
interface Selection {
  readonly countries: string[];
  readonly naceCodes: string[];
  readonly acknowledgedAt?: string | null;
}

/**
 * Values of a list query parameter (comma-separated or repeated).
 * @param url Request URL.
 * @param name Parameter name.
 */
const listParam = (url: string, name: string): string[] =>
  new URL(url).searchParams.getAll(name).flatMap((v) => v.split(','));

test('an example profile selects its countries and NACE Rev. 2.1 codes like a manual selection', async ({
  page,
}) => {
  const saved = (await (await page.request.get('/api/v1/profile')).json()) as Selection;
  const presets = (await (await page.request.get('/api/v1/profiles/presets')).json()) as (Selection & {
    id: string;
  })[];
  const retail = presets.find((p) => p.id === 'retail_es');
  expect(retail).toBeDefined();
  if (!retail) return;
  try {
    await page.goto('/');
    const radarRequest = page.waitForRequest(
      (r) => r.url().includes('/api/v1/radar') && listParam(r.url(), 'countries').join() === 'ES',
    );
    await page.getByTestId('preset-retail_es').click();

    const url = (await radarRequest).url();
    expect(listParam(url, 'naceCodes').sort()).toEqual([...retail.naceCodes].sort());
    await expect(page.getByTestId('country-select')).toContainText('ES');
    for (const code of retail.naceCodes) await expect(page.getByTestId(`nace-chip-${code}`)).toBeVisible();
    await expect(page.getByTestId('preset-retail_es')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preset-note')).toContainText('NACE Rev. 2 codes G47');
    await expect
      .poll(async () => ((await (await page.request.get('/api/v1/profile')).json()) as Selection).countries)
      .toEqual(['ES']);
  } finally {
    await page.request.put('/api/v1/profile', {
      data: {
        countries: saved.countries,
        naceCodes: saved.naceCodes,
        acknowledgedAt: saved.acknowledgedAt ?? null,
      },
    });
  }
});
