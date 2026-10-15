import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { computeDefaults, speedKey } from '../src/shared/defaults.ts';
import { note } from '../src/shared/messages.ts';
import { modelFamily } from '../src/shared/text.ts';

it('Hermes discovery is unavailable on non-Windows before any launch', async () => {
  vi.resetModules();
  vi.stubEnv('DIVAN_FAKE', '1');
  vi.stubEnv('DIVAN_FAKE_DETECTION', '');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { detect } = await import('../src/server/detection.ts');
    expect((await detect(true)).status.find((item) => item.id === 'hermes')).toMatchObject({
      usable: false,
      note: note('hermes_platform'),
    });
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  }
});

it('Hermes security/preflight failure replaces formerly usable discovery', async () => {
  vi.resetModules();
  vi.stubEnv('DIVAN_FAKE', '1');
  const good = {
    status: [{ id: 'hermes', installed: true, usable: true, note: null }],
    models: [
      {
        harness: 'hermes',
        models: [{ id: 'hermes/fixture/gpt-a', label: 'fixture', efforts: [], defaultEffort: '' }],
        listed: true,
        defaultModel: 'hermes/fixture/gpt-a',
        note: null,
        fallbackEfforts: [],
        fetchedAt: '',
      },
    ],
    detectedAt: '',
  };
  vi.stubEnv('DIVAN_FAKE_DETECTION', JSON.stringify(good));
  try {
    const { detect } = await import('../src/server/detection.ts');
    expect((await detect()).status[0]?.usable).toBe(true);
    vi.stubEnv(
      'DIVAN_FAKE_DETECTION',
      JSON.stringify({
        ...good,
        status: [{ id: 'hermes', installed: true, usable: false, note: note('hermes_guard') }],
        models: [],
      }),
    );
    const failed = await detect(true);
    expect(failed.status[0]).toMatchObject({ usable: false, note: note('hermes_guard') });
    expect(failed.status[0]?.notRechecked).toBeUndefined();
    expect(failed.models).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('merges per assistant, keeps failed checks and replaces Claude aliases with its catalogue', async () => {
  vi.resetModules();
  vi.stubEnv('DIVAN_FAKE', '1');
  const good = {
    status: [
      { id: 'claude', installed: true, usable: true, note: null },
      { id: 'codex', installed: true, usable: false, note: null },
    ],
    models: [
      {
        harness: 'claude',
        listed: false,
        models: [],
        defaultModel: '',
        note: null,
        fallbackEfforts: [],
        fetchedAt: '',
      },
    ],
    detectedAt: '',
  };
  vi.stubEnv('DIVAN_FAKE_DETECTION', JSON.stringify(good));
  try {
    const { detect } = await import('../src/server/detection.ts');
    const initial = detect();
    expect(detect(true)).toBe(initial);
    const cached = await initial;
    const aliases = cached.models[0];
    expect(aliases?.aliases).toBe(true);
    expect(aliases?.models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'haiku']);
    const council = computeDefaults(cached.models);
    expect(council.seats.filter((seat) => seat.enabled)).toHaveLength(2);
    expect(council.chairman.model).toBe('haiku');
    expect(aliases?.models.every((model) => modelFamily(model.id, 'claude') === 'anthropic')).toBe(
      true,
    );
    expect(speedKey('claude', 'opus')).not.toBe(speedKey('claude', 'sonnet'));
    vi.stubEnv(
      'DIVAN_FAKE_DETECTION',
      JSON.stringify({
        ...good,
        status: [
          { ...good.status[0], usable: false, note: note('claude_login_unknown') },
          { ...good.status[1], usable: true },
        ],
        models: [
          {
            harness: 'codex',
            listed: true,
            models: [{ id: 'gpt-a', label: 'gpt-a', efforts: [], defaultEffort: '' }],
            defaultModel: 'gpt-a',
            note: null,
            fallbackEfforts: [],
            fetchedAt: '',
          },
        ],
      }),
    );
    const refresh = detect(true);
    expect(detect(true)).toBe(refresh);
    expect(await detect(false)).toBe(cached);
    const merged = await refresh;
    expect(merged.status[0]).toMatchObject({ usable: true, notRechecked: true });
    expect(merged.status[1]).toMatchObject({ usable: true });
    expect(merged.models.find((item) => item.harness === 'claude')).toEqual(aliases);
    expect(merged.models.find((item) => item.harness === 'codex')?.models[0]?.id).toBe('gpt-a');
    for (const code of ['codex_login_unknown', 'codex_not_logged_in'] as const) {
      vi.stubEnv(
        'DIVAN_FAKE_DETECTION',
        JSON.stringify({
          ...good,
          status: [
            { ...good.status[0], usable: true },
            { ...good.status[1], usable: false, note: note(code) },
          ],
          models: [],
        }),
      );
      const checked = await detect(true);
      const codex = checked.status.find((item) => item.id === 'codex');
      if (code === 'codex_login_unknown') {
        expect(codex).toMatchObject({ usable: true, notRechecked: true });
        expect(checked.models.find((item) => item.harness === 'codex')?.models[0]?.id).toBe(
          'gpt-a',
        );
      } else {
        expect(codex).toMatchObject({ usable: false, note: note(code) });
        expect(codex?.notRechecked).toBeUndefined();
      }
      expect(checked.status[0]?.notRechecked).toBeUndefined();
    }
    vi.stubEnv(
      'DIVAN_FAKE_DETECTION',
      JSON.stringify({
        ...good,
        models: [
          {
            ...good.models[0],
            listed: true,
            models: [{ id: 'claude-opus-example', label: 'Opus', efforts: [], defaultEffort: '' }],
          },
        ],
      }),
    );
    const real = await detect(true);
    expect(real.models[0]?.aliases).toBeUndefined();
    expect(real.models[0]?.models[0]?.id).toBe('claude-opus-example');
    expect(real.status[0]?.notRechecked).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('accepts partial results on the first check', async () => {
  vi.resetModules();
  vi.stubEnv('DIVAN_FAKE', '1');
  vi.stubEnv(
    'DIVAN_FAKE_DETECTION',
    JSON.stringify({
      status: [
        { id: 'claude', installed: true, usable: false, note: note('claude_login_unknown') },
      ],
      models: [],
      detectedAt: '',
    }),
  );
  try {
    const { detect } = await import('../src/server/detection.ts');
    expect((await detect()).status[0]?.note?.code).toBe('claude_login_unknown');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('an assistant that is where its installer puts it but not on PATH is said to be there, and is never run', async () => {
  vi.resetModules();
  const windows = process.platform === 'win32';
  const root = mkdtempSync(join(tmpdir(), 'divan-offpath-'));
  const home = join(root, 'home');
  const folder = join(home, '.local', 'bin');
  const noPath = join(root, 'empty-path');
  const marker = join(root, 'ran');
  mkdirSync(folder, { recursive: true });
  mkdirSync(noPath);
  const program = join(folder, windows ? 'claude.exe' : 'claude');
  // what an installer left: on Unix a script that would leave a marker if anything ran it
  writeFileSync(program, windows ? '' : `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  // nothing real is looked at: this computer's home, PATH and Hermes folders are replaced by empty ones
  vi.stubEnv('DIVAN_FAKE', '');
  vi.stubEnv('DIVAN_FAKE_DETECTION', '');
  vi.stubEnv('PATH', noPath);
  for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, home);
  for (const name of ['LOCALAPPDATA', 'HERMES_HOME']) vi.stubEnv(name, join(root, name));
  try {
    const { detect, offPathProgram } = await import('../src/server/detection.ts');
    expect(offPathProgram('claude')).toBe(program);
    expect(offPathProgram('codex')).toBeNull();
    expect(offPathProgram('pi')).toBeNull();
    const status = (await detect(true)).status;
    expect(status.find((item) => item.id === 'claude')).toEqual({
      id: 'claude',
      installed: false,
      usable: false,
      note: note('harness_off_path', { path: program, folder }),
    });
    expect(status.find((item) => item.id === 'codex')?.note).toEqual(note('harness_missing'));
    expect(existsSync(marker)).toBe(false);
    // Grok's location is documented for Windows only
    const grokFolder = join(home, '.grok', 'bin');
    mkdirSync(grokFolder, { recursive: true });
    writeFileSync(join(grokFolder, windows ? 'grok.exe' : 'grok'), '');
    expect(offPathProgram('grok') === null).toBe(!windows);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
