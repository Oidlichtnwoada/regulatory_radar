import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolsFromOpenApi, toolUrl } from './mcp.js';
import { loadApiSpec } from './openapi.js';

const spec = loadApiSpec(join(import.meta.dirname, '../../../../openapi/openapi.yaml'));
const tools = toolsFromOpenApi(spec.operations);
const tool = (name: string) => tools.find((t) => t.name === name);

describe('MCP tools derived from openapi.yaml', () => {
  it('exposes every operation as a tool', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'getFinding',
        'getPipelineStatus',
        'getProcedureGroup',
        'getProfile',
        'getRadar',
        'getSystemStatus',
        'getWeeklyDigest',
        'listCountries',
        'listFindings',
        'listNaceCodes',
        'listProfilePresets',
        'listSources',
        'saveProfile',
      ].sort(),
    );
  });

  it('resolves shared parameters and builds the HTTP call', () => {
    const radar = tool('getRadar');
    expect(Object.keys(radar?.inputSchema.properties ?? {})).toEqual([
      'countries',
      'naceCodes',
      'verdicts',
      'asOf',
      'limit',
      'offset',
    ]);
    expect(radar && toolUrl('http://x/api/v1', radar, { countries: ['AT'], naceCodes: ['C24', 'C25'] })).toBe(
      'http://x/api/v1/radar?countries=AT&naceCodes=C24%2CC25',
    );
    const group = tool('getProcedureGroup');
    expect(group && toolUrl('http://x', group, { groupKey: 'boe:BOE-A-2026/1' })).toBe(
      'http://x/procedure-groups/boe%3ABOE-A-2026%2F1',
    );
  });

  it('describes request bodies with the full schema (OpenAPI nullable -> JSON Schema)', () => {
    const body = tool('saveProfile')?.inputSchema.properties.body as {
      required: string[];
      properties: Record<string, { type: unknown }>;
    };
    expect(tool('saveProfile')?.inputSchema.required).toEqual(['body']);
    expect(body.required).toEqual(['countries', 'naceCodes']);
    expect(body.properties.acknowledgedAt?.type).toEqual(['string', 'null']);
  });

  it('declares output schemas for JSON objects and behaviour hints from the HTTP method', () => {
    expect(tool('getRadar')?.outputSchema?.required).toContain('entries');
    expect(tool('listSources')?.outputSchema).toBeUndefined();
    expect(tool('getWeeklyDigest')?.outputSchema).toBeUndefined();
    expect(tool('getRadar')?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tool('saveProfile')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });
});

describe('request validation from openapi.yaml', () => {
  it('splits comma lists, coerces numbers and applies defaults', () => {
    expect(
      spec.validate.query('getRadar', { countries: 'AT,ES', limit: '20', verdicts: 'relevant' }),
    ).toEqual({
      countries: ['AT', 'ES'],
      limit: 20,
      offset: 0,
      verdicts: ['relevant'],
    });
  });

  it('rejects what the spec forbids with a readable detail', () => {
    const detail = (() => {
      try {
        spec.validate.query('getRadar', { limit: '900', verdicts: 'maybe', page: '2' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(detail).toContain('query.limit must be <= 500');
    expect(detail).toContain('query.verdicts.0 must be equal to one of the allowed values');
    expect(detail).toContain("query must NOT have additional properties 'page'");
    expect(() => spec.validate.path('getFinding', { id: 'nope' })).toThrow(
      /path\.id must match format "uuid"/,
    );
    expect(() => spec.validate.body('saveProfile', { countries: ['at'] })).toThrow(/naceCodes/);
  });
});
