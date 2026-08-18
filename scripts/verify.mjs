#!/usr/bin/env node
/**
 * dsh-agent-dock — 双格式自检（DSH 静态插件 + Agent Plugins 1.0）。
 * 关键文件存在性 + 身份一致性 + 相对引用完整性。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (msg) => console.log('OK  ' + msg);
const fail = (msg) => { fails.push(msg); console.error('FAIL ' + msg); };
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf-8'));

// 1) package.json 结构
if (pkg.name !== 'dsh-agent-dock') fail('package.json name must be dsh-agent-dock'); else ok('package name')
if (pkg.type !== 'module') fail('package.json type must be module');
if (!pkg.main || !existsSync(join(ROOT, pkg.main))) fail('main entry missing: ' + pkg.main); else ok('main entry')
if (!pkg.dsh?.bundle?.patch || !existsSync(join(ROOT, pkg.dsh.bundle.patch))) fail('dsh.bundle.patch missing'); else ok('dsh.bundle.patch')
if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be web');
if (!pkg.exports?.['./client']) fail('exports["./client"] missing');
for (const f of ['lib', 'client', 'skills', 'scripts', 'cordis.patch.yml', 'plugin.json']) {
  if (pkg.files && !pkg.files.includes(f)) fail('files must include ' + f);
}
ok('package.json structure')
// 2) plugin.json（Agent Plugins 1.0）
if (!plugin.$schema?.startsWith('https://agent-plugins.org/schemas/1.0.0/')) fail('plugin.json $schema must point to agent-plugins.org 1.0.0');
if (!/^[a-z0-9.]+(-[a-z0-9.]+)*$/.test(plugin.name) || /--|\.\./.test(plugin.name)) fail('plugin.json name violates Agent Plugins 1.0 rules: ' + plugin.name);
if (plugin.name !== pkg.name) fail('plugin.json name must match package.json name');
if (!/^\d+\.\d+\.\d+/.test(plugin.version)) fail('plugin.json version must be semver');
ok('plugin.json identity')
// 3) skills（唯一内容源）
const skillFile = join(ROOT, 'skills', 'agent-dock', 'SKILL.md');
if (!existsSync(skillFile)) fail('skills/agent-dock/SKILL.md missing');
else {
  const raw = readFileSync(skillFile, 'utf-8');
  if (!/^---\s*\n/.test(raw)) fail('SKILL.md missing frontmatter');
  if (!/name:\s*\S+/.test(raw)) fail('SKILL.md frontmatter missing name');
  if (!/description:/.test(raw)) fail('SKILL.md frontmatter missing description');
  else ok('skills/agent-dock/SKILL.md')
}
// 4) lib/index.js 导出与 client 打包
const libSrc = readFileSync(join(ROOT, pkg.main ?? 'lib/index.js'), 'utf-8');
if (!/export const name = ['"]agent-dock['"]/.test(libSrc)) fail('lib/index.js must export name = "agent-dock"');
if (!/export function apply/.test(libSrc)) fail('lib/index.js must export apply');
const clientSrc = readFileSync(join(ROOT, 'client', 'client.js'), 'utf-8');
if (!/__ModuleLoader__\.load/.test(clientSrc)) fail('client/client.js must be a module-loader bundle');
if (!/exports\.apply/.test(clientSrc)) fail('client/client.js must export apply');
if (/\bcredentials\b|\bapi[_-]?key\b|\bpassword\b|\btoken\b/.test(clientSrc + libSrc)) fail('source must not embed secrets');
ok('lib/client entry shape')
// 5) cordis.patch.yml 引用的一致性
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf-8');
if (!patch.includes(pkg.name)) fail('cordis.patch.yml must reference package name ' + pkg.name);
ok('cordis.patch.yml identity')

if (fails.length > 0) {
  console.error('\nverify failed: ' + fails.length + ' problem(s)');
  process.exit(1);
}
console.log('\nAll checks passed.');
