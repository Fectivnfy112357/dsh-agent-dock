/**
 * dsh-agent-dock — WebUI 客户端（单文件，__ModuleLoader__ 格式，免构建）。
 * 依赖：仅 react（module table 提供）；服务：slots + locale + sessions + layout（dsh-client-runtime）。
 * 交互（DESIGN Q2/Q12 修订 + v1.3 终端面板）：
 *   - 未运行：会话头部按钮"唤醒 mcode"（绿），点击 POST /agent-dock/wake（携带当前会话 cwd）；
 *     唤醒后会自动调 layout.openDetails() 打开右侧终端面板。
 *   - 运行中（归属命中）：可点击徽章（idle 灰 / working 琥珀 / blocked 红 / done 绿 / 离线），
 *     点击 = 幂等 wake + 打开终端面板聚焦该 pane（v1.1，DESIGN Q12 修订）；悬停展示 pane 名与工作目录。
 *   - 右侧终端面板（v1.4）：注册到 conversation.details.tool slot，xterm.js 渲染 herdr
 *     agent read --source recent --format ansi 的实时 VT 序列（颜色/框线/光标全保留）；
 *     输入经 POST /agent-dock/terminal/send 转发到 pane send-text / agent send-keys。
 *     自动轮询间隔取服务端配置 terminalPollMs（默认 1500ms）。
 *   - 轮询 /agent-dock/status?cwd=...，间隔取服务端配置 pollIntervalMs（默认 2s）。
 *   - cwd 取自当前会话（v1.3：ctx.sessions.list.getSnapshot().byId[sessionId].cwd。
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
      panelKeysLabel: "键",
      panelOpen: "打开终端面板",
      panelClose: "关闭面板",
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
      panelKeysLabel: "Keys",
      panelOpen: "Open terminal panel",
      panelClose: "Close panel",
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
          // 已经在页面里（比如用户开了其他页面）就跳过
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
      // listApi 由 apply(ctx) 时挂到 _ctxRef.current.sessions.list；factory 阶段 _ctxRef.current=null。
      var ctx = _ctxRef.current;
      var listApi = ctx && ctx.sessions && ctx.sessions.list;
      function readCwd() {
        if (!listApi || typeof listApi.getSnapshot !== 'function') return null;
        try {
          var snap = listApi.getSnapshot();
          // 运行时快照形状是 { ids, byId, current, ... }（dsh-client-runtime 的
          // SessionListState）：byId 以 sessionId 为键，每条含
          // { id, displayTitle, cwd?, ... }（projectList 里按 entry.cwd 是否存在投影）。
          // 旧实现读 snap.items + items[i].sessionId —— 快照里根本没有 items 数组，
          // 循环永远不执行，sessionCwd 恒为 null，按钮 payload 不带 cwd，唤醒便回退到
          // dsh web 进程 cwd（从 home 启动时 = C:\Users\32115），mcode 就跑到了 home 目录。
          var byId = (snap && snap.byId) || null;
          var entry = byId ? byId[sessionId] : null;
          if (entry && entry.cwd) return entry.cwd;
          if (byId) {
            // 兜底：按 id/sessionId 字段扫描（byId 的键即 sessionId，正常不会走到）
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
        // 组件挂载时 ctx 可能尚未构造（apply 比 React 树先；如有 race 这里重读一次）
        var liveList = (_ctxRef.current && _ctxRef.current.sessions && _ctxRef.current.sessions.list) || listApi;
        if (!liveList || typeof liveList.subscribe !== 'function' || !sessionId) return;
        var unsub = liveList.subscribe(function () { setCwd(readCwd()); });
        // 立即重读一次，覆盖 race 期间 ctx 后到的情形
        setCwd(readCwd());
        return unsub;
      }, [sessionId]);
      return cwd;
    }

    /**
     * 异步加载 xterm 的 hook；返回 { ready, error }。
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
     * 终端面板组件（v1.4）：注册到 conversation.details.tool slot。
     * - 数据：每 terminalPollMs ms 拉 POST /agent-dock/terminal/text，--format ansi
     * - 输出：term.write(ansi)（xterm.js 自带 ANSI 解析，渲染 mcode 完整 VT）
     * - 输入：term.onData → POST /agent-dock/terminal/send
     * - closeDetails 由 details slot 的 inject 提供（layout.closeDetails）。
     */
    function TerminalView(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var sessionCwd = useSessionCwd(sessionId);
      var cwd = sessionCwd;
      var xterm = useXterm();
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var useCallback = react.useCallback;
      var statusSt = useState({ mine: null, loading: true });
      var status = statusSt[0];
      var setStatus = statusSt[1];
      var containerRef = useRef(null);
      var termRef = useRef(null);
      var fitRef = useRef(null);
      var pollRef = useRef(1500);

      // 拉 status 拿 mine.cwd / terminalPollMs
      useEffect(function () {
        var alive = true;
        function tick() {
          var url = "/agent-dock/status" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : "");
          fetch(url, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (!alive) return;
              if (body.pollIntervalMs) pollRef.current = body.pollIntervalMs;
              setStatus({ mine: body.mine || null, loading: false });
            })
            .catch(function () { if (alive) setStatus({ mine: null, loading: false }); });
        }
        tick();
        return function () { alive = false; };
      }, [cwd]);

      // 拉 status 的 terminalPollMs（默认 1500）
      var cfgPoll = (status.mine && status.mine.terminalPollMs) || 1500;

      // 拉终端文本
      useEffect(function () {
        if (!xterm.ready || !status.mine || !cwd) return;
        var alive = true;
        var timer = null;
        var pending = false;
        var lastText = null;
        function tick() {
          if (!alive || pending) { timer = setTimeout(tick, cfgPoll); return; }
          pending = true;
          fetch("/agent-dock/terminal/text", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: cwd, lines: 80, source: "recent", format: "ansi" })
          })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (!alive) return;
              if (body && body.ok && typeof body.text === "string" && body.text !== lastText) {
                lastText = body.text;
                if (termRef.current) {
                  termRef.current.reset();
                  termRef.current.write(body.text);
                }
              }
            })
            .catch(function () { /* 静默：保留旧画面 */ })
            .then(function () {
              pending = false;
              if (alive) timer = setTimeout(tick, cfgPoll);
            });
        }
        timer = setTimeout(tick, cfgPoll);
        return function () { alive = false; if (timer) clearTimeout(timer); };
      }, [xterm.ready, status.mine, cwd, cfgPoll]);

      // 初始化 xterm
      useEffect(function () {
        if (!xterm.ready || !containerRef.current) return;
        var mods = xterm.term;
        var term = new mods.Terminal({
          cursorBlink: true,
          fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
          fontSize: 13,
          theme: { background: '#0e0e10', foreground: '#e6e6e6', cursor: '#e6e6e6' },
          convertEol: true,
          scrollback: 4000,
          disableStdin: false
        });
        var fit = new mods.FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        try { fit.fit(); } catch (_) {}
        termRef.current = term;
        fitRef.current = fit;
        var onResize = function () { try { fit.fit(); } catch (_) {} };
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
        return function () {
          window.removeEventListener("resize", onResize);
          try { term.dispose(); } catch (_) {}
          termRef.current = null;
          fitRef.current = null;
        };
      }, [xterm.ready]);

      var sendText = useCallback(function (text) {
        if (!text || !cwd) return;
        fetch("/agent-dock/terminal/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: cwd, text: text })
        }).catch(function () {});
      }, [cwd]);
      var sendKeys = useCallback(function (keys) {
        if (!keys || !cwd) return;
        fetch("/agent-dock/terminal/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: cwd, keys: Array.isArray(keys) ? keys : [keys] })
        }).catch(function () {});
      }, [cwd]);

      var renderEmpty = function () {
        return react.createElement("div", {
          style: { padding: 16, color: "#9aa0a6", fontSize: 13 }
        }, t("panelEmpty"));
      };
      var renderLoading = function () {
        return react.createElement("div", {
          style: { padding: 16, color: "#9aa0a6", fontSize: 13 }
        }, t("panelLoading"));
      };
      var renderError = function () {
        return react.createElement("div", {
          style: { padding: 16, color: "#e5584b", fontSize: 12, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }
        }, "xterm.js load failed: " + xterm.error + "\n\n请检查网络（CDN：cdn.jsdelivr.net / unpkg.com），或在内网部署时把 xterm.js 与 xterm-addon-fit 安装到本地 module table。");
      };

      var headerBar = react.createElement("div", {
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", color: "#cfd2d6", fontSize: 12,
          borderBottom: "1px solid #2a2a2e"
        }
      }, react.createElement("span", null, t("panelTitle") + " · " + (status.mine && status.mine.cwd ? status.mine.cwd : (cwd || "—"))),
        react.createElement("button", {
          onClick: function () { if (props.closeDetails) props.closeDetails(); },
          title: t("panelClose"),
          style: {
            background: "transparent", border: "1px solid #3a3a40", borderRadius: 4,
            color: "#cfd2d6", padding: "2px 8px", cursor: "pointer", fontSize: 11
          }
        }, "×"));

      var inputRow = react.createElement("div", { style: { display: "flex", gap: 6, padding: 8, borderTop: "1px solid #2a2a2e" } },
        react.createElement("input", {
          placeholder: t("panelCmdPlaceholder"),
          style: {
            flex: 1, padding: "5px 10px", border: "1px solid #3a3a40", borderRadius: 4,
            background: "#1c1c1f", color: "#e6e6e6", fontSize: 12,
            fontFamily: "ui-monospace, Consolas, monospace"
          },
        onKeyDown: function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            var v = e.currentTarget.value;
            sendText(v + "\n");
            e.currentTarget.value = "";
          }
        }
        }),
        react.createElement("button", {
          onClick: function () {
            var inp = document.getElementById("agent-dock-panel-input");
            if (inp && inp.value) { sendText(inp.value + "\n"); inp.value = ""; }
          },
          style: {
            padding: "5px 12px", borderRadius: 4, border: "1px solid #3a3a40",
            background: "#2a2a2e", color: "#e6e6e6", cursor: "pointer", fontSize: 12
          }
        }, t("panelSend"))
      );

      var keyRow = react.createElement("div", {
        style: { display: "flex", gap: 4, padding: "0 8px 8px", flexWrap: "wrap" }
      }, ["esc", "enter", "tab", "shift+tab", "ctrl+c", "ctrl+l", "up", "down"].map(function (k) {
        return react.createElement("button", {
          key: k,
          onClick: function () { sendKeys(k); },
          style: {
            padding: "2px 8px", borderRadius: 3, border: "1px solid #3a3a40",
            background: "#1c1c1f", color: "#cfd2d6", cursor: "pointer",
            fontSize: 11, fontFamily: "ui-monospace, monospace"
          }
        }, k);
      }));

      var body;
      if (!cwd) body = renderLoading();
      else if (!status.mine) body = renderEmpty();
      else if (!xterm.ready && !xterm.error) body = renderLoading();
      else if (xterm.error) body = renderError();
      else body = react.createElement("div", { ref: containerRef, style: { flex: 1, minHeight: 0, padding: 4 } });

      return react.createElement("div", {
        style: {
          display: "flex", flexDirection: "column",
          width: "100%", height: "100%",
          background: "#0e0e10", color: "#e6e6e6",
          fontFamily: "ui-monospace, Consolas, monospace"
        }
      }, headerBar, body, inputRow, keyRow);
    }

    /** 组件：唤醒按钮 / 状态徽章二态一体（徽章可点击 = 幂等 wake + 聚焦 + 打开终端面板）。 */
    function AgentDockWidget(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var passedCwd = props.cwd;
      var sessionCwd = useSessionCwd(sessionId);
      // 优先级：显式 props.cwd > sessions service 实时取的 sessionCwd > null
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
      var pollRef = useRef(2000);

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
        var ctx = _ctxRef.current;
        if (ctx && ctx.layout && typeof ctx.layout.openDetails === "function") {
          try { ctx.layout.openDetails(); } catch (_) {}
        }
      }

      async function onWake() {
        if (waking) return;
        setWaking(true);
        try {
          var payload = JSON.stringify(cwd ? { cwd: cwd } : {});
          await fetch("/agent-dock/wake", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
          // 唤醒后自动弹出右侧终端面板
          openPanel();
        } catch (err) { /* 轮询会反映状态 */ }
        setTimeout(function () { setWaking(false); }, 30000);
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
          + " — 点击打开终端面板";
        // 徽章可点击 = 打开终端面板（同时唤醒 — 幂等，已存在则聚焦）
        return react.createElement("button", {
          onClick: function () { openPanel(); onWake(); },
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

    var inject = ["slots", "locale", "sessions", "layout"];

    function apply(ctx) {
      // v1.2：将 ctx 暴露给组件实例化的闭包（factory 阶段 ctx 尚未构造，apply 时回填）。
      _ctxRef.current = ctx;
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-agent-dock: dictionaries");
      var t = ctx.locale.bind(NS);
      // 1) 唤醒按钮 / 状态徽章：会话头部 actions slot（与之前一致）
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "agent-dock-wake",
          order: 60,
          label: function () { return t("wake"); },
          locale: NS,
          inject: function (sessionId) {
            return { t: t, sessionId: sessionId, cwd: null };
          }
        }, function (props) { return react.createElement(AgentDockWidget, { t: props.t, sessionId: props.sessionId, cwd: props.cwd }); });
      });
      // 2) 终端面板：注册到 conversation.details.tool slot（v1.4，DSH conversation 子槽 single）
      ctx.slots.inject("conversation.details.tool", function () {
        return ctx.slots.register({
          name: "conversation.details.tool",
          id: "agent-dock-terminal",
          order: 60,
          label: function () { return t("panelTitle"); },
          locale: NS,
          inject: function (sessionId) {
            // inject 返回 closeDetails（details 面板的 close 入口）—— 按 DSH details slot 的 inject 约定
            return {
              t: t,
              sessionId: sessionId,
              closeDetails: function () {
                try {
                  var c = _ctxRef.current;
                  if (c && c.layout && typeof c.layout.closeDetails === "function") c.layout.closeDetails();
                } catch (_) {}
              }
            };
          }
        }, function (props) { return react.createElement(TerminalView, { t: props.t, sessionId: props.sessionId, closeDetails: props.closeDetails }); });
      });
    }

    exports.name = "dsh-agent-dock";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
