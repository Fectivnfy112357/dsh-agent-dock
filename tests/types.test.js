import { describe, it, expect } from 'vitest';
import { resolveConfig, validateConfig, DEFAULT_CONFIG, AGENT_STATES } from '../lib/types.js';

describe('types.js — 配置解析与校验', () => {
  it('默认配置完整且校验通过', () => {
    const cfg = resolveConfig();
    expect(cfg.paneName).toBe('mcode');
    expect(cfg.pollIntervalMs).toBe(2000);
    expect(cfg.delegationTimeoutMs).toBe(900000);
    expect(cfg.autoApprove).toBe(true);
    expect(AGENT_STATES).toContain('blocked');
  });

  it('用户配置覆盖默认值（浅合并）', () => {
    const cfg = resolveConfig({ paneName: 'copilot', pollIntervalMs: 3000 });
    expect(cfg.paneName).toBe('copilot');
    expect(cfg.pollIntervalMs).toBe(3000);
    expect(cfg.autoApprove).toBe(true);
  });

  it('非法配置 fail loudly', () => {
    expect(() => resolveConfig({ paneName: 'Bad Name' })).toThrow();
    expect(() => resolveConfig({ paneName: 'x'.repeat(40) })).toThrow();
    expect(() => resolveConfig({ pollIntervalMs: 100 })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, paneName: 'valid-name' })).not.toThrow();
  });
});
