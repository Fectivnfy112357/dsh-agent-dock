/**
 * dsh-agent-dock — agent provider 注册表（DESIGN Q13 扩展位）。
 * v1 只实现 minimax（mcode）。新增 agent 只需在此加一个 provider：
 *   - kind：herdr agent kind（`herdr agent start --kind <kind>`，或屏幕/进程检测的自动 kind）
 *   - cliName：pane 里执行的命令
 *   - startupCommand：根据配置生成启动命令
 * 不需要改动 routes / tools / client。多实例并发（Q10）的并发面也在 provider 层留口。
 */

/** provider 顺序（徽章/工具默认按此顺序呈现）。 */
export const PROVIDER_ORDER = ['minimax'];

// TODO(agent-dock): 扩展位 —— 例如 claude：
//   claude: {
//     kind: 'claude',
//     label: 'Claude Code',
//     cliName: 'claude',
//     startupCommand: (cfg) => (cfg.resumeLastSession ? 'claude --continue' : 'claude'),
//   },
// TODO(agent-dock): 扩展位 —— 例如 opencode：
//   opencode: {
//     kind: 'opencode',
//     label: 'OpenCode',
//     cliName: 'opencode',
//     startupCommand: (cfg) => (cfg.resumeLastSession ? 'opencode --continue' : 'opencode'),
//   },
// TODO(agent-dock): 多实例并发（Q10）—— provider 需要支持 per-instance 命名：paneName 加后缀，
//   当前单实例模型（paneName 固定）保持向后兼容。

/** 内置 providers 注册表（v1: minimax 唯一实现）。 */
export const PROVIDERS = {
  minimax: {
    kind: 'minimax',
    label: 'MiniMax Code',
    cliName: 'mcode',
    /** pane 内启动命令；resumeLastSession 时续接当前目录最近 session。 */
    startupCommand: (cfg) => (cfg.resumeLastSession ? 'mcode -c' : 'mcode'),
  },
};

export function getProvider(key) {
  const p = PROVIDERS[key];
  if (!p) throw new Error(`dsh-agent-dock: unknown provider '${key}'`);
  return p;
}

/** 默认 provider（v1 固定 minimax）。 */
export function defaultProvider() {
  return getProvider(PROVIDER_ORDER[0]);
}

/**
 * blocked 权限对话框的内容分类（DESIGN Q8 白名单自动放行）。
 * 返回值：'auto'（可自动确认）| 'human'（必须转人工）| 'unknown'（无法分类 → 按 human 处理）。
 * 分类基于 mcode 屏幕文本的关键词；白名单与危险清单都在这里维护（mcode UI 改版时只需更新这里）。
 */
const DANGER_PATTERNS = [
  /\b(?:delete|remove|uninstall|rm\b|drop\b|format|wipe|truncate|chmod|chown|sudo)\b/i,
  /\b(?:install)\b.*\b(?:npm|pnpm|yarn|pip|brew|apt|gem|go install)\b/i,
  /\b(?:npm install|pnpm (?:add|install)|yarn add|pip install|brew install|apt (?:get )?install)\b/i,
  /\b(?:pay|payment|purchase|billing|invoice|charge|card)\b/i,
  /\b(?:api[_-]?\s*key|password|credential|secret|token|session-cookie)\b/i,
  /\b(?:curl|wget|ssh\b|scp\b|netcat|nc\b|telnet|ftp\b)\b/i,
  /\b(?:git push|git reset --hard|git clean -f|git rebase|force push)\b/i,
];
const AUTO_PATTERNS = [
  /\b(?:allow|approve|permit|accept|continue|proceed|run\b|confirm|ok\b|yes\b|done)\b/i,
];

/** 白名单判定：先查危险清单（命中 → human），再查自动放行词（命中 → auto），否则 unknown。 */
export function classifyBlocked(text) {
  if (!text) return 'unknown';
  if (DANGER_PATTERNS.some((re) => re.test(text))) return 'human';
  if (AUTO_PATTERNS.some((re) => re.test(text))) return 'auto';
  return 'unknown';
}

/** blocked 归类后是否允许 DSH 自动确认（autoApprove 开关在调用方应用）。 */
export function shouldAutoApprove(classResult, cfg) {
  if (!cfg || cfg.autoApprove === false) return false;
  return classResult === 'auto';
}
