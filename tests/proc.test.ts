// Running a process: a timeout or a cancel kills the whole tree and settles the run; taskkill is the system's own.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree, resolveCommand, runProc, TASKKILL } from '../src/server/proc.ts';

const hang = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log('CHILD ' + c.pid);
setInterval(() => {}, 1000);`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the process runner', () => {
  it('replacement environment reaches the actual child without inherited controls or T3 credentials; inheritance remains available', async () => {
    const key = 'DIVAN_FIX7_ENV_SENTINEL';
    process.env[key] = 'synthetic';
    try {
      const spec = {
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        cwd: process.cwd(),
        idleMs: 5000,
      };
      const child = await runProc({
        ...spec,
        envMode: 'replace',
        env: {
          SystemRoot: process.env.SystemRoot,
          ONLY_ALLOWED: 'yes',
          t3_acp_mcp_authorization: 'synthetic',
        },
      });
      expect(child.code).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ ONLY_ALLOWED: 'yes' });
      expect(JSON.parse(child.stdout)[key]).toBeUndefined();
      expect(JSON.parse(child.stdout).t3_acp_mcp_authorization).toBeUndefined();
      expect(JSON.parse((await runProc(spec)).stdout)[key]).toBe('synthetic');
      expect(
        (await runProc({ ...spec, envMode: 'replace', env: { PATH: 'a', Path: 'b' } })).spawnError,
      ).toBe('Invalid replacement environment');
    } finally {
      delete process.env[key];
    }
  });
  it.skipIf(process.platform === 'win32')(
    'force-stops a Unix process without its own process group',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise((done) => child.once('spawn', done));
      const exited = new Promise((done) => child.once('close', done));
      try {
        expect(await killTree(child.pid as number)).toBe(true);
        await exited;
        expect(alive(child.pid as number)).toBe(false);
      } finally {
        if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
      }
    },
  );
  it('resolves npm and native cmd targets directly in a folder with spaces and Persian text', () => {
    if (process.platform !== 'win32') return;
    const folder = mkdtempSync(join(tmpdir(), 'divan-shim-پوشه '));
    const path = process.env.PATH;
    try {
      mkdirSync(join(folder, 'nested'));
      for (const ext of ['js', 'exe']) {
        writeFileSync(join(folder, 'nested', `target.${ext}`), '');
        writeFileSync(
          join(folder, `${ext}.cmd`),
          `IF EXIST "%dp0%\\node.exe" (echo node)\n"%~dp0nested\\target.${ext}" %*`,
        );
      }
      process.env.PATH = folder;
      expect(resolveCommand('exe')).toEqual({
        command: join(folder, 'nested', 'target.exe'),
        prefix: [],
      });
      expect(resolveCommand('js')).toEqual({
        command: process.execPath,
        prefix: [join(folder, 'nested', 'target.js')],
      });
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('uses taskkill by its absolute system path and treats a missing process as gone', async () => {
    if (process.platform === 'win32') {
      expect(isAbsolute(TASKKILL)).toBe(true);
      expect(TASKKILL.toLowerCase().split('\\').join('/')).toMatch(/\/system32\/taskkill\.exe$/u);
    }
    expect(await killTree(2_000_000_000)).toBe(true);
  });

  it('a timeout kills the tree and settles the run', async () => {
    const result = await runProc({
      command: process.execPath,
      args: ['-e', hang],
      cwd: process.cwd(),
      idleMs: 1200,
    });
    expect(result.timedOut).toBe(true);
    const child = Number(/CHILD (\d+)/u.exec(result.stdout)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(child)).toBe(false);
  });

  it('an abort kills the tree, says cancelled and settles; an abort before the start never spawns', async () => {
    const controller = new AbortController();
    const running = runProc({
      command: process.execPath,
      args: ['-e', hang],
      cwd: process.cwd(),
      idleMs: 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    const child = Number(/CHILD (\d+)/u.exec(result.stdout)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(child)).toBe(false);

    const early = new AbortController();
    early.abort();
    const never = await runProc({
      command: 'a-command-that-does-not-exist',
      args: [],
      cwd: process.cwd(),
      idleMs: 1000,
      signal: early.signal,
    });
    expect(never.cancelled).toBe(true);
    expect(never.spawnError).toBeNull();
  });

  it('a process that keeps writing is not stopped, however long it runs: only silence is', async () => {
    // writes every 150 ms for about 2.4 s, with an idle window of 1.5 s (ten times the gap, so a slow PC does not stop it)
    const writer = `let n = 0; const t = setInterval(() => { console.log('tick ' + (++n)); if (n === 16) { clearInterval(t); } }, 150);`;
    const chunks: string[] = [];
    const started = Date.now();
    const result = await runProc({
      command: process.execPath,
      args: ['-e', writer],
      cwd: process.cwd(),
      idleMs: 1500,
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1500);
    expect(result.stdout).toContain('tick 16');
    // every chunk was reported as it came: the signs of work
    expect(chunks.length).toBeGreaterThanOrEqual(8);
  });

  it('a process that writes and then goes silent is stopped one window after its last output', async () => {
    const quiet = `console.log('one sign'); setInterval(() => {}, 1000);`;
    const started = Date.now();
    const result = await runProc({
      command: process.execPath,
      args: ['-e', quiet],
      cwd: process.cwd(),
      idleMs: 800,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('one sign');
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });

  it('a wall-clock limit is only for housekeeping: it stops a process that writes steadily, the idle window does not', async () => {
    const writer = `setInterval(() => console.log('tick'), 100);`;
    const result = await runProc({
      command: process.execPath,
      args: ['-e', writer],
      cwd: process.cwd(),
      idleMs: 5000,
      maxMs: 700,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('tick');
  });

  it('T3 Code’s credential in the server’s own environment is never passed to a harness; the rest is, and what the caller sets wins', async () => {
    const names = [
      'T3_ACP_MCP_AUTHORIZATION',
      't3_acp_mcp_endpoint',
      'ELECTRON_RUN_AS_NODE',
      'DIVAN_TEST_KEPT',
    ];
    const saved = names.map((name) => process.env[name]);
    process.env.T3_ACP_MCP_AUTHORIZATION = 'Bearer secret';
    process.env.t3_acp_mcp_endpoint = 'http://127.0.0.1:1/';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.DIVAN_TEST_KEPT = 'kept';
    try {
      const report = `console.log(JSON.stringify(Object.keys(process.env).filter((k) => /^(T3_ACP_|ELECTRON_RUN_AS_NODE$|DIVAN_TEST_)/i.test(k)).sort()))`;
      const result = await runProc({
        command: process.execPath,
        args: ['-e', report],
        cwd: process.cwd(),
        idleMs: 30_000,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(['DIVAN_TEST_KEPT']);
      // a variable the caller sets itself is the caller's business
      const own = await runProc({
        command: process.execPath,
        args: ['-e', report],
        cwd: process.cwd(),
        env: { DIVAN_TEST_OWN: 'x' },
        idleMs: 30_000,
      });
      expect(JSON.parse(own.stdout.trim())).toEqual(['DIVAN_TEST_KEPT', 'DIVAN_TEST_OWN']);
    } finally {
      names.forEach((name, i) => {
        const value = saved[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});
