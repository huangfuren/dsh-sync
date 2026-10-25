// lib/lan/page.js — 进度页（服务端渲染的静态骨架 + SSE 增量更新）。零依赖。
//
// 为什么是浏览器页面而不是 DSH 界面里的面板：
//   DSH 的工具接口（dsh-tools 0.1.0-rc.6 的 DefineToolOptions）只有 execute 与
//   presentCall/presentResult，**没有执行期流式通道**。想在对话里看到实时进度，
//   只能等工具返回，而那正是最不需要它的时刻。所以进度走本机 HTTP + SSE：
//   不依赖客户端 UI 包、不需要构建链、跨 DSH 版本不坏，而且关掉页面不影响传输。
//
// 两个安全要点写在这里，因为它们是这一层独有的：
//   ① 来自对端的字符串（别名、主机名）一律转义。对方可以是任何人，主机名可以是
//      `<img onerror=...>`，直接拼进 HTML 就是一个现成的 XSS。
//   ② 「接受 / 拒绝」按钮只在 `canDecide` 为真时渲染，而 canDecide 由服务端按
//      请求源地址判定（见 host.js 的 isLocalRemote）。远端访问只拿到只读视图。
import { formatBytes, formatDuration } from './progress.js'

/** HTML 转义。同时处理 ` 与 '，因为属性值两种引号都可能用到。 */
export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 内联到 <script> 里的 JSON：转义 `<` 防止 `</script>` 提前闭合标签。 */
export function jsonForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

const STYLE = `
:root{
  color-scheme: light dark;
  --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --text:#15181c; --muted:#6b7280;
  --accent:#2563eb; --accent-weak:#eff4ff; --ok:#15803d; --ok-weak:#ecfdf3;
  --warn:#b45309; --warn-weak:#fff8eb; --bad:#b91c1c; --bad-weak:#fef2f2;
  --track:#eceef1;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#101214; --card:#191c20; --line:#2b3037; --text:#eef1f5; --muted:#9aa4b2;
    --accent:#60a5fa; --accent-weak:#17263d; --ok:#4ade80; --ok-weak:#122a1c;
    --warn:#fbbf24; --warn-weak:#2b2212; --bad:#f87171; --bad-weak:#2d1616;
    --track:#262b31;
  }
}
*{box-sizing:border-box}
body{
  margin:0; padding:32px 16px 56px; background:var(--bg); color:var(--text);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
main{max-width:760px;margin:0 auto}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.brand{font-size:14px;font-weight:600;letter-spacing:.02em;color:var(--muted)}
.badge{
  display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;
  font-size:13px;font-weight:600;background:var(--accent-weak);color:var(--accent);
}
.badge .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.badge.ok{background:var(--ok-weak);color:var(--ok)}
.badge.warn{background:var(--warn-weak);color:var(--warn)}
.badge.bad{background:var(--bad-weak);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:14px}
.card h2{margin:0 0 14px;font-size:13px;font-weight:600;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
.rows{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:14px}
.rows dt{color:var(--muted)}
.rows dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all}
.code{
  font:600 40px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.16em;color:var(--text);margin:4px 0 10px;
}
.hint{color:var(--muted);font-size:13.5px;margin:0}
.bar{height:10px;border-radius:999px;background:var(--track);overflow:hidden;margin:14px 0 10px}
.bar > i{display:block;height:100%;width:0;border-radius:999px;background:var(--accent);transition:width .25s ease}
.bar.slim{height:6px;margin:8px 0 0}
.bar.slim > i{background:var(--muted);opacity:.55}
.stats{display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;font-variant-numeric:tabular-nums}
.stats b{font-weight:600}
.stats span{color:var(--muted)}
.current{
  margin-top:12px;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;
}
.actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
button{
  font:inherit;font-weight:600;padding:10px 20px;border-radius:10px;border:1px solid transparent;
  cursor:pointer;transition:filter .15s ease;
}
button:hover{filter:brightness(.96)}
button.primary{background:var(--accent);color:#fff}
button.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
button:disabled{opacity:.55;cursor:not-allowed}
.note{font-size:13.5px;color:var(--muted);margin:12px 0 0}
.note.warn{color:var(--warn)}
.note.bad{color:var(--bad)}
.result-title{font-size:15px;font-weight:600;margin:0 0 10px}
pre.log{
  margin:0;max-height:260px;overflow:auto;font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--muted);white-space:pre-wrap;word-break:break-all;
}
.hide{display:none}
ul.errs{margin:10px 0 0;padding-left:20px;font-size:13.5px;color:var(--bad)}
footer{margin-top:22px;font-size:12.5px;color:var(--muted);text-align:center}
`

function phaseBadge(phase) {
  const map = {
    idle: ['准备中', ''],
    pairing: ['等待配对', ''],
    waiting: ['等待本机确认', 'warn'],
    transferring: ['正在传输', ''],
    verifying: ['校验与落地', ''],
    applying: ['正在落地', ''],
    done: ['已完成', 'ok'],
    failed: ['失败', 'bad'],
  }
  const [text, kind] = map[phase] || [String(phase || '未知'), '']
  return { text, kind }
}

/**
 * 渲染进度页。
 * @param {object} opts
 * @param {'host'|'client'} opts.role
 * @param {boolean} opts.local 请求是否来自本机（决定能否显示配对码与接受按钮）
 * @param {object} [opts.state] 初始状态快照（之后由 SSE 更新）
 */
export function renderPage({ role = 'host', local = false, state = {} }) {
  const initial = { role, local, ...state }
  const badge = phaseBadge(initial.phase)
  const title = role === 'host' ? 'dsh-sync · 发送端' : 'dsh-sync · 接收端'
  // 只有本机视图才提示「配对码只在屏幕上显示」；远端是只读的旁观视图。
  const subtitle = local
    ? '把下面的配对码在新机器上输入，然后在卡片里点「接受」才会开始传输。'
    : '这是只读视图：在发起请求的那台机器上操作才能接受传输。'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div class="brand">${esc(title)}</div>
    <div class="badge ${esc(badge.kind)}" id="phase-badge"><span class="dot"></span><span id="phase-text">${esc(badge.text)}</span></div>
  </header>

  <section class="card" id="code-card">
    <h2>配对码</h2>
    <div class="code" id="pair-code">— — — — — —</div>
    <p class="hint" id="pair-hint">${esc(subtitle)}</p>
    <p class="note hide" id="pair-expiry"></p>
  </section>

  <section class="card hide" id="pending-card">
    <h2>传输请求</h2>
    <dl class="rows">
      <dt>来自</dt><dd id="peer-alias">—</dd>
      <dt>机器</dt><dd id="peer-host">—</dd>
      <dt>地址</dt><dd id="peer-addr">—</dd>
      <dt>内容</dt><dd id="peer-bundle">—</dd>
    </dl>
    <div class="actions">
      <button class="primary" id="accept-btn">接受并开始传输</button>
      <button class="ghost" id="deny-btn">拒绝</button>
    </div>
    <p class="note" id="decide-note"></p>
  </section>

  <section class="card" id="progress-card">
    <h2>传输进度</h2>
    <div class="bar"><i id="bar-bytes"></i></div>
    <div class="bar slim"><i id="bar-files"></i></div>
    <div class="stats" style="margin-top:12px">
      <div><b id="pct">0%</b> <span>字节</span></div>
      <div><b id="bytes">0 B / 0 B</b></div>
      <div><b id="files">0 / 0</b> <span>文件</span></div>
      <div><b id="speed">—</b></div>
      <div><b id="eta">—</b></div>
    </div>
    <div class="current" id="current"></div>
    <p class="note hide" id="progress-note"></p>
  </section>

  <section class="card hide" id="summary-card">
    <h2>bundle 内容</h2>
    <dl class="rows" id="summary-rows"></dl>
  </section>

  <section class="card hide" id="result-card">
    <h2>结果</h2>
    <p class="result-title" id="result-title"></p>
    <dl class="rows" id="result-rows"></dl>
    <ul class="errs hide" id="result-errors"></ul>
  </section>

  <section class="card hide" id="log-card">
    <h2>日志</h2>
    <pre class="log" id="log"></pre>
  </section>

  <footer id="footer"></footer>
</main>
<script>
(function(){
  "use strict";
  var S = ${jsonForScript(initial)};
  var $ = function(id){ return document.getElementById(id); };
  var fmtBytes = function(n){
    n = Number(n) || 0;
    if (n <= 0) return "0 B";
    var u = ["B","KB","MB","GB","TB"], i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i === 0 ? String(Math.round(x)) : x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)) + " " + u[i];
  };
  var fmtDur = function(ms){
    ms = Number(ms) || 0;
    if (ms <= 0) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + "m" + (r > 0 ? " " + r + "s" : "");
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  };
  var PHASES = {
    idle:["准备中",""], pairing:["等待配对",""], waiting:["等待本机确认","warn"],
    transferring:["正在传输",""], verifying:["校验与落地",""], applying:["正在落地",""],
    done:["已完成","ok"], failed:["失败","bad"]
  };
  function setText(id, v){ var el = $(id); if (el) el.textContent = v; }
  function show(id, on){ var el = $(id); if (el) el.classList.toggle("hide", !on); }

  function render(){
    var p = S.phase || "idle";
    var ph = PHASES[p] || [p, ""];
    setText("phase-text", ph[0]);
    var badge = $("phase-badge");
    if (badge) { badge.className = "badge " + (ph[1] || ""); }

    // 配对码区：只在还没配对成功时出现
    var pair = S.pair;
    // 用过之后仍然显示：同一个码对同一台机器还能再用一次（续传），
    // 隐藏它会让「传一半断了怎么办」变成一个猜谜游戏。
    var showCode = !!pair && !pair.locked && S.local;
    show("code-card", showCode);
    if (showCode) {
      setText("pair-code", String(pair.code || "").replace(/(\\d{3})(\\d{3})/, "$1 $2"));
      var left = Number(pair.remainingMs) || 0;
      var exp = $("pair-expiry");
      if (exp) {
        exp.classList.remove("hide");
        var msg;
        if (left <= 0) {
          msg = "配对码已失效。在本机换一个新码再试（action=\\"renew\\"）。";
        } else if (pair.used) {
          msg = "这个码已经用过了。同一台机器重跑 pull 仍可续传（已收到的文件会跳过），" + fmtDur(left) + " 后失效。";
        } else {
          msg = "配对码 " + fmtDur(left) + " 后失效，且只能用一次。";
        }
        exp.textContent = msg;
        exp.className = "note" + (left > 0 ? "" : " warn");
      }
    }

    // 待确认卡片
    var pending = S.pending;
    var waiting = !!pending && pending.state === "waiting";
    show("pending-card", waiting);
    if (waiting) {
      var peer = S.peer || {};
      setText("peer-alias", peer.alias || "未知");
      setText("peer-host", peer.hostname || "未知");
      setText("peer-addr", peer.address || "未知");
      var b = pending.bundle || {};
      setText("peer-bundle", (b.files || 0) + " 个文件 · " + fmtBytes(b.bytes || 0));
      var canDecide = !!S.canDecide;
      $("accept-btn").disabled = !canDecide;
      $("deny-btn").disabled = !canDecide;
      var note = $("decide-note");
      if (note) {
        note.className = "note" + (canDecide ? "" : " warn");
        note.textContent = canDecide ? "" : "只有发起传输的那台机器能在这里决定是否接受。";
      }
    }

    // 进度
    var pr = S.progress || {};
    var pct = Number(pr.percent) || 0;
    $("bar-bytes").style.width = Math.max(0, Math.min(100, pct)) + "%";
    var fd = (pr.files && pr.files.done) || 0, ft = (pr.files && pr.files.total) || 0;
    $("bar-files").style.width = (ft > 0 ? Math.max(0, Math.min(100, fd / ft * 100)) : 0) + "%";
    setText("pct", pct.toFixed(1) + "%");
    var bd = (pr.bytes && pr.bytes.done) || 0, bt = (pr.bytes && pr.bytes.total) || 0;
    setText("bytes", fmtBytes(bd) + " / " + fmtBytes(bt));
    var skipped = (pr.files && pr.files.skipped) || 0;
    setText("files", fd + " / " + ft + (skipped > 0 ? "（续传跳过 " + skipped + "）" : ""));
    setText("speed", pr.bps > 0 ? fmtBytes(pr.bps) + "/s" : "—");
    setText("eta", pr.etaMs > 0 ? "剩余 " + fmtDur(pr.etaMs) : (p === "transferring" ? "估算中" : "—"));
    var cur = $("current");
    if (cur) { cur.textContent = pr.current || ""; cur.title = pr.current || ""; }
    var pn = $("progress-note");
    if (pn) {
      var noteText = pr.note || (pr.errorCount > 0 ? pr.errorCount + " 个文件失败" : "");
      pn.textContent = noteText;
      pn.className = "note" + (pr.errorCount > 0 ? " bad" : "");
      pn.classList.toggle("hide", !noteText);
    }

    // bundle 内容摘要（只有本机视图拿得到 S.summary；远端快照里没有这个字段）
    var sm = S.summary;
    var srows = $("summary-rows");
    if (sm && srows) {
      var pairs = [
        ["会话", sm.sessions != null ? sm.sessions + " 个" : "—"],
        ["插件", sm.plugins != null ? sm.plugins.map(function(p){ return p.name; }).join("、") : "—"],
        ["工作区", sm.workspaces != null ? (sm.workspaces.length > 0
          ? sm.workspaces.map(function(w){ return w.name + "（" + fmtBytes(w.bytes || 0) + "）"; }).join("、")
          : "未打包") : "—"],
        ["Profile", sm.profiles && sm.profiles.length > 0 ? sm.profiles.join("、") : "—"],
        ["体积", fmtBytes(sm.bytes || 0) + " · " + (sm.files || 0) + " 个文件"],
        ["凭据", sm.encrypted ? "🔒 加密搬运" : (sm.includesCredentials ? "明文包含" : "不包含")],
      ];
      srows.innerHTML = "";
      pairs.forEach(function(kv){
        var dt = document.createElement("dt"); dt.textContent = kv[0];
        var dd = document.createElement("dd"); dd.textContent = kv[1];
        srows.appendChild(dt); srows.appendChild(dd);
      });
      show("summary-card", true);
    } else {
      show("summary-card", false);
    }

    // 结果
    var r = S.result;
    show("result-card", !!r);
    if (r) {
      setText("result-title", (r.ok ? "✅ " : "❌ ") + (r.summary || ""));
      var rows = $("result-rows");
      rows.innerHTML = "";
      (r.rows || []).forEach(function(kv){
        var dt = document.createElement("dt"); dt.textContent = kv[0];
        var dd = document.createElement("dd"); dd.textContent = kv[1];
        rows.appendChild(dt); rows.appendChild(dd);
      });
      var errs = $("result-errors");
      var list = r.errors || [];
      errs.innerHTML = "";
      list.slice(0, 12).forEach(function(e){
        var li = document.createElement("li"); li.textContent = e; errs.appendChild(li);
      });
      errs.classList.toggle("hide", list.length === 0);
    }

    // 日志
    var logs = S.logs || [];
    show("log-card", logs.length > 0);
    if (logs.length > 0) { $("log").textContent = logs.join("\\n"); }

    var peerName = S.peer && S.peer.alias ? "对端：" + S.peer.alias : "";
    setText("footer", [peerName, S.self && S.self.alias ? "本机：" + S.self.alias : "", "页面可关闭，传输在后台继续"].filter(Boolean).join(" · "));
  }

  function decide(accept){
    var btns = [$("accept-btn"), $("deny-btn")];
    btns.forEach(function(b){ if (b) b.disabled = true; });
    var url = "/decide";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: !!accept }) })
      .then(function(r){ return r.json().catch(function(){ return { ok: r.ok }; }); })
      .then(function(j){
        if (!j || !j.ok) {
          var n = $("decide-note");
          if (n) { n.className = "note bad"; n.textContent = (j && j.error) || "操作失败，请重试。"; }
          btns.forEach(function(b){ if (b) b.disabled = false; });
        }
      })
      .catch(function(err){
        var n = $("decide-note");
        if (n) { n.className = "note bad"; n.textContent = "请求失败：" + err.message; }
        btns.forEach(function(b){ if (b) b.disabled = false; });
      });
  }
  var acc = $("accept-btn"); if (acc) acc.addEventListener("click", function(){ decide(true); });
  var den = $("deny-btn"); if (den) den.addEventListener("click", function(){ decide(false); });

  render();

  // SSE：服务端推全量快照。断了自动重连（EventSource 自带），页面关掉不影响传输。
  if (window.EventSource) {
    var es = new EventSource("/events");
    es.onmessage = function(ev){
      try { S = Object.assign({}, S, JSON.parse(ev.data)); render(); } catch (e) { /* 忽略坏帧 */ }
    };
  }
})();
</script>
</body>
</html>`
}

/** 一行摘要，给工具输出用（页面之外的第二处呈现）。 */
export function describeDevice(dev) {
  if (!dev) return '未知设备'
  const bits = [dev.alias || dev.hostname || dev.address]
  if (dev.address) bits.push(dev.address + (dev.port ? ':' + dev.port : ''))
  if (dev.bundle && dev.bundle.files > 0) {
    bits.push(dev.bundle.files + ' 个文件 / ' + formatBytes(dev.bundle.bytes))
  }
  return bits.join(' · ')
}

export { formatBytes, formatDuration }
