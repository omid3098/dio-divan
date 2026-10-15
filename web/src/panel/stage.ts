import { seatsOf } from '../../../src/shared/flow.ts';
// Which stage a running round is in: the members answer, the chairman writes, or the answer is ready. Pure, so a test can pin it.

import type { ChairNode } from '../../../src/shared/types.ts';

export type Stage = 'members' | 'chairman' | 'ready';

/**
 * The round is the members' while any of them is still working. It is the chairman's as soon as every member has settled
 * (answered, failed, or been stopped by the asker), even in the moment before the chairman reports that it started: the stage
 * card and the header must not say «members answer» while every row says «did not take part».
 */
export const stageOf = (
  chair: Pick<ChairNode, 'status' | 'seats' | 'steps'> & {
    chairman?: Pick<NonNullable<ChairNode['chairman']>, 'state'>;
  },
): Stage =>
  chair.status === 'done'
    ? 'ready'
    : (chair.steps?.find((step) => step.form === 'answer')?.run.state ?? chair.chairman?.state) ===
          'running' ||
        (chair.steps?.find((step) => step.form === 'answer')?.run.state ??
          chair.chairman?.state) === 'done' ||
        seatsOf(chair).every((seat) => seat.state !== 'running' && seat.state !== 'pending')
      ? 'chairman'
      : 'members';
