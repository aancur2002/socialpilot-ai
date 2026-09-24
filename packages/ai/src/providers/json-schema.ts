import { z } from 'zod';

/** Keywords structured-output engines commonly reject; zod still enforces them after parsing. */
const STRIP_KEYS = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'default']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (STRIP_KEYS.has(key)) continue;
    out[key] = sanitize(value);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * Converts an output zod schema to a strict JSON schema (every property required,
 * no additional properties). Output schemas must model optional values as nullable.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })) as Record<string, unknown>;
}

/** Extracts the first JSON object from model text (tolerates code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new SyntaxError('No JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
