/**
 * dsh-agent-dock — 归属（ownership）判定。
 *
 * 修订背景（DESIGN Q10 修订）：v1.0 按 paneName 全局匹配（herdr 里存在名为
 * paneName 的 agent 即视为"已唤醒"），导致用户在任何目录/workspace 手动启动的
 * mcode 都会抢占 DSH 的唤醒按钮（徽章取代按钮，无法点击）。
 * v1.1 改为「paneName + cwd」双重匹配：插件只认「名字匹配 且 工作目录匹配」的
 * agent 为自己的（owned）。用户在别的目录开的 mcode 不算 owned，按钮永远可点。
 *
 * 本模块为纯函数、零依赖（不 import 其它模块），可被单元测试直接导入。
 */

/** agent 对象取名字：rename 后是 .name，否则是 .agent（粗粒度 auto 名）。 */
export function agentNameOf(agent) {
  return agent?.name ?? agent?.agent ?? null;
}

/** agent 对象取状态：agent_status → state，优先 result.state 兼容。 */
export function stateOf(agent) {
  return agent?.agent_status ?? agent?.state ?? 'unknown';
}

/** Windows 路径归一化：统一小写、'/' 分隔、去尾部斜杠（大小写/分隔符不敏感比较）。 */
export function normalizeCwd(p) {
  if (!p) return '';
  return String(p).trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

/** 从 panes 列表按 pane_id 取 cwd（agent 对象本身通常不带 cwd，需 join pane）。 */
export function paneCwdOf(panes, paneId) {
  const p = (panes ?? []).find((x) => x?.pane_id === paneId);
  return p ? normalizeCwd(p.cwd ?? '') : '';
}

/**
 * 归属判定：**cwd 是主判据**——pane/agent 的 cwd 与期望 cwd 归一化相等即归属
 * （Windows 路径大小写/分隔符不敏感）。名字只是同目录多候选时的优先级：
 * 优先 paneName 完全匹配者（插件 rename 成功的情形），否则取第一个 cwd 匹配者
 * （rename 撞名失败时 agent 保持自动名如 minimax，仍算归属——cwd 已足以证明"在
 * 期望工作目录里跑的 agent"）。无 cwd 证据（join 不到 panes 且自身无 cwd）时跳过，
 * 安全降级为不命中（不误认领）。
 * @param {object} opts { agents, panes, paneName, cwd }
 * @returns {object|null} 命中的 agent 对象（带 pane 的 cwd 投影），否则 null
 */
export function findOwnedAgent({ agents = [], panes = [], paneName, cwd } = {}) {
  const want = normalizeCwd(cwd);
  if (!want) return null;
  const hits = [];
  for (const agent of agents ?? []) {
    const agentCwd = (agent.pane_id ? paneCwdOf(panes, agent.pane_id) : '') || normalizeCwd(agent.cwd ?? '');
    if (!agentCwd) continue; // 无 cwd 信息时跳过（不误认领）
    if (agentCwd !== want) continue;
    hits.push(Object.assign({}, agent, { cwd: agentCwd }));
  }
  if (hits.length === 0) return null;
  const preferred = hits.find((a) => agentNameOf(a) === paneName);
  return preferred ?? hits[0];
}

/**
 * 归属 target：命中返回 pane_id 优先、agent 名兜底；未命中返回 null。
 * 所有路由/工具寻址一律用这个 target（不再直接拼 cfg.paneName）。
 */
export function ownedTarget(opts) {
  const owned = findOwnedAgent(opts);
  if (!owned) return null;
  return owned.pane_id || agentNameOf(owned);
}

/** 状态投影（供 status 负载/工具返回）：name/state/stateSeq/pane/title/cwd/workspace。 */
export function summarizeOwned(owned) {
  return {
    name: agentNameOf(owned),
    state: stateOf(owned),
    stateSeq: owned.state_change_seq ?? null,  // v0.4.16: state_change_seq 用于客户端计算状态持续时间
    pane: owned.pane_id ?? '',
    title: owned.terminal_title ?? owned.terminal_title_stripped ?? '',
    cwd: owned.cwd ?? '',
    workspace: owned.workspace_id ?? '',
  };
}
