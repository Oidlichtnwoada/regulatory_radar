import { readFileSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsPlugin from 'ajv-formats';
import { parse } from 'yaml';
import type { operations } from '../generated/openapi.js';

/** A JSON Schema / OpenAPI schema node (loosely typed: it is data from the spec). */
export type SchemaNode = Readonly<Record<string, unknown>>;

/** OpenAPI parameter (after $ref resolution). */
export interface OpenApiParam {
  /** Parameter name. */
  readonly name: string;
  /** Location. */
  readonly in: 'query' | 'path';
  /** Whether it is required. */
  readonly required?: boolean;
  /** Description. */
  readonly description?: string;
  /** form/explode=false arrays are comma-separated. */
  readonly explode?: boolean;
  /** Schema (refs resolved). */
  readonly schema?: SchemaNode;
}

/** One operation of the spec with everything resolved: the single description of an endpoint. */
export interface ApiOperation {
  /** operationId (also the MCP tool name). */
  readonly operationId: string;
  /** Upper-case HTTP method. */
  readonly method: string;
  /** Path template, e.g. /procedure-groups/{groupKey}. */
  readonly path: string;
  /** Summary + description. */
  readonly description: string;
  /** Parameters. */
  readonly params: readonly OpenApiParam[];
  /** JSON request body schema, if any. */
  readonly bodySchema: SchemaNode | null;
  /** JSON schema of the 200 response, if it is JSON. */
  readonly responseSchema: SchemaNode | null;
}

/** The loaded spec: raw text (served), parsed document (Swagger UI) and resolved operations. */
export interface ApiSpec {
  /** YAML text. */
  readonly text: string;
  /** Parsed document. */
  readonly doc: SchemaNode;
  /** API title and version. */
  readonly info: { readonly title: string; readonly version: string };
  /** Operations in spec order. */
  readonly operations: readonly ApiOperation[];
  /** Request validation against the spec (types from the generated operation types). */
  readonly validate: RequestValidator;
}

/** Operation ids of the API. */
type OpId = keyof operations;
/** Query parameters of an operation (generated types). */
type QueryOf<K extends OpId> = operations[K] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;
/** Path parameters of an operation. */
type PathOf<K extends OpId> = operations[K] extends { parameters: { path: infer P } } ? P : never;
/** JSON body of an operation. */
type BodyOf<K extends OpId> = operations[K] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** Validates and coerces request parts against the spec; throws 400 (RFC 9457 via the filter) on failure. */
export interface RequestValidator {
  /** Query string: comma lists split, numbers coerced, defaults applied. `D` names keys that have defaults. */
  query<K extends OpId, D extends keyof QueryOf<K> = never>(
    op: K,
    raw: unknown,
  ): QueryOf<K> & Required<Pick<QueryOf<K>, D>>;
  /** Path parameters. */
  path<K extends OpId>(op: K, raw: unknown): PathOf<K>;
  /** JSON body. */
  body<K extends OpId>(op: K, raw: unknown): BodyOf<K>;
}

/** Follows a local $ref (#/components/...). */
const resolveRef = (doc: SchemaNode, ref: string): unknown =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as SchemaNode | undefined)?.[key], doc);

/** Inlines every $ref (cycles end in an empty schema). Pure. */
export const deref = (doc: SchemaNode, node: unknown, seen: readonly string[] = []): unknown => {
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, seen));
  if (typeof node !== 'object' || node === null) return node;
  const ref = (node as SchemaNode).$ref;
  if (typeof ref === 'string')
    return seen.includes(ref) ? {} : deref(doc, resolveRef(doc, ref), [...seen, ref]);
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(doc, v, seen)]));
};

/** Resolved operations of a parsed spec. Pure. */
export const operationsOf = (doc: SchemaNode): readonly ApiOperation[] =>
  Object.entries((doc.paths ?? {}) as Record<string, Record<string, SchemaNode>>).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, raw]) => {
      const op = deref(doc, raw) as SchemaNode & {
        operationId: string;
        summary?: string;
        description?: string;
        parameters?: OpenApiParam[];
        requestBody?: { content?: Record<string, { schema?: SchemaNode }> };
        responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
      };
      return {
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        description: [op.summary, op.description].filter(Boolean).join('\n').trim(),
        params: op.parameters ?? [],
        bodySchema: op.requestBody?.content?.['application/json']?.schema ?? null,
        responseSchema: op.responses?.['200']?.content?.['application/json']?.schema ?? null,
      };
    }),
  );

/** ajv-formats is published as CommonJS; its default export is the plugin function. */
const addFormats = addFormatsPlugin as unknown as (ajv: Ajv) => Ajv;

/** Readable message of Ajv errors for a request part. */
const describe = (part: string, errors: readonly ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((e) => {
      const where = `${part}${e.instancePath.replace(/\//g, '.')}`;
      const extra = 'additionalProperty' in e.params ? ` '${String(e.params.additionalProperty)}'` : '';
      return `${where} ${e.message ?? 'is invalid'}${extra}`;
    })
    .join('; ');

/** Compiles validators for every operation (query, path, body) from the spec. */
const requestValidator = (operations: readonly ApiOperation[]): RequestValidator => {
  const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
  addFormats(ajv);
  const objectOf = (params: readonly OpenApiParam[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(params.map((p) => [p.name, p.schema ?? {}])),
    required: params.filter((p) => p.required).map((p) => p.name),
  });
  const compiled = new Map(
    operations.map((o) => {
      const query = o.params.filter((p) => p.in === 'query');
      return [
        o.operationId,
        {
          query,
          validateQuery: ajv.compile(objectOf(query)),
          validatePath: ajv.compile(objectOf(o.params.filter((p) => p.in === 'path'))),
          validateBody: o.bodySchema ? ajv.compile(o.bodySchema) : null,
        },
      ] as const;
    }),
  );
  const get = (op: string) => {
    const c = compiled.get(op);
    if (!c) throw new Error(`operation ${op} is not in the OpenAPI spec`);
    return c;
  };
  // Ajv coerces and fills defaults in place: it always works on a fresh copy, never on the request.
  const check = <T>(fn: ValidateFunction, part: string, input: unknown): T => {
    const copy = structuredClone(input ?? {});
    if (!fn(copy)) throw new BadRequestException(describe(part, fn.errors));
    return copy as T;
  };
  return {
    query: (op, raw) => {
      const { query, validateQuery } = get(op);
      const commaLists = query.filter((p) => p.schema?.type === 'array' && p.explode === false);
      const input = Object.fromEntries(
        Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) =>
          commaLists.some((p) => p.name === k) && typeof v === 'string'
            ? [
                k,
                v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              ]
            : [k, v],
        ),
      );
      return check(validateQuery, 'query', input);
    },
    path: (op, raw) => check(get(op).validatePath, 'path', raw),
    body: (op, raw) => {
      const { validateBody } = get(op);
      if (!validateBody) throw new Error(`operation ${op} has no JSON body`);
      return check(validateBody, 'body', raw);
    },
  };
};

/** Loads openapi.yaml once: served text, parsed document, resolved operations and request validators. */
export const loadApiSpec = (path: string): ApiSpec => {
  const text = readFileSync(path, 'utf8');
  const doc = parse(text) as SchemaNode;
  const operations = operationsOf(doc);
  return {
    text,
    doc,
    info: doc.info as ApiSpec['info'],
    operations,
    validate: requestValidator(operations),
  };
};
