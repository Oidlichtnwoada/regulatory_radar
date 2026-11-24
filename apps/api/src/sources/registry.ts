import { isAbsolute, join } from 'node:path';
import type { Env } from '../config/env.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import { boeSource } from './boe.source.js';
import { eurlexSource } from './eurlex.source.js';
import { fileSource } from './file.source.js';
import type { SourceAdapter } from './source.types.js';

/** A configured source and whether the .env enables it. */
export interface ConfiguredSource {
  /** The adapter. */
  readonly adapter: SourceAdapter;
  /** SOURCE_*_ENABLED. */
  readonly enabled: boolean;
}

/** Builds every known source from the configuration; disabled ones are listed but not streamed. */
export const configuredSources = (env: Env, tax: NaceTaxonomy): readonly ConfiguredSource[] => {
  const timeoutMs = env.SOURCE_HTTP_TIMEOUT_SECONDS * 1000;
  const filePath = isAbsolute(env.SOURCE_FILE_PATH)
    ? env.SOURCE_FILE_PATH
    : join(env.DATA_DIR, env.SOURCE_FILE_PATH);
  return [
    {
      enabled: env.SOURCE_FILE_ENABLED,
      adapter: fileSource(tax, {
        path: filePath,
        since: env.SOURCE_FILE_SINCE,
        pollSeconds: env.SOURCE_FILE_POLL_SECONDS,
        batchSize: env.SOURCE_FILE_BATCH_SIZE,
      }),
    },
    {
      enabled: env.SOURCE_EURLEX_ENABLED,
      adapter: eurlexSource({
        since: env.SOURCE_EURLEX_SINCE,
        lookbackDays: env.SOURCE_EURLEX_LOOKBACK_DAYS,
        rescanDays: env.SOURCE_EURLEX_RESCAN_DAYS,
        celexPattern: env.SOURCE_EURLEX_CELEX_PATTERN,
        pageSize: env.SOURCE_EURLEX_PAGE_SIZE,
        pollSeconds: env.SOURCE_EURLEX_POLL_SECONDS,
        timeoutMs,
      }),
    },
    {
      enabled: env.SOURCE_BOE_ENABLED,
      adapter: boeSource({
        since: env.SOURCE_BOE_SINCE,
        lookbackDays: env.SOURCE_BOE_LOOKBACK_DAYS,
        sections: env.SOURCE_BOE_SECTIONS,
        departments: env.SOURCE_BOE_DEPARTMENTS,
        pollSeconds: env.SOURCE_BOE_POLL_SECONDS,
        timeoutMs,
      }),
    },
  ];
};
