/**
 * dsh-agent-dock — 配置默认值、常量与输入校验。
 * 本模块保持零依赖（纯 ESM，可被单元测试直接导入）。
 */

/** Agent 生命周期状态（与 herdr agent wait --until 的合法值一致）。 */
export const AGENT_STATES = ['idle', 'working', 'blocked', 'done', 'unknown'];

/** 默认配置。用户可通过 profile 的 cordis patch / config 覆盖（键名小驼峰）。 */
export const DEFAULT_CONFIG = {
  /** herdr 可执行文件；默认 'herdr'（PATH 解析）。非 fork 构建会被探测并报错。 */
  herdrBin: 'herdr',
  /** mcode pane 的工作目录；null = 使用 DSH 当前工作目录。 */
  mcodeCwd: null,
  /** 协同 pane/agent 名（herdr 命名规则 [a-z][a-z0-9_-]{0,31}）。 */
  paneName: 'mcode',
  /** WebUI 徽章轮询间隔（ms）。 */
  pollIntervalMs: 2000,
  /** 单次委托超时（ms），默认 15 分钟。 */
  delegationTimeoutMs: 900000,
  /** 唤醒时是否以 `mcode -c` 续接工作目录里最近的 session。 */
  resumeLastSession: false,
  /** blocked 对话框白名单自动放行（危险动作始终转人工，见 providers.classifyBlocked）。 */
  autoApprove: true,
  /** 唤醒后等待屏幕检测识别 minimax agent 的超时（ms）。 */
  detectTimeoutMs: 30000,
  /** herdr server 拉起后的就绪等待超时（ms）。 */
  serverStartTimeoutMs: 30000,
};

/** pane 名合法性（herdr 约束 [a-z][a-z0-9_-]{0,31}）。 */
export const PANE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 校验配置；不合法的键值抛错（fail loudly）。 */
export function validateConfig(cfg) {
  const errors = [];
  if (typeof cfg.herdrBin !== 'string' || cfg.herdrBin.length === 0) errors.push('herdrBin must be a non-empty string');
  if (!PANE_NAME_RE.test(cfg.paneName)) errors.push(`paneName must match ${PANE_NAME_RE} (got ${cfg.paneName})`);
  if (!Number.isFinite(cfg.pollIntervalMs) || cfg.pollIntervalMs < 500) errors.push('pollIntervalMs must be >= 500');
  if (!Number.isFinite(cfg.delegationTimeoutMs) || cfg.delegationTimeoutMs < 1000) errors.push('delegationTimeoutMs must be >= 1000');
  if (typeof cfg.autoApprove !== 'boolean') errors.push('autoApprove must be a boolean');
  if (typeof cfg.resumeLastSession !== 'boolean') errors.push('resumeLastSession must be a boolean');
  if (errors.length > 0) throw new Error('dsh-agent-dock: invalid config: ' + errors.join('; '));
  return cfg;
}

/** 合并用户配置与默认值并校验。 */
export function resolveConfig(userConfig = {}) {
  return validateConfig({ ...DEFAULT_CONFIG, ...(userConfig ?? {}) });
}
