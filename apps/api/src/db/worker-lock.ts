import { Client } from 'pg';

/** Advisory lock key of the pipeline loop (one pipeline worker per database). */
export const PIPELINE_LOCK_KEY = 74_201_101;

/** A held session-level advisory lock; `release` unlocks it and closes its connection. */
export interface HeldLock {
  /** Unlocks and closes the dedicated connection. */
  readonly release: () => Promise<void>;
}

/**
 * Tries to take a session-level advisory lock on a dedicated connection (it is held as long as that connection
 * lives, so a crashed worker frees it automatically). Null when another process holds it.
 */
export const tryAdvisoryLock = async (databaseUrl: string, key: number): Promise<HeldLock | null> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // An error on the idle lock connection (e.g. a database restart) must not crash the process; the lock is lost then.
  client.on('error', () => undefined);
  const { rows } = await client
    .query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key])
    .catch(async (e: unknown) => {
      await client.end().catch(() => undefined);
      throw e;
    });
  if (!rows[0]?.locked) {
    await client.end();
    return null;
  }
  return {
    release: async () => {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
};
