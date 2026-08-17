/**
 * dsh-agent-dock — WebUI 路由（dshmarket 同款模式：host.webServer.register）。
 * 只做请求解析/序列化；进程/CLI 操作全部走 herdr api。
 * 安全：mutating 端点仅接受同源 POST（sameOrigin）。
 */
import { agentNameOf, stateOf } from './herdr.js';
import { findOwnedAgent, summarizeOwned } from './owned.js';
import { AGENT_STATES } from './types.js';

const READ_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'];
const MAX_TIMEOUT_MS = 3600000; // 1h 硬上限
const MAX_TEXT_LEN = 8000;

/** 参数卫生：超时/文本/来源 的上限校验。 */
function cleanTimeout(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1000), max);
}

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

export function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export async function readJsonBody(request, cap = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > cap) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** 探测结果短缓存（fork 探测/心跳较频繁，控制 CLI 调用量）。 */
const probeCache = new Map(); // bin -> { ttl, value }
function cached(key, ttlMs, fn) {
  const hit = probeCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  return fn().then((value) => { probeCache.set(key, { value, expires: Date.now() + ttlMs }); return value; });
}

/**
 * 组装状态负载：server/fork/agents/paneName/轮询间隔。
 * v1.1：mine 按「paneName + cwd」归属匹配（findOwnedAgent），不再按名字全局匹配。
 * @param {object} api herdr api
 * @param {object[]} agents agent list
 * @param {object[]} panes pane list（join agent 的 cwd）
 * @param {string} [cwd] 期望工作目录（来自客户端当前会话；未传则回退 cfg.mcodeCwd/process.cwd）
 */
function buildStatusPayload(api, agents, panes, cwd) {
  const expectCwd = cwd ?? api.cfg.mcodeCwd ?? process.cwd();
  const owned = findOwnedAgent({ agents, panes, paneName: api.cfg.paneName, cwd: expectCwd });
  const summarized = (agents ?? []).map((a) => ({
    name: agentNameOf(a) ?? a.agent ?? '',
    state: stateOf(a),
    pane: a.pane_id ?? '',
    title: a.terminal_title ?? a.terminal_title_stripped ?? '',
  }));
  return {
    ok: true,
    provider: 'minimax', // TODO(agent-dock): 多 provider 时改为按 cfg 或列表返回
    paneName: api.cfg.paneName,
    expectCwd,
    pollIntervalMs: api.cfg.pollIntervalMs,
    serverOk: true,
    forkOk: true,
    agents: summarized,
    mine: owned ? summarizeOwned(owned) : null,
  };
}

/** 统一归属 target 解析：命中返回 pane_id/名字，未命中 null（操作路由共用）。 */
async function resolveOpTarget(api, cwd) {
  return api.resolveTarget({ cwd: cwd ?? undefined });
}

/**
 * 挂载 dsh-agent-dock 的全部路由（返回卸载函数）。
 * @param {object} host 已注入 webServer 的宿主上下文
 * @param {object} api createHerdrApi 返回的高层 API
 */
export function mountRoutes(host, api) {
  const key = api.bin || 'herdr';
  const disposers = [];
  const push = (route) => { const d = host.webServer.register(route); disposers.push(d); };
  push({
    kind: 'exact',
    path: '/agent-dock/status',
    handler: async (request, response) => {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
      try {
        const forkOk = await cached(key + ':fork', 60000, () => api.isForkBuild());
        const serverOk = await cached(key + ':server', 4000, () => api.serverStatus());
        // cwd 来自客户端轮询时的当前会话工作目录（?cwd=...），用于归属匹配；
        // 未传则由服务端回退链（cfg.mcodeCwd → process.cwd）兜底。
        const u = new URL(request.url, 'http://x');
        const cwd = u.searchParams.get('cwd') || undefined;
        const [agents, panes] = serverOk ? await Promise.all([api.list(), api.panes()]) : [[], []];
        sendJson(response, 200, { ...buildStatusPayload(api, agents, panes, cwd), forkOk, serverOk });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'status', message: String(error?.message ?? error) } });
      }
    },
  });

  push({
    kind: 'exact',
    path: '/agent-dock/wake',
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } }); return; }
      try {
        const body = await readJsonBody(request).catch(() => ({}));
        const cwd = typeof body.cwd === 'string' && body.cwd.length <= 4096 ? body.cwd : undefined;
        const provider = typeof body.provider === 'string' && body.provider.length <= 64 ? body.provider : undefined;
        const result = await api.wake({ provider, cwd });
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'wake', message: String(error?.message ?? error) } });
      }
    },
  });

  push({
    kind: 'exact',
    path: '/agent-dock/prompt',
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } }); return; }
      try {
        const body = await readJsonBody(request).catch(() => ({}));
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text.length === 0 || text.length > MAX_TEXT_LEN) { sendJson(response, 400, { ok: false, error: { code: 'prompt', message: 'text required (<=8000 chars)' } }); return; }
        if (text.startsWith('-')) { sendJson(response, 400, { ok: false, error: { code: 'prompt', message: 'text must not start with -' } }); return; }
        const until = Array.isArray(body.until) ? [...new Set(body.until.filter((s) => typeof s === 'string' && AGENT_STATES.includes(s)))] : [];
        const timeoutMs = cleanTimeout(body.timeoutMs, api.cfg.delegationTimeoutMs, MAX_TIMEOUT_MS);
        const target = await resolveOpTarget(api, body.cwd);
        if (!target) { sendJson(response, 409, { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent（paneName=' + api.cfg.paneName + '），请先唤醒（POST /agent-dock/wake）' } }); return; }
        const r = await api.prompt(target, text, { wait: body.wait ?? true, until, timeoutMs });
        sendJson(response, r.ok ? 200 : 409, { ok: r.ok, error: r.error, agent: r.data?.agent ?? null, state: r.data?.agent?.agent_status ?? null });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'prompt', message: String(error?.message ?? error) } });
      }
    },
  });

  push({
    kind: 'exact',
    path: '/agent-dock/read',
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } }); return; }
      try {
        const body = await readJsonBody(request).catch(() => ({}));
        const source = READ_SOURCES.includes(body.source) ? body.source : 'recent-unwrapped';
        const lines = cleanTimeout(body.lines ?? 60, 60, 500);
        const target = await resolveOpTarget(api, body.cwd);
        if (!target) { sendJson(response, 409, { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先唤醒' } }); return; }
        const r = await api.read(target, { source, lines });
        sendJson(response, r.ok ? 200 : 409, { ok: r.ok, error: r.error, text: r.ok ? r.text : '' });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'read', message: String(error?.message ?? error) } });
      }
    },
  });

  push({
    kind: 'exact',
    path: '/agent-dock/stop',
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request rejected' } }); return; }
      try {
        const body = await readJsonBody(request).catch(() => ({}));
        const target = await resolveOpTarget(api, body.cwd);
        if (!target) { sendJson(response, 409, { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先唤醒' } }); return; }
        const result = await api.stop({ target });
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'stop', message: String(error?.message ?? error) } });
      }
    },
  });

  return () => { for (const d of disposers) d(); };
}
