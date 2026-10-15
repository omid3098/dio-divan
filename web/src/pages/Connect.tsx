// Connect: how Pi, T3 Code and any OpenAI-compatible client reach the council: the address, the key, the fixed port (with a
// sentence that says what the port is now), the models this endpoint offers (every council, at four reasoning levels), a
// setup snippet per tool, and a connection test.

import { CheckIcon, EyeIcon, EyeOffIcon, PlugZapIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { testEndpoint } from '@/actions';
import { ApiError, api } from '@/api';
import { Mono } from '@/components/bidi';
import { CopyButton } from '@/components/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/i18n/index.tsx';
import { noteText } from '@/i18n/notes.tsx';
import { profileName } from '@/lib/profile';
import { REASONING_LEVELS } from '../../../src/shared/levels.ts';
import type { EndpointInfo, Meta } from '../../../src/shared/types.ts';

type Endpoint = EndpointInfo & { key: string };

function Row({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Connect({ meta }: { meta: Meta }) {
  const { t, tx } = useI18n();
  const endpoint = meta.endpoint;
  const [info, setInfo] = useState<Endpoint | null>(null);
  const [shown, setShown] = useState(false);
  const [port, setPort] = useState(String(endpoint.configuredPort));
  const [note, setNote] = useState<string | null>(null);
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle');
  const [reason, setReason] = useState('');
  const [found, setFound] = useState(0);

  useEffect(() => {
    api<Endpoint>('/endpoint')
      .then(setInfo)
      .catch(() => undefined);
  }, []);

  async function savePort() {
    setNote(null);
    try {
      const next = await api<Endpoint>('/endpoint', 'PUT', { port: Number(port) });
      setInfo(next);
      setNote(
        next.configuredPort === next.port ? t('connect.portSaved') : t('connect.portSavedLater'),
      );
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : t('connect.portFailed'));
    }
  }

  // A browser may not call /v1 (it is for programs), so the server calls its own /v1/models with the key, as a client would.
  async function runTest() {
    setTest('testing');
    setReason('');
    try {
      const result = await testEndpoint();
      if (result.ok) {
        setFound(result.models.length);
        setTest('ok');
      } else {
        setReason(noteText(result));
        setTest('failed');
      }
    } catch (error) {
      setReason(error instanceof ApiError ? error.message : t('common.serverError'));
      setTest('failed');
    }
  }

  const key = info?.key ?? '';
  const masked = info ? (shown ? info.key : `${info.key.slice(0, 6)}${'•'.repeat(20)}`) : '…';
  const normalPort = endpoint.port === endpoint.defaultPort;
  const profiles = meta.settings.profiles;
  const first = profiles[0]?.id ?? 'default';
  // the real folder of the extension on this PC (the server knows its own install path); quoted when it has a space
  const piFolder = /\s/u.test(endpoint.piExtension)
    ? `"${endpoint.piExtension}"`
    : endpoint.piExtension;
  // T3 Code has no OpenAI-compatible provider: Divan is its own provider there (ACP, a local command), given as T3 asks for it,
  // the executable and then its arguments one per line
  const t3Command = [
    `Executable  ${endpoint.acp.command}`,
    ...endpoint.acp.args.map(
      (arg, index) => `${index === 0 ? 'Arguments   ' : ' '.repeat(12)}${arg}`,
    ),
  ].join('\n');
  const curl = `curl ${endpoint.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${shown && key ? key : '<API key>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "divan/${first}", "reasoning_effort": "high", "messages": [{"role": "user", "content": "Which should we build first?"}]}'`;

  return (
    <div className="h-full overflow-y-auto" data-testid="connect">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold">{t('nav.connect')}</h2>
          <p className="text-sm text-muted-foreground">{t('connect.intro')}</p>
        </div>

        <section
          className="divide-y rounded-lg border px-4"
          data-testid="endpoint"
          aria-label={t('connect.endpoint')}
        >
          <Row
            label={t('connect.url')}
            action={<CopyButton text={endpoint.baseUrl} data-testid="copy-url" />}
          >
            <Mono className="text-sm break-all" data-testid="endpoint-url">
              {endpoint.baseUrl}
            </Mono>
          </Row>
          <Row
            label={t('connect.key')}
            action={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!info}
                  onClick={() => setShown((value) => !value)}
                >
                  {shown ? <EyeOffIcon /> : <EyeIcon />}
                  {shown ? t('common.hide') : t('common.show')}
                </Button>
                <CopyButton text={key} data-testid="copy-key" />
              </>
            }
          >
            <Mono className="text-sm break-all" data-testid="endpoint-key">
              {masked}
            </Mono>
            <p className="mt-1 text-xs text-muted-foreground">{t('connect.keyHint')}</p>
          </Row>
          <div className="py-3">
            <FieldGroup>
              <Field orientation="horizontal" className="flex-wrap items-center">
                <FieldLabel
                  htmlFor="endpoint-port"
                  className="w-28 flex-none text-sm font-normal text-muted-foreground"
                >
                  {t('connect.port')}
                </FieldLabel>
                <Input
                  id="endpoint-port"
                  data-testid="endpoint-port"
                  type="number"
                  inputMode="numeric"
                  dir="ltr"
                  className="w-28 flex-none font-mono"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
                <Button size="sm" variant="outline" onClick={() => void savePort()}>
                  {t('common.save')}
                </Button>
              </Field>
              <FieldDescription>
                {endpoint.port !== endpoint.configuredPort
                  ? t('connect.portDiffers', { running: endpoint.port })
                  : normalPort
                    ? t('connect.portNormal', { port: endpoint.port })
                    : t('connect.portOther', {
                        port: endpoint.port,
                        normal: endpoint.defaultPort,
                      })}{' '}
                {note}
              </FieldDescription>
            </FieldGroup>
          </div>
          <div className="flex flex-wrap items-center gap-3 py-3" data-testid="test-row">
            <Button
              variant="outline"
              data-testid="test-connection"
              disabled={test === 'testing'}
              onClick={() => void runTest()}
            >
              {test === 'testing' ? <Spinner aria-label={t('connect.testing')} /> : <PlugZapIcon />}
              {t('connect.test')}
            </Button>
            {test === 'ok' ? (
              <Badge variant="secondary" data-testid="test-result" data-result="ok">
                <CheckIcon />
                {t('connect.connected')} · {t('connect.modelsFound', { count: found })}
              </Badge>
            ) : null}
            {test === 'failed' ? (
              <Badge variant="destructive" data-testid="test-result" data-result="failed">
                {t('connect.stopped')}
                {reason ? ` · ${reason}` : ''}
              </Badge>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="models-heading">
          <h3 id="models-heading" className="text-sm font-medium">
            {t('connect.models')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('connect.modelsHint')}</p>
          <ul className="divide-y rounded-lg border px-4" data-testid="models">
            {profiles.map((profile) => (
              <li key={profile.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <Mono className="text-sm">divan/{profile.id}</Mono>
                <span className="text-sm text-muted-foreground" translate="no">
                  {profileName(profile, t)}
                </span>
                {profile.blocked ? (
                  <Badge variant="destructive">{t('connect.blocked')}</Badge>
                ) : null}
                <span className="ms-auto flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {REASONING_LEVELS.map((level) => (
                    <Badge
                      key={level}
                      variant={level === profile.defaultLevel ? 'secondary' : 'outline'}
                    >
                      {t(`level.${level}`)}
                    </Badge>
                  ))}
                </span>
                <CopyButton text={`divan/${profile.id}`} />
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="setup-heading">
          <h3 id="setup-heading" className="text-sm font-medium">
            {t('connect.setup')}
          </h3>
          <Tabs defaultValue="pi">
            <TabsList>
              <TabsTrigger value="pi">Pi</TabsTrigger>
              <TabsTrigger value="t3">T3 Code</TabsTrigger>
              <TabsTrigger value="other">{t('connect.other')}</TabsTrigger>
            </TabsList>
            <TabsContent value="pi" className="flex flex-col gap-2 pt-3">
              <p className="text-sm text-muted-foreground">{t('connect.piSteps')}</p>
              <Snippet text={`pi install ${piFolder}`} />
              <p className="text-sm text-muted-foreground">
                {tx('connect.piLevels', {
                  model: <Mono key="m">divan/{first}</Mono>,
                  command: <Mono key="c">/model</Mono>,
                })}
              </p>
            </TabsContent>
            <TabsContent value="t3" className="flex flex-col gap-2 pt-3">
              <p className="text-sm text-muted-foreground">{t('connect.t3Steps')}</p>
              <Snippet text={t3Command} />
              <p className="text-sm text-muted-foreground">
                {tx('connect.t3Levels', { model: <Mono key="m">d1-{first}</Mono> })}
              </p>
            </TabsContent>
            <TabsContent value="other" className="flex flex-col gap-2 pt-3">
              <p className="text-sm text-muted-foreground">{t('connect.otherSteps')}</p>
              <Snippet text={curl} />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    // a command is left to right whatever the interface is: the block is, and the button is at its physical right, clear of it
    <div className="relative" dir="ltr">
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 pr-24 font-mono text-xs leading-5 whitespace-pre-wrap">
        {text}
      </pre>
      <div className="absolute top-1 right-1">
        <CopyButton text={text} />
      </div>
    </div>
  );
}
