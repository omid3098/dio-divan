// Fixed stdio service. Caller-supplied SQL and paths are never accepted.
import { HERMES_HISTORY_DB, HERMES_HISTORY_PYTHON, readHermesHistory } from './hermes-history.ts';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const tools = ['search', 'read'].map((action) => ({
  name: `hermes_history_${action}`,
  description:
    action === 'search'
      ? 'Literal title-only history search, insertion-descending. Use nextCursor to inspect older sessions; even empty pages may continue.'
      : 'User/assistant history text, including inactive messages, insertion-descending. Omitted roles still advance nextCursor; clipping is explicit.',
  inputSchema: {
    type: 'object',
    properties: {
      ...(action === 'search'
        ? { query: { type: 'string', minLength: 2, maxLength: 200 } }
        : { sessionId: { type: 'string', maxLength: 128 } }),
      cursor: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
      limit: { type: 'integer', minimum: 1, maximum: action === 'search' ? 100 : 300 },
    },
    required: [action === 'search' ? 'query' : 'sessionId'],
    additionalProperties: false,
  },
  annotations,
}));
async function line(input: string) {
  let id: string | number | null = null;
  try {
    const request = JSON.parse(input);
    if (request.id === undefined) return;
    if (
      request.jsonrpc !== '2.0' ||
      !['string', 'number'].includes(typeof request.id) ||
      String(request.id).length > 128 ||
      typeof request.method !== 'string'
    )
      throw new Error('invalid');
    id = request.id;
    let result: unknown;
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hermes_history', version: '1' },
      };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      const tool = tools.find((tool) => tool.name === request.params?.name);
      const args = request.params?.arguments;
      if (!tool || !args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('invalid');
      try {
        const path = process.env[HERMES_HISTORY_DB],
          python = process.env[HERMES_HISTORY_PYTHON];
        if (!path || !python) throw new Error('unavailable');
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                await readHermesHistory(
                  path,
                  python,
                  tool.name.endsWith('search') ? 'search' : 'read',
                  args,
                ),
              ),
            },
          ],
        };
      } catch {
        result = {
          content: [
            { type: 'text', text: 'Hermes history is unavailable for the protected reader.' },
          ],
          isError: true,
        };
      }
    } else {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })}\n`,
      );
      return;
    }
    const output = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (Buffer.byteLength(output) > 128 * 1024) throw new Error('bounded');
    process.stdout.write(`${output}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid request' } })}\n`,
    );
  }
}
let pending = '',
  overflow = false;
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  for (const char of chunk.toString('utf8')) {
    if (char === '\n') {
      await line(overflow ? '' : pending);
      pending = '';
      overflow = false;
    } else if (!overflow) {
      pending += char;
      if (Buffer.byteLength(pending) > 16384) {
        pending = '';
        overflow = true;
      }
    }
  }
}
if (pending || overflow) await line(overflow ? '' : pending);
