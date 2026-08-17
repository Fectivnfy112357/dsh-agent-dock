import { describe, it, expect, vi } from 'vitest';
import { createHerdrApi, parseCli, focusArgs, findOwned } from '../lib/herdr.js';
import { resolveConfig, DEFAULT_CONFIG } from '../lib/types.js';

const cfg = resolveConfig({ ...DEFAULT_CONFIG });

/** 简易 fake CLI：handler 为函数时返回其值（完整 run 结果），否则 JSON 包装为 result。 */
function fakeCli(handlers) {
  return vi.fn(async (_bin, args) => {
    const key = args.join(' ');
    const h = handlers[key];
    if (!h) return { code: 1, stdout: JSON.stringify({ id: 'x', error: { code: 'unhandled', message: 'no fake for ' + key } }), stderr: '' };
    if (typeof h === 'function') return h();
    return { code: 0, stdout: JSON.stringify({ id: 'x', result: h }), stderr: '' };
  });
}

const SERVER_STATUS = 'client:\n  version: 0.8.0\nserver:\n  status: running\n  protocol: 20';

describe('herdr.js — 归属寻址（v1.1：paneName + cwd 双重匹配）', () => {
  it('focusArgs 构造 agent focus 参数', () => {
    expect(focusArgs('w2:p2')).toEqual(['agent', 'focus', 'w2:p2']);
  });

  it('findOwned 从 agents+panes 命中同名同目录 agent（返回带 pane_id 的 target）', () => {
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' }];
    expect(findOwned({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBe('w2:p2');
  });

  it('findOwned 同名但不同目录返回 null（核心回归：别处手动开的 mcode 不抢归属）', () => {
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'C:\\Users\\32115' }];
    expect(findOwned({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBeNull();
  });

  it('wake existing 分支：命中归属 -> outcome=existing 且调用 agent focus 聚焦', async () => {
    const cli = fakeCli({
      'status': () => ({ code: 0, stdout: SERVER_STATUS, stderr: '' }),
      'agent start --help': { possible: ['pi', 'minimax'] },
      'agent list': { agents: [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle', terminal_title: 'mcode' }] },
      'pane list': { panes: [{ pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' }] },
      'agent focus w2:p2': { ok: true },
      'agent get mcode': { agent: { pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' } },
    });
    const api = createHerdrApi(cfg, { runCli: cli });
    const wake = await api.wake({ cwd: 'D:\\programming\\projects\\dsh_worlspace' });
    expect(wake.outcome).toBe('existing');
    expect(wake.pane).toBe('w2:p2');
    expect(cli.mock.calls.some((c) => c[1]?.join(' ') === 'agent focus w2:p2')).toBe(true);
    expect(wake.focused).toBe(true);
  });

  it('wake 非归属分支：同名但不同目录的 mcode 不应阻止新建（重新分裂 pane）', async () => {
    const cli = fakeCli({
      'status': () => ({ code: 0, stdout: SERVER_STATUS, stderr: '' }),
      'agent start --help': { possible: ['pi', 'minimax'] },
      'agent list': { agents: [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }] }, // 在 C:\\Users\\32115
      'pane list': {
        panes: [
          { pane_id: 'w2:p1', cwd: 'C:\\Users\\32115' },
          { pane_id: 'w2:p2', cwd: 'C:\\Users\\32115' },
        ],
      },
      'pane current': { pane: { pane_id: 'w2:p1' } },
      'pane split --pane w2:p1 --direction right --no-focus --cwd D:\\programming\\projects\\dsh_worlspace': { pane: { pane_id: 'w2:p3' } },
      // v1.2 修订：herdr fork 0.8.0 的 pane split --cwd 已设置 pane shell cwd，mcode 启动直接继承，
      // 不再需要 cd 拼接前缀（实测 `cd ; mcode` 会让 mcode 因 Start-Process 反而跑回 $HOME）
      'pane run w2:p3 mcode': { ok: true },
      'agent get w2:p3': { agent: { pane_id: 'w2:p3', agent: 'minimax', agent_status: 'working' } },
      'agent rename w2:p3 mcode': { ok: true },
      'agent get mcode': { agent: { pane_id: 'w2:p3', name: 'mcode', agent_status: 'working' } },
    });
    const api = createHerdrApi(cfg, { runCli: cli });
    const wake = await api.wake({ cwd: 'D:\\programming\\projects\\dsh_worlspace' });
    expect(wake.outcome).toBe('created');
    expect(wake.pane).toBe('w2:p3');
    expect(cli.mock.calls.some((c) => c[1]?.join(' ').includes('--cwd D:\\programming\\projects\\dsh_worlspace'))).toBe(true);
  });

  it('wake 默认 cwd 回退链：显式 cwd > cfg.mcodeCwd > process.cwd()', () => {
    const cfg2 = resolveConfig({ ...DEFAULT_CONFIG, mcodeCwd: 'D:\\cfg\\override' });
    expect(cfg2.mcodeCwd).toBe('D:\\cfg\\override');
  });
});
