import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { databaseUrlFor, type Env } from '../config/env.js';

/** Creates the database of the current mode if needed, then applies all Prisma migrations to it. */
export const migrate = async (env: Env): Promise<void> => {
  const target = new URL(databaseUrlFor(env));
  const name = target.pathname.slice(1);
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target.toString() },
  });
};
