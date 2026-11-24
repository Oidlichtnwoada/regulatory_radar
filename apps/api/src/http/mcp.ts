import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { ApiOperation, ApiSpec, SchemaNode } from './openapi.js';

/** JSON Schema object as MCP expects it for tool inputs and outputs. */
type ObjectSchema = {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required: string[];
  readonly [key: string]: unknown;
};

/** An MCP tool derived from one OpenAPI operation. */
export interface DerivedTool {
  /** Tool name = operationId. */
  readonly name: string;
  /** Summary + description. */
  readonly description: string;
  /** JSON Schema of the arguments: the parameters, plus `body` with the request body schema. */
  readonly inputSchema: ObjectSchema;
  /** JSON Schema of the result, when the 200 response is a JSON object. */
  readonly outputSchema?: ObjectSchema;
  /** Behaviour hints derived from the HTTP method. */
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly idempotentHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
  /** The operation the tool forwards to. */
  readonly operation: ApiOperation;
}

/**
 * OpenAPI 3.0 schema -> JSON Schema: `nullable: true` becomes a "null" type (also on enums), allOf/items
 * and properties are converted recursively. Pure.
 */
export const toJsonSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (typeof node !== 'object' || node === null) return node;
  const { nullable, ...rest } = node as SchemaNode;
  const converted = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, toJsonSchema(v)]));
  if (nullable !== true) return converted;
  return typeof converted.type === 'string'
    ? {
        ...converted,
        type: [converted.type, 'null'],
        ...(Array.isArray(converted.enum) ? { enum: [...converted.enum, null] } : {}),
      }
    : { anyOf: [converted, { type: 'null' }] };
};

/** A converted schema as an MCP object schema, or undefined when it is not an object (e.g. arrays, HTML). */
const asObjectSchema = (schema: SchemaNode | null): ObjectSchema | undefined => {
  if (!schema) return undefined;
  const s = toJsonSchema(schema) as Record<string, unknown>;
  const isObject = s.type === 'object' || (Array.isArray(s.allOf) && s.allOf.length > 0);
  return isObject
    ? {
        ...s,
        type: 'object',
        properties: (s.properties as Record<string, unknown>) ?? {},
        required: (s.required as string[]) ?? [],
      }
    : undefined;
};

/**
 * Derives MCP tools from the resolved OpenAPI operations: one tool per operation, inputs = parameters plus
 * the full request body schema, output = the 200 response schema, hints from the HTTP method. Nothing is
 * duplicated: calls are forwarded to the HTTP API itself.
 */
export const toolsFromOpenApi = (operations: readonly ApiOperation[]): readonly DerivedTool[] =>
  operations.map((op) => {
    const outputSchema = asObjectSchema(op.responseSchema);
    return {
      name: op.operationId,
      description: op.description,
      inputSchema: {
        type: 'object',
        properties: {
          ...Object.fromEntries(
            op.params.map((p) => [
              p.name,
              { ...(toJsonSchema(p.schema ?? {}) as object), description: p.description },
            ]),
          ),
          ...(op.bodySchema
            ? { body: { ...(toJsonSchema(op.bodySchema) as object), description: 'JSON request body' } }
            : {}),
        },
        required: [
          ...op.params.filter((p) => p.required).map((p) => p.name),
          ...(op.bodySchema ? ['body'] : []),
        ],
      },
      ...(outputSchema ? { outputSchema } : {}),
      annotations: {
        title: op.description.split('\n')[0] ?? op.operationId,
        readOnlyHint: op.method === 'GET',
        idempotentHint: op.method === 'GET' || op.method === 'PUT',
        destructiveHint: false,
        openWorldHint: false,
      },
      operation: op,
    };
  });

/** Builds the HTTP request URL of a tool call (path params substituted, arrays comma-joined). */
export const toolUrl = (
  baseUrl: string,
  tool: DerivedTool,
  args: Readonly<Record<string, unknown>>,
): string => {
  const str = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v));
  const { params, path } = tool.operation;
  const filled = params
    .filter((p) => p.in === 'path')
    .reduce((acc, p) => acc.replace(`{${p.name}}`, encodeURIComponent(str(args[p.name]))), path);
  const query = new URLSearchParams(
    params
      .filter((p) => p.in === 'query' && args[p.name] !== undefined)
      .map((p) => [p.name, str(args[p.name])]),
  );
  return `${baseUrl}${filled}${query.size ? `?${query}` : ''}`;
};

/** Creates an MCP server whose tools are the API operations; each call is forwarded to `baseUrl`. */
export const createMcpServer = (spec: ApiSpec, tools: readonly DerivedTool[], baseUrl: string): Server => {
  const server = new Server(
    { name: 'regulatory-radar', version: spec.info.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ operation: _operation, ...tool }) => tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
    const args = req.params.arguments ?? {};
    const res = await fetch(toolUrl(baseUrl, tool, args), {
      method: tool.operation.method,
      headers: { 'Content-Type': 'application/json' },
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
    });
    const text = await res.text();
    // Structured result only for successful JSON objects of tools that declare an output schema.
    const structured = res.ok && tool.outputSchema && res.headers.get('content-type')?.includes('json');
    return {
      isError: !res.ok,
      content: [{ type: 'text', text }],
      ...(structured ? { structuredContent: JSON.parse(text) as Record<string, unknown> } : {}),
    };
  });
  return server;
};

/** Express handler for the stateless Streamable HTTP transport; tools are derived once, a server per request. */
export const mcpHandler = (spec: ApiSpec, baseUrl: string) => {
  const tools = toolsFromOpenApi(spec.operations);
  return async (req: Request, res: Response): Promise<void> => {
    const server = createMcpServer(spec, tools, baseUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
};
