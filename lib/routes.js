/**
 * dsh-agent-dock — WebUI 路由（dshmarket 同款模式：host.webServer.register）。
 * 只做请求解析/序列化；进程/CLI 操作全部走 herdr api。
 * 安全：mutating 端点仅接受同源 POST（sameOrigin）。
 */
import { agentNameOf, stateOf } from './herdr.js';

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
 * 前端徽章轮询此端点，间隔取服务端配置（pollIntervalMs）。
 */
function buildStatusPayload(api, agents) {
  const summarized = (agents ?? []).map((a) => ({
    name: agentNameOf(a) ?? a.agent ?? '',
    state: stateOf(a),
    pane: a.pane_id ?? '',
    title: a.terminal_title ?? a.terminal_title_stripped ?? '',
  }));
  const mine = summarized.find((a) => a.name === api.cfg.paneName) ?? null;
  return {
    ok: true,
    provider: 'minimax', // TODO(agent-dock): 多 provider 时改为按 cfg 或列表返回
    paneName: api.cfg.paneName,
    pollIntervalMs: api.cfg.pollIntervalMs,
    serverOk: true,
    forkOk: true,
    agents: summarized,
    mine,
  };
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
        const agents = serverOk ? await api.list() : [];
        sendJson(response, 200, { ...buildStatusPayload(api, agents), forkOk, serverOk });
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
        const result = await api.wake({ provider: body.provider, cwd: body.cwd });
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
        if (!body.text || typeof body.text !== 'string') { sendJson(response, 400, { ok: false, error: { code: 'prompt', message: 'text is required' } }); return; }
        const r = await api.prompt(api.cfg.paneName, body.text, { wait: body.wait ?? true, until: body.until ?? [], timeoutMs: body.timeoutMs });
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
        const r = await api.read(api.cfg.paneName, { source: body.source ?? 'recent-unwrapped', lines: body.lines ?? 60 });
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
        const result = await api.stop({});
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 500, { ok: false, error: { code: 'stop', message: String(error?.message ?? error) } });
      }
    },
  });

  return () => { for (const d of disposers) d(); };
}
