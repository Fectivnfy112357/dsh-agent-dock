# dsh-agent-dock

在 DSH（DeepSeek Harness）WebUI 一键唤醒 herdr 代管的 coding agent 并自动协同。v1 对接 MiniMax Code（mcode）的 idle / working / blocked 状态检测，依赖 herdr fork 构建（kele98/herdr · feature/MiniMax-detection，Discussion herdrdev/herdr#2884）。

**双格式**：同一包同时是 DSH 静态插件（bundle + client）+ Agent Plugins 1.0（plugin.json + skills/）。

## 功能

- **WebUI 按钮**（会话头部）：一键拉起 headless herdr server（若未运行）→ 在当前 workspace 右侧分裂兄弟 pane → 启动 mcode → 等屏幕检测识别 minimax agent → 命名 `mcode`（幂等：已存在则复用）。
- **状态徽章**：2 秒轮询，显示 idle / working / blocked / done / 离线；悬停显示 pane 与 workspace。
- **DSH 动态工具**：`agent_wake / agent_status / agent_prompt / agent_wait / agent_read / agent_stop`，全自动协同协议见技能 `agent-dock`。

## 安装

```
bash
dsh plugin --profile web add ./dsh-agent-dock   # 或 npm 包名 / git url
```

重启 DSH 后刷新页面，会话头部出现"唤醒 mcode"按钮。

## 配置（可选项，默认零配置可用）

```
yaml
# profile 的 cordis.patch.yml 覆盖示例（config 键小驼峰）
- insert:
    - id: agent-dock
      name: 'dsh-agent-dock'
      config:
        paneName: copilot           # 默认 mcode
        pollIntervalMs: 3000        # 徽章轮询间隔
        delegationTimeoutMs: 900000 # 单次委托超时 15 分钟
        resumeLastSession: false     # true 时 mcode -c 续接
        autoApprove: true            # blocked 白名单自动放行（危险动作仍转人工）
        herdrBin: herdr              # herdr 可执行文件路径
```

## 开发

```
bash
npm install
npm test                   # vitest 单元测试
node scripts/verify.mjs    # 双格式自检
node scripts/e2e.mjs       # 集成测试（真实 herdr + mcode，独立探针 workspace）
```

## 已知边界

- 检测锚定 mcode v0.1.2 屏幕文本，mcode UI 迭代后需同步更新检测规则。
- mcode TUI 用 alternate screen，屏幕回读可能丢已完成输出 → 交付物必须落盘（.mcode-handoff/<task-id>.result.md）。
- 单实例模型（固定 pane 名 mcode），但**归属判定为 paneName + cwd 双重匹配**（lib/owned.js）：
  其它目录手动启动的同名 mcode 不算插件的，DSH 按钮/工具只认工作目录匹配的那个（WebUI 按钮从 ctx.sessions.list
  实时取当前会话 cwd，agent_* 工具建议显式传 cwd）。已归属时点击按钮/agent_wake 为幂等唤醒 + 自动聚焦该 pane。
  （v1.2：修复 client 拿不到会话 cwd → 唤醒到 dsh web 进程目录（C:\Users\32115）的 bug——
  用 ctx.sessions.list.getSnapshot().items[sessionId].cwd 作为按钮 payload。）
- 多实例/多 provider（claude/opencode）为预留扩展（lib/providers.js 注释位）。
