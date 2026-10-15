// Once a conversation has branches, the original line is named too («Main»), so no two rounds read the same: «Round 3» on the
// main line and «Round 3 · Branch 2».

import { describe, expect, it } from 'vitest';
import type { SessionNode } from '../src/shared/types.ts';
import { branchLabelText, branchNames, branchNumbers } from '../web/src/canvas/branches.ts';
import { chairNode, userNode } from './fixtures.ts';

const at = (n: number) => `2026-10-10T00:0${n}:00Z`;
const tree = (nodes: SessionNode[]) => Object.fromEntries(nodes.map((node) => [node.id, node]));

describe('the branch a node is in', () => {
  it('names nothing while the conversation is one line', () => {
    const nodes = tree([
      userNode('u0', null, 'Q'),
      chairNode('c1', 'u0', 1),
      userNode('u1', 'c1', 'More'),
      chairNode('c2', 'u1', 2),
    ]);
    expect(branchNumbers(nodes).size).toBe(0);
    expect(branchNames(nodes).size).toBe(0);
  });

  it('names the original line «Main» and the next lines 2, 3, once a round is asked again from a round that has a child', () => {
    const nodes = tree([
      { ...userNode('u0', null, 'Q'), createdAt: at(0) },
      { ...chairNode('c1', 'u0', 1), createdAt: at(1) },
      { ...userNode('u1', 'c1', 'First follow-up'), createdAt: at(2) },
      { ...chairNode('c2', 'u1', 2), createdAt: at(3) },
      // the second line from round 1, then a third
      { ...userNode('u2', 'c1', 'Another way'), createdAt: at(4) },
      { ...chairNode('c3', 'u2', 2), createdAt: at(5) },
      { ...userNode('u3', 'c1', 'And a third'), createdAt: at(6) },
    ]);
    const names = branchNames(nodes);
    for (const id of ['u0', 'c1', 'u1', 'c2']) expect(names.get(id), id).toBe('main');
    for (const id of ['u2', 'c3']) expect(names.get(id), id).toBe(2);
    expect(names.get('u3')).toBe(3);
    // the two second rounds no longer read the same
    expect(names.get('c2')).not.toBe(names.get('c3'));
  });

  it('REPRODUCTION: a branch from round 1 and a later one from round 2 of Main are two branches, never both «Branch 2»', () => {
    const nodes = tree([
      { ...userNode('u0', null, 'Q'), createdAt: at(0) },
      { ...chairNode('c1', 'u0', 1), createdAt: at(1) },
      // the main line goes on: a follow-up and its round 2
      { ...userNode('u1', 'c1', 'Follow-up'), createdAt: at(2) },
      { ...chairNode('c2', 'u1', 2), createdAt: at(3) },
      // the first branch, from round 1
      { ...userNode('u2', 'c1', 'Another way from round one'), createdAt: at(4) },
      { ...chairNode('c3', 'u2', 2), createdAt: at(5) },
      // round 2 of Main goes on (its first child), and is then branched from (its second child)
      { ...userNode('u3', 'c2', 'Main goes on'), createdAt: at(6) },
      { ...chairNode('c4', 'u3', 3), createdAt: at(7) },
      { ...userNode('u4', 'c2', 'A branch from round two'), createdAt: at(8) },
      { ...chairNode('c5', 'u4', 3), createdAt: at(9) },
    ]);
    const names = branchNames(nodes);
    for (const id of ['u0', 'c1', 'u1', 'c2', 'u3', 'c4']) expect(names.get(id), id).toBe('main');
    for (const id of ['u2', 'c3']) expect(names.get(id), id).toBe(2);
    for (const id of ['u4', 'c5']) expect(names.get(id), id).toBe(3);
    // the numbers follow the order the branches were made in, across the whole conversation
    expect([...branchNumbers(nodes)].sort()).toEqual([
      ['u2', 2],
      ['u4', 3],
    ]);
  });

  it('numbers by creation order, whatever the order the nodes are listed in', () => {
    const late = { ...userNode('u9', 'c1', 'late branch'), createdAt: at(8) };
    const early = { ...userNode('u8', 'c1', 'early branch'), createdAt: at(4) };
    const nodes = tree([
      { ...userNode('u0', null, 'Q'), createdAt: at(0) },
      { ...chairNode('c1', 'u0', 1), createdAt: at(1) },
      { ...userNode('u1', 'c1', 'first line'), createdAt: at(2) },
      late,
      early,
    ]);
    expect(branchNumbers(nodes).get('u8')).toBe(2);
    expect(branchNumbers(nodes).get('u9')).toBe(3);
  });

  it("is said in words in both languages' catalogues: «Main», «Branch 2»", () => {
    const t = (key: 'map.main' | 'map.branch', params?: Record<string, string | number>) =>
      key === 'map.main' ? 'Main' : `Branch ${params?.n}`;
    expect(branchLabelText('main', t)).toBe('Main');
    expect(branchLabelText(2, t)).toBe('Branch 2');
  });
});
