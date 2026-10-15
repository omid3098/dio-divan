// The closing line of an answer of ours: a link that opens the round in the web app, and the only place a round's identity
// is written for a client. The identity is in the link's address (`?round=<session>.<round>`), so it does not show as text
// but comes back with the answer when a client sends its history again (a fork in T3 Code, Pi's conversation): that is how
// the server finds the round a conversation continues. The server's `/open/<ticket>` handler reads only the path, so the
// query is ignored there.
// This module owns the format: nothing else builds, finds or cuts the line. The label is the caller's (the language of the
// answer), so no sentence of a language is written here. An older form, `Dio Divan: <link> ref:<session>.<round>`, is still
// read and cut, so a conversation from before keeps working.

export interface RoundRef {
  sessionId: string;
  chairId: string;
}

/** The line that ends an answer: `[label](<one-time address>?round=<session>.<round>)`. */
export const roundLink = (url: string, ref: RoundRef, label: string): string =>
  `[${label}](${url}?round=${ref.sessionId}.${ref.chairId})`;

// A round as it is named in either form. The id is a session's uuid and a round's `c_` and hex digits.
const NAMED = /(?:[?&]round=|\bref:)([0-9a-f-]{36})\.(c_[0-9a-f]+)/gu;

/** The last round a text names, in the link or in the older line, wherever it stands in the text. */
export function lastRound(text: string): RoundRef | undefined {
  const last = [...text.matchAll(NAMED)].at(-1);
  return last ? { sessionId: last[1] as string, chairId: last[2] as string } : undefined;
}

// The line at the end of a text, either form. The new one is cut whatever its label and whatever the round says, so a line a
// client has changed a little is still taken off; but it must stand on a line of its own and point at our `/open/` path with
// `?round=` as its query, so another link that merely has a `round` in it (a fixtures page) is never taken for ours. Every
// part is bounded so that a hostile text cannot make the search slow.
const CLOSING =
  /(?:(?<=^|\n)\[[^\]\n]{0,80}\]\([^\s()?]{0,300}\/open\/[^\s()?]{0,100}\?round=[^\s()]{0,100}\)|Dio Divan: \S+(?: ref:\S+)?)$/u;

/** The round the closing line at the very end of a text names, in either form; a round named anywhere else is not read. */
export function closingRound(text: string): RoundRef | undefined {
  const found = CLOSING.exec(text.trimEnd());
  return found ? lastRound(found[0]) : undefined;
}

/** A text without the closing line of ours (either form) and the blank lines before it. */
export function withoutRoundLink(text: string): string {
  const trimmed = text.trimEnd();
  const found = CLOSING.exec(trimmed);
  return found ? trimmed.slice(0, found.index).trimEnd() : trimmed;
}
