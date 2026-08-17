/**
 * dsh-agent-dock — WebUI 客户端（单文件，__ModuleLoader__ 格式，免构建）。
 * 依赖：仅 react（module table 提供）；服务：slots（dsh-client-runtime）+ locale（dsh-client-locale）。
 * 交互（DESIGN Q2/Q12）：
 *   - 未运行：会话头部按钮"唤醒 mcode"（绿），点击 POST /agent-dock/wake；
 *   - 运行中：状态徽章（idle 灰 / working 琥珀 / blocked 红 / done 绿 / 离线），悬停展示 pane 名；
 *   - 轮询 /agent-dock/status，间隔取服务端配置 pollIntervalMs（默认 2s）。
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
    /** 组件：唤醒按钮 / 状态徽章二态一体。 */
    function AgentDockWidget(props) {
      var t = props.t;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var [state, setState] = useState({ loading: true, serverOk: false, forkOk: false, mine: null, error: null });
      var [waking, setWaking] = useState(false);
      var pollRef = useRef(2000);

      useEffect(function () {
        var alive = true;
        var timer = null;
        async function tick() {
          try {
            var res = await fetch("/agent-dock/status", { cache: "no-store" });
            var body = await res.json();
            if (!alive) return;
            if (body.pollIntervalMs && body.pollIntervalMs >= 500) pollRef.current = body.pollIntervalMs;
            setState({ loading: false, serverOk: !!body.serverOk, forkOk: !!body.forkOk, mine: body.mine || null, error: body.error || null });
          } catch (err) {
            if (alive) setState({ loading: false, serverOk: false, forkOk: false, mine: null, error: String(err && err.message || err) });
          }
        }
        tick();
        timer = setInterval(tick, pollRef.current);
        return function () { alive = false; if (timer) clearInterval(timer); };
      }, []);

      async function onWake() {
        if (waking) return;
        setWaking(true);
        try {
          await fetch("/agent-dock/wake", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        } catch (err) { /* 轮询会反映状态 */ }
        setTimeout(function () { setWaking(false); }, 3000);
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
            style: buttonStyle(state.mine ? {} : idleStyle),
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
        return react.createElement("span", {
          style: Object.assign({}, baseStyle, { cursor: "default", borderColor: meta.color, color: meta.color }),
          title: (state.mine.name || state.mine.pane) + " · " + meta.label + (state.mine.workspace ? " · " + state.mine.workspace : "")
        }, dot, meta.label);
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

    var inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-agent-dock: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "agent-dock-wake",
          order: 60,
          label: function () { return t("wake"); },
          locale: NS,
          inject: function () { return { t: t }; }
        }, function () { return react.createElement(AgentDockWidget, { t: t }); });
      });
    }

    exports.name = "dsh-agent-dock";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});

