import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { agentsOf, chairmanOf, type FlowStep, reportMember, seatsOf } from '../src/shared/flow.ts';
import { I18nProvider } from '../web/src/i18n/index.tsx';
import { ChairPanel } from '../web/src/panel/ChairPanel.tsx';
import { singleFlow, writerFlow } from './fixtures/flows.ts';
import { chairNode, requireValue, sessionOf, userNode } from './fixtures.ts';

vi.mock('../web/src/panel/Waiting.tsx', () => ({ Waiting: () => null }));
vi.mock('../web/src/panel/Composer.tsx', () => ({ Composer: () => null }));

// Inspect the dialog's content without its portal or an interactive browser.
vi.mock('@/components/ui/dialog', () => {
  const wrapper = ({
    children,
    'data-testid': testid,
  }: {
    children: ReactNode;
    'data-testid'?: string;
  }) => createElement('div', { 'data-testid': testid }, children);
  return Object.fromEntries(
    [
      'Dialog',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogTitle',
    ].map((name) => [name, wrapper]),
  );
});

it('the stop dialog counts critics, honours custom minima and requires the draft', () => {
  const flow = writerFlow();
  const chair = chairNode('c1', 'u0', 1, { status: 'running' });
  const seat = requireValue(seatsOf(chair)[0]);
  chair.steps = agentsOf(flow).map((agent): FlowStep => {
    const base = { id: agent.id, inputs: [], aliases: {}, attempts: [] };
    if (agent.form === 'answer')
      return {
        ...base,
        form: 'answer',
        output: null,
        run: { ...chairmanOf(chair), state: 'pending' },
      };
    const run = {
      ...seat,
      seatId: agent.id,
      label: agent.id,
      state: 'running' as const,
      sanitized: null,
      parsed: null,
    };
    return agent.form === 'report'
      ? { ...base, form: 'report', run }
      : { ...base, form: 'member', run };
  });
  const writer = chair.steps[0] as Extract<FlowStep, { form: 'report' }>;
  writer.run.state = 'done';
  writer.run.sanitized = { report: 'draft' };
  const critic = chair.steps[1] as Extract<FlowStep, { form: 'member' }>;
  critic.run.state = 'done';
  critic.run.sanitized = reportMember({ report: 'criticism' });
  const session = sessionOf([userNode('u0', null, 'Q'), chair]);
  session.settings.flow = flow;
  const noop = () => {};
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ChairPanel, {
          session,
          chair,
          running: true,
          openDetail: null,
          onToggleDetail: noop,
          onSeeMember: noop,
          onStarted: noop,
          answers: [],
          onAnswer: noop,
          onSent: noop,
          onUnclear: noop,
          onSelectNode: noop,
          onFocusComposer: noop,
          comment: '',
          onComment: noop,
          focusSignal: 0,
        }),
      ),
    );
  const first = render();
  expect(first).not.toContain('data-testid="stop-rest"');
  expect(first).toContain('Only 1 member has answered');
  const second = chair.steps[2] as Extract<FlowStep, { form: 'member' }>;
  second.run.state = 'done';
  second.run.sanitized = critic.run.sanitized;
  expect(render()).toContain('data-testid="stop-rest"');
  requireValue(agentsOf(flow).at(-1)?.responses).min = 3;
  expect(render()).not.toContain('data-testid="stop-rest"');
  expect(render()).toContain('needs 3 responses');
  requireValue(agentsOf(flow).at(-1)?.responses).min = 2;
  writer.run.state = 'failed';
  expect(render()).not.toContain('data-testid="stop-rest"');
  session.settings.flow = singleFlow();
  const final = requireValue(chair.steps.find((step) => step.form === 'answer'));
  chair.steps = [{ ...final, id: 'assistant' }];
  final.run.state = 'running';
  expect(render()).not.toContain('data-testid="stop-rest"');
  expect(render()).toContain('The assistant stops now.');
});
