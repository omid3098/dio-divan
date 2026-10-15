// The answers typed to the chairman's questions are kept by the session page, per round: going to another node and back loses none.

import { describe, expect, it } from 'vitest';
import {
  type AnswerDrafts,
  answersAfterSend,
  answersOf,
  commentAfterSend,
  withAnswer,
  withoutAnswers,
} from '../web/src/drafts.ts';

describe('answer drafts, by round', () => {
  it('answer, switch to another round, come back: the answers are still there', () => {
    let drafts: AnswerDrafts = {};
    drafts = withAnswer(drafts, 'c1', 0, 'About 40 euros');
    drafts = withAnswer(drafts, 'c1', 1, 'Nobody yet');
    // the user selects another round and answers its question there
    drafts = withAnswer(drafts, 'c2', 0, 'Roughly 90 euros');
    // and goes back
    expect(answersOf(drafts, 'c1')).toEqual(['About 40 euros', 'Nobody yet']);
    expect(answersOf(drafts, 'c2')).toEqual(['Roughly 90 euros']);
    expect(answersOf(drafts, 'c3')).toEqual([]);
  });

  it('an answer to a later question leaves the ones before it empty, not missing', () => {
    const drafts = withAnswer({}, 'c1', 2, 'third');
    expect(answersOf(drafts, 'c1')).toEqual(['', '', 'third']);
  });

  it('changes one answer and nothing else, and never the drafts it was given', () => {
    const before: AnswerDrafts = { c1: ['a', 'b'] };
    const after = withAnswer(before, 'c1', 0, 'changed');
    expect(after.c1).toEqual(['changed', 'b']);
    expect(before.c1).toEqual(['a', 'b']);
  });

  it('forgets the answers of a round once it was sent, and those only', () => {
    const drafts: AnswerDrafts = { c1: ['a'], c2: ['b'] };
    expect(withoutAnswers(drafts, 'c1')).toEqual({ c2: ['b'] });
    // a round with no drafts: the same object, nothing to change
    expect(withoutAnswers(drafts, 'c9')).toBe(drafts);
  });
});

describe('what a send clears: only what still is exactly what was sent', () => {
  const questions = ['What is the monthly cost?', 'Who maintains it?', 'What would make you stop?'];
  const sent = [
    { question: questions[0] as string, answer: 'About 40 euros' },
    { question: questions[2] as string, answer: 'A missed launch' },
  ];

  it('the comment is cleared when it is what was sent', () => {
    const drafts = { c1: 'And the budget?', c2: 'another round' };
    expect(commentAfterSend(drafts, 'c1', 'And the budget?')).toEqual({
      c1: '',
      c2: 'another round',
    });
  });

  it('REPRODUCTION: a comment edited while the request was in flight is newer than the send and stays', () => {
    // sent «And the budget?»; the user went on typing before the answer came back
    const drafts = { c1: 'And the budget? Also the hiring plan.' };
    expect(commentAfterSend(drafts, 'c1', 'And the budget?')).toBe(drafts);
    // and one that was emptied and rewritten
    const rewritten = { c1: 'Something else entirely' };
    expect(commentAfterSend(rewritten, 'c1', 'And the budget?')).toBe(rewritten);
  });

  it('the answers are cleared when they are what was sent (the unanswered question stays empty)', () => {
    const drafts: AnswerDrafts = { c1: ['About 40 euros', '', ' A missed launch '], c2: ['x'] };
    // what was sent is trimmed, as the composer sends it
    expect(answersAfterSend(drafts, 'c1', questions, sent)).toEqual({ c2: ['x'] });
  });

  it('REPRODUCTION: an answer edited while the request was in flight stays; the others are cleared', () => {
    const drafts: AnswerDrafts = {
      c1: ['About 40 euros', '', 'A missed launch, and a lost customer'],
    };
    expect(answersAfterSend(drafts, 'c1', questions, sent)).toEqual({
      c1: ['', '', 'A missed launch, and a lost customer'],
    });
    // an answer written to a question that was not answered when it was sent is newer too
    const added: AnswerDrafts = { c1: ['About 40 euros', 'Nobody', 'A missed launch'] };
    expect(answersAfterSend(added, 'c1', questions, sent)).toEqual({ c1: ['', 'Nobody', ''] });
  });

  it('changes nothing when nothing in the drafts is what was sent', () => {
    const drafts: AnswerDrafts = { c1: ['Changed', '', 'Changed too'] };
    expect(answersAfterSend(drafts, 'c1', questions, sent)).toBe(drafts);
    const other: AnswerDrafts = { c2: ['x'] };
    expect(answersAfterSend(other, 'c1', questions, sent)).toBe(other);
  });
});
