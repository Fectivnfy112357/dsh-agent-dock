import { describe, it, expect } from 'vitest';
import {
  parseCli, parseForkProbe, parseServerStatus, agentNameOf, stateOf,
} from '../lib/herdr.js';

describe('herdr.js — 解析层（纯函数 seam）', () => {
  it('parseCli 解析成功 JSON result', () => {
    const r = parseCli({ code: 0, stdout: '{"id":"cli:agent:list","result":{"agents":[{"agent":"minimax"}]}}', stderr: '' });
    expect(r.ok).toBe(true);
    expect(r.data.agents[0].agent).toBe('minimax');
  });
  it('parseCli 解析 JSON 错误（exit 1）', () => {
    const r = parseCli({ code: 1, stdout: '{"error":{"code":"agent_blocked","message":"Approval needed"},"id":"cli:agent:prompt"}', stderr: '' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('agent_blocked');
  });
  it('parseCli 回退纯文本（agent read 的输出）', () => {
    const r = parseCli({ code: 0, stdout: 'Message · Enter send\n──\n›\n', stderr: '' });
    expect(r.ok).toBe(true);
    expect(r.raw).toContain('Message');
  });
  it('parseForkProbe 识别 fork（kind 列表含 minimax）', () => {
    expect(parseForkProbe('[possible values: pi, claude, minimax, opencode]')).toBe(true);
    expect(parseForkProbe('[possible values: pi, claude, codex]')).toBe(false);
  });
  it('parseServerStatus 识别运行中的 server', () => {
    const sample = 'client:\n  version: 0.8.0\nserver:\n  status: running\n  protocol: 20';
    expect(parseServerStatus(sample)).toBe(true);
    expect(parseServerStatus('server:\n  status: stopped')).toBe(false);
  });
  it('agentNameOf/stateOf 正确投影（rename 前后两种字段布局）', () => {
    const renamed = { name: 'mcode', agent: 'minimax', agent_status: 'blocked' };
    const auto = { agent: 'minimax', agent_status: 'working' };
    expect(agentNameOf(renamed)).toBe('mcode');
    expect(agentNameOf(auto)).toBe('minimax');
    expect(agentNameOf(null)).toBe(null);
    expect(stateOf(renamed)).toBe('blocked');
    expect(stateOf(auto)).toBe('working');
    expect(stateOf({})).toBe('unknown');
  });
});
