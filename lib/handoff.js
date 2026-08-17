/**
 * dsh-agent-dock — 任务交接（handoff）文件约定（DESIGN §6/Q14）。
 * 两层上下文：持久层工作区根 AGENTS.md（mcode 与 DSH 共享记忆）；
 * 任务层 .mcode-handoff/<task-id>.md（目标/约束/已完成/期望产出）。
 * 本模块纯函数、零依赖，便于单元测试。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 任务层目录名（工作区根下）。 */
export const HANDOFF_DIR = '.mcode-handoff';

/** 生成一个可读、可追溯的任务 id。 */
export function newTaskId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `task-${Date.now().toString(36)}-${rand}`;
}

/** 任务目录绝对路径。 */
export function taskDir(root) {
  return join(root, HANDOFF_DIR);
}

/** 上下文文件路径（DSH 写、mcode 读）。 */
export function contextFilePath(dir, taskId) {
  return join(dir, `${taskId}.md`);
}

/** 结果文件路径（mcode 写、DSH 读）。 */
export function resultFilePath(dir, taskId) {
  return join(dir, `${taskId}.result.md`);
}

/**
 * 渲染一份任务上下文文档（写入上下文文件的内容）。
 * @param {{taskId: string, goal: string, constraints?: string[], done?: string[], expected?: string, notes?: string}} p
 */
export function renderContextFile(p) {
  const constraints = (p.constraints ?? []).map((c) => `- ${c}`).join('\n');
  const done = (p.done ?? []).map((d) => `- ${d}`).join('\n');
  return [
    `# Task ${p.taskId}`,
    '',
    '## Goal 目标',
    p.goal,
    '',
    '## Constraints 约束',
    constraints || '- （无）',
    '',
    '## Already done 已完成',
    done || '- （无）',
    '',
    p.expected ? `## Expected output 期望产出\n${p.expected}` : '## Expected output 期望产出\n- （执行后按你认为最有用的形式交付）',
    '',
    p.notes ? `## Notes 备注\n${p.notes}` : '',
    ''
  ].filter((line) => line !== null).join('\n');
}

/**
 * 渲染发给 mcode 的浓缩提示词（经 herdr agent prompt 注入）。
 * @param {string} taskId
 * @param {string} contextFile 上下文文件相对工作区根的路径
 * @param {string} resultFile   结果文件相对工作区根的路径
 */
export function renderPrompt(taskId, contextFile, resultFile) {
  return [
    `Execute task ${taskId} for me.`,
    `1. Read the task file: ${contextFile} (relative to the current working directory).`,
    `2. Complete the Goal subject to the Constraints. You may inspect code, run tests, and edit files as needed.`,
    `3. When finished, write a concise summary of what you did and the deliverables (paths, commands, results) to: ${resultFile}. Reply with the result file path only.`
  ].join('\n');
}

/** 读取结果文档；容错返回 { ok, raw, preview }。 */
export function readResultFile(dir, taskId) {
  const path = resultFilePath(dir, taskId);
  if (!existsSync(path)) return { ok: false, raw: null, preview: '' };
  try {
    const raw = readFileSync(path, 'utf-8');
    return { ok: true, raw, preview: raw.slice(0, 400) };
  } catch (error) {
    return { ok: false, raw: null, preview: String(error) };
  }
}

/** 确保任务目录存在。 */
export function ensureTaskDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
