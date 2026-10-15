import type { JsonSchema } from './types.ts';

/** Only validation keywords reach a model; field names and literal values remain the asker's data. */
export function providerSchema(schema: JsonSchema): JsonSchema {
  const metadata = new Set([
    '$schema',
    '$id',
    '$comment',
    '$anchor',
    '$dynamicAnchor',
    '$vocabulary',
    'title',
    'description',
    'default',
    'examples',
    'deprecated',
    'readOnly',
    'writeOnly',
  ]);
  const maps = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).flatMap(([key, value]) => {
        if (metadata.has(key) || key.startsWith('x-')) return [];
        return [
          [
            key,
            maps.has(key)
              ? Object.fromEntries(
                  Object.entries(value as JsonSchema).map(([name, field]) => [name, walk(field)]),
                )
              : ['const', 'enum'].includes(key)
                ? structuredClone(value)
                : walk(value),
          ],
        ];
      }),
    );
  };
  return walk(schema) as JsonSchema;
}
