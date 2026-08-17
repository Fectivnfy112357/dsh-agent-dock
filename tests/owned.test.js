import { describe, it, expect } from 'vitest';
import { normalizeCwd, findOwnedAgent, ownedTarget } from '../lib/owned.js';

describe('owned.js — 归属判定（DESIGN Q10 修订：paneName + cwd 双重匹配）', () => {
  it('normalizeCwd 归一化 Windows 路径（大小写/反斜杠/尾斜杠）', () => {
    expect(normalizeCwd('D:\\Programming\\Projects\\dsh_worlspace')).toBe('d:/programming/projects/dsh_worlspace');
    expect(normalizeCwd('d:/programming/projects/dsh_worlspace/')).toBe('d:/programming/projects/dsh_worlspace');
    expect(normalizeCwd('C:\\Users\\32115')).toBe('c:/users/32115');
    expect(normalizeCwd('')).toBe('');
    expect(normalizeCwd(null)).toBe('');
  });

  it('findOwnedAgent：同目录的 paneName agent 命中', () => {
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle', terminal_title: 'mcode' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' }];
    const hit = findOwnedAgent({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' });
    expect(hit).not.toBeNull();
    expect(hit.pane_id).toBe('w2:p2');
  });

  it('findOwnedAgent：同名但不同目录的 mcode 不算归属（核心回归）', () => {
    // 用户在 C:\Users\32115 手动起的 mcode —— 名字匹配但目录不符，不应被插件认领
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'C:\\Users\\32115' }];
    const miss = findOwnedAgent({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' });
    expect(miss).toBeNull();
  });

  it('findOwnedAgent：目录一致但名字不同仍命中（cwd 是主判据，名字仅优先级）', () => {
    // rename 撞名失败时 agent 保持自动名（如 minimax），cwd 匹配即归属
    const agents = [{ pane_id: 'w2:p2', name: 'other-name', agent: 'minimax', agent_status: 'idle' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' }];
    expect(findOwnedAgent({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).not.toBeNull();
  });

  it('findOwnedAgent：同目录多候选时优先 paneName 精确匹配者', () => {
    const agents = [
      { pane_id: 'w2:p3', name: 'minimax', agent: 'minimax', agent_status: 'idle' },
      { pane_id: 'w2:p2', name: 'mcode', agent: 'minimax', agent_status: 'working' },
    ];
    const panes = [
      { pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' },
      { pane_id: 'w2:p3', cwd: 'D:\\programming\\projects\\dsh_worlspace' },
    ];
    const hit = findOwnedAgent({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' });
    expect(hit).not.toBeNull();
    expect(hit.pane_id).toBe('w2:p2'); // 优先名字=mcode 的那个
  });

  it('findOwnedAgent：cwd 大小写/分隔符差异仍命中（Windows 路径）', () => {
    const agents = [{ pane_id: 'w3:p1', name: 'mcode', agent_status: 'working' }];
    const panes = [{ pane_id: 'w3:p1', cwd: 'D:/PROGRAMMING/PROJECTS/DSH_WORLSPACE' }];
    const hit = findOwnedAgent({ agents, panes, paneName: 'mcode', cwd: 'd:\\programming\\projects\\dsh_worlspace' });
    expect(hit).not.toBeNull();
  });

  it('findOwnedAgent：无 panes 数据时安全降级为不命中（不误认领）', () => {
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }];
    expect(findOwnedAgent({ agents, panes: [], paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBeNull();
  });

  it('ownedTarget：命中返回 pane_id 优先、名字兜底；未命中返回 null', () => {
    const agents = [{ pane_id: 'w2:p2', name: 'mcode', agent_status: 'idle' }];
    const panes = [{ pane_id: 'w2:p2', cwd: 'D:\\programming\\projects\\dsh_worlspace' }];
    expect(ownedTarget({ agents, panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBe('w2:p2');
    // pane_id 缺失但 agent 自带 cwd（join 不到 panes）：命中且用名字兜底
    const selfCwd = [{ name: 'mcode', agent_status: 'idle', pane_id: undefined, cwd: 'D:\\programming\\projects\\dsh_worlspace' }];
    expect(ownedTarget({ agents: selfCwd, panes: [], paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBe('mcode');
    // pane_id 缺失且无 cwd 证据：安全不命中（不误认领）
    const noCwd = [{ name: 'mcode', agent_status: 'idle' }];
    expect(ownedTarget({ agents: noCwd, panes: panes, paneName: 'mcode', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBeNull();
    // cwd 匹配即归属（paneName 只是优先级，不是排除条件）：目录匹配的 agent 即使名字不同也命中
    expect(ownedTarget({ agents, panes, paneName: 'other', cwd: 'D:\\programming\\projects\\dsh_worlspace' })).toBe('w2:p2');
  });
});
