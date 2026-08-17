/**
 * dsh-agent-dock — WebUI 客户端（单文件，__ModuleLoader__ 格式，免构建）。
 * 依赖：仅 react（module table 提供）；服务：slots + locale + sessions（dsh-client-runtime）。
 * 交互（DESIGN Q2/Q12 修订）：
 *   - 未运行：会话头部按钮"唤醒 mcode"（绿），点击 POST /agent-dock/wake（携带当前会话 cwd）；
 *   - 运行中（归属命中）：可点击徽章（idle 灰 / working 琥珀 / blocked 红 / done 绿 / 离线），
 *     点击 = 幂等 wake + 聚焦该 pane（v1.1，DESIGN Q12 修订）；悬停展示 pane 名与工作目录；
 *   - 轮询 /agent-dock/status?cwd=...，间隔取服务端配置 pollIntervalMs（默认 2s）。
 *   - cwd 取自当前会话（v1.3：ctx.sessions.list.getSnapshot().byId[sessionId].cwd；
 *     v1.2 误读不存在的 snap.items/items[i].sessionId 导致 cwd 恒空、唤醒回退到 dsh web 进程目录；
 *     更早 v1.0 用 ctx.sessions.summaries 同样不存在）。
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
    };
    var en = {
      wake: "Wake mcode",
      waking: "Waking…",
      offline: "herdr offline",
      noFork: "fork build required",
      btnTitle: "Wake Herdr-hosted MiniMax Code (mcode)",
    };
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

    /** 组件：唤醒按钮 / 状态徽章二态一体（徽章可点击 = 幂等 wake + 聚焦）。 */
    function AgentDockWidget(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var passedCwd = props.cwd;
      var sessionCwd = useSessionCwd(sessionId);
      // 优先级：显式 props.cwd > sessions service 实时取的 sessionCwd > null（按钮点击时 fallback 到 process.cwd 服务端兜底）
      var cwd = passedCwd || sessionCwd || null;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var [state, setState] = useState({ loading: true, serverOk: false, forkOk: false, mine: null, error: null });
      var [waking, setWaking] = useState(false);
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

      async function onWake() {
        if (waking) return;
        setWaking(true);
        try {
          var payload = JSON.stringify(cwd ? { cwd: cwd } : {});
          await fetch("/agent-dock/wake", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
        } catch (err) { /* 轮询会反映状态 */ }
        // 30s 安全兜底：正常时下一次 status 返回 mine 即复位
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
            display: "inline-block",
            width: 8, height: 8,
            borderRadius: "50%",
            background: meta.color,
            marginRight: 6,
            boxShadow: "0 0 6px " + meta.color,
            verticalAlign: "middle",
          }
        });
        var badgeTitle = (state.mine.name || state.mine.pane) + " · " + meta.label
          + (state.mine.cwd ? " · " + state.mine.cwd : "")
          + (state.mine.workspace ? " · ws " + state.mine.workspace : "")
          + " — 点击聚焦/唤醒";
        // v1.1：徽章可点击（幂等 wake + 聚焦该 pane），不再是纯展示 span
        return react.createElement("button", {
          onClick: onWake,
          disabled: !!waking,
          className: "agent-dock-badge",
          style: Object.assign({}, baseStyle, { borderColor: meta.color, color: meta.color }),
          title: badgeTitle
        }, dot, waking ? (t("wake")) : meta.label);
      }

      var baseStyle = {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        borderRadius: 999,
        border: "1px solid",
        fontSize: 12,
        lineHeight: "18px",
        background: "transparent",
        cursor: "pointer",
        whiteSpace: "nowrap",
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

    var inject = ["slots", "locale", "sessions"];

    function apply(ctx) {
      // v1.2：将 ctx 暴露给组件实例化的闭包（factory 阶段 ctx 尚未构造，apply 时回填）。
      _ctxRef.current = ctx;
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-agent-dock: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "agent-dock-wake",
          order: 60,
          label: function () { return t("wake"); },
          locale: NS,
          // v1.2：组件内用 useSessionCwd(sessionId) 实时从 ctx.sessions.list 拿 cwd（修复唤醒到错误目录的根因）。
          // 这里不再直接预读 cwd —— 交由组件订阅 sessions list 自动更新。
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

