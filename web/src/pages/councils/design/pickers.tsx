// The pickers of an agent's prompt and output form: each lists the Library entries that FIT this agent (a prompt written for its form
// and for its inputs; a form its place in the design allows), marks the built-in ones, says in one line what each is, and has two
// ways out: «Open in Library» (the current entry) and «New from this…» (a copy of it that is then used here). A node holds only the
// id of the entry: editing an entry in the Library changes every model that uses it.

import { BookOpenIcon, CheckIcon, ChevronDownIcon, CopyPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { Flow, FlowAgent } from '../../../../../src/shared/flow.ts';
import type { LibraryView } from '../../../../../src/shared/library.ts';
import { entryName } from '../../library/labels.ts';
import { NewEntryDialog } from '../../library/NewEntryDialog.tsx';
import {
  applyForm,
  applyPrompt,
  contextOf,
  formPreview,
  formsFor,
  promptPreview,
  promptsFor,
} from './library.ts';

interface Option {
  id: string;
  name: string;
  builtin: boolean;
  preview: string;
}

function Picker({
  testid,
  labelledby,
  current,
  options,
  hidden,
  showAll,
  onShowAll,
  onPick,
  href,
  onNewFrom,
  disabled,
}: {
  testid: 'agent-prompt' | 'agent-form';
  labelledby: string;
  current: Option;
  options: Option[];
  /** How many entries do not fit and are left out. */
  hidden: number;
  showAll: boolean;
  onShowAll: (next: boolean) => void;
  onPick: (id: string) => void;
  href: string;
  onNewFrom: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            data-testid={testid}
            data-value={current.id}
            aria-labelledby={labelledby}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-start text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
        }
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium" dir="auto" data-testid={`${testid}-name`}>
              {current.name}
            </span>
            {current.builtin ? (
              <Badge variant="secondary" className="shrink-0">
                {t('flow.pick.builtin')}
              </Badge>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground" dir="auto">
            {current.preview}
          </span>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0"
        data-testid={`${testid}-list`}
      >
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1" role="listbox">
          {options.map((option) => (
            <div key={option.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.id === current.id}
                data-testid="picker-option"
                data-entry-id={option.id}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-muted focus-visible:bg-muted',
                  option.id === current.id && 'bg-muted',
                )}
                onClick={() => {
                  setOpen(false);
                  if (option.id !== current.id) onPick(option.id);
                }}
              >
                <CheckIcon
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    option.id === current.id ? 'opacity-100' : 'opacity-0',
                  )}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium" dir="auto">
                      {option.name}
                    </span>
                    {option.builtin ? (
                      <Badge variant="secondary" className="shrink-0">
                        {t('flow.pick.builtin')}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground" dir="auto">
                    {option.preview}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
        {hidden > 0 || showAll ? (
          <div className="border-t px-1 py-1">
            <Button
              variant="ghost"
              size="xs"
              data-testid="picker-show-all"
              onClick={() => onShowAll(!showAll)}
            >
              {showAll ? t('flow.pick.onlyFit') : t('flow.pick.showAll', { count: hidden })}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1 border-t p-1">
          <Button
            variant="ghost"
            size="xs"
            data-testid="picker-open-library"
            render={<a href={href} />}
            onClick={() => setOpen(false)}
          >
            <BookOpenIcon />
            {t('flow.pick.openLibrary')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            data-testid="picker-new-from"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onNewFrom();
            }}
          >
            <CopyPlusIcon />
            {t('flow.pick.newFrom')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PickerProps {
  flow: Flow;
  agent: FlowAgent;
  library: LibraryView;
  disabled: boolean;
  onChange: (next: Flow) => void;
  /** An entry was made from a picker: the Library as it is now. */
  onLibrary: (next: LibraryView) => void;
  labelledby: string;
}

/** The prompt of an agent: the Library's prompts written for its form and its inputs. */
export function PromptPicker({
  flow,
  agent,
  library,
  disabled,
  onChange,
  onLibrary,
  labelledby,
}: PickerProps) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const [making, setMaking] = useState(false);
  const context = contextOf(flow, agent);
  const shown = promptsFor(library, agent, context, all);
  const everything = promptsFor(library, agent, context, true);
  const current = library.prompts.find((item) => item.id === agent.prompt);
  const option = (item: LibraryView['prompts'][number]): Option => ({
    id: item.id,
    name: entryName(item, 'prompts', t),
    builtin: item.builtin,
    preview: promptPreview(item.text),
  });
  return (
    <>
      <Picker
        testid="agent-prompt"
        labelledby={labelledby}
        current={
          current
            ? option(current)
            : { id: agent.prompt ?? '', name: agent.prompt ?? '', builtin: false, preview: '' }
        }
        options={shown.map(option)}
        hidden={everything.length - shown.length}
        showAll={all}
        onShowAll={setAll}
        onPick={(id) => {
          const next = library.prompts.find((item) => item.id === id);
          if (next) onChange(applyPrompt(flow, agent.id, next));
        }}
        href={`#/library/prompts/${current?.id ?? agent.prompt ?? ''}`}
        onNewFrom={() => setMaking(true)}
        disabled={disabled}
      />
      {making && current ? (
        <NewEntryDialog
          kind="prompts"
          from={{ id: current.id, name: entryName(current, 'prompts', t) }}
          taken={library.prompts.map((item) => item.id)}
          onClose={() => setMaking(false)}
          onDone={(view, id) => {
            setMaking(false);
            onLibrary(view);
            const made = view.prompts.find((item) => item.id === id);
            if (made) onChange(applyPrompt(flow, agent.id, made));
          }}
        />
      ) : null}
    </>
  );
}

/** The output form of an agent: the Library's forms its place in the design allows. */
export function FormPicker({
  flow,
  agent,
  library,
  disabled,
  onChange,
  onLibrary,
  labelledby,
}: PickerProps) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const [making, setMaking] = useState(false);
  const context = contextOf(flow, agent);
  const shown = formsFor(library, agent, context, all);
  const everything = formsFor(library, agent, context, true);
  const current = library.forms.find((item) => item.id === agent.form);
  const option = (item: LibraryView['forms'][number]): Option => ({
    id: item.id,
    name: item.builtin ? t(`flow.form.${item.id}` as Key) : item.name,
    builtin: item.builtin,
    preview: formPreview(item),
  });
  return (
    <>
      <Picker
        testid="agent-form"
        labelledby={labelledby}
        current={
          current
            ? option(current)
            : {
                id: agent.form,
                name: agent.formInfo?.name ?? agent.form,
                builtin: false,
                preview: '',
              }
        }
        options={shown.map(option)}
        hidden={everything.length - shown.length}
        showAll={all}
        onShowAll={setAll}
        onPick={(id) => {
          const next = library.forms.find((item) => item.id === id);
          if (next) onChange(applyForm(flow, agent.id, next, library));
        }}
        href={`#/library/forms/${current?.id ?? agent.form}`}
        onNewFrom={() => setMaking(true)}
        disabled={disabled}
      />
      {making && current ? (
        <NewEntryDialog
          kind="forms"
          from={{ id: current.id, name: option(current).name }}
          taken={library.forms.map((item) => item.id)}
          onClose={() => setMaking(false)}
          onDone={(view, id) => {
            setMaking(false);
            onLibrary(view);
            const made = view.forms.find((item) => item.id === id);
            if (made) onChange(applyForm(flow, agent.id, made, view));
          }}
        />
      ) : null}
    </>
  );
}
