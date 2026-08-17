/**
 * dsh-agent-dock — herdr CLI 封装（零运行时依赖，Socket 驱动）。
 *
 * 所有返回形状均以本机 herdr fork（0.8.0，MiniMax detection）实测为准：
 *   - 控制命令 stdout 为 JSON（{ id, result, error? }），错误时 exit 1、错误在 JSON.error；
 *   - agent read 直接返回终端纯文本（非 JSON）；
 *   - agent wait/prompt --wait 会阻塞至状态匹配或超时（--timeout）。
 *
 * 本模块把「参数构建」与「解析」拆成可单测的导出，spawn 只出现在 runCli。
 */
import { spawn } from 'node:child_process';
import { getProvider } from './providers.js';

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_SERVER_START_TIMEOUT = 30000;
const DEFAULT_DETECT_TIMEOUT = 30000;

/** 运行一次 herdr CLI（超时即 kill；Windows shim 回退）。 */
export function runCli(bin, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise) => {
    // Windows shim 回退：herdrBin 可能是 .cmd/.bat 路径，裸命令 ENOENT 时依次尝试 .exe / .cmd
    const candidates = /\.(exe|cmd|bat)$/i.test(bin) ? [bin] : [bin, bin + '.exe', bin + '.cmd'];
    attemptNext(0);

    function attemptNext(index) {
      const child = spawn(candidates[index] ?? bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolvePromise({ code: null, stdout, stderr, timedOut: true, error: 'timeout' });
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER); });
      child.stderr.on('data', (d) => { stderr += d; if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER); });
      child.on('error', (err) => {
        if (settled) return;
        clearTimeout(timer);
        const next = index + 1;
        if (next < candidates.length) attemptNext(next);
        else {
          settled = true;
          resolvePromise({ code: null, stdout, stderr, timedOut: false, error: String(err?.message ?? err) });
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr, timedOut: false });
      });
    }
  });
}

/** 解析 CLI 输出：优先 JSON（result/error），否则按纯文本处理。 */
export function parseCli(run) {
  if (run.timedOut) return { ok: false, error: { code: 'timeout', message: 'herdr CLI timed out' }, data: null, raw: '' };
  if (run.error && !run.stdout) return { ok: false, error: { code: 'spawn', message: run.error }, data: null, raw: '' };
  const text = run.stdout.trim() || run.stderr.trim();
  try {
    const json = JSON.parse(text);
    if (json.error) return { ok: false, error: json.error, data: json.result ?? null, raw: text };
    return { ok: true, error: null, data: json.result ?? null, raw: text };
  } catch {
    if (run.code !== 0) return { ok: false, error: { code: 'exit', message: run.stderr.trim() || run.stdout.trim() }, data: null, raw: text };
    return { ok: true, error: null, data: null, raw: text };
  }
}

/** fork 检测：herdr agent start --help 的 kind 列表必须含 minimax（官方版没有）。 */
export function parseForkProbe(stdout) {
  return /\bminimax\b/i.test(stdout);
}

/** 从 agent 对象取名字：rename 后是 .name，否则是 .agent（粗粒度 auto 名）。 */
export function agentNameOf(agent) {
  return agent?.name ?? agent?.agent ?? null;
}

/** 从 agent 对象取状态：agent_status → state，优先 result.state 兼容。 */
export function stateOf(agent) {
  return agent?.agent_status ?? agent?.state ?? 'unknown';
}

/** 解析 officer 状态文本：server 段 status: running。 */
export function parseServerStatus(text) {
  return /server:\s*\n\s*status:\s*running/i.test(text);
}

/**
 * 组装 herdr 高层 API（routes / tools 只面向这个接口，便于测试替换）。
 * @param {object} cfg 已 resolve 的配置（types.resolveConfig 输出）
 */
export function createHerdrApi(cfg) {
  const bin = cfg.herdrBin || 'herdr';

  async function run(args, opts) { return parseCli(await runCli(bin, args, opts)); }

  async function serverStatus() {
    const r = await runCli(bin, ['status'], { timeoutMs: 8000 });
    return parseServerStatus(r.stdout + r.stderr);
  }

  async function isForkBuild() {
    const r = await runCli(bin, ['agent', 'start', '--help'], { timeoutMs: 8000 });
    return parseForkProbe(r.stdout + r.stderr);
  }

  /** 确保 server 运行；没有则后台拉起 headless server 并等待就绪（幂等）。 */
  async function ensureServer({ timeoutMs = cfg.serverStartTimeoutMs ?? DEFAULT_SERVER_START_TIMEOUT } = {}) {
    if (await serverStatus()) return { ok: true, started: false };
    const child = spawn(bin, ['server'], { detached: true, stdio: 'ignore', windowsHide: true });
    let spawnFailure = null;
    child.on('error', (err) => { spawnFailure = String(err?.message ?? err); });
    child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnFailure) return { ok: false, attempted: true, error: spawnFailure };
      if (await serverStatus()) return { ok: true, started: true };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, attempted: true, error: spawnFailure ?? 'server start timeout' };
  }

  async function heartbeat() {
    const serverOk = await serverStatus();
    const agents = serverOk ? await list() : [];
    return { serverOk, agents };
  }

  async function list() {
    const r = await run(['agent', 'list']);
    return r.ok ? (r.data?.agents ?? []) : [];
  }

  async function get(target) { return run(['agent', 'get', target]); }

  async function read(target, { source = 'recent-unwrapped', lines = 60 } = {}) {
    const r = await runCli(bin, ['agent', 'read', target, '--source', source, '--lines', String(lines)], { timeoutMs: 10000 });
    if (r.code !== 0) return { ok: false, error: { code: 'exit', message: r.stderr || r.stdout }, text: '' };
    return { ok: true, error: null, text: r.stdout };
  }

  async function wait(target, { until = [], timeoutMs = cfg.delegationTimeoutMs } = {}) {
    const args = ['agent', 'wait', target];
    for (const s of until) args.push('--until', s);
    args.push('--timeout', String(timeoutMs));
    return run(args);
  }

  async function prompt(target, text, { wait = true, until = [], timeoutMs = cfg.delegationTimeoutMs } = {}) {
    const args = ['agent', 'prompt', target, text];
    if (wait) args.push('--wait');
    for (const s of until) args.push('--until', s);
    args.push('--timeout', String(timeoutMs));
    return run(args);
  }

  async function sendKeys(target, keys) { return run(['agent', 'send-keys', target, keys]); }

  async function rename(target, name) { return run(['agent', 'rename', target, name]); }

  /** 当前会话可用的宿主 pane（优先聚焦 pane，否则工作区首个 tab 的首个 pane）。 */
  async function resolveHostPane() {
    const cur = await run(['pane', 'current']);
    if (cur.ok) return cur.data?.pane?.pane_id ?? null;
    const ws = await run(['workspace', 'list']);
    if (!ws.ok) return null;
    const w = ws.data?.workspaces?.[0];
    if (!w) return null;
    const panes = await run(['pane', 'list', '--workspace', w.workspace_id]);
    return panes.data?.panes?.[0]?.pane_id ?? null;
  }

  /** 在宿主 pane 右侧分裂一个新 pane（不抢焦点）。 */
  async function splitRight(hostPaneId, cwd, { direction = 'right' } = {}) {
    const args = ['pane', 'split', '--pane', hostPaneId, '--direction', direction, '--no-focus'];
    if (cwd) args.push('--cwd', cwd);
    const r = await run(args);
    return r.ok ? (r.data?.pane?.pane_id ?? null) : null;
  }

  async function paneRun(paneId, command) { return run(['pane', 'run', paneId, command]); }
  /** 轮询等待某 pane 被检测出 agent（屏幕检测），返回 paneId 作为后续 target。 */
  async function waitForAgentInPane(paneId, { timeoutMs = cfg.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await get(paneId);
      if (r.ok) return paneId;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async function closeWorkspace(workspaceId) { return run(['workspace', 'close', workspaceId]); }
  /**
   * 唤醒流程（DESIGN Q5/Q6/Q7）：ensure server → 幂等检查 → 分裂兄弟 pane → 启动 mcode → 等检测 → 命名。
   * @returns {Promise<{outcome:'existing'|'created', pane?:string, agent?:object|null}>} Agent 未就绪/失败时抛错。
   */
  async function wake({ provider = 'minimax', cwd = null, hostPane = null } = {}) {
    const p = getProvider(provider);
    const workCwd = cwd ?? cfg.mcodeCwd ?? process.cwd();
    if (!(await isForkBuild())) throw new Error('herdr 需要 MiniMax detection fork 构建（kind 列表含 minimax）');
    const server = await ensureServer();
    if (!server.ok) throw new Error('herdr server 启动失败: ' + (server.error ?? '未知错误'));
    const existing = await get(cfg.paneName);
    if (existing.ok) return { outcome: 'existing', pane: existing.data?.agent?.pane_id ?? null, agent: existing.data?.agent ?? null };
    const hostPaneId = hostPane ?? (await resolveHostPane());
    if (!hostPaneId) throw new Error('无法定位 herdr 宿主 pane');
    const newPane = await splitRight(hostPaneId, workCwd);
    if (!newPane) throw new Error('pane 分裂失败');
    const runRes = await paneRun(newPane, p.startupCommand(cfg));
    if (!runRes.ok) throw new Error('启动 mcode 失败: ' + (runRes.error?.message ?? '未知错误'));
    const detected = await waitForAgentInPane(newPane);
    if (!detected) throw new Error('mcode 启动超时，未被 herdr 屏幕检测识别（检查 mcode 是否正常启动）');
    const renamed = await rename(newPane, cfg.paneName);
    if (!renamed.ok) throw new Error('agent 重命名失败: ' + (renamed.error?.message ?? '未知错误'));
    const got = await get(cfg.paneName);
    return { outcome: 'created', pane: newPane, agent: got.ok ? got.data?.agent ?? null : null };
  }

  /** 打断 mcode（默认 esc → ctrl+c 递进，直到不再 working）。 */
  async function stop({ keys = ['esc', 'ctrl+c'] } = {}) {
    const r = await get(cfg.paneName);
    if (!r.ok) return { ok: false, error: { code: 'agent_not_found', message: 'mcode 未运行（paneName=' + cfg.paneName + '）' } };
    let last = null;
    for (const k of keys) {
      last = await sendKeys(cfg.paneName, k);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const st = await get(cfg.paneName);
      if (st.data?.agent && stateOf(st.data.agent) !== 'working') break;
    }
    return { ok: true, result: last };
  }

  return {
    cfg, bin,
    run, serverStatus, isForkBuild, ensureServer, heartbeat,
    list, get, read, wait, prompt, sendKeys, rename,
    resolveHostPane, splitRight, paneRun, waitForAgentInPane, closeWorkspace,
    wake, stop,
    // TODO(agent-dock): provider 级扩展方法（多实例并发 Q10 等）挂靠到各 provider 对象，本 API 已按 provider 参数化，无侵入。
  };
}

