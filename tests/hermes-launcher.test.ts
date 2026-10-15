import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree } from '../src/server/proc.ts';
import { hermesAssets, hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!hermesLayoutReady)('Hermes Windows launcher, actual disposable objects', () => {
  it('streams before stdin EOF, handles slow/broken consumers, excludes a sentinel handle, and survives supported nested jobs', async () => {
    const fixture = hermesFixture();
    const children = new Set<ChildProcess>();
    const start = (code: string, python = fixture.python) => {
      const child = spawn(
        fixture.basePython,
        [
          '-I',
          '-S',
          '-B',
          join(hermesAssets, 'launcher.py'),
          join(fixture.run, 'scratch'),
          String(process.pid),
          fixture.stamp,
          python,
          '-I',
          '-B',
          '-c',
          code,
        ],
        {
          cwd: fixture.control,
          env: fixture.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      children.add(child);
      let out = '',
        err = '';
      const closed = new Promise<number | null>((done, fail) => {
        child.once('error', fail);
        child.once('close', (code) => {
          children.delete(child);
          done(code);
        });
      });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (data) => {
        out += data.toString('utf8');
      });
      child.stderr.on('data', (data) => {
        err += data.toString('utf8');
      });
      return { child, closed, out: () => out, err: () => err };
    };
    try {
      const streaming = start(
        "import sys,os;print('READY',flush=True);data=sys.stdin.buffer.read();os.write(1,data);os.write(2,b'e'*100000)",
      );
      await new Promise<void>((done) => streaming.child.stdout.once('data', () => done()));
      expect(streaming.out()).toContain('READY');
      for (const byte of Buffer.from('partial 🙂 input'))
        streaming.child.stdin.write(Buffer.from([byte]));
      streaming.child.stdin.end();
      expect(await streaming.closed).toBe(0);
      expect(streaming.out()).toContain('partial 🙂 input');
      expect(streaming.err().length).toBe(100000);
      const slow = start("import os;os.write(1,b'x'*2097152);os.write(2,b'e'*100000)");
      slow.child.stdout.pause();
      slow.child.stdin.end();
      await new Promise((done) => setTimeout(done, 5500));
      slow.child.stdout.resume();
      expect(await slow.closed).toBe(0);
      expect(slow.out().length).toBe(2097152);
      const inputBroken = start(
        "import os,time;os.close(0);print('READY',flush=True);time.sleep(120)",
        fixture.basePython,
      );
      await new Promise<void>((done) => inputBroken.child.stdout.once('data', () => done()));
      inputBroken.child.stdin.end(Buffer.alloc(100000));
      expect(await inputBroken.closed).toBe(125);
      for (const channel of ['stdout', 'stderr'] as const) {
        const broken = start(
          "import os,time;os.write(1,b'READY');time.sleep(.3);os.write(1,b'x'*100000);os.write(2,b'e'*100000);time.sleep(120)",
        );
        await new Promise<void>((done) => broken.child.stdout.once('data', () => done()));
        broken.child[channel].destroy();
        broken.child.stdin.end();
        expect(await broken.closed).toBe(125);
      }
      for (const mode of ['sentinel', 'nested', 'rejected']) {
        const result = execFileSync(
          fixture.basePython,
          [
            '-I',
            '-S',
            '-B',
            join(import.meta.dirname, 'fixtures/hermes/lifetime.py'),
            hermesAssets,
            join(fixture.run, 'scratch'),
            fixture.python,
            mode,
          ],
          { env: fixture.env, windowsHide: true, encoding: 'utf8', timeout: 20000 },
        );
        expect(result).toContain(
          mode === 'sentinel' ? 'SENTINEL ABSENT' : mode === 'nested' ? 'NESTED' : 'NESTED REFUSED',
        );
      }
    } finally {
      for (const child of children) {
        const closed = new Promise((done) => child.once('close', done));
        if (child.pid) await killTree(child.pid);
        await closed;
      }
      fixture.close();
    }
  }, 120_000);
  it('kills descendants when only the launcher dies or its Divan parent dies, and cancellation cleans before returning', async () => {
    const fixture = hermesFixture();
    const owned = new Set<number>();
    try {
      for (const loss of ['launcher', 'parent']) {
        const child = spawn(
          fixture.basePython,
          [
            '-I',
            '-S',
            '-B',
            join(import.meta.dirname, 'fixtures/hermes/lifetime.py'),
            hermesAssets,
            join(fixture.run, 'scratch'),
            fixture.python,
            'parent',
          ],
          { env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (child.pid) owned.add(child.pid);
        const closed = new Promise((done) => child.once('close', done));
        let out = '';
        child.stderr.resume();
        await new Promise<void>((done, fail) => {
          child.once('error', fail);
          child.stdout.on('data', (data) => {
            out += data.toString();
            if (/LAUNCHER (\d+)/u.test(out) && /LOW (\d+)/u.test(out) && /DESC (\d+)/u.test(out))
              done();
          });
        });
        const pids = [...out.matchAll(/(?:LAUNCHER|LOW|DESC) (\d+)/gu)].map((match) =>
          Number(match[1]),
        );
        for (const pid of pids) owned.add(pid);
        const launcher = Number(/LAUNCHER (\d+)/u.exec(out)?.[1]);
        process.kill(loss === 'parent' ? (child.pid as number) : launcher, 'SIGKILL');
        if (loss === 'launcher' && child.pid) process.kill(child.pid, 'SIGKILL');
        await closed;
        for (let n = 0; n < 100 && pids.some(alive); n++)
          await new Promise((done) => setTimeout(done, 30));
        expect(pids.filter(alive)).toEqual([]);
      }
    } finally {
      for (const pid of owned) if (alive(pid)) await killTree(pid);
      fixture.close();
    }
  }, 60_000);
  it('permits own/other Low writes, denies medium writes, drains both binary streams and kills a descendant after root exit 7', async () => {
    const fixture = hermesFixture();
    let descendant: number | undefined;
    try {
      const other = join(fixture.temp, 'other-low');
      mkdirSync(other);
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/icacls.exe'),
        [other, '/setintegritylevel', '(OI)(CI)L'],
        { windowsHide: true, stdio: 'pipe' },
      );
      const script = join(fixture.control, 'canary.py');
      writeFileSync(
        script,
        `import sys,os,json,subprocess\nsys.path.insert(0,${JSON.stringify(hermesAssets)})\nfrom windows import low_token\nassert low_token()\nresult={}\nfor name,path in ${JSON.stringify(
          [
            ['own', join(fixture.run, 'scratch/allowed')],
            ['medium', join(fixture.control, 'denied')],
            ['other', join(other, 'allowed')],
          ],
        )}:\n try:\n  with open(path,'w') as f:f.write('canary')\n  result[name]=True\n except PermissionError:result[name]=False\nprint(json.dumps(result),flush=True)\np=subprocess.Popen([sys.executable,'-I','-S','-B','-c','import time;time.sleep(120)'],creationflags=0x08000000)\nprint('PID '+str(p.pid),flush=True)\nos.write(2,b'x'*1048576)\nos.write(1,('UNICODE '+chr(0x1f642)).encode('utf-8'))\nsys.exit(7)\n`,
      );
      const result = await fixture.executeCommand(fixture.python, ['-I', '-B', script]);
      descendant = Number(/PID (\d+)/u.exec(result.stdout)?.[1]);
      expect(result.code, result.stderr.slice(0, 100)).toBe(7);
      expect(JSON.parse(result.stdout.split('\n')[0] ?? '')).toEqual({
        own: true,
        medium: false,
        other: true,
      });
      expect(result.stdout).toContain('🙂');
      expect(result.stderr.length).toBeGreaterThan(100000);
      expect(existsSync(join(fixture.control, 'denied'))).toBe(false);
      expect(() => process.kill(descendant as number, 0)).toThrow();
      expect(readFileSync(join(other, 'allowed'), 'utf8')).toBe('canary');
    } finally {
      if (descendant) await killTree(descendant);
      fixture.close();
    }
  }, 150_000);
  it('cleans every acquired stage on injected launcher failure', async () => {
    const fixture = hermesFixture();
    try {
      // The injector is medium and owns only disposable children; Hermes itself is never imported here.
      for (const stage of [
        'token',
        'job',
        'pipe1',
        'pipe2',
        'pipe3',
        'attributes',
        'handles',
        'joblist',
        'create',
        'membership',
        'resume',
        'drain',
      ]) {
        const output = execFileSync(
          fixture.basePython,
          [
            '-I',
            '-S',
            '-B',
            join(import.meta.dirname, 'fixtures/hermes/launcher-fault.py'),
            fixture.policyFile,
            hermesAssets,
            stage,
          ],
          { env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
        );
        expect(output).toContain('"cleaned": true');
      }
    } finally {
      fixture.close();
    }
  }, 150_000);
});
