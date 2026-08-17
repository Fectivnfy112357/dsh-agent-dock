#!/usr/bin/env node
/**
 * dsh-agent-dock — 集成测试（E2E，本地直跑真实 herdr + mcode）。
 * 在独立探针 workspace 内跑完整链路：apply() 挂路由 → POST wake（分裂 pane → 启动 mcode → 检测 → 命名）
 * → 轮询 status → agent_prompt 极小任务 --wait → read → stop → 关闭探针 workspace。
 * 不触碰用户现有 pane（hostPane 指向探针 workspace 的 root pane）。
 * 依赖：herdr fork（MiniMax detection）+ mcode 已装；要求 herdr server 在跑（自动拉起）。
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHerdrApi } from '../lib/herdr.js';
import { apply as pluginApply, name as pluginName } from '../lib/index.js';
import { resolveConfig, DEFAULT_CONFIG } from '../lib/types.js';
import { mountRoutes } from '../lib/routes.js';
const cfg = resolveConfig({ ...DEFAULT_CONFIG, detectTimeoutMs: 40000 });
const api = createHerdrApi(cfg);
const routes = [];
const fakeHost = {
  webServer: { register: (route) => { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; } },
  effect: (fn, tag) => fn(),
};
const fakeCtx = {
  effect: (fn) => fn(),
  inject: (deps, fn) => { if (deps.includes('webServer')) fn(fakeHost); },
  skills: { register: () => () => {} },
  on: () => () => {},
};
globalThis.harness = { defineTool: (d) => d, registerTool: () => () => {} };

// 挂载路由
pluginApply(fakeCtx, cfg);
console.log('[e2e] plugin name:', pluginName, '| routes:', routes.map((r) => r.path).join(', '));
// 探针 workspace（隔离，不碰用户现有布局）
const wsRes = await api.run(['workspace', 'create', '--label', 'dock-e2e', '--cwd', process.cwd()]);
if (!wsRes.ok) { console.error('[e2e] workspace create failed', wsRes.error); process.exit(1); }
const wsId = wsRes.data.workspace.workspace_id;
const rootPane = wsRes.data.root_pane.pane_id;
console.log('[e2e] probe workspace:', wsId, 'rootPane:', rootPane);
// 最小 HTTP 服务模拟 webServer 路由分发（同 origin 校验走真实实现）
const server = createServer((req, res) => {
  const route = routes.find((r) => r.path === (req.url || '').split('?')[0]);
  if (!route) { res.writeHead(404); res.end('not found'); return; }
  route.handler(req, res).catch((err) => { res.writeHead(500); res.end(String(err)); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = 'http://127.0.0.1:' + port;
const request = async (path, method = 'GET', body) => {
  const res = await fetch(origin + path, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const results = { wake: null, status: null, prompt: null, read: null, stop: null };
try {
  // 1) wake：在探针 workspace 里唤醒 mcode（hostPane 内部覆盖）
  results.wake = await api.wake({ hostPane: rootPane });
  console.log('[e2e] wake =>', JSON.stringify(results.wake).slice(0, 300));
  // 2) status 路由（GET）
  results.status = await request('/agent-dock/status');
  console.log('[e2e] GET /agent-dock/status =>', JSON.stringify(results.status).slice(0, 300));
  console.log('[e2e]   mine:', JSON.stringify(results.status.body.mine));
  // 3) prompt 极小任务（真实 mcode 执行，等待 settle）
  results.prompt = await request('/agent-dock/prompt', 'POST', {
    text: 'Reply with the single word E2E_OK and stop. Do not run any tools.',
    wait: true, timeoutMs: 90000,
  });
  console.log('[e2e] POST /agent-dock/prompt =>', JSON.stringify(results.prompt).slice(0, 300));
  // 4) read 路由
  await new Promise((r) => setTimeout(r, 1000));
  results.read = await request('/agent-dock/read', 'POST', { lines: 20 });
  console.log('[e2e] POST /agent-dock/read =>', JSON.stringify(results.read).slice(0, 300));
  // 5) stop
  results.stop = await request('/agent-dock/stop', 'POST', {});
  console.log('[e2e] POST /agent-dock/stop =>', JSON.stringify(results.stop).slice(0, 200));
} finally {
  // 清理：关闭探针 workspace（mcode pane 随之消失）
  const close = await api.closeWorkspace(wsId);
  console.log('[e2e] close workspace', wsId, '=>', JSON.stringify(close));
  server.close();
}
const okAll = results.wake && results.status?.body?.ok && results.prompt?.status === 200 && results.read?.status === 200 && results.stop?.status === 200;
console.log(okAll ? '[e2e] SUCCESS' : '[e2e] PARTIAL/FAILED');
process.exit(okAll ? 0 : 2);
