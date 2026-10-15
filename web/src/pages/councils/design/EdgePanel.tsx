// The inspector of a line. A line between agents carries an answer: all of its fields, or only the ones ticked (the receiving agent
// then sees nothing else of it). A line that leaves a condition is a gate: it carries no answer, it only lets the next box run when
// that exit is taken. In a design with a condition the person says, for each answer that reaches an agent, whether the agent
// needs it («Required») or is one of several it waits for («One of the answers»): the two sides of a condition are alternatives.

import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Mono } from '@/components/bidi';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n/index.tsx';
import { isolate } from '@/lib/isolate';
import type { Flow } from '../../../../../src/shared/flow.ts';
import type { Selection } from './Canvas.tsx';
import {
  agentOf,
  controllingConditions,
  disconnect,
  inputOf,
  isAgent,
  isCondition,
  nodeOf,
  setWireFields,
  setWireRole,
  setWireWhen,
  wireFields,
  wireRole,
} from './edit.ts';
import { Heading } from './parts.tsx';

export function EdgePanel({
  flow,
  edge,
  names,
  level,
  disabled,
  onChange,
  onSelect,
}: {
  flow: Flow;
  edge: Extract<Selection, { kind: 'edge' }>;
  names: Record<string, string>;
  level: unknown;
  disabled: boolean;
  onChange: (next: Flow) => void;
  onSelect: (next: Selection | null) => void;
}) {
  const { t, lang } = useI18n();
  const from = nodeOf(flow, edge.from);
  const to = nodeOf(flow, edge.to);
  const line = flow.edges.find(
    (item) => item.from === edge.from && item.to === edge.to && item.gate === edge.gate,
  );
  const label = (id: string, kind: string | undefined) =>
    kind === 'input'
      ? t('flow.input.name')
      : kind === 'output'
        ? t('flow.output.name')
        : (names[id] ?? id);
  const toName = isolate(label(edge.to, to?.kind), lang);
  const fromName = isolate(label(edge.from, from?.kind), lang);
  const editable = level === null && !disabled;
  const branched = flow.nodes.some((node) => node.kind === 'condition');
  const role = wireRole(flow, edge.from, edge.to);
  const what = edge.gate
    ? t(edge.gate === 'yes' ? 'flow.edge.gateYes' : 'flow.edge.gateNo', {
        from: fromName,
        to: toName,
      })
    : isCondition(to)
      ? t('flow.edge.read', { from: fromName, to: toName })
      : edge.from === inputOf(flow)
        ? t('flow.edge.input', { to: toName })
        : to?.kind === 'output'
          ? t('flow.edge.output')
          : role === 'required'
            ? t('flow.edge.required', { to: toName })
            : t('flow.edge.group', { to: toName });
  const names_ = wireFields(flow, edge.from, edge.to);
  const picked = line?.fields;
  const controls = controllingConditions(flow, edge.from, edge.to);
  const whenValue = line?.when ? `${line.when.condition}:${line.when.exit}` : 'always';
  // «Choose fields» stays open while every box is ticked (that is the whole answer again), until the person picks «All fields»
  const [choosing, setChoosing] = useState(picked !== undefined);
  const chosen = picked ?? names_ ?? [];
  const source = agentOf(flow, edge.from);
  const described = (name: string): string => {
    const property = source?.schema?.properties?.[name] as { description?: unknown } | undefined;
    return typeof property?.description === 'string' ? property.description : '';
  };
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="inspector-edge" data-gate={edge.gate}>
      <Heading>{t(edge.gate ? 'flow.edge.gateTitle' : 'flow.edge.title')}</Heading>
      <p className="text-sm font-medium" dir="auto">
        {t('flow.edge.ends', { from: fromName, to: toName })}
      </p>
      <p className="text-sm text-muted-foreground">{what}</p>

      {isAgent(from) && isAgent(to) && !edge.gate && branched ? (
        <section className="flex flex-col gap-2" aria-labelledby="edge-when-label">
          <Heading>
            <span id="edge-when-label">{t('flow.edge.onlyWhen')}</span>
          </Heading>
          <Select
            value={whenValue}
            disabled={!editable}
            onValueChange={(value) => {
              if (!value) return;
              const [condition, exit] = value.split(':');
              onChange(
                setWireWhen(
                  flow,
                  edge.from,
                  edge.to,
                  value === 'always'
                    ? undefined
                    : { condition: condition as string, exit: exit as 'yes' | 'no' },
                ),
              );
            }}
          >
            <SelectTrigger
              data-testid="edge-when"
              aria-labelledby="edge-when-label"
              className="w-full"
            >
              <SelectValue>
                {line?.when
                  ? t('flow.edge.whenChoice', {
                      name: isolate(names[line.when.condition] ?? line.when.condition, lang),
                      exit: t(line.when.exit === 'yes' ? 'flow.cond.yes' : 'flow.cond.no'),
                    })
                  : t('flow.edge.always')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always" data-testid="edge-when-always">
                {t('flow.edge.always')}
              </SelectItem>
              {controls.flatMap((condition) =>
                (['yes', 'no'] as const).map((exit) => (
                  <SelectItem
                    key={`${condition.id}:${exit}`}
                    value={`${condition.id}:${exit}`}
                    data-testid={`edge-when-${condition.id}-${exit}`}
                  >
                    {t('flow.edge.whenChoice', {
                      name: isolate(names[condition.id] ?? condition.id, lang),
                      exit: t(exit === 'yes' ? 'flow.cond.yes' : 'flow.cond.no'),
                    })}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
        </section>
      ) : null}

      {names_ && isAgent(to) && !edge.gate ? (
        <section className="flex flex-col gap-2" aria-labelledby="edge-fields">
          <Heading>
            <span id="edge-fields">{t('flow.edge.fields')}</span>
          </Heading>
          <ToggleGroup
            variant="outline"
            spacing={0}
            size="sm"
            aria-labelledby="edge-fields"
            value={[choosing ? 'some' : 'all']}
            disabled={!editable}
            data-testid="edge-fields-mode"
            onValueChange={(value) => {
              if (value[0] === 'all') {
                setChoosing(false);
                onChange(setWireFields(flow, edge.from, edge.to, null));
              } else if (value[0] === 'some') setChoosing(true);
            }}
          >
            <ToggleGroupItem value="all" data-testid="edge-fields-all">
              {t('flow.edge.fieldsAll')}
            </ToggleGroupItem>
            <ToggleGroupItem value="some" data-testid="edge-fields-some">
              {t('flow.edge.fieldsSome')}
            </ToggleGroupItem>
          </ToggleGroup>
          {choosing ? (
            <>
              <ul className="flex flex-col gap-1" data-testid="edge-field-list">
                {names_.map((name) => {
                  const on = chosen.includes(name);
                  const last = on && chosen.length === 1;
                  return (
                    <li key={name}>
                      <label
                        className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                        title={last ? t('flow.edge.fieldsLast') : undefined}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          data-testid={`edge-field-${name}`}
                          checked={on}
                          disabled={!editable || last}
                          onChange={() =>
                            onChange(
                              setWireFields(
                                flow,
                                edge.from,
                                edge.to,
                                on ? chosen.filter((item) => item !== name) : [...chosen, name],
                              ),
                            )
                          }
                        />
                        <span className="flex min-w-0 flex-col">
                          <Mono>{name}</Mono>
                          {described(name) ? (
                            <span className="text-xs text-muted-foreground" dir="auto">
                              {described(name)}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('flow.edge.fieldsHint', { to: toName })}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('flow.edge.fieldsAllHint')}</p>
          )}
        </section>
      ) : null}

      {branched && !edge.gate && isAgent(from) && isAgent(to) && role !== null ? (
        <section className="flex flex-col gap-2" aria-labelledby="edge-role">
          <Heading>
            <span id="edge-role">{t('flow.edge.role', { to: toName })}</span>
          </Heading>
          <ToggleGroup
            variant="outline"
            spacing={0}
            size="sm"
            aria-labelledby="edge-role"
            value={[role]}
            disabled={!editable}
            data-testid="edge-role"
            onValueChange={(value) =>
              value[0] &&
              onChange(setWireRole(flow, edge.from, edge.to, value[0] as 'required' | 'group'))
            }
          >
            <ToggleGroupItem value="required" data-testid="edge-role-required">
              {t('flow.edge.roleRequired')}
            </ToggleGroupItem>
            <ToggleGroupItem value="group" data-testid="edge-role-group">
              {t('flow.edge.roleGroup')}
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">{t('flow.edge.roleHint')}</p>
        </section>
      ) : null}

      {level === null ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="edge-delete"
          disabled={disabled}
          onClick={() => {
            onChange(disconnect(flow, edge.from, edge.to, edge.gate));
            onSelect(null);
          }}
        >
          <Trash2Icon />
          {t('flow.edge.delete')}
        </Button>
      ) : null}
    </div>
  );
}
