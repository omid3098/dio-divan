// The stage of a running round follows what is really happening: once every member has settled the round is the chairman's,
// even before the chairman reports that it started (after «stop waiting» the stage card must not still say «members answer»).

import { describe, expect, it } from 'vitest';
import type { SeatRun } from '../src/shared/types.ts';

const MODULE = '../web/src/panel/stage.ts';
type State = SeatRun['state'];
type StageOf = (round: {
  status: string;
  seats: { state: State }[];
  chairman: { state: string };
}) => 'members' | 'chairman' | 'ready';

describe('the stage of a round', async () => {
  const { stageOf } = (await import(MODULE)) as { stageOf: StageOf };
  const round = (states: State[], chairman = 'pending', status = 'running') => ({
    status,
    seats: states.map((state) => ({ state })),
    chairman: { state: chairman },
  });

  it('is the members’ while any of them is working', () => {
    expect(stageOf(round(['done', 'running', 'done', 'done']))).toBe('members');
    expect(stageOf(round(['pending', 'pending']))).toBe('members');
  });

  it('is the chairman’s the moment every member has settled: answered, failed, or stopped by the asker', () => {
    // «Stop waiting for this member»: three answered, the fourth is skipped, the chairman has not reported yet
    expect(stageOf(round(['done', 'done', 'done', 'skipped']))).toBe('chairman');
    expect(stageOf(round(['done', 'failed', 'timeout', 'done']))).toBe('chairman');
    expect(stageOf(round(['done', 'done'], 'running'))).toBe('chairman');
  });

  it('is ready when the round is done', () => {
    expect(stageOf(round(['done', 'done'], 'done', 'done'))).toBe('ready');
  });
});
