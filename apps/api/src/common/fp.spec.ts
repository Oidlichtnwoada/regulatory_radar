import { describe, expect, it } from 'vitest';
import { mapLimit, sleep } from './fp.js';

describe('mapLimit', () => {
  it('keeps the input order and never exceeds the limit', async () => {
    const state = { running: 0, peak: 0 };
    const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms) => {
      state.peak = Math.max(state.peak, ++state.running);
      await sleep(ms);
      state.running--;
      return ms * 2;
    });
    expect(out).toEqual([60, 10, 40, 2, 20]);
    expect(state.peak).toBe(2);
  });

  it('starts the next item as soon as any slot is free, not after the whole chunk', async () => {
    const finished = new Set<number>();
    const seenAtStart: boolean[] = [];
    await mapLimit([0, 1, 2], 2, async (i) => {
      if (i === 2) seenAtStart.push(finished.has(0));
      await sleep(i === 0 ? 50 : 1);
      finished.add(i);
    });
    // Item 2 starts while the slow item 0 is still running.
    expect(seenAtStart).toEqual([false]);
  });
});
