import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Header,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { addDays, isoDay } from '../common/fp.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { EU_COUNTRIES, EU_COUNTRY_CODES } from '../domain/countries.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import type { ProfilePreset } from '../domain/presets.js';
import type { components } from '../generated/openapi.js';
import type { AiProviders } from '../llm/providers.js';
import { renderDigest } from '../radar/digest.js';
import { type ApiVerdict, findingsByIds, queryFindings, queryRadar } from '../radar/queries.js';
import { asOfDate, pipelineStatus, sourceStatuses, systemStatus } from '../radar/status.js';
import type { ConfiguredSource } from '../sources/registry.js';
import { AI, ENV, PRESETS, SOURCES, SPEC, TAXONOMY } from '../tokens.js';
import type { ApiSpec } from './openapi.js';

/** API schema types. */
type S = components['schemas'];

/** RFC 9457 problem details for every error (application/problem+json). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  /** Logger. */
  private readonly log = new Logger('Http');

  /** Writes the problem document: standard title of the status, detail for client errors, the request path as instance. */
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status >= 500)
      this.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    const problem: S['Problem'] = {
      type: 'about:blank',
      status,
      title: STATUS_CODES[status] ?? 'Error',
      ...(status < 500 && error instanceof Error ? { detail: error.message } : {}),
      instance: req.originalUrl,
    };
    res.status(status).type('application/problem+json').json(problem);
  }
}

/** Rejects country codes that are well-formed (checked by the spec) but not EU member states. */
const checkCountries = (codes: readonly string[]): readonly string[] => {
  const unknown = codes.filter((c) => !EU_COUNTRY_CODES.has(c));
  if (unknown.length) throw new BadRequestException(`not EU member states: ${unknown.join(', ')}`);
  return codes;
};

/** Latest operator profile (or the empty default). */
const currentProfile = async (db: PrismaService): Promise<S['OperatorProfile']> => {
  const p = await db.operatorProfile.findFirst({ orderBy: { createdAt: 'desc' } });
  return {
    countries: p?.countries ?? [],
    naceCodes: p?.naceCodes ?? [],
    acknowledgedAt: p?.acknowledgedAt?.toISOString() ?? null,
    savedAt: p?.createdAt.toISOString() ?? null,
  };
};

/** Rejects NACE codes that are well-formed (checked by the spec) but not in the Rev. 2.1 taxonomy. */
const checkNace = (tax: NaceTaxonomy, codes: readonly string[]): readonly string[] => {
  const unknown = codes.filter((c) => !tax.byCode.has(c));
  if (unknown.length) throw new BadRequestException(`unknown NACE Rev. 2.1 codes: ${unknown.join(', ')}`);
  return codes;
};

/** System and pipeline status. */
@Controller('system')
export class SystemController {
  /** Injects dependencies. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AI) private readonly ai: AiProviders,
    @Inject(TAXONOMY) private readonly tax: NaceTaxonomy,
    private readonly db: PrismaService,
  ) {}

  /** GET /system/status */
  @Get('status')
  status(): S['SystemStatus'] {
    return systemStatus(this.env, this.ai);
  }

  /** GET /system/pipeline */
  @Get('pipeline')
  pipeline(): Promise<S['PipelineStatus']> {
    return pipelineStatus(this.db, this.ai, this.tax);
  }
}

/** Source status. */
@Controller('sources')
export class SourcesController {
  /** Injects dependencies. */
  constructor(
    private readonly db: PrismaService,
    @Inject(SOURCES) private readonly sources: readonly ConfiguredSource[],
  ) {}

  /** GET /sources */
  @Get()
  list(): Promise<readonly S['SourceStatus'][]> {
    return sourceStatuses(this.db, this.sources);
  }
}

/** Imported findings (common schema). */
@Controller('findings')
export class FindingsController {
  /** Injects dependencies. */
  constructor(
    private readonly db: PrismaService,
    @Inject(SPEC) private readonly spec: ApiSpec,
  ) {}

  /** GET /findings */
  @Get()
  async list(@Query() query: unknown): Promise<S['FindingPage']> {
    const q = this.spec.validate.query<'listFindings', 'limit' | 'offset'>('listFindings', query);
    const page = await queryFindings(this.db, {
      countries: q.countries ?? [],
      sourceIds: q.sourceIds ?? [],
      q: q.q ?? null,
      limit: q.limit,
      offset: q.offset,
    });
    return { items: [...page.items], total: page.total, limit: q.limit, offset: q.offset };
  }

  /** GET /findings/:id */
  @Get(':id')
  async get(@Param() params: unknown): Promise<S['FindingDetail']> {
    const fid = this.spec.validate.path('getFinding', params).id;
    const [finding] = await findingsByIds(this.db, [fid]);
    const row = await this.db.finding.findUnique({ where: { id: fid }, include: { rawRecord: true } });
    if (!finding || !row) throw new NotFoundException(`finding ${fid} not found`);
    const [embedding] = await this.db.$queryRaw<{ status: string; engine: string; dims: number | null }[]>`
      SELECT status::text, engine, dims FROM embedding WHERE finding_id = ${fid}::uuid ORDER BY created_at DESC LIMIT 1`;
    return {
      ...finding,
      raw: row.rawRecord.payload as Record<string, unknown>,
      attributes: row.attributes as Record<string, unknown>,
      embedding: embedding
        ? {
            status: embedding.status as S['EmbeddingStatus'],
            engine: embedding.engine,
            dimensions: embedding.dims,
          }
        : { status: 'pending', engine: null, dimensions: null },
    };
  }
}

/** Taxonomies. */
@Controller('taxonomy')
export class TaxonomyController {
  /** Injects the NACE taxonomy. */
  constructor(@Inject(TAXONOMY) private readonly tax: NaceTaxonomy) {}

  /** GET /taxonomy/nace */
  @Get('nace')
  nace(): readonly S['NaceCode'][] {
    return this.tax.nodes;
  }

  /** GET /taxonomy/countries */
  @Get('countries')
  countries(): readonly S['Country'][] {
    return EU_COUNTRIES;
  }
}

/** Operator profile (append-only versions). */
@Controller('profile')
export class ProfileController {
  /** Injects dependencies. */
  constructor(
    private readonly db: PrismaService,
    @Inject(TAXONOMY) private readonly tax: NaceTaxonomy,
    @Inject(SPEC) private readonly spec: ApiSpec,
  ) {}

  /** GET /profile */
  @Get()
  get(): Promise<S['OperatorProfile']> {
    return currentProfile(this.db);
  }

  /** PUT /profile: stores a new version. */
  @Put()
  async save(@Body() body: unknown): Promise<S['OperatorProfile']> {
    const input = this.spec.validate.body('saveProfile', body);
    const p = await this.db.operatorProfile.create({
      data: {
        countries: [...new Set(checkCountries(input.countries))].sort(),
        naceCodes: [...new Set(checkNace(this.tax, input.naceCodes))].sort(),
        acknowledgedAt: input.acknowledgedAt
          ? new Date(input.acknowledgedAt)
          : input.acknowledgedAt === null
            ? null
            : (await this.db.operatorProfile.findFirst({ orderBy: { createdAt: 'desc' } }))?.acknowledgedAt,
      },
    });
    return {
      countries: p.countries,
      naceCodes: p.naceCodes,
      acknowledgedAt: p.acknowledgedAt?.toISOString() ?? null,
      savedAt: p.createdAt.toISOString(),
    };
  }
}

/** Example operator profiles as NACE Rev. 2.1 selections. */
@Controller('profiles')
export class PresetsController {
  /** Injects the presets. */
  constructor(@Inject(PRESETS) private readonly presets: readonly ProfilePreset[]) {}

  /** GET /profiles/presets */
  @Get('presets')
  list(): S['ProfilePreset'][] {
    return this.presets.map((p) => ({
      ...p,
      countries: [...p.countries],
      naceCodes: [...p.naceCodes],
      naceCodesRev2: [...p.naceCodesRev2],
    }));
  }
}

/** The ranked radar and procedure groups. */
@Controller()
export class RadarController {
  /** Injects dependencies. */
  constructor(
    private readonly db: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(TAXONOMY) private readonly tax: NaceTaxonomy,
    @Inject(SPEC) private readonly spec: ApiSpec,
  ) {}

  /** Selection from the query, falling back to the saved profile. */
  private async resolve(q: { countries?: readonly string[]; naceCodes?: readonly string[] }) {
    const profile = await currentProfile(this.db);
    return {
      countries: checkCountries(q.countries?.length ? q.countries : profile.countries),
      naceCodes: checkNace(this.tax, q.naceCodes?.length ? q.naceCodes : profile.naceCodes),
      acknowledgedAt: profile.acknowledgedAt ? new Date(profile.acknowledgedAt) : null,
    };
  }

  /** GET /radar */
  @Get('radar')
  async radar(@Query() query: unknown): Promise<S['RadarResult']> {
    const q = this.spec.validate.query<'getRadar', 'limit' | 'offset'>('getRadar', query);
    const sel = await this.resolve(q);
    const verdicts: ApiVerdict[] = q.verdicts?.length ? [...q.verdicts] : ['relevant', 'borderline'];
    const asOf = asOfDate(this.env, q.asOf);
    const page = await queryRadar(this.db, { ...sel, verdicts, asOf, limit: q.limit, offset: q.offset });
    return {
      asOf: isoDay(asOf),
      countries: [...sel.countries],
      naceCodes: [...sel.naceCodes],
      verdicts,
      total: page.total,
      groupsChecked: page.groupsChecked,
      findingsChecked: page.findingsChecked,
      entries: [...page.entries],
    };
  }

  /** GET /procedure-groups/:groupKey */
  @Get('procedure-groups/:groupKey')
  async group(@Param() params: unknown, @Query() query: unknown): Promise<S['ProcedureGroupDetail']> {
    const { groupKey } = this.spec.validate.path('getProcedureGroup', params);
    const sel = await this.resolve({});
    const asOf = asOfDate(this.env, this.spec.validate.query('getProcedureGroup', query).asOf);
    const verdicts: ApiVerdict[] = ['relevant', 'borderline', 'not_relevant'];
    const [entry] = (
      await queryRadar(this.db, { ...sel, verdicts, asOf, limit: 1, offset: 0, groupKeys: [groupKey] })
    ).entries;
    if (!entry) throw new NotFoundException(`procedure group ${groupKey} not found`);
    const [ids] = await this.db.$queryRaw<{ member_ids: string[] }[]>`
      SELECT member_ids FROM radar_group_current WHERE group_key = ${groupKey}`;
    const labels = await this.db.$queryRaw<S['RelevanceLabel'][]>`
      SELECT CASE WHEN count(*) = 27 THEN 'EU' ELSE string_agg(country, ',' ORDER BY country) END AS country,
             nace_code AS "naceCode", verdict::text AS verdict, max(score) AS score, rationale
      FROM radar_label_current WHERE group_key = ${groupKey}
      GROUP BY nace_code, verdict, rationale ORDER BY max(verdict_rank) DESC, nace_code`;
    const links = await this.db.groupLink.findMany({
      where: { findingId: { in: ids?.member_ids ?? [] } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...entry,
      members: [...(await findingsByIds(this.db, ids?.member_ids ?? []))],
      labels,
      groupingDecisions: links.map((l) => ({
        findingId: l.findingId,
        engine: l.engine,
        decision: l.decision as 'join' | 'separate',
        targetGroupKey: l.targetGroupKey,
        rationale: l.rationale,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** GET /digest/weekly: e-mail-ready HTML. */
  @Get('digest/weekly')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async digest(@Query() query: unknown): Promise<string> {
    const q = this.spec.validate.query('getWeeklyDigest', query);
    const sel = await this.resolve(q);
    const weekEnding = q.weekEnding ? new Date(`${q.weekEnding}T00:00:00Z`) : asOfDate(this.env);
    const weekStart = addDays(weekEnding, -6);
    const page = await queryRadar(this.db, {
      ...sel,
      verdicts: ['relevant', 'borderline'],
      asOf: weekEnding,
      limit: 200,
      offset: 0,
    });
    const newKeys = new Set(
      page.entries
        .filter(
          (e) => new Date(e.firstSeenAt) >= weekStart && new Date(e.firstSeenAt) < addDays(weekEnding, 1),
        )
        .map((e) => e.groupKey),
    );
    return renderDigest({
      weekStart: isoDay(weekStart),
      weekEnding: isoDay(weekEnding),
      countries: sel.countries,
      naceCodes: sel.naceCodes,
      entries: page.entries,
      newKeys,
      groupsChecked: page.groupsChecked,
      total: page.total,
    });
  }
}
