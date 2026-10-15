import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_READ_TOOLS, T3_TOOLS } from '../../shared/readonly-tools.ts';
import { HERMES_HISTORY_DB, HERMES_HISTORY_PYTHON } from '../hermes-history.ts';
import { t3DbPath } from '../t3-threads.ts';
import { type HermesLayout, hermesKey } from './hermes-install.ts';

type Service = {
  tools: Record<string, { description: string; parameters: Record<string, unknown> }>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headerEnv?: string;
};
const text = { type: 'string', maxLength: 2000 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export function hermesServices(
  layout: HermesLayout,
  tools: boolean,
  memory: { url: string; headerEnv: string } | null,
) {
  const services: Record<string, Service> = {};
  const secrets: Record<string, string> = {};
  if (memory) {
    const url = new URL(memory.url);
    const key = hermesKey(memory.headerEnv, layout.home);
    if (
      !key ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Hermes memory connection unavailable');
    secrets[memory.headerEnv] = key;
    const parameters: Record<string, Record<string, unknown>> = {
      whoami: schema({}),
      search: schema({ query: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }, [
        'query',
      ]),
      get_page: schema({ slug: text, section: text }, ['slug']),
      list_pages: schema({ prefix: text, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
      recent_changes: schema({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
      ask: schema({ query: text }, ['query']),
    };
    services.memory = {
      url: url.href,
      headerEnv: memory.headerEnv,
      tools: Object.fromEntries(
        MEMORY_READ_TOOLS.map((name) => [
          name,
          {
            description: 'Read-only memory operation. No writes, proposals, resources or prompts.',
            parameters: parameters[name] ?? schema({}),
          },
        ]),
      ),
    };
  }
  if (tools) {
    const server = (name: string) =>
      fileURLToPath(
        new URL(
          import.meta.url.endsWith('.js') ? `../${name}.js` : `../${name}.ts`,
          import.meta.url,
        ),
      );
    const history = join(layout.home, 'state.db');
    if (existsSync(history))
      services.hermes_history = {
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', server('hermes-history-mcp')],
        env: { [HERMES_HISTORY_DB]: history, [HERMES_HISTORY_PYTHON]: layout.basePython },
        tools: {
          hermes_history_search: {
            description:
              'Literal title-only search; insertion-descending pages. Empty pages may have nextCursor. Results explicitly report clipping.',
            parameters: schema(
              {
                query: { type: 'string', minLength: 2, maxLength: 200 },
                cursor: text,
                limit: { type: 'integer', minimum: 1, maximum: 100 },
              },
              ['query'],
            ),
          },
          hermes_history_read: {
            description:
              'Read user/assistant history including inactive text; other roles are omitted but advance the cursor. Results explicitly report clipping.',
            parameters: schema(
              {
                sessionId: { type: 'string', maxLength: 128 },
                cursor: text,
                limit: { type: 'integer', minimum: 1, maximum: 300 },
              },
              ['sessionId'],
            ),
          },
        },
      };
    const t3 = t3DbPath();
    if (existsSync(t3))
      services.t3 = {
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', server('hermes-t3-mcp')],
        env: { DIVAN_T3_DB: t3, [HERMES_HISTORY_PYTHON]: layout.basePython },
        tools: Object.fromEntries(
          T3_TOOLS.map((name) => [
            name,
            {
              description: 'Read-only local T3 conversations.',
              parameters: name.endsWith('read')
                ? schema(
                    {
                      threadId: text,
                      limit: { type: 'integer', minimum: 1, maximum: 2000 },
                      skip: { type: 'integer', minimum: 0 },
                    },
                    ['threadId'],
                  )
                : name.endsWith('search')
                  ? schema({ query: text, limit: { type: 'integer', minimum: 1, maximum: 30 } }, [
                      'query',
                    ])
                  : schema({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
            },
          ]),
        ),
      };
  }
  return { services, secrets };
}
