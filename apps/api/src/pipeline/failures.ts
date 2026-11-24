import type { Logger } from '@nestjs/common';

/**
 * Logs one warning per stage and cycle when items failed (their failure is also stored and retried): how many, what
 * happens next and the first error, so e.g. an exhausted API quota shows up in the logs, not only in the database.
 */
export const warnFailures = (
  log: Pick<Logger, 'warn'>,
  what: string,
  total: number,
  errors: readonly string[],
  next: string,
): void => {
  if (errors.length > 0)
    log.warn(`${errors.length} of ${total} ${what} failed (${next}): ${errors[0]?.slice(0, 300)}`);
};
