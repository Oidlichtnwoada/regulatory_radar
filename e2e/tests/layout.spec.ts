import { expect, test } from '@playwright/test';

/** A seeded procedure group with a reaction (source trail of two members). */
const GROUP_KEY = 'AT-PAR-0016';

test.describe('phone layout (390 × 844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('no page scrolls horizontally', async ({ page }) => {
    const { items } = (await (await page.request.get('/api/v1/findings?limit=1')).json()) as {
      items: { id: string }[];
    };
    /** Each page with an element that shows its content has rendered. */
    const pages: readonly (readonly [string, string])[] = [
      ['/', 'denominator'],
      [`/groups/${GROUP_KEY}`, 'source-trail'],
      ['/findings', 'finding-row'],
      [`/findings/${items[0]?.id}`, 'finding-fields'],
      ['/sources', 'health-file'],
    ];
    for (const [path, testId] of pages) {
      await page.goto(path);
      await expect(page.getByTestId(testId).first()).toBeVisible();
      const [scrollWidth, innerWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        window.innerWidth,
      ]);
      expect(scrollWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(innerWidth);
    }
  });
});
