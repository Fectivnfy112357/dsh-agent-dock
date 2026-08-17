/**
 * dsh-agent-dock — Cordis 插件入口（双格式：DSH 静态插件 + Agent Plugins 1.0）。
 * 职责：
 *   1. 把 skills/agent-dock/SKILL.md 注册进 ctx.skills（唯一内容源，双格式不分叉）；
 *   2. 挂载 /agent-dock/* HTTP 路由（WebUI 按钮/徽章）；
 *   3. 注册 agent_* 动态工具（DSH agent 全自动协同入口）。
 * 配置（config）见 lib/types.js DEFAULT_CONFIG；可通过 profile patch 覆盖。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './types.js';
import { createHerdrApi } from './herdr.js';
import { mountRoutes } from './routes.js';
import { buildToolDefs } from './tools.js';

export const name = 'agent-dock';
// 依赖 ctx.skills（技能注册）/ ctx.webServer（HTTP 路由）/ ctx.tools（动态工具）；
// 静态插件走 `ctx.tools.register(defineTool(...))` 路径，不读 globalThis.harness
// （harness 是动态插件 hostCode 的 vm 沙箱全局，静态插件里永远 undefined —— 见
// dsh-dual-plugin-guide references/tools.md §2 边界说明）。
export const inject = ['skills', 'webServer', 'tools'];

const SKILL_DIR = new URL('../skills/agent-dock/', import.meta.url);
const SKILL_FILE = new URL('SKILL.md', SKILL_DIR);
/** 极简 frontmatter 解析（name/description/whenToUse）。 */
function parseFrontmatter(raw) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  if (!m) throw new Error('dsh-agent-dock: SKILL.md missing frontmatter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[key] = value;
  }
  if (!meta.name || !meta.description) throw new Error('dsh-agent-dock: SKILL.md frontmatter must contain name and description');
  return meta;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? {});
  const api = createHerdrApi(cfg);
  // 1) 技能注册（双格式唯一内容源）
  const raw = readFileSync(SKILL_FILE, 'utf-8');
  const meta = parseFrontmatter(raw);
  ctx.effect(
    () => ctx.skills.register({
      name: meta.name,
      description: meta.description,
      whenToUse: meta.whenToUse ?? '',
      content: raw,
      source: 'runtime',
      resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    }),
    'agent-dock: skill registration'
  );

  // 2) HTTP 路由（WebUI 按钮/徽章）
  ctx.inject(['webServer'], (host) => {
    const dispose = mountRoutes(host, api);
    host.effect(() => dispose, 'agent-dock: http routes');
  });

  // 3) 动态工具（DSH agent 全自动协同）——通过 ctx.tools 注册，cordis 卸载时自动反注册
  for (const def of buildToolDefs(api)) {
    ctx.effect(() => ctx.tools.register(defineTool(def)), 'agent-dock: tool ' + def.name);
  }
}
