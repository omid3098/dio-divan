// What the user has typed in a session and not sent: the comment of each round and the answers to the chairman's questions of
// each round. They are kept by the session page (not by the panel of a round, which is rebuilt every time another node is
// selected), so going to another node and back loses nothing.

/** The text of each question's answer, by the chairman node whose questions they are (`''`: not answered). */
export type AnswerDrafts = Record<string, string[]>;

const NONE: string[] = [];

/** The answers typed for the questions of one round. */
export const answersOf = (drafts: AnswerDrafts, chairId: string): string[] =>
  drafts[chairId] ?? NONE;

/** The drafts with one answer set (the others, and the other rounds', are untouched). */
export function withAnswer(
  drafts: AnswerDrafts,
  chairId: string,
  index: number,
  value: string,
): AnswerDrafts {
  const next = [...answersOf(drafts, chairId)];
  // an answer past the end leaves the unanswered ones before it empty, not missing
  for (let at = next.length; at < index; at += 1) next[at] = '';
  next[index] = value;
  return { ...drafts, [chairId]: next };
}

/** What a send used: the comment as it was typed, and the answered questions with the answers (trimmed) as they were sent. */
export interface Submitted {
  comment: string;
  answers: { question: string; answer: string }[];
}

/**
 * The comments after a send succeeded: the round's comment is cleared only when it still is exactly what was sent. Text typed
 * (or changed) while the request was in flight is newer than the send and stays.
 */
export function commentAfterSend(
  drafts: Record<string, string>,
  chairId: string,
  sent: string,
): Record<string, string> {
  return (drafts[chairId] ?? '') === sent ? { ...drafts, [chairId]: '' } : drafts;
}

/**
 * The answers after a send succeeded: each answer that still is what was sent for its question is cleared, one that was changed
 * while the request was in flight stays (and so does one that was written for a question that was not answered when it was
 * sent). `questions` are the round's questions in order; `sent` are the answered ones, in the same order.
 */
export function answersAfterSend(
  drafts: AnswerDrafts,
  chairId: string,
  questions: string[],
  sent: Submitted['answers'],
): AnswerDrafts {
  const current = answersOf(drafts, chairId);
  let at = 0;
  let changed = false;
  const next = current.map((text, index) => {
    const pair = sent[at];
    if (!pair || pair.question !== questions[index]) return text;
    at += 1;
    if (text.trim() !== pair.answer) return text;
    changed = true;
    return '';
  });
  if (!changed) return drafts;
  return next.every((text) => text === '')
    ? withoutAnswers(drafts, chairId)
    : { ...drafts, [chairId]: next };
}

/** The drafts without those of one round (they were sent). */
export function withoutAnswers(drafts: AnswerDrafts, chairId: string): AnswerDrafts {
  if (!(chairId in drafts)) return drafts;
  const { [chairId]: _sent, ...rest } = drafts;
  return rest;
}
