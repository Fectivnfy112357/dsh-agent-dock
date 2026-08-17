---
name: agent-dock
description: >-
  Coordinate with the docked coding agent (v1: MiniMax Code / mcode) hosted in Herdr:
  wake it, delegate complex tasks, read results, handle approval dialogs. Use when Herdr
  is available (herdr fork with MiniMax detection installed), the user asks to use mcode,
  a task is complex enough to delegate (multi-file changes, long autonomous loops, parallel
  subtasks), or the user wants to see / hear the docked agent work. 通过 WebUI 按钮或 agent_*
  工具唤醒 herdr 代管的 mcode 并自动协同推进任务。
whenToUse: 用户请求使用 mcode/唤醒 mcode/让 mcode 干活；或任务复杂到适合委托给并行 agent；或需要 agent_* 工具与 herdr pane 中的 mcode 协同。
---

# agent-dock：与 herdr 代管的 coding agent 协同（v1: mcode）

本技能定义 DSH agent 与 herdr 内 mcode pane 的**协同协议**：何时委托、如何交接上下文、
如何等结果、如何处理权限对话框、如何被打断。配套动态工具 `agent_wake / agent_status /
`agent_prompt / agent_wait / agent_read / agent_stop` 由 dsh-agent-dock 插件注册。

## 0. 前置条件

- 本机已安装 herdr fork（0.8.0 + MiniMax detection，kind 列表含 `minimax`）与 mcode（v0.1.2）。
- 前提检查：`agent_status`。若 `forkOk=false` → 明确告知用户需要 MiniMax detection 构建；
  若 `serverOk=false` → 直接 `agent_wake`（插件会自动拉起 headless herdr server）。
- 不要直接调用 `herdr` CLI——只允许用 `agent_*` 工具（插件后端统一封装，护栏在插件内）。

### 归属规则（v1.1，重要）

插件的 mcode 是**「按名字 + 工作目录归属」**的，不是全局唯一：

- `agent_wake` / 徽章只认「名字 = paneName（默认 mcode）**且 pane 工作目录匹配 cwd**」的 agent；
- 你在其它目录 / workspace 手动开的 mcode **不会**被插件认领，也不会抢走 WebUI 按钮——按钮永远可点；
- 因此在 DSH 侧调用 `agent_*` 工具时，**务必显式传 `cwd` = 当前会话工作目录**（系统提示会给出，
  如 `D:\\programming\\projects\\dsh_worlspace`）——不要依赖服务端默认值（服务端回退链是
  `cfg.mcodeCwd → process.cwd()`，而 process.cwd 是 dsh web 进程的启动目录，**不是**会话工作目录）。
- 已归属的 agent 存在时，点击按钮 / `agent_wake` 是**幂等唤醒 + 自动聚焦该 pane**（`herdr agent focus`）；
  未归属时则新建 pane 并唤醒。

## 1. 触发标准（何时委托给 mcode）

**适合委托**：多文件修改、需要长时自主循环、可独立交付的子任务（写文档/写测试/独立重构/资料整理）、
可与当前主线并行推进的工作（用户同时还在跟 DSH 对话）。
**不委托**：单文件小改、需要与用户反复确认的决策、涉及用户隐私/凭据/支付的操作、10 秒内能完成的事。

## 2. 交接流程（一次委托 = 一个 task-id）
0. 维护持久层共享记忆：工作区根 `AGENTS.md` 是 DSH 与 mcode 的共享记忆（mcode init 原生读取）——项目事实、约束、当前进展写这里；只有本次任务的一次性上下文才用 `.mcode-handoff/`（DESIGN Q14）。
1. `agent_status` 确认 present 且 state 为 idle/done（working 中先 `agent_wait` 等它停下再派活）。
2. 在工作区根目录（mcode 的 cwd，即 DSH 当前工作目录）写任务上下文文件
   `.mcode-handoff/<task-id>.md`，格式：

```markdown
# Task <task-id>
## Goal 目标
<一个清晰的任务目标>
## Constraints 约束
- <约束 1>
## Already done 已完成
- <已完成的调研/现状，避免 mcode 重复劳动>
## Expected output 期望产出
<期望的交付形式：文件路径、测试用例、文档位置等>
```

   <task-id> 建议形如 task-2026xxxx-abcdef（时间戳+随机后缀）。
3. `agent_prompt` 提交浓缩提示词（模板）：

   > Execute task <task-id> for me.
   > 1. Read the task file: .mcode-handoff/<task-id>.md (relative to the current working directory).
   > 2. Complete the Goal subject to the Constraints. You may inspect code, run tests, and edit files as needed.
   > 3. When finished, write a concise summary of what you did and the deliverables (paths, commands, results) to: .mcode-handoff/<task-id>.result.md. Reply with the result file path only.
   即：上下文全量在文件里，提示词保持浓缩（DESIGN Q9）。
4. `agent_prompt --wait`（默认等 idle/done/blocked）阻塞到这次委托进入稳定态。
5. 读结果：先读 `.mcode-handoff/<task-id>.result.md`；如果不存在，用 `agent_read` 看终端实时输出。
   （mcode TUI 用 alternate screen，屏幕回读可能丢已完成输出——**交付物必须落盘**。）
6. 汇总给用户：mcode 做了什么、产出了哪些文件/命令、有没有需要用户后续处理的事项。

## 3. blocked（权限对话框）处理（DESIGN Q8）

`agent_prompt --wait` 或 `agent_wait --until blocked` 命中 blocked 时：

1. `agent_read` 读对话框内容，明确它在请求什么权限。
2. 分类：白名单（文件读写、跑测试、常规命令）→ 视为 auto，用 `agent_prompt` 提交简短确认
   （如 "Proceed / Allow / Yes" 或对话框显示的确认按键文字）后继续 `agent_wait`。
3. 危险类别（删除/卸载/安装依赖/支付/凭据/网络外发/强制 git 操作/提权）→ **停止自动推进**，
   把对话框内容完整贴给用户，等用户拍板；用户同意后 DSH 再替 mcode 提交确认。
4. `agent_status` 的 `autoApprove` 开关由插件配置控制（默认开，仅放行白名单类）。

## 4. 打断与超时
- 用户中途发新消息：先 `agent_stop`（esc → ctrl+c 递进）打断 mcode，`agent_read` 抓当前进度，
  向用户汇报"mcode 已暂停，进度是 X，我可以继续处理你的新需求"，再处理新指令。
- 单次委托默认 15 分钟超时（`delegationTimeoutMs`），超时先 `agent_stop` 再汇报。
- `agent_wait`/`agent_prompt --wait` 可能返回：`agent_blocked`（见 §3）、`agent_prompt_stalled`
  （提交后 5s 内无状态变化，重新提交或检查 pane）、`timeout`。

## 5. 工具契约速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `agent_wake` | 唤醒/确保 mcode 在跑（幂等；已归属则聚焦） | provider, **cwd** |
| `agent_status` | 感知归属存在与状态 | previewLines, cwd |
| `agent_prompt` | 提交任务/指令（可选等待） | text, wait, until, timeoutMs, cwd |
| `agent_wait` | 等状态（idle/working/blocked/done） | until, timeoutMs, cwd |
| `agent_read` | 读终端输出/对话框 | source, lines, cwd |
| `agent_stop` | 打断（esc→ctrl+c） | keys, cwd |

> 所有 `agent_*` 工具都支持 `cwd` 参数；**调用时传当前会话工作目录**（见 §0 归属规则）。
扩展位：本协议按 provider 参数化；新增 claude/opencode 时工具不变，仅 provider 注册扩展
（插件侧 TODO 标记处）。

## 7. WebUI 右侧终端面板（v1.4）

插件在 DSH 右侧 `conversation.details.tool` slot 注册了终端面板（xterm.js），把 mcode 的实时 TUI 渲染到 WebUI：

- 数据源：`herdr agent read <pane> --source recent --format ansi`（完整 VT 序列，含颜色 / 框线 / 光标反显）
- 输入回传：`POST /plugins/dsh-agent-dock/terminal/send` → `herdr pane send-text` 或 `herdr agent send-keys`
- 轮询间隔：服务端配置 `terminalPollMs`（默认 1500ms）
- 触发：唤醒按钮/状态徽章点击后自动 `layout.openDetails()` 打开
- 与 DSH agent 协作时，面板可作为「查看 mcode 在干什么」的可视化旁路

## 6. 已知边界
- 检测锚定 mcode v0.1.2 屏幕文本（如 "◆ Approval needed"、Plan 模式对话框），mcode UI 迭代后
  检测规则需随插件/ fork 更新。
- 屏幕读取可能丢已滚动输出 → 交付物一律要求落盘文件。
- 插件单实例模型（固定 pane 名 mcode），但归属判定为「paneName + cwd」双重匹配——
  其它目录手动启动的同名 mcode 不算插件的，DSH 按钮/工具只认工作目录匹配的那个。
- 多实例并发（worktree 并行）为预留扩展（DESIGN Q10 TODO）。