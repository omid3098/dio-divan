import type { ToolEvent } from '../../shared/types.ts';
import { asRecord } from './util.ts';

/** Only tool inputs become targets: never a tool result, output or credential header. */
export function toolEvent(name: string, input: unknown, server = ''): ToolEvent {
  const args = asRecord(input) ?? {};
  const full = `${server} ${name}`;
  const kind = /(?:^|\W|__)memory(?:\W|__|$)/iu.test(full)
    ? 'memory'
    : /t3_thread_|(?:^|\W|__)t3(?:\W|__|$)/iu.test(full)
      ? 'thread'
      : /web.?search|web.?fetch|browse|fetch_url|search_web|read_url_content/iu.test(name)
        ? 'web'
        : /^(?:read(?:_file)?|grep|glob|ls|list_dir|find|shell|bash|command_execution|exec_command|view_file|grep_search|list_directory|find_by_name|run_command)$/iu.test(
              name,
            )
          ? 'file'
          : 'other';
  let target = typeof input === 'string' ? input : '';
  for (const key of [
    'file_path',
    'target_file',
    'target_directory',
    'path',
    'pattern',
    'query',
    'url',
    'slug',
    'threadId',
    'command',
  ]) {
    if (typeof args[key] === 'string') {
      target = args[key];
      break;
    }
  }
  return { kind, name, target: target.slice(0, 200) };
}
