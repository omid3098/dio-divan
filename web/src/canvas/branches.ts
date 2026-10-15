// Which branch of the conversation a node is in. A conversation is one line until a round is asked again from a round that has a
// child already: the new line is branch 2, the next branch 3. Once there is a second line, the first needs a name as much as
// the others: it is «Main», so no two rounds read the same («Round 3» of the main line and «Round 3 · Branch 2»).

import type { SessionNode } from '../../../src/shared/types.ts';

/** A branch label: its number (2, 3, …) or `main` for the original line. */
export type BranchLabel = number | 'main';

/** «Main» or «Branch 2», for text that is not made of nodes (the answer's kicker). `t` is the page's translate function. */
export function branchLabelText(
  label: BranchLabel,
  t: (key: 'map.main' | 'map.branch', params?: Record<string, string | number>) => string,
): string {
  return label === 'main' ? t('map.main') : t('map.branch', { n: label });
}

/**
 * The branch number of every node that starts a branch after the first line (it is not the first child of its parent). The
 * branches are numbered across the WHOLE conversation, 2, 3, … in the order they were made, never per parent: a branch from round 1
 * and a later one from round 2 of the main line are two branches, 2 and 3, not both «Branch 2».
 */
export function branchNumbers(nodes: Record<string, SessionNode>): Map<string, number> {
  const byParent = new Map<string, SessionNode[]>();
  for (const node of Object.values(nodes)) {
    if (!node.parentId) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const starts: SessionNode[] = [];
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    starts.push(...siblings.slice(1));
  }
  starts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(starts.map((node, index) => [node.id, index + 2]));
}

/**
 * The branch every node belongs to: the number of the branch that its nearest ancestor-or-self starting one gave (so a branch's
 * whole chain carries its name, not only its first input), and `main` for every node of the original line, but only in a
 * conversation that has branches. A conversation with one line names nothing.
 */
export function branchNames(nodes: Record<string, SessionNode>): Map<string, BranchLabel> {
  const starts = branchNumbers(nodes);
  const out = new Map<string, BranchLabel>();
  if (starts.size === 0) return out;
  const nameOf = (id: string, seen: Set<string>): BranchLabel => {
    const own = starts.get(id);
    if (own !== undefined) return own;
    const parent = nodes[id]?.parentId;
    if (!parent || seen.has(parent)) return 'main';
    seen.add(parent);
    return nameOf(parent, seen);
  };
  for (const id of Object.keys(nodes)) out.set(id, nameOf(id, new Set([id])));
  return out;
}
