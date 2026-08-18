/**
 * dsh-agent-dock — WebUI 客户端（单文件，__ModuleLoader__ 格式，免构建）。
 * 依赖：react / react-dom / xterm CDN（module table 提供 react + react-dom）。
 * 设计（v0.3.0 终端浮层重写）：
 *   - 不再挂 conversation.details.tool：那个 slot 只在选中 tool call 时渲染（详见
 *     DSH DetailsPanel.tsx），与我们的"唤醒即看终端"诉求不匹配。
 *   - 也不依赖 layout.openDetails()/closeDetails()。
 *   - 改为：会话头部 actions slot 仍是挂载点（id='agent-dock-wake'），
 *     但 AgentDockWidget 内部用 React state 管理 dockOpen，并通过
 *     react-dom.createPortal 把 TerminalDockPanel 渲染到 document.body 下
 *     一个独占 div，position: fixed 钉在屏幕右侧，z-index 高于 DSH 内容。
 *   - 这样唤醒按钮所在的 slot 是常驻的（list, scope=session, 每会话渲染一次），
 *     浮层随 DockHost 一起挂载/卸载，与 DSH 的 selection/chat state 完全解耦。
 * 交互：
 *   - 未运行：头部"唤醒 mcode"按钮（绿），点击 → POST /agent-dock/wake（携带
 *     当前会话 cwd）→ setDockOpen(true) 打开右侧浮层。
 *   - 运行中：徽章（idle/working/blocked/done 状态色），点击 → 幂等 wake + 打开浮层；
 *     再点一次则关闭浮层。
 *   - 浮层：xterm.js 渲染 herdr agent read --format ansi 的实时 VT 序列；
 *     输入经 POST /agent-dock/terminal/send 转发到 pane send-text / agent send-keys。
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
    var reactDom = require("react-dom");

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
      panelOpen: "打开终端浮层",
      panelClose: "关闭终端浮层",
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
      panelOpen: "Open terminal dock",
      panelClose: "Close terminal dock",
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
     * 终端浮层组件（v0.3.0）：通过 React Portal 渲染到 document.body 下的
     * 独占 div，position: fixed 钉在屏幕右侧，与 DSH 的 selection/chat state
     * 完全解耦（详见模块头注释）。
     * - 数据：每 terminalPollMs ms 拉 POST /agent-dock/terminal/text，--format ansi
     * - 输出：term.write(ansi)（xterm.js 自带 ANSI 解析，渲染 mcode 完整 VT）
     * - 输入：term.onData → POST /agent-dock/terminal/send
     * - 关闭：props.onClose（由 DockHost 注入）
     */
    function TerminalDockPanel(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var onClose = props.onClose;
      try {
        return TerminalDockPanelInner(props);
      } catch (err) {
        return react.createElement("div", {
          style: { padding: 0, color: "#e5584b", fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre-wrap", background: "#0e0e10", position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 60vw)", zIndex: 2147483600, boxShadow: "-4px 0 16px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column" }
        }, react.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #2a2a2e" } },
          react.createElement("strong", null, t("panelTitle")),
          react.createElement("button", { onClick: onClose, style: { background: "transparent", border: "1px solid #3a3a40", borderRadius: 4, color: "#cfd2d6", padding: "2px 8px", cursor: "pointer", fontSize: 11 } }, "×")
        ),
        react.createElement("pre", { style: { padding: 16, margin: 0, whiteSpace: "pre-wrap", flex: 1, overflow: "auto" } }, "dsh-agent-dock TerminalDockPanel render error:\n\n" + String(err && err.stack || err) + "\n\nsessionId=" + sessionId)
        );
      }
    }
    function TerminalDockPanelInner(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var onClose = props.onClose;
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

      // 拉 status 拿 mine.cwd / terminalPollMs
      useEffect(function () {
        var alive = true;
        function tick() {
          var url = "/agent-dock/status" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : "");
          fetch(url, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (!alive) return;
              setStatus({ mine: body.mine || null, loading: false });
            })
            .catch(function () { if (alive) setStatus({ mine: null, loading: false }); });
        }
        tick();
        return function () { alive = false; };
      }, [cwd]);

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
              if (alive) timer = setTimeout(poll, cfgPoll);
            });
        }
        timer = setTimeout(poll, cfgPoll);
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

      var diagLine = (function () {
        var parts = [];
        parts.push("v0.3.0");
        parts.push("cwd=" + (cwd || "null"));
        if (status.mine) parts.push("mine=" + status.mine.state + "@" + status.mine.pane);
        if (xterm.ready) parts.push("xterm=ok");
        else if (xterm.error) parts.push("xterm=err");
        return parts.join(" · ");
      })();

      var headerBar = react.createElement("div", {
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", color: "#cfd2d6", fontSize: 12,
          borderBottom: "1px solid #2a2a2e", flexShrink: 0
        }
      },
        react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
          react.createElement("strong", null, t("panelTitle") + " · " + (status.mine && status.mine.cwd ? status.mine.cwd : (cwd || "—"))),
          react.createElement("span", { style: { fontSize: 10, color: "#7f858c", wordBreak: "break-all" } }, diagLine)
        ),
        react.createElement("button", {
          onClick: onClose,
          title: t("panelClose"),
          "aria-label": t("panelClose"),
          style: {
            background: "transparent", border: "1px solid #3a3a40", borderRadius: 4,
            color: "#cfd2d6", padding: "2px 8px", cursor: "pointer", fontSize: 14,
            lineHeight: 1
          }
        }, "×")
      );

      var inputRow = react.createElement("div", { style: { display: "flex", gap: 6, padding: 8, borderTop: "1px solid #2a2a2e", flexShrink: 0 } },
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
        style: { display: "flex", gap: 4, padding: "0 8px 8px", flexWrap: "wrap", flexShrink: 0 }
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

      var renderEmpty = function () {
        return react.createElement("div", { style: { padding: 16, color: "#9aa0a6", fontSize: 13 } }, t("panelEmpty"));
      };
      var renderLoading = function () {
        return react.createElement("div", { style: { padding: 16, color: "#9aa0a6", fontSize: 13 } }, t("panelLoading"));
      };
      var renderError = function () {
        return react.createElement("div", {
          style: { padding: 16, color: "#e5584b", fontSize: 12, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }
        }, "xterm.js load failed: " + xterm.error + "\n\n请检查网络（CDN：cdn.jsdelivr.net / unpkg.com），或在内网部署时把 xterm.js 与 xterm-addon-fit 安装到本地 module table。");
      };

      var body;
      if (!cwd) body = renderLoading();
      else if (!status.mine) body = renderEmpty();
      else if (!xterm.ready && !xterm.error) body = renderLoading();
      else if (xterm.error) body = renderError();
      else body = react.createElement("div", { ref: containerRef, style: { flex: 1, minHeight: 0, padding: 4 } });

      return react.createElement("div", {
        "data-dsh-agent-dock": "panel",
        style: {
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(560px, 60vw)",
          background: "#0e0e10",
          color: "#e6e6e6",
          fontFamily: "ui-monospace, Consolas, monospace",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          zIndex: 2147483600,
          boxSizing: "border-box"
        }
      }, headerBar, body, inputRow, keyRow);
    }

    /**
     * DockHost：actions slot 条目的顶层组件。
     * - 渲染唤醒按钮 / 状态徽章（v1.1 旧逻辑）
     * - 维护 dockOpen 状态；唤醒/点徽章后打开浮层；运行中再点徽章则关闭浮层
     * - 浮层通过 React Portal 渲染到 document.body 下的独占 div，
     *   position: fixed 钉在屏幕右侧，与 DSH selection 完全解耦。
     */
    function AgentDockWidget(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var passedCwd = props.cwd;
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
      var dockOpen = openSt[0];
      var setDockOpen = openSt[1];
      var pollRef = useRef(2000);

      // 创建一个独占的 portal 容器挂在 document.body 下，浮层从此处渲染。
      // portal 让 React 树更干净，避免被父级 transform/filter 创建的
      // containing block 影响 fixed 参考系。
      var portalHostRef = useRef(null);
      if (portalHostRef.current === null && typeof document !== "undefined") {
        var existing = document.getElementById("dsh-agent-dock-portal-host");
        if (!existing) {
          existing = document.createElement("div");
          existing.id = "dsh-agent-dock-portal-host";
          // portal host 自身不占布局，不抢事件；浮层（TerminalDockPanel）才是真正的 fixed 容器
          existing.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483600;";
          document.body.appendChild(existing);
        }
        portalHostRef.current = existing;
      }

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

      async function onWake() {
        if (waking) return;
        setWaking(true);
        try {
          var payload = JSON.stringify(cwd ? { cwd: cwd } : {});
          await fetch("/agent-dock/wake", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
        } catch (err) { /* 轮询会反映状态 */ }
        setDockOpen(true);
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
          + " — 点击" + (dockOpen ? "关闭" : "打开") + "终端浮层";
        return react.createElement("button", {
          onClick: function () { if (dockOpen) setDockOpen(false); else onWake(); },
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

      var pill = react.createElement("span", { className: "agent-dock-pill" }, renderContent());

      // 浮层：通过 React Portal 渲染到 body 下的独占 div，与 DSH selection 无关。
      var portalHost = portalHostRef.current;
      var dockNode = (dockOpen && portalHost)
        ? reactDom.createPortal(
            react.createElement(TerminalDockPanel, {
              t: t,
              sessionId: sessionId,
              onClose: function () { setDockOpen(false); }
            }),
            portalHost
          )
        : null;

      return react.createElement(react.Fragment, null, pill, dockNode);
    }

    var inject = ["slots", "locale", "sessions"];

    function apply(ctx) {
      _ctxRef.current = ctx;
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-agent-dock: dictionaries");
      var t = ctx.locale.bind(NS);
      // 会话头部 actions slot：唯一注入点（list 类型，每会话渲染一次，常驻）。
      // 终端浮层通过同一组件内部的 React Portal 渲染到 document.body，
      // 不再依赖 conversation.details.tool（详见模块头注释）。
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
    }

    exports.name = "dsh-agent-dock";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
