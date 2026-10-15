// Every npm call runs in a private project with explicit, private configuration.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutT3 } from '../src/server/launch.ts';
import { resolveCommand } from '../src/server/proc.ts';

export function npmEnvironment(temp, project, inherited = withoutT3()) {
  mkdirSync(project, { recursive: true });
  if (!existsSync(join(project, 'package.json')))
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'divan-package-fixture', version: '1.0.0', private: true }),
    );
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => !/^(?:npm_config_|NODE_)/iu.test(key)),
  );
  for (const name of ['userconfig', 'globalconfig']) writeFileSync(join(temp, name), '');
  return {
    ...env,
    HOME: temp,
    USERPROFILE: temp,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    npm_config_cache: join(temp, 'npm-cache'),
    npm_config_logs_dir: join(temp, 'npm-logs'),
    npm_config_userconfig: join(temp, 'userconfig'),
    npm_config_globalconfig: join(temp, 'globalconfig'),
    npm_config_prefix: project,
    npm_config_global: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

export async function checkNpmIsolation(temp, run) {
  const parent = join(temp, 'hostile');
  const project = join(parent, 'project');
  const sentinel = join(parent, 'sentinel');
  mkdirSync(sentinel, { recursive: true });
  const manifest = '{"name":"hostile-parent","version":"1.0.0","workspaces":["project"]}';
  const config = `prefix=${sentinel}\ncache=${sentinel}\nlogs-dir=${sentinel}\npack-destination=${sentinel}\ntag=hostile\n`;
  writeFileSync(join(parent, 'package.json'), manifest);
  writeFileSync(join(parent, '.npmrc'), config);
  const preload = join(parent, 'preload.cjs');
  const marker = join(sentinel, 'preloaded');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
  const hostile = {
    ...withoutT3(),
    NODE_V8_COVERAGE: sentinel,
    NODE_OPTIONS: `--require "${preload}"`,
    node_redirect_warnings: join(sentinel, 'warnings'),
    NODE_COMPILE_CACHE: sentinel,
  };
  for (const key of ['logs_dir', 'cache', 'prefix', 'userconfig', 'globalconfig']) {
    hostile[`npm_config_${key}`] = sentinel;
    hostile[`NPM_CONFIG_${key.toUpperCase()}`] = sentinel;
  }
  const env = npmEnvironment(parent, project, hostile);
  assert.ok(!Object.keys(env).some((key) => /^NODE_/iu.test(key)));
  const npm = resolveCommand('npm');
  assert.ok(npm);
  const packed = await run(
    npm.command,
    [
      ...npm.prefix,
      'pack',
      '.',
      '--prefix',
      project,
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      parent,
    ],
    { cwd: project, env },
  );
  const [pack] = JSON.parse(packed.out);
  assert.equal(pack.name, 'divan-package-fixture');
  assert.ok(existsSync(join(parent, pack.filename)));
  assert.deepEqual(readdirSync(sentinel), []);
  assert.ok(!existsSync(marker));
  assert.equal(readFileSync(join(parent, 'package.json'), 'utf8'), manifest);
  assert.equal(readFileSync(join(parent, '.npmrc'), 'utf8'), config);
  await run(
    npm.command,
    [
      ...npm.prefix,
      'install',
      '--local',
      '--prefix',
      project,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(parent, pack.filename),
    ],
    { cwd: project, env },
  );
  assert.deepEqual(readdirSync(sentinel), []);
  assert.ok(!existsSync(marker));
  assert.equal(
    JSON.parse(readFileSync(join(project, 'node_modules', pack.name, 'package.json'), 'utf8')).name,
    pack.name,
  );
  assert.equal(readFileSync(join(parent, 'package.json'), 'utf8'), manifest);
  assert.equal(readFileSync(join(parent, '.npmrc'), 'utf8'), config);
}
