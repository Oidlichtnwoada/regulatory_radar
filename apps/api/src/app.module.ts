import { join } from 'node:path';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { databaseUrlFor, type Env } from './config/env.js';
import { PrismaService } from './db/prisma.service.js';
import { loadTaxonomy } from './domain/nace.js';
import { loadPresets } from './domain/presets.js';
import {
  FindingsController,
  PresetsController,
  ProfileController,
  RadarController,
  SourcesController,
  SystemController,
  TaxonomyController,
} from './http/controllers.js';
import { loadApiSpec } from './http/openapi.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { createAiProviders } from './llm/providers.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { configuredSources } from './sources/registry.js';
import { AI, ENV, PRESETS, SOURCES, SPEC, TAXONOMY } from './tokens.js';

/** Providers shared by the API and the worker (everything is derived from the environment). */
const coreProviders = (env: Env): readonly Provider[] => {
  const taxonomy = loadTaxonomy(join(env.DATA_DIR, 'nace_rev2_1.csv'));
  return [
    { provide: ENV, useValue: env },
    { provide: TAXONOMY, useValue: taxonomy },
    { provide: PRESETS, useValue: loadPresets(join(env.DATA_DIR, 'profile_presets.json'), taxonomy) },
    { provide: SOURCES, useValue: configuredSources(env, taxonomy) },
    { provide: AI, useValue: createAiProviders(env) },
    { provide: PrismaService, useFactory: () => new PrismaService(databaseUrlFor(env)) },
    IngestionService,
    PipelineService,
  ];
};

/** Root Nest module; its providers depend on the environment, see apiModule / workerModule. */
@Module({})
export class AppModule {}

/** Module of the HTTP API process (services plus controllers). */
export const apiModule = (env: Env): DynamicModule => ({
  module: AppModule,
  providers: [
    ...coreProviders(env),
    { provide: SPEC, useValue: loadApiSpec(join(env.DATA_DIR, '..', 'openapi', 'openapi.yaml')) },
  ],
  controllers: [
    SystemController,
    SourcesController,
    FindingsController,
    TaxonomyController,
    ProfileController,
    PresetsController,
    RadarController,
  ],
});

/** Module of the worker / CLI processes (services only). */
export const workerModule = (env: Env): DynamicModule => ({
  module: AppModule,
  providers: [...coreProviders(env)],
});
