/**
 * dsh-agent-dock — DSH agent 动态工具（agent_*，DSH agent 全自动协同入口）。
 * 工具名以 agent_ 前缀、面向 provider 参数化（DESIGN Q13）：扩展新 agent 时只加 provider，
 * 工具面与 UI 面不动。
 * v1.1：寻址从「全局 paneName」改为「归属 target」（paneName + cwd，见 owned.js）；
 * 调用方（DSH agent）应在参数里传 cwd=当前工作目录（系统提示提供），默认回退 cfg.mcodeCwd。
 * 这些定义经 ctx.tools.register(defineTool(...)) 注册（见 index.js），
 * 入参为统一 schema DSL，execute 返回 JSON 兼容值。
 */
import { agentNameOf, stateOf } from './herdr.js';
import { classifyBlocked, shouldAutoApprove, PROVIDER_ORDER } from './providers.js';

/** 标准 JSON 渲染器：把规范值 JSON.stringify 后塞进一条 text content block。
 *  defineTool / ctx.tools.register 要求 output.render 必须是函数（d沙箱守卫 guard.ts:558、
 *  dsh-tools register 守卫 lib/index.js:2758），这里给所有 agent_* 工具用同一个轻量渲染。 */
const jsonTextRender = (_args, value) => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
];

/** 将 execute 失败转成工具级错误对象（工具不抛裸错误，避免中断 agent 回合）。 */
function toToolResult(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ ok: true, ...value }))
    .catch((err) => ({ ok: false, error: { code: 'agent-dock', message: String(err?.message ?? err) } }));
}

/** 把 herdr run 结果归一化成工具返回（agent/state 投影 + 附加字段）。 */
function settled(res, extra = {}) {
  return {
    ok: res.ok,
    error: res.error ?? null,
    agent: res.data?.agent ?? null,
    state: res.data?.agent ? stateOf(res.data.agent) : undefined,
    ...extra,
  };
}

/**
 * 归属 target 解析：命中返回 pane_id/名字；未命中返回 null（对调用方透明）。
 * @param {object} api herdr api
 * @param {object} args 工具入参（cwd 可选，默认回退链见 resolveTarget）
 */
async function ownedTargetOrNull(api, args = {}) {
  return api.resolveTarget({ cwd: args.cwd ?? undefined });
}

/**
 * Q8 白名单自动放行：agent 停在 blocked 时读对话框 → 分类 → auto 且开启 autoApprove 则 Enter 确认后继续等；
 * human/unknown 停止自动推进并返回对话框内容供 DSH 转人工。target 为已解析的归属 target。
 */
async function autoApproveBlocked(api, target) {
  const read = await api.read(target, { source: 'recent-unwrapped', lines: 40 });
  const dialog = read.ok ? read.text : '';
  const cls = classifyBlocked(dialog);
  if (cls === 'auto' && shouldAutoApprove(cls, api.cfg)) {
    await api.sendKeys(target, 'enter');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = await api.wait(target, { timeoutMs: Math.min(api.cfg.delegationTimeoutMs, 120000) });
    return { ...settled(after), autoApproved: true, dialogClass: cls };
  }
  return {
    ok: false,
    error: { code: 'agent_blocked', message: 'approval required: escalate to the user' },
    blocked: { classify: cls, dialog: dialog.slice(0, 800) },
  };
}

/** 未运行/错误时的统一摘要。 */
function absentStatus(api, reason) {
  return { ok: true, present: false, reason, paneName: api.cfg.paneName, provider: PROVIDER_ORDER[0] };
}
/** 工具调用方未传 cwd 时的提示文案（DSH agent 应传当前工作目录）。 */
function cwdHint(api) {
  return '（agent_* 工具建议显式传 cwd=当前工作目录；服务端回退链: cfg.mcodeCwd → process.cwd）';
}
/**
 * 构建全部 agent_* 工具定义（数组，由 index.js 逐个注册）。
 * @param {object} api createHerdrApi 返回的高层 API
 */
export function buildToolDefs(api) {
  return [
    {
      name: 'agent_wake',
      description: 'Wake the docked coding agent (v1: MiniMax Code / mcode) inside Herdr: ensure headless server, split a sibling pane, launch the agent CLI, wait for screen detection, and name it. Ownership rule: only an agent whose pane working directory matches cwd counts as "already running" — an mcode started elsewhere never blocks this. Idempotent: if the owned agent exists it focuses that pane (existing) instead of spawning. Call before delegating a task to the docked agent.',
      parameters: {
        provider: { type: 'string', description: 'Provider key (default: minimax; extension points for claude/opencode).' },
        cwd: { type: 'string', description: 'Expected working directory of the mcode pane — pass the DSH current working directory. Default: cfg.mcodeCwd, else the dsh web process cwd.' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => toToolResult(() => api.wake({ provider: args.provider, cwd: args.cwd })),
    },
    {
      name: 'agent_status',
      description: 'Report whether the docked agent is present in Herdr and its current lifecycle state (idle/working/blocked/done/unknown), server/fork health, and a short recent-output preview. Use to sense the agent before delegating or when it seems stuck.',
      parameters: {
        previewLines: { type: 'number', description: 'Lines of recent terminal output to include (default 8).' },
        cwd: { type: 'string', description: 'Expected working directory (default: cfg.mcodeCwd / process.cwd).' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => {
        const heartbeat = await api.heartbeat();
        if (!heartbeat.serverOk) return absentStatus(api, 'herdr server 未运行（插件可先 agent_wake 自动拉起）');
        const [agents, panes] = await Promise.all([api.list(), api.panes()]);
        const owned = await api.resolveOwned({ cwd: args.cwd ?? undefined });
        if (!owned) return absentStatus(api, '归属的 agent（paneName=' + api.cfg.paneName + ' 且 cwd 匹配）未检测到（可 agent_wake）' + cwdHint(api));
        const target = owned.pane_id || agentNameOf(owned);
        const preview = await api.read(target, { lines: Math.min(args.previewLines ?? 8, 60) });
        return {
          ok: true, present: true,
          name: agentNameOf(owned),
          state: stateOf(owned),
          pane: owned.pane_id ?? '',
          workspace: owned.workspace_id ?? '',
          cwd: owned.cwd ?? '',
          preview: preview.ok ? preview.text.slice(0, 2000) : '',
          forkOk: await api.isForkBuild(),
        };
      },
    },
    {
      name: 'agent_prompt',
      description: 'Submit a prompt to the docked agent via Herdr (typed into its input, Enter sent). With wait (default) blocks until the agent settles to idle/done/blocked or times out. Use after writing a handoff context file (see the agent-dock skill for the file protocol). Errors: agent_blocked (needs approval — read the dialog with agent_read), agent_prompt_stalled (no state change within 5s), timeout.',
      parameters: {
        text: { type: 'string', required: true, description: 'The prompt text to submit to the agent.' },
        wait: { type: 'boolean', description: 'Wait for a settled state (default true).' },
        until: { type: 'array', description: 'Explicit states to match when waiting (idle/working/blocked/done/unknown; default idle, done, blocked).' },
        timeoutMs: { type: 'number', description: 'Wait timeout in ms (default delegationTimeoutMs, 900000).' },
        cwd: { type: 'string', description: 'Expected working directory (default: cfg.mcodeCwd / process.cwd).' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => toToolResult(async () => {
        const target = await ownedTargetOrNull(api, args);
        if (!target) return { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先 agent_wake' + cwdHint(api) } };
        const r = await api.prompt(target, args.text, { wait: args.wait ?? true, until: args.until ?? [], timeoutMs: args.timeoutMs });
        const blocked = args.wait === false ? false : (!r.ok && r.error?.code === 'agent_blocked') || (r.ok && !!r.data?.agent && stateOf(r.data.agent) === 'blocked');
        if (blocked) return autoApproveBlocked(api, target);
        return settled(r);
      }),
    },
    {
      name: 'agent_wait',
      description: 'Block until the docked agent reaches one of the requested states (default idle/done/blocked) or timeout. Use after agent_prompt to track a delegated task, or with until=[blocked] to detect an approval dialog.',
      parameters: {
        until: { type: 'array', description: 'States to match (idle/working/blocked/done/unknown; default idle, done, blocked).' },
        timeoutMs: { type: 'number', description: 'Wait timeout in ms (default 120000).' },
        cwd: { type: 'string', description: 'Expected working directory (default: cfg.mcodeCwd / process.cwd).' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => toToolResult(async () => {
        const target = await ownedTargetOrNull(api, args);
        if (!target) return { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先 agent_wake' + cwdHint(api) } };
        return settled(await api.wait(target, { until: args.until ?? [], timeoutMs: args.timeoutMs ?? 120000 }));
      }),
    },
    {
      name: 'agent_read',
      description: 'Read the docked agent terminal output (recent-unwrapped by default). Use for live progress, approval-dialog content, or result verification. For final deliverables prefer reading the result file the agent wrote (see skill).',
      parameters: {
        source: { type: 'string', description: 'Snapshot source: visible | recent | recent-unwrapped | detection (default recent-unwrapped).' },
        lines: { type: 'number', description: 'Rows to read (default 60).' },
        cwd: { type: 'string', description: 'Expected working directory (default: cfg.mcodeCwd / process.cwd).' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => toToolResult(async () => {
        const target = await ownedTargetOrNull(api, args);
        if (!target) return { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先 agent_wake' + cwdHint(api) } };
        const r = await api.read(target, { source: args.source ?? 'recent-unwrapped', lines: args.lines ?? 60 });
        return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error };
      }),
    },
    {
      name: 'agent_stop',
      description: 'Interrupt the docked agent (esc, then ctrl+c if still working). Use when the user sends a new message mid-delegation or the agent is stuck.',
      parameters: {
        keys: { type: 'array', description: 'Keys to send in order (default ["esc","ctrl+c"]).' },
        cwd: { type: 'string', description: 'Expected working directory (default: cfg.mcodeCwd / process.cwd).' },
      },
      output: { schema: { type: 'json' }, render: jsonTextRender },
      execute: async (args) => toToolResult(async () => {
        const target = await ownedTargetOrNull(api, args);
        if (!target) return { ok: false, error: { code: 'agent_not_owned', message: '未检测到归属的 agent，请先 agent_wake' + cwdHint(api) } };
        return api.stop({ keys: args.keys ?? ['esc', 'ctrl+c'], target });
      }),
    },
  ];
}
