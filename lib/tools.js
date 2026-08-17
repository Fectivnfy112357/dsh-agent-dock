/**
 * dsh-agent-dock — DSH agent 动态工具（agent_*，DSH agent 全自动协同入口）。
 * 工具名以 agent_ 前缀、面向 provider 参数化（DESIGN Q13）：扩展新 agent 时只加 provider，
 * 工具面与 UI 面不动。
 * 这些定义经 harness.defineTool + harness.registerTool 注册（见 index.js），
 * 入参为统一 schema DSL，execute 返回 JSON 兼容值。
 */
import { agentNameOf, stateOf } from './herdr.js';
import { classifyBlocked, shouldAutoApprove, PROVIDER_ORDER } from './providers.js';

/** 将 execute 失败转成工具级错误对象（工具不抛裸错误，避免中断 agent 回合）。 */
function toToolResult(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ ok: true, ...value }))
    .catch((err) => ({ ok: false, error: { code: 'agent-dock', message: String(err?.message ?? err) } }));
}

/** 未运行/错误时的统一摘要。 */
function absentStatus(api, reason) {
  return { ok: true, present: false, reason, paneName: api.cfg.paneName, provider: PROVIDER_ORDER[0] };
}
/**
 * 构建全部 agent_* 工具定义（数组，由 index.js 逐个注册）。
 * @param {object} api createHerdrApi 返回的高层 API
 */
export function buildToolDefs(api) {
  const P = () => api.cfg.paneName;
  return [
    {
      name: 'agent_wake',
      description: 'Wake the docked coding agent (v1: MiniMax Code / mcode) inside Herdr: ensure headless server, split a sibling pane in the current workspace, launch the agent CLI, wait for screen detection, and name it. Idempotent: if the agent is already running it reports existing without spawning a new pane. Call before delegating a task to the docked agent.',
      parameters: {
        provider: { type: 'string', description: 'Provider key (default: minimax; extension points for claude/opencode).' },
        cwd: { type: 'string', description: 'Working directory of the new pane (default: DSH current workspace).' },
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => toToolResult(() => api.wake({ provider: args.provider, cwd: args.cwd })),
    },
    {
      name: 'agent_status',
      description: 'Report whether the docked agent is present in Herdr and its current lifecycle state (idle/working/blocked/done/unknown), server/fork health, and a short recent-output preview. Use to sense the agent before delegating or when it seems stuck.',
      parameters: {
        previewLines: { type: 'number', description: 'Lines of recent terminal output to include (default 8).' },
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => {
        const heartbeat = await api.heartbeat();
        if (!heartbeat.serverOk) return absentStatus(api, 'herdr server 未运行（插件可先 agent_wake 自动拉起）');
        const agents = heartbeat.agents ?? [];
        const mine = agents.find((a) => agentNameOf(a) === P()) ?? null;
        if (!mine) return absentStatus(api, 'panename ' + P() + ' 未检测到（可 agent_wake）');
        const preview = await api.read(P(), { lines: Math.min(args.previewLines ?? 8, 60) });
        return {
          ok: true, present: true,
          name: agentNameOf(mine),
          state: stateOf(mine),
          pane: mine.pane_id ?? '',
          workspace: mine.workspace_id ?? '',
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
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => toToolResult(() => {
        const r = api.prompt(P(), args.text, { wait: args.wait ?? true, until: args.until ?? [], timeoutMs: args.timeoutMs });
        return r.then((res) => {
          if (!res.ok) return { ok: false, error: res.error, agent: res.data?.agent ?? null, state: res.data?.agent ? stateOf(res.data.agent) : undefined };
          return { ok: true, agent: res.data?.agent ?? null, state: res.data?.agent ? stateOf(res.data.agent) : undefined };
        });
      }),
    },
    {
      name: 'agent_wait',
      description: 'Block until the docked agent reaches one of the requested states (default idle/done/blocked) or timeout. Use after agent_prompt to track a delegated task, or with until=[blocked] to detect an approval dialog.',
      parameters: {
        until: { type: 'array', description: 'States to match (idle/working/blocked/done/unknown; default idle, done, blocked).' },
        timeoutMs: { type: 'number', description: 'Wait timeout in ms (default 120000).' },
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => toToolResult(() => {
        const r = api.wait(P(), { until: args.until ?? [], timeoutMs: args.timeoutMs ?? 120000 });
        return r.then((res) => {
          if (!res.ok) return { ok: false, error: res.error, agent: res.data?.agent ?? null, state: res.data?.agent ? stateOf(res.data.agent) : undefined };
          return { ok: true, agent: res.data?.agent ?? null, state: res.data?.agent ? stateOf(res.data.agent) : undefined };
        });
      }),
    },
    {
      name: 'agent_read',
      description: 'Read the docked agent terminal output (recent-unwrapped by default). Use for live progress, approval-dialog content, or result verification. For final deliverables prefer reading the result file the agent wrote (see skill).',
      parameters: {
        source: { type: 'string', description: 'Snapshot source: visible | recent | recent-unwrapped | detection (default recent-unwrapped).' },
        lines: { type: 'number', description: 'Rows to read (default 60).' },
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => toToolResult(() => {
        return api.read(P(), { source: args.source ?? 'recent-unwrapped', lines: args.lines ?? 60 }).then((r) => r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error });
      }),
    },
    {
      name: 'agent_stop',
      description: 'Interrupt the docked agent (esc, then ctrl+c if still working). Use when the user sends a new message mid-delegation or the agent is stuck.',
      parameters: {
        keys: { type: 'array', description: 'Keys to send in order (default ["esc","ctrl+c"]).' },
      },
      output: { schema: { type: 'json' } },
      execute: async (args) => toToolResult(() => api.stop({ keys: args.keys ?? ['esc', 'ctrl+c'] })),
    },
  ];
}
