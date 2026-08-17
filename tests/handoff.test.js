import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newTaskId, taskDir, contextFilePath, resultFilePath,
  renderContextFile, renderPrompt, readResultFile, ensureTaskDir, HANDOFF_DIR,
} from '../lib/handoff.js';

describe('handoff.js — 交接文件约定（DESIGN Q9/Q14）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dock-handoff-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('newTaskId 生成可追溯 id', () => {
    const id = newTaskId();
    expect(id).toMatch(/^task-[a-z0-9]+-[a-z0-9]+$/);
    expect(newTaskId()).not.toBe(id);
  });

  it('路径约定：目录/上下文/结果文件', () => {
    const d = taskDir(dir);
    expect(d).toBe(join(dir, '.mcode-handoff'));
    expect(contextFilePath(d, 'task-x1')).toBe(join(d, 'task-x1.md'));
    expect(resultFilePath(d, 'task-x1')).toBe(join(d, 'task-x1.result.md'));
  });

  it('renderContextFile 生成完整任务文档', () => {
    const text = renderContextFile({
      taskId: 'task-x1',
      goal: '写一组单元测试',
      constraints: ['不要改生产代码', '使用 vitest'],
      done: ['已梳理模块边界'],
      expected: 'tests/*.test.js',
    });
    expect(text).toContain('# Task task-x1');
    expect(text).toContain('## Goal');
    expect(text).toContain('写一组单元测试');
    expect(text).toContain('- 不要改生产代码');
    expect(text).toContain('## Already done');
    expect(text).toContain('已梳理模块边界');
  });

  it('renderPrompt 引用文件路径', () => {
    const p = renderPrompt('task-x1', '.mcode-handoff/task-x1.md', '.mcode-handoff/task-x1.result.md');
    expect(p).toContain('Execute task task-x1');
    expect(p).toContain('.mcode-handoff/task-x1.md');
    expect(p).toContain('.mcode-handoff/task-x1.result.md');
  });

  it('readResultFile 与 ensureTaskDir 落盘往返', () => {
    const d = ensureTaskDir(taskDir(dir));
    const id = 'task-r1';
    expect(readResultFile(d, id).ok).toBe(false);
    writeFileSync(resultFilePath(d, id), '全部测试通过\n3 files passed', 'utf-8');
    const r = readResultFile(d, id);
    expect(r.ok).toBe(true);
    expect(r.raw).toContain('全部测试通过');
  });
});
