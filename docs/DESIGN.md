# dsh-agent-dock — 设计文档（DESIGN）

> 状态：已与用户完成 /grilling 全轮决议，方案确认，进入实现。
> 依赖环境：本机 herdr fork（kele98/herdr `feature/MiniMax-detection`，已替换官方版）+ mcode v0.1.2（`C:\Users\32115\.minimax-code\mcode.cmd`）+ DSH profile `web`。

## 1. 背景与动机

用户平时用 herdr（终端 agent 运行时）同时挂多个 coding agent pane，其中主力是 MiniMax Code（mcode）。用户为 herdr 贡献了 mcode 状态检测（fork 分支 `feature/MiniMax-detection`，检出 idle / working / blocked 四类屏幕规则 + 进程识别，含 Windows mcode.cmd shim），官方 PR 走 Discussion #2884 提案。

本插件的动机：把`herdr 能识别 mcode`的能力接入 DSH（DeepSeek Harness web GUI）：
1. WebUI 上一个按钮，一键唤醒 mcode CLI（TUI）；
2. 唤醒后 DSH agent 能`感知`mcode 的存在与状态（idle/working/blocked）；
3. 复杂任务时 DSH agent 主动与 mcode 共享上下文、协同推进任务。

## 2. 可行性探索结论（事实依据）

| 环节 | 依据 |
|---|---|
| WebUI 按钮 | DSH 静态插件可带 client 端（dshmarket 模板）：`dsh.client` + `client.js` 打包 + `ctx.slots.inject` 注册按钮位（42 个 Slot，候选：`conversation.session.header.actions` / `conversation.input.right` / `sidebar.footer.action` 等） |
| 按钮→宿主动作 | client fetch(`/agent-dock/wake`) 调插件后端（dshmarket 模式：`ctx.inject(['webServer','loader'], …)` + `mountMarketRoutes`），后端可 spawn 进程、调 `herdr` CLI |
| 唤醒 mcode | fork herdr 内置 agent kind `minimax`（`herdr agent start --kind minimax` 合法值）；pane 分裂 + `pane run` 跑 `mcode`；屏幕检测自动识别 |
| 感知状态 | `herdr agent get / read / wait --until idle|working|blocked|done|unknown`、`herdr api snapshot` |
| 协同/上下文 | `herdr agent prompt <name> <text> --wait`（原子提交文本+Enter，尊重 bracketed paste）；`agent read --source recent-unwrapped` 回读；mcode 自身支持 `exec`（无 TUI）、`acp`（Agent Client Protocol）、`init`（生成 AGENTS.md） |
| 外部控制 | `herdr` CLI 可从 DSH 侧经 socket 控制运行中的 server（已实测 `herdr status` / `server stop` / headless `herdr server`） |

已知边界：
- mcode TUI 用 alternate screen，已完成输出可能不进 herdr host scrollback → 结果必须要求 mcode `写文件`回传，屏幕读只用于实时状态；
- 检测锚定 mcode v0.1.2 屏幕文本（如 `◆ Approval needed`、Plan 模式对话框），mcode UI 迭代后规则需跟进（用户会维护）。

## 3. 决议记录（/grilling 全轮）

### Q1 协同通道选型 → `A（herdr fork 桥接）+ 预留 C`
- A. herdr fork 桥接：按钮唤醒 mcode 到 herdr pane，DSH 经 `herdr agent prompt/read/wait` 协同。
- B. mcode ACP 直连：`mcode acp` JSON-RPC（v1 不做）。
- C. 混合：herdr 为主 v1，ACP 留到 mcode 开放稳定协议接口时升级。
- 决策：v1 只用 herdr 桥接；ACP 不在范围内。

### Q2 按钮职责边界 → `B（唤醒 + 状态徽章）`
- 未运行：按钮 = 唤醒；（A 纯唤醒、C 加停止/聚焦快捷按钮均否决）
- 运行中：按钮变徽章显示 idle/working/blocked/done/离线。
- v1 不做：停止/聚焦快捷按钮、详情抽屉、通知推送。

### Q3 协同触发策略 → `全自动`
- DSH 自行判断复杂任务 → 打包上下文 → `agent_prompt` 交 mcode → wait/read → 汇总。
- 每次交接在聊天留痕（给了 mcode 什么任务、预期产出）。
- 护栏见 Q8。

### Q4 插件形态与按钮位置 → `双格式 + conversation.session.header.actions`
- 单目录同时是 DSH 静态插件包 + Agent Plugins 1.0 包（dsh-dual-plugin-guide 默认流程）。
- 按钮放会话头部（会话级动作），列表型 Slot 允许多插件共存。

### Q5 herdr 生命周期与 pane 落位 → `A + A'`
- A：插件检测不到 server 时自动后台拉起 headless `herdr server`（凭 socket 驱动）。
- A'：mcode pane 落在`当前 workspace / 当前 tab`分裂的兄弟 pane（`--no-focus` 不抢焦点）。
- C'（每任务新 workspace/worktree 隔离）留给以后并行任务。

### Q6 mcode 启动模式与 cwd → `C + A'`
- C：默认全新会话（`mcode`），配置 `resumeLastSession` 为 true 时 `mcode -c`。
- A'：cwd = DSH 当前工作目录（同一代码库协同）。

### Q7 感知形态 → `2s 轮询 + 6 工具`
- 徽章轮询 2s（`pollIntervalMs` 可配）。
- 动态工具：`agent_wake / agent_status / agent_prompt / agent_wait / agent_read / agent_stop`（面向 provider，不写死 mcode）。

### Q8 委托护栏 → `白名单自动放行 + 危险转人工`
- blocked 时读对话框内容（`agent_read`）：白名单（文件读写/测试/常规命令）自动回车确认；危险动作（删文件、装依赖、pay、网络外发）停止自动推进并转人工。
- 单次委托超时默认 15 分钟（`delegationTimeoutMs` 可配）。
- 用户中途发新消息 → 先 `agent_stop` 打断 mcode + 汇报进度，再响应新指令。

### Q9 上下文打包与结果回传 → `A（持久上下文文件 + 提炼提示词）`
- DSH 写任务上下文文件 → `agent_prompt` 发浓缩提示词 → mcode 结果写回文件 → DSH 读文件 + `agent_read` 补实时状态。
- 每次委托带 task-id，可追溯。

### Q10 mcode 实例策略 → `C（单实例 v1 + 扩展口）`
- v1：固定 pane 名 `mcode`（唯一），跨任务复用；幂等唤醒（已存在则聚焦不重开）。
- 扩展：worktree 并行多实例留给以后。

### Q11 配置面 → `按推荐清单`
`herdrBin`（自动探测）、`mcodeCwd`（默认 DSH 当前工作目录）、`paneName`（默认 `mcode`，须匹配 `[a-z][a-z0-9_-]{0,31}`）、`pollIntervalMs`（2000）、`delegationTimeoutMs`（900000）、`resumeLastSession`（false）、`autoApprove`（true；类别：文件读写/测试/常规命令）。
无配置面板 UI，改 `config.toml`。

### Q12 按钮/徽章交互边界 → `按推荐`
未运行=唤醒（绿/灰）；运行中=徽章（idle 灰 / working 琥珀 / blocked 红 / done 绿 / 离线），悬停提示 pane 名与最近状态；点击不做第二行为。
v1 不做：停止/聚焦快捷按钮、详情抽屉、通知推送（stop 由 `agent_stop` 工具兜底）。

### Q13 包名与扩展位 → `dsh-agent-dock`
- 概念是`通用 agent 停靠台`，v1 只注册 `minimax` provider。
- `lib/providers.js` 内置 registry + `// TODO: <kind>` 扩展位（`claude`、`opencode`、多实例并发）。
- 工具统一 `agent_*` 命名，扩展时只加 provider。

### Q14 上下文共享地基 → `两层结构`
- 持久层：工作区根 `AGENTS.md`（DSH 与 mcode 共享记忆，mcode init 原生支持）。
- 任务层：`.mcode-handoff/<task-id>.md`（目标/约束/已完成/期望产出）+ `<task-id>.result.md`（结果回传）。

## 4. 架构总览

```
WebUI (conversation.session.header.actions)
   │ 按钮/徽章（client.js: slots.inject + React.createElement + fetch）
   │ fetch("/agent-dock/wake" | "/agent-dock/status")
   ▼
lib/index.js (Cordis 插件 apply(ctx))
   ├─ ctx.inject(['webServer']) → mountRoutes（dshmarket 模式）
   ├─ 轮询器：每 pollIntervalMs 调 herdr agent get → badge 状态缓存
   ├─ harness.defineTool ×6（agent_*）→ DSH agent 全自动协同入口
   └─ herdr.js：CLI 封装（ensureServer / pane split / pane run / agent get|prompt|read|wait|send-keys）
        │ child_process spawn，走 socket，与用户 herdr TUI 共享同一 server 会话
        ▼
herdr fork server（无则 headless 拉起）→ mcode pane（screen 检测 → idle/working/blocked）
```

核心链路：
- 唤醒：探测 socket → 无则起 headless `herdr server` → 当前 workspace/tab 右侧分裂（`--no-focus`，cwd=mcodeCwd）→ `pane run` 执行 `mcode`（或 `mcode -c`）→ herdr 自动识别 minimax agent → 命名 `mcode`。幂等：已存在只聚焦。
- 感知：徽章 2s 轮询 `herdr agent get <paneName>`；工具 `agent_status` 同源。
- 协同：判复杂 → 写 `.mcode-handoff/<task-id>.md` → `agent_prompt mcode "读任务文件 X，执行，结果写回 X.result.md" --wait` → 循环 wait/read → blocked 处理（白名单/转人工）→ 超时/打断。

fork 探测：`herdr agent start --help` 的 possible values 含 `minimax` 才可用；否则徽章报错`需要 MiniMax detection 构建`。

## 5. 目录结构（双格式）

```
dsh-agent-dock/
├── package.json          # dsh.bundle.patch + dsh.client{inject,platform:"web"} + exports ./client + peerDependencies:@deepseek-ai/cordis
├── cordis.patch.yml      # - insert: {id: agent-dock, name: dsh-agent-dock}
├── plugin.json           # Agent Plugins 1.0（$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json）
├── docs/
│   └── DESIGN.md         # 本文档
├── lib/
│   ├── index.js          # apply(ctx)：routes、轮询器、6 个动态工具、effect 清理
│   ├── herdr.js          # CLI 封装（含 fork 探测、pane/agent 参数构建）
│   ├── providers.js      # registry：minimax v1 + claude/opencode/multi TODO 注释
│   ├── handoff.js        # 任务上下文/结果文件读写、task-id 生成
│   └── types.js
├── src/client/           # tsdown → client/client.js（normalize-client-banner，dshmarket 模式）
├── client/client.js      # 产物：slots.inject("conversation.session.header.actions", …)
├── skills/agent-dock/
│   └── SKILL.md          # 协同协议唯一内容源（frontmatter name+description）
├── scripts/
│   └── verify.mjs        # 自检：关键文件 + 身份一致性 + 相对链接
├── tests/                # vitest unit（seam 见 §7）
└── README.md / README.zh.md
```

## 6. 上下文协议（SKILL.md 内容纲要）

SKILL.md 是双格式唯一内容源，DSH agent 全自动协同的操作规程：
1. `触发标准`：多文件修改、长自动循环、独立可交付子任务、可并行推进的主流程 → 委托 mcode；单文件小改、需与用户强交互 → 自己做。
2. `交接流程`：`agent_status` 确认空闲 → 写 `.mcode-handoff/<task-id>.md`{目标/约束/已完成/期望产出/验收} → `agent_prompt` 附提示词模板 → `agent_wait`（默认 idle|done|blocked，超时 delegationTimeoutMs）→ `agent_read` 回读 → 读 `<task-id>.result.md` → 汇总。
3. `blocked 处理`：`agent_read` 读对话框 → 白名单自动 `agent_prompt` 确认 → 危险转人工（停止自动推进，向用户汇报）。
4. `打断`：用户新消息 → `agent_stop`（esc → ctrl+c 递进）→ 汇进度。
5. `工具用法`：`agent_*` 工具契约、错误码（如 agent_prompt_stalled、timeout）。

## 7. 测试 seams（TDD 预确认）

- `herdr.js`：CLI 参数/命令构建（无副作用纯函数：split/pane-run/agent-prompt/wait 的参数序列）、fork 探测逻辑、输出 JSON 解析。
- `providers.js`：registry 形态、minimax provider 的 kind/启动命令/白名单类别；状态归类（idle/working/blocked/done/unknown 映射）。
- `handoff.js`：task-id 生成、上下文文档渲染、结果文档解析。
- `index.js 工具面`：agent_* 工具的入参校验（mock spawn）。
- 集成验证（非 unit）：以真实 headless herdr（测试 session）跑 唤醒→检测→read→stop 链路；curl /agent-dock/status 冒烟。
- 不测：mcode UI 自身、herdr 内部实现。

## 8. 配置项（config.toml 键）

| 键 | 默认 | 说明 |
|---|---|---|
| `herdrBin` | 自动探测 | herdr 可执行文件路径；探测失败或非 fork 版 → 界面报错 |
| `mcodeCwd` | DSH 当前工作目录 | mcode pane 工作目录 |
| `paneName` | `mcode` | 协同 pane 名（`[a-z][a-z0-9_-]{0,31}`） |
| `pollIntervalMs` | 2000 | 徽章轮询间隔 |
| `delegationTimeoutMs` | 900000 | 单次委托超时 |
| `resumeLastSession` | false | `mcode -c` 续接上次会话 |
| `autoApprove` | true | 白名单自动放行（文件读写/测试/常规命令） |

## 9. v1 明确不做（留扩展位）

- mcode ACP 通道（Q1-C 预留）
- UI 停止/聚焦快捷按钮、详情抽屉、通知推送（Q12）
- 多 mcode 实例并行（Q10 worktree 方案预留）
- mcode 插件分发、配置面板 UI

## 10. 安装 / 验证 / 回滚

- 开发位置：`D:\programming\projects\dsh_worlspace\dsh-agent-dock`（独立 git repo，main 分支）。
- 检查：`npm run check`（tsc typecheck server + tsdown 构建 client + vitest + `verify.mjs`）。
- 安装：`dsh plugin --profile web add ./dsh-agent-dock` → 重启 web GUI（或按提示刷新）。
- 验证：
  1. 会话头部出现`唤醒 mcode`按钮（刷新页面）；
  2. 点击 → headless server 拉起 → pane 分出 → mcode TUI 起来 → 徽章变状态；
  3. E2E：`agent_read` 读到输出、`agent_wait blocked` 识别权限对话框、真实小任务全自动闭环（工作区小任务实测）；
  4. 非 fork herdr 场景错误提示。
- 回滚：`dsh plugin --profile web remove dsh-agent-dock`；herdr fork 与 mcode 安装不受影响。

## 11. 与 herdr 官方 skill 的职责边界

- DSH 不跑在 herdr pane 内（无 `HERDR_ENV=1`），不走官方 skill 的`仅 pane 内`路径。
- 插件在 server 侧封装 herdr CLI（socket 驱动）；DSH agent 只允许用 `agent_*` 工具，不直接调 `herdr` CLI（避免绕过护栏）。
