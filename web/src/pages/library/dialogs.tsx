// What the Library page asks and says in a dialog: the models and prompts that keep an entry from being deleted.

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n/index.tsx';
import { isolate } from '@/lib/isolate';
import type { LibraryView } from '../../../../src/shared/library.ts';
import type { ProfileView } from '../../../../src/shared/types.ts';
import { modelsOf } from './labels.ts';

/** A deletion the server refused: which models (and which prompts, for a form) still use the entry. */
export function InUseDialog({
  name,
  models,
  prompts,
  library,
  profiles,
  onClose,
}: {
  name: string;
  models: string[];
  prompts: string[];
  library: LibraryView;
  profiles: readonly ProfileView[];
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="in-use-dialog">
        <DialogHeader>
          <DialogTitle>{t('library.inUse.title')}</DialogTitle>
          <DialogDescription>
            {t('library.inUse.text', { name: isolate(name, lang) })}
          </DialogDescription>
        </DialogHeader>
        {models.length > 0 ? (
          <section className="flex flex-col gap-1.5" aria-labelledby="in-use-models">
            <h3 id="in-use-models" className="text-sm font-medium">
              {t('library.inUse.models')}
            </h3>
            <ul className="flex flex-wrap gap-1.5" data-testid="in-use-models">
              {modelsOf(models, profiles, t).map((model) => (
                <li key={model.id}>
                  <a
                    href={`#/models/${model.id}`}
                    data-model-id={model.id}
                    className="inline-flex rounded-md border px-2 py-1 text-sm hover:bg-muted"
                    onClick={onClose}
                  >
                    <span dir="auto">{model.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {prompts.length > 0 ? (
          <section className="flex flex-col gap-1.5" aria-labelledby="in-use-prompts">
            <h3 id="in-use-prompts" className="text-sm font-medium">
              {t('library.inUse.prompts')}
            </h3>
            <ul className="flex flex-wrap gap-1.5" data-testid="in-use-prompts">
              {prompts.map((id) => (
                <li key={id}>
                  <a
                    href={`#/library/prompts/${id}`}
                    className="inline-flex rounded-md border px-2 py-1 text-sm hover:bg-muted"
                    onClick={onClose}
                  >
                    <span dir="auto">
                      {library.prompts.find((item) => item.id === id)?.name ?? id}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('library.inUse.how')}</p>
        <DialogFooter>
          <Button data-testid="in-use-close" onClick={onClose}>
            {t('library.inUse.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
