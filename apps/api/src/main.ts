import 'reflect-metadata';
import { ConsoleLogger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { apiModule, workerModule } from './app.module.js';
import { runEval } from './cli/eval.js';
import { migrate } from './cli/migrate.js';
import { databaseUrlFor, type Env, llmSettings, loadEnv } from './config/env.js';
import { ProblemFilter } from './http/controllers.js';
import { mcpHandler } from './http/mcp.js';
import type { ApiSpec } from './http/openapi.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { SPEC } from './tokens.js';

/** JSON logs on stdout (collected by docker compose). */
const logger = new ConsoleLogger({
  json: process.env.LOG_FORMAT !== 'text',
  logLevels: ['log', 'warn', 'error', 'fatal'],
});

/** Aborts on SIGTERM / SIGINT so loops end and connections close. */
const shutdownSignal = (): AbortSignal => {
  const controller = new AbortController();
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => controller.abort());
  return controller.signal;
};

/** HTTP API: REST under /api/v1, the OpenAPI document, Swagger UI and the MCP endpoint. */
const startApi = async (env: Env): Promise<void> => {
  const app = await NestFactory.create(apiModule(env), { logger });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  const spec = app.get<ApiSpec>(SPEC);
  const http = app.getHttpAdapter().getInstance() as Express;
  http.get('/api/openapi.yaml', (_req, res) => void res.type('application/yaml').send(spec.text));
  http.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec.doc));
  http.post('/mcp', mcpHandler(spec, `http://127.0.0.1:${env.API_PORT}/api/v1`));
  await app.listen(env.API_PORT, '0.0.0.0');
  logger.log(`API on :${env.API_PORT} (REST /api/v1, docs /api/docs, MCP /mcp)`, 'Main');
};

/** Runs ingestion and the pipeline until the process is stopped. */
const runWorker = async (ctx: INestApplicationContext, signal: AbortSignal): Promise<void> => {
  await Promise.all([
    ctx.get(IngestionService).runForever(signal),
    ctx.get(PipelineService).runForever(signal),
  ]);
};

/** Commands of the entrypoint; anything else fails instead of silently doing nothing. */
const COMMANDS = ['migrate', 'api', 'worker', 'all', 'eval'];

/** Entrypoint: `migrate`, `api`, `worker`, `all` (api + worker) or `eval [--labels file ...]`. */
const main = async (): Promise<void> => {
  const env = loadEnv();
  const [command = 'all', ...args] = process.argv.slice(2);
  if (!COMMANDS.includes(command))
    throw new Error(`unknown command "${command}", expected one of ${COMMANDS.join(', ')}`);
  const settings = llmSettings(env);
  // eval prints JSON on stdout, so its notes go to stderr.
  const note = command === 'eval' ? (m: string) => console.error(m) : (m: string) => logger.log(m, 'Config');
  note(`mode ${settings.mode}, database ${new URL(databaseUrlFor(env)).pathname.slice(1)}`);
  settings.warnings.forEach(note);
  if (command === 'migrate') await migrate(env);
  if (command === 'api' || command === 'all') await startApi(env);
  if (command === 'worker' || command === 'all') {
    const ctx = await NestFactory.createApplicationContext(workerModule(env), { logger });
    await runWorker(ctx, shutdownSignal());
    await ctx.close();
  }
  if (command === 'eval') {
    const ctx = await NestFactory.createApplicationContext(workerModule(env), {
      logger: ['warn', 'error'],
    });
    process.exitCode = await runEval(ctx, env, args);
    await ctx.close();
  }
};

void main().catch((e: unknown) => {
  logger.fatal(e instanceof Error ? (e.stack ?? e.message) : String(e), 'Main');
  process.exit(1);
});
