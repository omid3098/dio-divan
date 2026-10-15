// A process's output with a bound. A harness that streams every token of its thinking can print many megabytes before its
// final answer and its usage; the whole of it must not be kept, and the end of it must not be lost.

/** What the head and the tail of a stdout may hold, and what stderr may hold (characters). */
export const HEAD_OUTPUT = 2 * 1024 * 1024;
export const TAIL_OUTPUT = 3 * 1024 * 1024;
export const STDERR_OUTPUT = 512 * 1024;

/**
 * The first `headMax` characters of an output and its last `tailMax` characters. The final answer and the usage come last,
 * so they are in the tail, and nothing printed in the middle can push them out; what was left out is said in a line of its
 * own. Only whole lines are kept at the two cuts. What a long stream adds up to (a harness that reports its usage message by
 * message) is NOT read from here: that is added up as the lines arrive (`StreamWatcher.streamed`).
 */
export class BoundedOutput {
  private head = '';
  private tail = '';
  private total = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(headMax = HEAD_OUTPUT, tailMax = TAIL_OUTPUT) {
    this.headMax = headMax;
    this.tailMax = tailMax;
  }

  push(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest) {
      this.tail += rest;
      // cut in steps, not at every chunk
      if (this.tail.length > 2 * this.tailMax) this.tail = this.tail.slice(-this.tailMax);
    }
  }

  /** Whether anything had to be left out. */
  get elided(): boolean {
    return this.head.length + this.tail.length < this.total;
  }

  toString(): string {
    if (!this.elided) return this.head + this.tail;
    const omitted = this.total - this.head.length - this.tail.length;
    // the head ends and the tail begins inside a line, most likely: only whole lines are kept
    const head = this.head.slice(0, this.head.lastIndexOf('\n') + 1);
    const cut = this.tail.indexOf('\n');
    const tail = cut === -1 ? '' : this.tail.slice(cut + 1);
    return `${head}[... ${omitted} characters of output left out ...]\n${tail}`;
  }
}

/** The first and the last of a long text, for a diagnostic that must stay short: the end of a log is where the error is. */
export function endsOf(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters left out ...]\n${text.slice(-tail)}`;
}
