import { describe, it, expect } from 'vitest';
import { classifyBlocked, shouldAutoApprove, getProvider, defaultProvider } from '../lib/providers.js';

describe('providers.js — blocked 白名单分类（DESIGN Q8）', () => {
  it('白名单自动放行: 允许/继续/运行类', () => {
    expect(classifyBlocked('Allow running tests?')).toBe('auto');
    expect(classifyBlocked('Proceed with the edit?')).toBe('auto');
    expect(classifyBlocked('Do you want to continue? [Y/n]')).toBe('auto');
  });

  it('危险动作必须转人工（命中任意危险关键词）', () => {
    expect(classifyBlocked('Delete the directory?')).toBe('human');
    expect(classifyBlocked('Run npm install?')).toBe('human');
    expect(classifyBlocked('curl https://example.com')).toBe('human');
    expect(classifyBlocked('git push --force?')).toBe('human');
    expect(classifyBlocked('Enter payment card details')).toBe('human');
    expect(classifyBlocked('Show API key')).toBe('human');
    // 危险清单优先于自动放行词
    expect(classifyBlocked('Allow the npm install?')).toBe('human');
  });

  it('未知内容返回 unknown（fail-safe，调用方按 human 处理）', () => {
    expect(classifyBlocked('Some random dialog text')).toBe('unknown');
    expect(classifyBlocked('')).toBe('unknown');
    expect(classifyBlocked(null)).toBe('unknown');
  });

  it('shouldAutoApprove 受 autoApprove 开关控制', () => {
    const cfgOn = { autoApprove: true };
    const cfgOff = { autoApprove: false };
    expect(shouldAutoApprove('auto', cfgOn)).toBe(true);
    expect(shouldAutoApprove('human', cfgOn)).toBe(false);
    expect(shouldAutoApprove('auto', cfgOff)).toBe(false);
  });

  it('provider registry: minimax v1 可用，未知 provider 报错', () => {
    const p = getProvider('minimax');
    expect(p.kind).toBe('minimax');
    expect(p.cliName).toBe('mcode');
    expect(p.startupCommand({ resumeLastSession: false })).toBe('mcode');
    expect(p.startupCommand({ resumeLastSession: true })).toBe('mcode -c');
    expect(defaultProvider().kind).toBe('minimax');
    expect(() => getProvider('nope')).toThrow();
  });
});
