import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { loadTaxonomy } from '../domain/nace.js';
import { configuredSources } from './registry.js';

const tax = loadTaxonomy(join(import.meta.dirname, '../../../../data/nace_rev2_1.csv'));
const enabled = (vars: Record<string, string>) =>
  configuredSources(loadEnv(vars), tax)
    .filter((s) => s.enabled)
    .map((s) => s.adapter.descriptor.id);

describe('source switches', () => {
  it('streams only the seed file by default', () => {
    expect(enabled({})).toEqual(['file']);
  });

  it('can switch off the seed file and run live sources only', () => {
    expect(
      enabled({ SOURCE_FILE_ENABLED: 'false', SOURCE_EURLEX_ENABLED: 'true', SOURCE_BOE_ENABLED: 'true' }),
    ).toEqual(['eurlex', 'es_boe']);
  });
});
