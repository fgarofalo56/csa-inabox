/**
 * OpenAPI generation for publishing a Spindle (AIP-Logic) function as REST.
 *
 * A published Logic function exposes a single typed operation — `POST /invoke`
 * — whose request body mirrors the function's typed inputs and whose response
 * carries the typed output. Kept pure + dependency-free so it is unit-testable
 * and reused by the publish route (which imports it into APIM via the real ARM
 * importApiFromOpenApi path). Azure-native — no Fabric.
 */

export interface LogicInputLite { name?: unknown; type?: unknown; objectType?: unknown; description?: unknown; required?: unknown }

/** Map an AIP-Logic input type to a JSON-schema type + format. */
export function aipTypeToJsonSchema(type: string): Record<string, unknown> {
  switch (type) {
    case 'integer': case 'long': return { type: 'integer' };
    case 'double': case 'float': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'array': case 'object list': case 'object set': return { type: 'array', items: {} };
    case 'struct': return { type: 'object' };
    case 'date': return { type: 'string', format: 'date' };
    case 'timestamp': return { type: 'string', format: 'date-time' };
    default: return { type: 'string' }; // string / object / model / media reference (keyed by id)
  }
}

/** Map the function's typed output to a JSON-schema type for the response. */
export function outputTypeToJsonSchema(outputType: string): Record<string, unknown> {
  switch (outputType) {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': return { type: 'object' };
    default: return { type: 'string' };
  }
}

/** Turn a name into a safe slug for an APIM api id / path. */
export function slugifyApi(s: string): string {
  return (s || 'spindle').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 54) || 'spindle';
}

export interface BuildLogicOpenApiInput {
  displayName: string;
  inputs: LogicInputLite[];
  outputType: string;
  outputDescription?: string;
}

/** Build the OpenAPI 3.0.1 document for the function's `POST /invoke` operation. */
export function buildLogicOpenApi(input: BuildLogicOpenApiInput): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of input.inputs || []) {
    const name = String(i?.name || '').trim();
    if (!name) continue;
    const schema = aipTypeToJsonSchema(String(i?.type || 'string'));
    if (i?.description) (schema as Record<string, unknown>).description = String(i.description);
    properties[name] = schema;
    if (i?.required) required.push(name);
  }
  const inputsSchema: Record<string, unknown> = { type: 'object', properties, ...(required.length ? { required } : {}) };
  const outputSchema = outputTypeToJsonSchema(input.outputType);
  if (input.outputDescription) (outputSchema as Record<string, unknown>).description = input.outputDescription;

  return {
    openapi: '3.0.1',
    info: {
      title: input.displayName,
      version: '1.0',
      description: `Typed Spindle (Palantir AIP-Logic parity) function published as REST. POST /invoke runs the typed block graph against the Azure-native runtime (Azure OpenAI + Synapse) and returns the typed output.`,
    },
    paths: {
      '/invoke': {
        post: {
          summary: 'Invoke the Spindle function',
          operationId: 'invoke',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['inputs'],
                  properties: {
                    inputs: inputsSchema,
                    mode: { type: 'string', enum: ['logic', 'agent'], default: 'logic' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The typed function output.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' }, output: outputSchema, model: { type: 'string' } },
                  },
                },
              },
            },
            '401': { description: 'Unauthenticated' },
            '503': { description: 'Honest infrastructure gate (e.g. no Azure OpenAI deployment).' },
          },
        },
      },
    },
  };
}
