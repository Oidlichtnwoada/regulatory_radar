import { createHmac } from 'node:crypto';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryConfig } from 'pg';

/** Login role of the agents' SQL tool: SELECT on the pipeline tables only, no superuser, no role memberships. */
export const AGENT_READER_ROLE = 'radar_agent_reader';

/** Rows an agent query returns at most. */
export const AGENT_SQL_MAX_ROWS = 50;

/** Characters of one result row (as JSON) handed back at most. */
const MAX_ROW_CHARS = 2000;

/** Runs one model-written query and returns its rows (at most AGENT_SQL_MAX_ROWS). */
export type SqlReader = (sql: string) => Promise<readonly unknown[]>;

/**
 * Password of the reader role, derived from the main connection's password (HMAC-SHA256), so no extra secret is
 * configured or committed and every process of a deployment derives the same one. Pure.
 */
export const agentReaderPassword = (databaseUrl: string): string =>
  createHmac('sha256', decodeURIComponent(new URL(databaseUrl).password))
    .update(AGENT_READER_ROLE)
    .digest('hex');

/** The main database URL with the reader role's credentials. Pure. */
export const agentReaderUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  url.username = AGENT_READER_ROLE;
  url.password = agentReaderPassword(databaseUrl);
  return url.toString();
};

/**
 * Statement that lets the reader role log in with its derived password and pins its attributes. Executed with the
 * main (owner) connection; the hex password needs no quoting beyond the literal.
 */
export const agentReaderLoginSql = (databaseUrl: string): string =>
  `ALTER ROLE ${AGENT_READER_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION ` +
  `NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${agentReaderPassword(databaseUrl)}'`;

/**
 * The cursor statement around a model-written query. The query sits on its own lines, so a trailing `--` comment
 * cannot swallow the wrapper; each row comes back as JSON text cut at MAX_ROW_CHARS. Pure.
 */
export const agentCursorSql = (sql: string): string => {
  const body = sql.trim().replace(/;\s*$/, '');
  return `DECLARE agent_cursor NO SCROLL CURSOR FOR SELECT left(row_to_json(agent_query)::text, ${MAX_ROW_CHARS}) AS row FROM (\n${body}\n) AS agent_query`;
};

/** A row's JSON text as an object, or the cut text itself when it was truncated. Pure. */
const parsedRow = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { truncated: text };
  }
};

/** Runs the cursor of one query in a READ ONLY transaction with a 5 s timeout and returns the first rows. */
const runReadOnly = async (client: PoolClient, sql: string): Promise<readonly unknown[]> => {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await client.query("SET LOCAL work_mem = '16MB'");
    // Extended protocol: exactly one statement, so nothing can follow the query (no COMMIT, no second statement).
    // (queryMode is supported by pg at runtime but missing from its type definitions.)
    const extended: QueryConfig & { readonly queryMode: 'extended' } = {
      text: agentCursorSql(sql),
      queryMode: 'extended',
    };
    await client.query(extended);
    const { rows } = await client.query<{ row: string }>(`FETCH ${AGENT_SQL_MAX_ROWS} FROM agent_cursor`);
    return rows.map((r) => parsedRow(r.row));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
};

/**
 * The agents' SQL tool backend. It connects as its own non-superuser login role (radar_agent_reader), so a query
 * cannot switch to the owner's role (`set_config('role', ...)` needs membership, which the reader does not have)
 * or reach superuser-only functions. The role's login is enabled lazily on first use with the owner connection.
 */
export class AgentSqlReader implements OnModuleDestroy {
  /** Logger. */
  private readonly log = new Logger('AgentSql');

  /** Pool and login setup, created on first use (the API process never needs them). */
  private readonly state: { pool?: Promise<Pool> } = {};

  /** Creates the reader (nothing connects before the first query). */
  constructor(
    /** The main (owner) connection URL of the mode's database. */
    private readonly databaseUrl: string,
    /** Runs one statement with the owner connection (used once to enable the reader's login). */
    private readonly enableLogin: (sql: string) => Promise<unknown>,
  ) {}

  /** The reader as a function for the agent tools. */
  readonly query: SqlReader = async (sql) => {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      return await runReadOnly(client, sql);
    } finally {
      client.release();
    }
  };

  /** The reader pool; the first call enables the role's login with its derived password. */
  private pool(): Promise<Pool> {
    this.state.pool ??= this.enableLogin(agentReaderLoginSql(this.databaseUrl)).then(
      () =>
        new Pool({
          connectionString: agentReaderUrl(this.databaseUrl),
          max: 2,
          idleTimeoutMillis: 30_000,
          query_timeout: 10_000,
        }),
      (e: unknown) => {
        this.state.pool = undefined; // retried on the next call
        this.log.error(`cannot enable the ${AGENT_READER_ROLE} login: ${String(e)}`);
        throw new Error('sql_query is unavailable (the reader role could not be enabled)');
      },
    );
    return this.state.pool;
  }

  /** Closes the reader pool on shutdown. */
  async onModuleDestroy(): Promise<void> {
    const pool = await this.state.pool?.catch(() => undefined);
    await pool?.end();
  }
}
