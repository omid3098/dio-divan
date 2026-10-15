// Renaming and deleting a session, from the sidebar, the list and the palette. Renaming is a small dialog. Deleting is
// undoable: the session disappears from every list at once, a toast offers Undo for eight seconds, and only when it goes
// unanswered is the session deleted on the server (a page closed meanwhile deletes nothing).

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { deleteSession, renameSession } from '@/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { translate, useI18n } from '@/i18n/index.tsx';
import { forgetSession } from '@/layout-sync';
import { navigate } from '@/leave-guard';
import { parseRoute } from '@/router';
import { hideSession, unhideSession } from '@/store';
import { textDirection } from '../../../src/shared/text.ts';
import type { SessionSummary } from '../../../src/shared/types.ts';

interface Actions {
  rename: (session: SessionSummary) => void;
  remove: (session: SessionSummary) => void;
}

const Context = createContext<Actions | null>(null);

export const useSessionActions = (): Actions => {
  const value = useContext(Context);
  if (!value) throw new Error('SessionActionsProvider is missing');
  return value;
};

const UNDO_MS = 8000;

export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [name, setName] = useState('');

  const remove = useCallback((item: SessionSummary) => {
    if (item.running) {
      toast.add({ title: translate('sessions.runningCannotDelete'), type: 'warning' });
      return;
    }
    hideSession(item.id);
    // a session that is open is left at once: the page behind it would show something that is going away
    const route = parseRoute(window.location.hash);
    const open = route.name === 'session' && route.id === item.id;
    if (open) navigate('#/');
    let undone = false;
    toast.add({
      title: translate('sessions.deleted'),
      description: item.title,
      type: 'info',
      timeout: UNDO_MS,
      actionProps: {
        children: translate('common.undo'),
        onClick: () => {
          undone = true;
          unhideSession(item.id);
        },
      },
      onClose: () => {
        if (undone) return;
        deleteSession(item.id)
          .then(() => forgetSession(item.id))
          .catch(() => {
            unhideSession(item.id);
            toast.add({ title: translate('sessions.deleteFailed'), type: 'error' });
          });
      },
    });
  }, []);

  const rename = useCallback((item: SessionSummary) => {
    setName(item.name);
    setRenaming(item);
  }, []);

  async function commit() {
    if (!renaming || !name.trim()) return;
    const target = renaming;
    setRenaming(null);
    try {
      await renameSession(target.id, name.trim());
    } catch {
      toast.add({ title: translate('sessions.renameFailed'), type: 'error' });
    }
  }

  const value = useMemo(() => ({ rename, remove }), [rename, remove]);
  return (
    <Context.Provider value={value}>
      {children}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('sessions.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rename-input">{t('common.name')}</FieldLabel>
            <Input
              id="rename-input"
              data-testid="rename-input"
              autoFocus
              value={name}
              dir={textDirection(name) ?? undefined}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void commit();
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="rename-ok" disabled={!name.trim()} onClick={() => void commit()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
