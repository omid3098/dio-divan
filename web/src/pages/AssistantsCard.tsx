import { useRef, useState } from 'react';
import { ApiError, api } from '@/api';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { useNotes } from '@/i18n/notes';
import { HARNESS_LABEL } from '../../../src/shared/defaults.ts';
import { note } from '../../../src/shared/messages.ts';
import { modelFamily } from '../../../src/shared/text.ts';
import type { HarnessId, Meta, SettingsView } from '../../../src/shared/types.ts';

const pages: Record<HarnessId, string> = {
  hermes: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation/',
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli/',
  grok: 'https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md',
  pi: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md',
  agy: 'https://antigravity.google/',
};

export function AssistantsCard({
  meta,
  names,
  onChecked,
}: {
  meta: Meta;
  names: string;
  onChecked: (settings: SettingsView) => void;
}) {
  const notes = useNotes();
  const { lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const checking = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const windows = meta.platform === 'win32';
  const hasAutomatic = meta.settings.status.some((item) => item.usable && item.id !== 'agy');
  const install: Record<HarnessId, string> = {
    hermes: '',
    claude: windows
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: 'npm install -g @openai/codex',
    grok: windows
      ? 'irm https://x.ai/cli/install.ps1 | iex'
      : 'curl -fsSL https://x.ai/cli/install.sh | bash',
    pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    agy: '',
  };
  async function check() {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    setFailure(null);
    try {
      onChecked(await api<SettingsView>('/detect', 'POST'));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : notes.text(note('detection_failed')));
    } finally {
      checking.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="ds-group ds-panel" data-testid="assistants-card" open={!hasAutomatic}>
      <summary className="ds-group__head">
        {notes.node(
          names
            ? note('setup_uses', { names })
            : note(hasAutomatic ? 'setup_ready' : 'setup_empty'),
        )}
      </summary>
      <div className="ds-group__body">
        {meta.settings.status
          .filter((item) => item.id !== 'agy' || item.installed)
          .map((item) => {
            // Hermes works on Windows only: elsewhere it is one plain sentence, with nothing to set up
            const hermesElsewhere = item.id === 'hermes' && !windows;
            const offPath = item.note?.code === 'harness_off_path';
            // installed but not on PATH: nothing to install, the sentence says what to do
            const command = !item.installed
              ? offPath
                ? ''
                : install[item.id]
              : item.usable
                ? ''
                : item.id === 'claude'
                  ? 'claude auth login'
                  : item.id === 'codex'
                    ? 'codex login'
                    : item.id === 'grok'
                      ? 'grok login'
                      : item.id === 'pi'
                        ? 'pi'
                        : '';
            const catalogue = item.id === 'claude' && item.note?.code === 'models_claude_none';
            return (
              <div className="ds-row" key={item.id} data-assistant={item.id}>
                <strong translate="no">{HARNESS_LABEL[item.id]}</strong>
                <p>{notes.node(item.note ?? note('setup_ready'))}</p>
                {item.id === 'agy' ? (
                  <p data-testid="agy-warning">
                    {notes.node(note('agy_warning'))} {notes.node(note('agy_controlled_short'))}
                  </p>
                ) : null}
                {item.id === 'hermes' && windows ? (
                  <p>
                    {notes.node(note('hermes_tools_note'))} {notes.node(note('hermes_usage'))}
                  </p>
                ) : null}
                {catalogue ? <p>{notes.node(note('setup_claude_picker'))}</p> : null}
                {item.notRechecked ? (
                  <p role="status">{notes.node(note('setup_not_rechecked'))}</p>
                ) : null}
                {item.usable &&
                meta.settings.models
                  .find((list) => list.harness === item.id)
                  ?.models.some((model) => modelFamily(model.id, item.id) === 'unknown') ? (
                  <p data-testid="unknown-company">{notes.node(note('setup_unknown_company'))}</p>
                ) : null}
                {item.id === 'pi' && !item.usable && item.installed ? (
                  <p>{notes.node(note('setup_pi_login'))}</p>
                ) : null}
                {command || catalogue ? (
                  <div className="ds-command">
                    <code dir="ltr">{catalogue ? 'claude' : command}</code>
                    <CopyButton text={catalogue ? 'claude' : command} />
                  </div>
                ) : null}
                {hermesElsewhere ? null : (
                  <a href={pages[item.id]} target="_blank" rel="noreferrer">
                    {notes.node(note('setup_official'))}
                  </a>
                )}
              </div>
            );
          })}
        <p>{notes.node(note('setup_restart'))}</p>
        <p>
          {notes.node(
            note('setup_checked', {
              time: new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR-u-nu-latn' : 'en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              }).format(new Date(meta.settings.detectedAt)),
            }),
          )}
        </p>
        {failure ? <p role="alert">{failure}</p> : null}
        <Button disabled={busy} onClick={() => void check()} data-testid="check-assistants">
          {busy ? <Spinner /> : null}
          {notes.node(note(busy ? 'setup_checking' : 'setup_check'))}
        </Button>
      </div>
    </details>
  );
}
