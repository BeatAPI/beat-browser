#!/usr/bin/env node
// [INPUT] Current source and public npm dependencies.
// [OUTPUT] Verified tarball contents, isolated install and MCP discovery.
// [POS] Package release gate.
// [PROTOCOL] Never writes the user's MCP configs or connects to their browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beatbrowser-package-'));
const fakeHome = path.join(temporary, 'home');
fs.mkdirSync(fakeHome);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|KEY|SECRET|AUTH/i.test(key)));
env.HOME = fakeHome;
env.USERPROFILE = fakeHome;
env.APPDATA = path.join(fakeHome, 'AppData');
env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');
env.NPM_CONFIG_USERCONFIG = path.join(fakeHome, '.npmrc');
env.NPM_CONFIG_CACHE = path.join(temporary, 'npm-cache');
env.BEAT_BROWSER_FAST_AGENT = '0';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });

try {
  const pack = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', temporary], root))[0];
  const names = new Set(pack.files.map(file => file.path));
  for (const required of ['LICENSE', 'README.md', 'AGENT_INSTALL.md', 'PRIVACY.md', 'TEST_RESULTS.md',
    'src/cli.js', 'src/agents.json', 'extension/manifest.json', 'extension/background.js',
    'media/architecture.png', 'media/architecture.svg', 'docs/COMPARISON.md', 'docs/DEMO.md',
    'docs/RELEASING.md', 'test/fixtures/demo.html', 'skills/beat-browser/SKILL.md']) {
    assert.ok(names.has(required), `Missing package file: ${required}`);
  }
  for (const name of names) {
    assert.ok(!/(^|\/)(?:\.env(?:\.|$)|\.git|\.npmrc|_local|node_modules|screenshots-local)|\.pem$|\.log$|\.local\.md$/.test(name), `Private package file: ${name}`);
    assert.ok(!name.startsWith('docs/learnings/') || name === 'docs/learnings/x.com.md', `Unreviewed site note: ${name}`);
  }
  const sandbox = path.join(temporary, 'installation');
  fs.mkdirSync(sandbox);
  run(npm, ['install', '--prefix', sandbox, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', path.join(temporary, pack.filename)]);
  const installed = path.join(sandbox, 'node_modules', '@beatapi', 'beat-browser');
  const cli = path.join(installed, 'src', 'cli.js');
  const metadata = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  const extension = JSON.parse(fs.readFileSync(path.join(installed, 'extension', 'manifest.json')));
  assert.equal(metadata.version, extension.version, 'CLI/extension versions differ');
  assert.match(run(process.execPath, [cli, '--help']), /beat-browser: let any AI agent/);
  assert.match(run(process.execPath, [cli, 'extension']), new RegExp(installed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), '{"mcpServers":{}}\n');
  fs.mkdirSync(path.join(fakeHome, '.codex'));
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), '# Synthetic package check\n');
  run(process.execPath, [cli, 'install', '--dry-run']);
  assert.equal(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'), '{"mcpServers":{}}\n');
  run(process.execPath, [cli, 'install']);
  const launch = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'))).mcpServers['beat-browser'];
  assert.equal(fs.realpathSync(launch.args[0]), fs.realpathSync(cli), 'MCP launcher must share the stable installed extension path');
  assert.ok(!launch.args.includes('npx'));
  assert.match(fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.beat-browser/);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: temporary, env, stderr: 'pipe' });
  const client = new Client({ name: 'package-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 23);
    assert.ok(!tools.some(tool => tool.name === 'browser_task'));
    assert.ok(!fs.existsSync(path.join(fakeHome, '.beat-browser')), 'Tool discovery must not start a browser bridge');
  } finally {
    await client.close();
  }
  console.log(JSON.stringify({ version: metadata.version, files: names.size, tarballBytes: pack.size,
    cleanInstall: true, stableLauncher: true, normalTools: 23, browserConnected: false }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
