// A button that copies a text to the clipboard and says so for a moment. A browser that refuses the clipboard API still copies
// through a field that is selected (the older way).

import { CheckIcon, CopyIcon } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/index.tsx';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.insetBlockStart = '-1000px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function CopyButton({
  text,
  label,
  doneLabel,
  ...props
}: { text: string; label?: string; doneLabel?: string } & Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'children'
>) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <Button
      variant="ghost"
      size="sm"
      {...props}
      onClick={async () => {
        setState((await copyText(text)) ? 'done' : 'failed');
        setTimeout(() => setState('idle'), 1800);
      }}
    >
      {state === 'done' ? <CheckIcon /> : <CopyIcon />}
      {state === 'done'
        ? (doneLabel ?? t('common.copied'))
        : state === 'failed'
          ? t('common.copyFailed')
          : (label ?? t('common.copy'))}
    </Button>
  );
}
