/**
 * dsh-agent-dock — WebUI 客户端（单文件，__ModuleLoader__ 格式，免构建）。
 * 依赖：react（module table 提供）。
 * 设计（v0.4.0 终端面板重挂载）：
 *   - 修复历史：v0.2.1 把终端面板挂在 conversation.details.tool，结果 DetailsPanel
 *     只在选中 tool call 时渲染该 slot，唤醒按钮只打开了空壳面板；
 *     v0.3.0 改用 React Portal 在 body 下挂了一个 fixed 浮层 —— 渲染问题解决了，但
 *     浮层是"嵌入式"外观（自配色、自字号、自 box-shadow），与 DSH 详情列完全脱节，
 *     用户反馈突兀。
 *   - v0.4.0 走正路：DSH 的 AppFrame 自身在右侧渲染一个 details 列（容器自带 DSH
 *     边框、背景、拖拽手柄、让步、响应式折叠），并把 details 列的内容交给
 *     'details' slot（single, scope=session；当前默认由 ui-conversation 的
 *     DetailsPanel 以 priority 0 占用）。插件注册到 'details' slot，priority: -10
 *     覆盖 DetailsPanel，让自己成为整列渲染器；终端面板只画内部布局（标题行 + xterm
 *     + 输入栏 + 键按钮），外框/边框/配色完全继承 DSH 主题（用 --dsw-* CSS 变量）。
 *   - 唤醒按钮点击 → ctx.layout.openDetails() 展开右侧详情列（DSH 原生过渡动画）。
 *   - 关闭按钮点击 → ctx.layout.closeDetails() 收起详情列。
 *   - 状态徽章：运行中 + 列开着 → 点关闭；运行中 + 列关着 → 点展开（幂等 wake）。
 * 交互：
 *   - 轮询 /agent-dock/status?cwd=...，间隔取服务端配置 pollIntervalMs（默认 2s）；
 *     终端文本轮询 /agent-dock/terminal/text，间隔取 terminalPollMs（默认 1500ms）。
 *   - cwd 取自当前会话（v1.3：ctx.sessions.list.getSnapshot().byId[sessionId].cwd）。
 * 扩展位：按钮/徽章与 provider 无关；新增 provider 时只需扩展状态映射文案。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-dock",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    var NS = "dsh-agent-dock";
    // 由 apply(ctx) 在 host 调用时填入；factory 阶段 ctx 尚未构造，无法直接捕获到闭包。
    var _ctxRef = { current: null };
    var STATUS_META = {
      idle:    { label: "idle", color: "#9aa0a6" },
      working: { label: "working", color: "#e8a33d" },
      blocked: { label: "blocked", color: "#e5584b" },
      done:    { label: "done", color: "#57ab5a" },
      unknown: { label: "unknown", color: "#9aa0a6" },
    };
    var zh = {
      wake: "唤醒 mcode",
      waking: "唤醒中…",
      offline: "herdr 离线",
      noFork: "需要 fork 构建",
      btnTitle: "一键唤醒 herdr 代管的 MiniMax Code（mcode）",
      panelTitle: "mcode 终端",
      panelEmpty: "未检测到归属的 mcode，请先在头部点击「唤醒 mcode」",
      panelLoading: "正在加载终端…",
      panelSend: "发送",
      panelCmdPlaceholder: "向 mcode 发送文本（Enter 提交，pane send-text）",
      panelClose: "关闭终端列",
    };
    var en = {
      wake: "Wake mcode",
      waking: "Waking…",
      offline: "herdr offline",
      noFork: "fork build required",
      btnTitle: "Wake Herdr-hosted MiniMax Code (mcode)",
      panelTitle: "mcode Terminal",
      panelEmpty: "No owned mcode in this workspace. Click “Wake mcode” first.",
      panelLoading: "Loading terminal…",
      panelSend: "Send",
      panelCmdPlaceholder: "Send text to mcode (Enter to submit, pane send-text)",
      panelClose: "Close terminal column",
    };

    // ===== xterm.js / FitAddon 动态加载（CDN） =====
    var XTERM_VERSION = "5.3.0";
    var FIT_VERSION = "0.8.0";
    var XTERM_CDNS = [
      { js: "https://cdn.jsdelivr.net/npm/xterm@" + XTERM_VERSION + "/lib/xterm.js", css: "https://cdn.jsdelivr.net/npm/xterm@" + XTERM_VERSION + "/css/xterm.css" },
      { js: "https://cdn.jsdelivr.net/npm/xterm-addon-fit@" + FIT_VERSION + "/lib/xterm-addon-fit.js", css: null },
    ];
    var _xtermReady = null;
    function loadScript(url) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = url;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error("failed to load " + url)); };
        document.head.appendChild(s);
      });
    }
    function ensureXterm() {
      if (_xtermReady) return _xtermReady;
      _xtermReady = (async function () {
        // 1) CSS
        for (var i = 0; i < XTERM_CDNS.length; i++) {
          var c = XTERM_CDNS[i].css;
          if (!c) continue;
          if (!document.querySelector('link[href="' + c + '"]')) {
            var link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = c;
            document.head.appendChild(link);
          }
        }
        // 2) JS（按顺序；xterm 主体先，addon 后）
        var tasks = [];
        for (var j = 0; j < XTERM_CDNS.length; j++) {
          var entry = XTERM_CDNS[j];
          var already = false;
          for (var k = 0; k < document.scripts.length; k++) {
            if (document.scripts[k].src === entry.js) { already = true; break; }
          }
          if (!already) tasks.push(loadScript(entry.js).catch(function () { return loadScript(entry.js.replace("cdn.jsdelivr.net", "unpkg.com")); }));
        }
        await Promise.all(tasks);
        if (typeof window.Terminal !== "function") throw new Error("xterm.js did not expose window.Terminal");
        if (typeof window.FitAddon !== "object" || typeof window.FitAddon.FitAddon !== "function") throw new Error("xterm-addon-fit did not expose window.FitAddon.FitAddon");
        return { Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon };
      })().catch(function (err) {
        _xtermReady = null;
        throw err;
      });
      return _xtermReady;
    }

    /**
     * 从 sessions service 取当前 sessionId 对应的 cwd（修复唤醒到错误目录的 bug）。
     * 正确接口是 ctx.sessions.list.getSnapshot() → { ids, byId, ... }，cwd 在
     * byId[sessionId].cwd（快照没有 items 字段；v1.2 误读 snap.items 导致 cwd 恒为 null）。
     * subscribe 触发 setState，让 cwd 变化时组件重渲染。
     */
    function useSessionCwd(sessionId) {
      var useState = react.useState;
      var useEffect = react.useEffect;
      var ctx = _ctxRef.current;
      var listApi = ctx && ctx.sessions && ctx.sessions.list;
      function readCwd() {
        if (!listApi || typeof listApi.getSnapshot !== 'function') return null;
        try {
          var snap = listApi.getSnapshot();
          var byId = (snap && snap.byId) || null;
          var entry = byId ? byId[sessionId] : null;
          if (entry && entry.cwd) return entry.cwd;
          if (byId) {
            for (var k in byId) {
              var it = byId[k];
              if (it && (it.id === sessionId || it.sessionId === sessionId)) return it.cwd || null;
            }
          }
        } catch (e) { /* swallow */ }
        return null;
      }
      var pair = useState(readCwd());
      var cwd = pair[0];
      var setCwd = pair[1];
      useEffect(function () {
        var liveList = (_ctxRef.current && _ctxRef.current.sessions && _ctxRef.current.sessions.list) || listApi;
        if (!liveList || typeof liveList.subscribe !== 'function' || !sessionId) return;
        var unsub = liveList.subscribe(function () { setCwd(readCwd()); });
        setCwd(readCwd());
        return unsub;
      }, [sessionId]);
      return cwd;
    }

    /**
     * 异步加载 xterm 的 hook；返回 { ready, error, term }。
     */
    function useXterm() {
      var useState = react.useState;
      var useEffect = react.useEffect;
      var st = useState({ ready: false, error: null, term: null });
      var ready = st[0];
      var setReady = st[1];
      useEffect(function () {
        var alive = true;
        ensureXterm().then(function (mods) {
          if (!alive) return;
          setReady({ ready: true, error: null, term: mods });
        }).catch(function (err) {
          if (!alive) return;
          setReady({ ready: false, error: String(err && err.message || err), term: null });
        });
        return function () { alive = false; };
      }, []);
      return ready;
    }

    /**
     * 读 DSH 主题背景：终端背景色应与 DSH 详情列内里近似但不刺眼。
     * body 上挂的 --dsw-alias-* alias tokens 在 detailsCol 内继承，理论上直接
     * CSS 变量取值最稳；这里走 document.body 取计算值，保证与主题呈现器一致。
     */
    function readThemeColors() {
      var body = (typeof document !== "undefined") ? document.body : null;
      if (!body) return { bg: "#0e0e10", fg: "#e6e6e6", isDark: true };
      var cs = window.getComputedStyle(body);
      var bg = cs.getPropertyValue("--dsw-alias-bg-base").trim() || cs.backgroundColor || "#0e0e10";
      var fg = cs.getPropertyValue("--dsw-alias-text-l1").trim() || "#e6e6e6";
      var isDark = body.getAttribute("data-ds-dark-theme") !== null && body.getAttribute("data-ds-dark-theme") !== "false";
      if (!bg || bg === "transparent") bg = isDark ? "#15171a" : "#ffffff";
      if (!fg) fg = isDark ? "#e6e6e6" : "#1f2328";
      return { bg: bg, fg: fg, isDark: isDark };
    }

    /**
     * 终端面板渲染器：注册到 'details' slot（v0.4.0）。
     * - 由 DSH AppFrame 渲染在右侧 detailsCol 容器内（DSH 自带左边框、配色、拖拽手柄）。
     * - 本组件只负责内部：标题行 + xterm 容器 + 输入栏 + 键按钮。
     * - 外框/边框/背景都从 DSH CSS 变量（--dsw-alias-*）继承，不另起 fixed/portal。
     * - closeDetails 由 'details' slot 的 inject 钩子提供（ctx.layout.closeDetails()）。
     */
    function TerminalPanelForDetails(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var closeDetails = props.closeDetails;
      try {
        return TerminalPanelInner(props);
      } catch (err) {
        return react.createElement("div", {
          style: {
            padding: 12, color: "#e5584b", fontFamily: "ui-monospace, monospace",
            fontSize: 12, whiteSpace: "pre-wrap",
            background: "var(--dsw-alias-bg-base, #0e0e10)",
            height: "100%", boxSizing: "border-box"
          }
        }, "dsh-agent-dock TerminalPanel render error:\n\n" + String(err && err.stack || err) + "\n\nsessionId=" + sessionId);
      }
    }
    function TerminalPanelInner(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var closeDetails = props.closeDetails;
      var sessionCwd = useSessionCwd(sessionId);
      var cwd = sessionCwd;
      var xterm = useXterm();
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var useCallback = react.useCallback;
      // v0.4.16: 加 serverOk / forkOk 字段，状态区要显示 herdr 连接状态
      var statusSt = useState({ mine: null, loading: true, serverOk: false, forkOk: false });
      var status = statusSt[0];
      var setStatus = statusSt[1];
      var themeSt = useState(readThemeColors());
      var theme = themeSt[0];
      var setTheme = themeSt[1];
      var containerRef = useRef(null);
      var termRef = useRef(null);
      var fitRef = useRef(null);

      // v0.4.16: stateStartRef 跟踪 mcode 状态开始时间（stateSeq 变化时重置）
      var stateStartRef = useRef({ seq: null, at: Date.now() });

      // 拉 status 拿 mine.cwd / terminalPollMs / stateSeq（v0.4.16）
      useEffect(function () {
        var alive = true;
        function tick() {
          var url = "/agent-dock/status" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : "");
          fetch(url, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (!alive) return;
              var next = { mine: body.mine || null, loading: false, serverOk: !!body.serverOk, forkOk: !!body.forkOk };
              // v0.4.16: 检测 stateSeq 变化 → 重置状态开始时间
              var seq = next.mine && next.mine.stateSeq;
              if (seq !== null && seq !== stateStartRef.current.seq) {
                stateStartRef.current = { seq: seq, at: Date.now() };
              }
              setStatus(next);
            })
            .catch(function () { if (alive) setStatus({ mine: null, loading: false, serverOk: false, forkOk: false }); });
        }
        tick();
        return function () { alive = false; };
      }, [cwd]);

      // 主题跟随：监听 body 的 data-ds-dark-theme / style 变化。
      useEffect(function () {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        var alive = true;
        var mo = new MutationObserver(function () {
          if (!alive) return;
          setTheme(readThemeColors());
        });
        mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "style"] });
        return function () { alive = false; mo.disconnect(); };
      }, []);

      var cfgPoll = (status.mine && status.mine.terminalPollMs) || 1500;

      // 拉终端文本
      useEffect(function () {
        if (!xterm.ready || !status.mine || !cwd) return;
        var alive = true;
        var timer = null;
        var pending = false;
        var lastText = null;
        function poll() {
          if (!alive || pending) { timer = setTimeout(poll, cfgPoll); return; }
          pending = true;
          fetch("/agent-dock/terminal/text", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: cwd, lines: 80, source: "recent", format: "ansi" })
          })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (!alive) return;
              // v0.4.4 修：termRef 缺失时不缓存 lastText。xterm init 时机 bug（Fix 1 修）期间
              // termRef.current 可能是 null，若仍把 body.text 写进 lastText，等 termRef 就绪后
              // body.text === lastText → textChanged=false → 永远不再进入 write 分支。
              // 修复：termRef.current 提升为主条件的一部分；lastText 仅在实际 write 后才赋值。
              if (body && body.ok && typeof body.text === "string" && body.text !== lastText && termRef.current) {
                termRef.current.reset();
                termRef.current.write(body.text);
                lastText = body.text;
                // v0.4.12: 删除 rowsRef 自适应逻辑（fit.fit() 在 ResizeObserver/window resize
                // 已处理 cols+rows 同步；poll 只负责内容写入）
              }
            })
            .catch(function () { /* 静默：保留旧画面 */ })
            .then(function () {
              pending = false;
              if (alive) timer = setTimeout(poll, cfgPoll);
            });
        }
        timer = setTimeout(poll, cfgPoll);
        return function () { alive = false; if (timer) clearTimeout(timer); };
      }, [xterm.ready, status.mine, cwd, cfgPoll]);

      // 初始化 xterm（v0.4.5 硬编码 GitHub Dark palette + 黑底，与 DSH 主题解耦）
      useEffect(function () {
        if (!xterm.ready) return;
        // v0.4.4 修：xterm init 时机 bug。body 渲染为 containerRef div 的前提是
        // cwd && status.mine && xterm.ready 三个都为真，但 xterm.ready 异步加载通常比
        // status fetch 先完成——xterm.ready=true 触发本 useEffect 时 status.mine 还是 null，
        // body 走 renderEmpty 分支、containerRef div 不挂载，containerRef.current 仍是 null。
        // 早返回后 status.mine 回来让 body 切到 containerRef div，但 useEffect 依赖 [xterm.ready]
        // 没变（true→true），不重跑，term 永远不创建，termRef.current 永远是 null。
        // 修复：依赖保持 [xterm.ready]，但 init 逻辑挪进 attempt() 用 raf 轮询等到
        // containerRef.current 挂载后再创建 term。term/fit/ro/onResize 提到闭包外便于
        // cleanup 释放；attempt() 内部幂等（termRef.current 非空直接 return）。
        var cancelled = false;
        var raf = null;
        var term = null;
        var fit = null;
        var ro = null;
        var onResize = null;
        function attempt() {
          if (cancelled) return;
          if (!containerRef.current) { raf = requestAnimationFrame(attempt); return; }
          if (termRef.current) return;
          var mods = xterm.term;
          term = new mods.Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
            // v0.4.15：fontSize 14→8 + lineHeight 1.15→1.0
            // 根因：mcode pane viewport_cols = 94（herdr workspace 宽度），xterm.js
            // 字符宽度最小值 ≈ fontSize × 0.6。fontSize 14 → chars.width ≈ 8.4px，
            // 94 × 8.4 = 790px 远超 details column ~370px，xterm 不会强制缩小字符，
            // 多余空间留空（用户截图的'左侧稀疏+右侧大片空白'）。
            // fontSize 8 → chars.width ≈ 4.8px，94 × 4.8 = 451px 接近 details column，
            // 字符小但 94 cols 完整对齐显示。配合 overflow-x: auto 万一仍稍大
            // 也能水平滚动看完整内容。
            fontSize: 8,
            fontWeight: 400,
            fontWeightBold: 700,
            lineHeight: 1.0,
            // v0.4.5：硬编码终端深色风格（GitHub Dark palette），不再跟随 DSH 主题。
            // 真正的终端就该永远黑底亮字——DSH 切浅/深主题时面板内部一致，
            // mcode 自己输出的 ANSI 灰色 / 浅蓝 / 浅黄等在亮 1-2 阶的 palette 下更清晰。
            theme: {
              background: "#0d1117",
              foreground: "#e6edf3",
              cursor: "#e6edf3",
              cursorAccent: "#0d1117",
              selectionBackground: "rgba(180,180,200,0.30)",
              black: "#1f2328",
              red: "#ff7b72",
              green: "#7ee787",
              yellow: "#e3b341",
              blue: "#79c0ff",
              magenta: "#d2a8ff",
              cyan: "#56d4dd",
              white: "#e6edf3",
              brightBlack: "#8b949e",
              brightRed: "#ffa198",
              brightGreen: "#a5d6a7",
              brightYellow: "#f0c674",
              brightBlue: "#9ecbff",
              brightMagenta: "#e0b8ff",
              brightCyan: "#80deea",
              brightWhite: "#f0f6fc"
            },
            convertEol: true,
            scrollback: 4000,
            disableStdin: false
          });
          fit = new mods.FitAddon();
          term.loadAddon(fit);
          term.open(containerRef.current);
          // v0.4.17：回滚 v0.4.14 viewportCols 强制 max —— 那是字符挤压的真正根因。
          // xterm 网格按 details column 宽度算 cols（fitAddon 自动），字符宽度
          // 自适应。字符位置不再严格跟 mcode pane viewport_cols 对齐（因为
          // herdr workspace viewport_cols=94 远大于 details column 宽度），但字符
          // 显示正常，不再被 xterm.js 强制按 viewport_cols 渲染导致 94-58=36 个
          // 字符垂直堆叠（每个字符一行竖向挤压）。
          try { fit.fit(); } catch (_) {}
          // v0.4.3 修：DSH details column 展开动画第一帧 containerRef.current.clientWidth
          // ≈0，fitAddon 算出 cols=1 后 term 网格被定死在 1×N（每个字符单独一行）；
          // window.resize 不会冒泡 details 列内部尺寸变化，所以单纯依赖 window.resize
          // 无法在 details 列打开或拖拽 handle 改宽时重新 fit。
          // ResizeObserver 在 observe 后异步触发，覆盖展开动画第一帧 / 拖拽 handle /
          // 窗口 resize 全链路的容器尺寸变化，统一重新 fit。
          // v0.4.17: ResizeObserver/window resize 用 fit.fit()（按容器宽度）
          ro = new ResizeObserver(function () { try { fit.fit(); } catch (_) {} });
          ro.observe(containerRef.current);
          termRef.current = term;
          fitRef.current = fit;
          onResize = function () { try { fit.fit(); } catch (_) {} };
          window.addEventListener("resize", onResize);
          // 输入转发：term.onData → POST /terminal/send
          term.onData(function (data) {
            if (!cwd) return;
            fetch("/agent-dock/terminal/send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ cwd: cwd, text: data })
            }).catch(function () {});
          });
        }
        attempt();
        return function () {
          cancelled = true;
          if (raf) cancelAnimationFrame(raf);
          if (ro) ro.disconnect();
          if (onResize) window.removeEventListener("resize", onResize);
          if (term) { try { term.dispose(); } catch (_) {} }
          termRef.current = null;
          fitRef.current = null;
        };
      }, [xterm.ready]);

      // v0.4.5：xterm 主题已硬编码（GitHub Dark palette），不再跟随 DSH 主题动态更新——
      // 终端面板内部保持永远黑底亮字，与 DSH 浅/深主题切换解耦。

      // v0.4.9：删除 sendText / sendKeys / inputRow / keyRow。用户要求'底部的 bar 也全部去掉'——
      // mcode TUI 自带 `>` prompt + 键盘输入，插件的输入栏 + 键按钮是冗余 UI；
      // 整个 details column 现在只剩 xterm 容器 + 右上角 floating ×。
      // xterm 自身通过 term.onData 把按键转发到 mcode（init useEffect 内已有），用户键入直接进 mcode。

      // v0.4.8：删除整块 headerBar（标题 + 诊断行 + × 按钮），让黑色 xterm 顶到顶部。
      // 用户反馈浅灰色 header 与黑色终端不协调，要求'上边这块浅灰色内容全部移除'。
      // × 关闭功能改为 floating 按钮 absolute 定位到右上角，半透明深色背景融入终端风格；
      // DSH details column 没有显式 × 关闭按钮（只有 drag handle），保留 floating × 避免用户只能拖拽关闭。
      var floatingClose = (typeof closeDetails === "function") ? react.createElement("button", {
        onClick: function () { closeDetails(); },
        title: t("panelClose"),
        "aria-label": t("panelClose"),
        style: {
          position: "absolute", top: 6, right: 6, zIndex: 10,
          width: 22, height: 22,
          background: "rgba(13, 17, 23, 0.65)",
          border: "1px solid rgba(230, 237, 243, 0.25)",
          borderRadius: 4,
          color: "#e6edf3",
          padding: 0, cursor: "pointer",
          fontSize: 14, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace)"
        }
      }, "×") : null;

      // v0.4.9：inputRow 和 keyRow 已删除（注释见上）

      // v0.4.16：状态区——mcode pane info + 状态机 + 计时 + herdr 连接状态
      // 复用 status fetch（每 2s）+ 状态开始时间记录
      var renderStatusPanel = function () {
        var mine = status.mine || null;
        var stateLabel = (mine && mine.state) || "unknown";
        var stateColor = stateLabel === "working" ? "#e3b341"
          : stateLabel === "blocked" ? "#e5584b"
          : stateLabel === "done" ? "#7ee787"
          : "#9aa0a6";  // idle/unknown
        // 状态已持续多久（v0.4.16）
        var elapsedSec = Math.floor((Date.now() - stateStartRef.current.at) / 1000);
        var elapsedStr = elapsedSec < 60 ? (elapsedSec + "s")
          : Math.floor(elapsedSec / 60) + "m" + (elapsedSec % 60) + "s";

        var paneInfo = mine ? [
          ["pane", mine.pane || "—"],
          ["viewport", (mine.viewportCols || "?") + "×" + (mine.viewportRows || "?")],
          ["cwd", mine.cwd || "—"],
          ["workspace", mine.workspace || "—"]
        ] : [["pane", "—"], ["viewport", "—"], ["cwd", "—"], ["workspace", "—"]];

        var connectionInfo = [
          ["server", status.serverOk ? "ok" : "down"],
          ["fork", status.forkOk ? "ok" : "no"],
          ["owned", mine ? "yes" : "no"]
        ];

        function kv(label, value) {
          return react.createElement("div", {
            style: { display: "flex", gap: 6, fontFamily: "ui-monospace, Consolas, monospace" }
          },
            react.createElement("span", { style: { color: "#7f858c", minWidth: 64 } }, label),
            react.createElement("span", { style: { color: "#e6edf3", wordBreak: "break-all", overflow: "hidden", textOverflow: "ellipsis" } }, value)
          );
        }

        function group(title, rows) {
          return react.createElement("div", { style: { marginBottom: 8 } },
            react.createElement("div", { style: { color: "#9aa0a6", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 } }, title),
            react.createElement("div", null, rows.map(function (r) { return kv(r[0], r[1]); }))
          );
        }

        return react.createElement("div", {
          "data-dsh-agent-dock": "status-panel",
          style: {
            flex: "0 0 auto",
            padding: "8px 10px",
            borderTop: "1px solid rgba(230, 237, 243, 0.12)",
            background: "rgba(13, 17, 23, 0.7)",
            color: "#e6edf3",
            fontSize: 11,
            fontFamily: "ui-monospace, Consolas, monospace",
            overflowX: "auto"
          }
        },
          // 状态机+计时
          react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
            react.createElement("span", { style: {
              display: "inline-block", width: 8, height: 8, borderRadius: "50%",
              background: stateColor, boxShadow: "0 0 6px " + stateColor
            } }),
            react.createElement("span", { style: { fontWeight: 500 } }, stateLabel),
            react.createElement("span", { style: { color: "#7f858c" } }, elapsedStr)
          ),
          group("mcode pane", paneInfo),
          group("herdr", connectionInfo)
        );
      };

      var renderEmpty = function () {
        return react.createElement("div", {
          style: {
            padding: 16,
            color: "var(--dsw-alias-text-l3, #9aa0a6)",
            fontSize: 13
          }
        }, t("panelEmpty"));
      };
      var renderLoading = function () {
        return react.createElement("div", {
          style: {
            padding: 16,
            color: "var(--dsw-alias-text-l3, #9aa0a6)",
            fontSize: 13
          }
        }, t("panelLoading"));
      };
      var renderError = function () {
        return react.createElement("div", {
          style: {
            padding: 16,
            color: "#e5584b",
            fontSize: 12, fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap"
          }
        }, "xterm.js load failed: " + xterm.error + "\n\n请检查网络（CDN：cdn.jsdelivr.net / unpkg.com），或在内网部署时把 xterm.js 与 xterm-addon-fit 安装到本地 module table。");
      };

      var body;
      if (!cwd) body = renderLoading();
      else if (!status.mine) body = renderEmpty();
      else if (!xterm.ready && !xterm.error) body = renderLoading();
      else if (xterm.error) body = renderError();
      else body = react.createElement("div", {
        ref: containerRef,
        // v0.4.16: minHeight 216px (= mcode pane viewport_rows 27 × fontSize 8) — 保证 mcode
        // 内容不被挤压变形。flex: "1 1 216px" 让 xterm 至少 216px + 按 details column 剩余空间增长。
        style: {
          flex: "1 1 216px", padding: "0 6px", background: "#0d1117",
          overflowX: "auto", overflowY: "hidden", minHeight: 0
        }
      });

      return react.createElement("div", {
        "data-dsh-agent-dock": "panel",
        style: {
          display: "flex", flexDirection: "column",
          width: "100%", height: "100%",
          // v0.4.11: 加 background:#0d1117 覆盖 details column 浅色主题背景
          //（v0.4.10 xterm container 收缩后 details column 自身浅色背景暴露）
          background: "#0d1117",
          color: "var(--dsw-alias-text-l1, #e6e6e6)",
          fontFamily: "var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace)",
          boxSizing: "border-box",
          overflow: "hidden",
          position: "relative"  // v0.4.8: 给 floating × 按钮 absolute 定位用
        }
      }, body, renderStatusPanel(), floatingClose);
    }

    /**
     * 唤醒按钮 / 状态徽章（v1.1 旧逻辑）。
     * - 点击未运行：wake + layout.openDetails() 展开右侧详情列。
     * - 点击运行中：toggle（开 → layout.closeDetails；关 → wake + openDetails）。
     * - 订阅 layout store：DSH 的 × 关闭详情列时按钮同步显示"未展开"。
     */
    function AgentDockWidget(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var passedCwd = props.cwd;
      // layout 与 layoutStore 由 slot register options.inject 注入到 props（v0.4.1 修）：
      // cordis 在 widget 内 ctx.layout 反射访问时要求 layout 出现在 exports.inject 数组里，
      // 否则抛 "cannot get property layout without inject"，连带整个 slot 列表被 React
      // error boundary 接住——表现为整列按钮消失。layout 已声明为 inject，详见 exports.inject。
      // 这里仍走 props 路径，避免组件内反射 ctx 带来的运行时依赖，便于未来 cordis 行为变动。
      var layout = props.layout || null;
      var layoutStore = props.layoutStore || (layout && layout.store) || null;
      var sessionCwd = useSessionCwd(sessionId);
      var cwd = passedCwd || sessionCwd || null;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var st = useState({ loading: true, serverOk: false, forkOk: false, mine: null, error: null });
      var state = st[0];
      var setState = st[1];
      var wkSt = useState(false);
      var waking = wkSt[0];
      var setWaking = wkSt[1];
      var openSt = useState(false);
      var detailsOpen = openSt[0];
      var setDetailsOpen = openSt[1];
      var pollRef = useRef(2000);

      // 订阅 layout store：DSH 的 × / 拖拽关闭详情列时按钮 toggle 视觉跟着走。
      useEffect(function () {
        var store = layoutStore;
        if (!store || typeof store.subscribe !== "function") return;
        var apply = function () {
          try {
            var snap = store.getSnapshot ? store.getSnapshot() : null;
            var cur = snap && typeof snap.details === "number" ? snap.details > 0 : false;
            setDetailsOpen(cur);
          } catch (_) {}
        };
        var unsub = store.subscribe(apply);
        apply();
        return unsub;
      }, [layoutStore]);

      useEffect(function () {
        var alive = true;
        var timer = null;
        function tick() {
          var url = "/agent-dock/status" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : "");
          fetch(url, { cache: "no-store" })
            .then(function (res) { return res.json(); })
            .then(function (body) {
              if (!alive) return;
              if (body.pollIntervalMs && body.pollIntervalMs >= 500) pollRef.current = body.pollIntervalMs;
              setState({ loading: false, serverOk: !!body.serverOk, forkOk: !!body.forkOk, mine: body.mine || null, error: body.error || null });
              if (body.mine) setWaking(false);
            })
            .catch(function (err) {
              if (alive) setState({ loading: false, serverOk: false, forkOk: false, mine: null, error: String(err && err.message || err) });
            })
            .then(function () { if (alive) timer = setTimeout(tick, pollRef.current); });
        }
        tick();
        return function () { alive = false; if (timer) clearTimeout(timer); };
      }, [cwd]);

      function openPanel() {
        if (layout && typeof layout.openDetails === "function") {
          try { layout.openDetails(); } catch (_) {}
        }
      }
      function closePanel() {
        if (layout && typeof layout.closeDetails === "function") {
          try { layout.closeDetails(); } catch (_) {}
        }
      }

      async function onWake() {
        if (waking) return;
        setWaking(true);
        try {
          var payload = JSON.stringify(cwd ? { cwd: cwd } : {});
          await fetch("/agent-dock/wake", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
        } catch (err) { /* 轮询会反映状态 */ }
        openPanel();
        setTimeout(function () { setWaking(false); }, 30000);
      }

      function onBadgeClick() {
        if (detailsOpen) closePanel();
        else onWake();
      }

      function renderContent() {
        var meta = state.mine ? (STATUS_META[state.mine.state] || STATUS_META.unknown) : null;
        if (state.loading) {
          return react.createElement("span", { style: baseStyle, opacity: 0.7 }, "…");
        }
        if (!state.serverOk) {
          return react.createElement("button", {
            onClick: onWake,
            style: buttonStyle(errorStyle),
            title: state.error ? String(state.error) : (t("offline") + " — 点击自动拉起 herdr server")
          }, t("offline"));
        }
        if (!state.forkOk) {
          return react.createElement("button", {
            style: buttonStyle(errorStyle),
            title: t("noFork")
          }, t("noFork"));
        }
        if (!meta) {
          return react.createElement("button", {
            onClick: onWake,
            disabled: !!waking,
            style: buttonStyle(idleStyle),
            title: t("btnTitle")
          }, waking ? t("waking") : t("wake"));
        }
        var dot = react.createElement("span", {
          style: {
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: meta.color, marginRight: 6, boxShadow: "0 0 6px " + meta.color,
            verticalAlign: "middle"
          }
        });
        var badgeTitle = (state.mine.name || state.mine.pane) + " · " + meta.label
          + (state.mine.cwd ? " · " + state.mine.cwd : "")
          + (state.mine.workspace ? " · ws " + state.mine.workspace : "")
          + " — 点击" + (detailsOpen ? "关闭" : "打开") + "终端列";
        return react.createElement("button", {
          onClick: onBadgeClick,
          disabled: !!waking,
          className: "agent-dock-badge",
          style: Object.assign({}, baseStyle, { borderColor: meta.color, color: meta.color }),
          title: badgeTitle
        }, dot, waking ? (t("wake")) : meta.label);
      }

      var baseStyle = {
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "3px 10px", borderRadius: 999, border: "1px solid",
        fontSize: 12, lineHeight: "18px", background: "transparent",
        cursor: "pointer", whiteSpace: "nowrap"
      };
      var buttonStyle = function (extra) { return Object.assign({}, baseStyle, extra); };
      var idleStyle = { color: "#57ab5a", borderColor: "#57ab5a" };
      var errorStyle = { color: "#e5584b", borderColor: "#e5584b" };
      (function () {
        var el = document.getElementById("agent-dock-wake-style");
        if (el) return;
        var style = document.createElement("style");
        style.id = "agent-dock-wake-style";
        style.textContent = ".agent-dock-pill:hover{filter:brightness(1.1)}.agent-dock-pill:disabled{opacity:.6;cursor:default}";
        document.head.appendChild(style);
      })();

      return react.createElement("span", { className: "agent-dock-pill" }, renderContent());
    }

    // cordis 的 inject 数组声明本 bundle 运行时需要的 ctx 服务。cordis 会在该服务
    // 就绪前阻止 entry 创建，并要求 widget 内通过 ctx.X 反射访问时 X 必须出现在这里
    // （否则抛出 "cannot get property X without inject"，连带 slot 渲染失败——
    // React error boundary 会把整个 slot 列表接住，表现为整列按钮不见，v0.4.0 bug）。
    // layout 由 ui-layout 提供，是本插件终端面板开关的核心依赖，必须声明。
    var inject = ["slots", "locale", "sessions", "layout"];

    function apply(ctx) {
      _ctxRef.current = ctx;
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-agent-dock: dictionaries");
      var t = ctx.locale.bind(NS);
      // 1) 唤醒按钮 / 状态徽章：会话头部 actions slot（沿用之前）
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "agent-dock-wake",
          order: 60,
          label: function () { return t("wake"); },
          locale: NS,
          // v0.4.1 修：把 layout 与 layoutStore 通过 props 注入 widget，避免组件内
          // ctx.X 反射访问 layout（layout 未声明在 exports.inject 时 cordis 抛
          // "cannot get property layout without inject"，连带 slot 列表被 React
          // error boundary 接住，整个 actions slot 按钮消失）。
          inject: function (sessionId) {
            var layout = ctx.layout || null;
            return {
              t: t,
              sessionId: sessionId,
              cwd: null,
              layout: layout,
              layoutStore: layout && layout.store ? layout.store : null
            };
          }
        }, function (props) { return react.createElement(AgentDockWidget, { t: props.t, sessionId: props.sessionId, cwd: props.cwd, layout: props.layout, layoutStore: props.layoutStore }); });
      });
      // 2) 终端面板：注册到 'details' slot（v0.4.0），priority -10 覆盖 ui-conversation
      // 默认注册的 DetailsPanel。DSH AppFrame 在右侧 detailsCol 内渲染此组件——
      // 外框/边框/配色/拖拽手柄全部由 DSH 自带（AppFrame.module.css .detailsCol），
      // 组件内只画标题行 + xterm 容器 + 输入栏 + 键按钮，整体外观与 DSH 原生一致。
      ctx.slots.inject("details", function () {
        return ctx.slots.register({
          name: "details",
          priority: -10,
          label: function () { return t("panelTitle"); },
          locale: NS,
          // 同 v0.4.1 修：closeDetails 直接捕获 ctx.layout（apply 作用域，cordis 已
          // 确保 layout 服务就绪；layout 已声明在 exports.inject 数组里，无 getter 抛错风险）。
          inject: function (sessionId) {
            var layout = ctx.layout || null;
            return {
              t: t,
              sessionId: sessionId,
              closeDetails: function () {
                if (layout && typeof layout.closeDetails === "function") {
                  try { layout.closeDetails(); } catch (_) {}
                }
              }
            };
          }
        }, function (props) { return react.createElement(TerminalPanelForDetails, { t: props.t, sessionId: props.sessionId, closeDetails: props.closeDetails }); });
      });
    }

    exports.name = "dsh-agent-dock";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
