// client.js — dsh-sync 的浏览器半边：设置 → 内置插件 里的一张配置卡片。
//
// 为什么需要它：宿主 0.2.1-rc.2 的 dsh-settings 明确写着 autoGenerate
// 「for clients that build pages from the schema; no shipped client does so yet」——
// 只导出 Config 的插件在设置里根本不会出现任何卡片。想让默认值和本机状态可见，
// 只能自己注册一个 settings.plugins.tab 贡献。
//
// 结构照 dsh-outline 的做法（手写单文件 IIFE、不引 tsdown/React 打包链）：
//   · 配置读写走 configForms 共享表单（命名空间 = 本插件在 cordis.patch.yml 里的 entry id = "sync"）；
//   · 只读状态走宿主已认证的 /api 围栏（宿主半 lib/status.js 注册）。
// 两件事分开：表单失败不该连累状态显示，状态失败也不该让配置区变灰。
window.__ModuleLoader__.load({
  id: "dsh-sync",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");

    // 字典命名空间（渲染器只对声明了 locale 的条目注入 props.t）
    const NS = "settings.sync";
    // settings 命名空间 / configForms key / cordis entry id 三者同名
    const NS_KEY = "sync";

    /** 卡片要编辑的字段。顺序即渲染顺序。 */
    const FIELDS = ["outDir", "profile", "includeState", "includePlugins"];
    /** 字段类型：text 走输入框，bool 走开关。 */
    const TEXT_FIELDS = ["outDir", "profile"];
    const BOOL_FIELDS = ["includeState", "includePlugins"];

    /**
     * 状态端点。
     * ⚠️ 宿主半 lib/status.js 的 OVERVIEW_ROUTE 是同一个值，两处各写一份（浏览器半不能
     * import 宿主模块）。改一处必须改两处。
     */
    const ROUTE = "/api/dsh-sync/overview";

    /**
     * 设备端点。
     * ⚠️ 宿主半 lib/status.js 的 DEVICES_ROUTE 是同一个值，两处各写一份（浏览器半不能
     * import 宿主模块）。改一处必须改两处，有测试钉住。
     */
    const DEVICES_ROUTE = "/api/dsh-sync/devices";

    /**
     * 迁移通道（发起 + 查进度）。
     * ⚠️ 宿主半 lib/migrate.js 的 MIGRATE_ROUTE 是同一个值，两处各写一份。
     */
    const MIGRATE_ROUTE = "/api/dsh-sync/migrate";

    const zh = {
      cardTitle: "dsh-sync 迁移",
      cardDescription: "把整台机器的 dsh 状态导出，落到另一台机器：声明层 / 状态层 / 工作区层。",
      expand: "展开",
      collapse: "收起",
      configured: "已配置",
      defaults: "默认值",
      unsaved: "未保存",
      // 策略组
      policyTitle: "导出默认值",
      policyHint: "这里只决定「不传参数时用什么」。每次导出仍可用工具参数覆盖。",
      outDir: "输出目录",
      outDirHint: "bundle 直接写在这个目录里（manifest.json、state/、plugins/ 都在这层）。",
      profileName: "Profile",
      profileNameHint: "* 表示导出全部 profile；桌面版通常是 desktop。",
      includeState: "携带状态层",
      includeStateHint: "sessions / storages / skills。不搬的话新机器能用但历史全空。",
      includePlugins: "携带 link: 插件源码",
      includePluginsHint: "把本地开发的插件源码一起打包，否则目标机上这些插件无法解析。",
      secretNote: "凭据（.credentials.yaml）不在这里保存——任何表单都不落密钥。下面的口令只用于本次迁移的解密，按次填写、不落盘。",
      readOnly: "当前设置只读。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      saveFailed: "保存失败，再试一次。",
      discard: "放弃改动",
      reset: "还原默认",
      overridden: "已覆盖",
      // 状态组
      statusTitle: "本机状态",
      statusRefresh: "刷新",
      statusLoading: "读取中…",
      statusFailed: "读不到状态（宿主未提供接口，或旧版本）。配置区不受影响。",
      statusRetry: "重试",
      rowMachine: "机器",
      rowRuntime: "dsh",
      rowState: "状态层",
      rowBundle: "输出目录",
      rowLan: "局域网",
      unknown: "—",
      noBundle: "还没有 bundle",
      bundleOk: "已有 bundle",
      bundleFrom: "来自",
      bundleFiles: "文件",
      bundleEncrypted: "已加密",
      bundlePlain: "含明文凭据",
      lanIdle: "发送端未运行",
      lanRunning: "运行中 · 端口 {port}",
      lanPair: "配对码 {code}",
      lanJobs: "{total} 个任务（{running} 个进行中）",
      sessions: "会话 {n}",
      workspaces: "工作区 {n}",
      skills: "skills {n}",
      profiles: "profile {n}",
      sourceDesktop: "桌面版",
      sourceRuntimes: "运行时快照",
      sourceModules: "profile 依赖",
      sourceCli: "CLI",
      // 设备区
      devicesTitle: "局域网设备",
      devicesScan: "扫描",
      devicesScanning: "扫描中…",
      devicesHint: "只列出已开启发送端的机器。展开卡片时会先广播一次；没找到再点「扫描」全量找一遍。",
      devicesIdle: "点「扫描」查找局域网里的机器",
      devicesEmpty: "没有找到开着的发送端",
      devicesEmptyWhy: "常见：源机还没起发送端、两台不在同一子网、防火墙拦了 UDP 38472 与 TCP 38473。",
      devicesSelected: "已选中",
      devicesAutoPicked: "只找到这一台，已自动选中",
      devicesPick: "点一台设备选中它",
      devicesStale: "选中的设备已不在最新列表（对方可能关了发送端），请重新扫描",
      devicesNext: "已选 {alias}：下面填配对码 → 点「开始迁移」→ 在源机页面点「接受」。",
      devicesFiles: "{files} 个文件 · {bytes}",
      devicesNoBundle: "未报告体积",
      devStatePairing: "等待配对",
      devStateWaiting: "有请求待确认",
      devicesFailed: "读不到设备列表（宿主未提供接口，或旧版本）",
      // 迁移区
      migrateTitle: "开始迁移",
      migrateHint: "从选中的机器拉 bundle 到本机并落地。配对码在源机页面上。",
      migrateCode: "配对码",
      migrateCodeHint: "源机页面 / dshsync_lan_host 输出里的 6 位数字",
      migrateDest: "收到哪",
      migrateDestHint: "本机放 bundle 的目录，不能在 $DSH_HOME 内部",
      migrateRoot: "项目代码落到",
      migrateRootHint: "bundle 含工作区时必填；各项目按名字展开在这个目录下",
      migratePass: "凭据口令（选填）",
      migratePassHint: "导出时给了 credentialPassphrase 就填同一个；只在本次迁移的内存里用，不保存",
      migrateStart: "开始迁移",
      migrateStarting: "正在发起…",
      migrateNeedSelect: "先在上面选中一台设备",
      migrateNeedCode: "填源机页面上的配对码",
      migrateWait: "还差一步：在源机页面上点「接受并开始传输」，不点就不会传。",
      migrateProgressPage: "打开进度页",
      migratePercent: "{percent}%",
      migrateFiles: "{done} / {total} 个文件",
      migrateSkip: "（跳过 {n}）",
      migrateEta: "剩余 {eta}",
      migrateDone: "迁移完成",
      migrateFailed: "迁移失败",
      migrateNoJob: "还没有迁移任务",
      migrateNext: "接下来",
      migrateLogs: "最近日志",
      // 一条龙：内容计数 / 自动接受 / 汇总判定
      willLine: "将迁移：会话 {sessions} · 插件 {plugins} · 工作区 {workspaces} · {bytes}",
      willEncrypted: "🔒 已加密（落地需要口令）",
      devicesNextAuto: "已选 {alias}：填配对码 → 点「开始迁移」。之后自动传输与落地，两端都不需要再操作。",
      migrateWaitAuto: "传输自动进行中，无需在源机操作。",
      verdictTitle: "迁移结果",
      verdictOkLine: "迁移完毕：插件正常，dsh 配置正常，可以使用",
      verdictRestart: "重启 dsh（桌面版从托盘完全退出再打开）后即与旧机一致。",
      verdictBad: "以下项目未通过，按「接下来」处理后重跑即可（已收到的文件自动跳过）：",
    };

    const en = {
      cardTitle: "dsh-sync migration",
      cardDescription: "Export an entire dsh installation and land it on another machine: declaration, state and workspace layers.",
      expand: "Expand",
      collapse: "Collapse",
      configured: "Configured",
      defaults: "Defaults",
      unsaved: "Unsaved",
      policyTitle: "Export defaults",
      policyHint: "These only decide what happens when no argument is passed. Every export can still override them.",
      outDir: "Output directory",
      outDirHint: "The bundle is written directly here (manifest.json, state/, plugins/).",
      profileName: "Profile",
      profileNameHint: "* exports every profile; the desktop app usually uses desktop.",
      includeState: "Carry the state layer",
      includeStateHint: "sessions / storages / skills. Skip it and the target works but has no history.",
      includePlugins: "Carry link: plugin sources",
      includePluginsHint: "Bundle locally developed plugin sources, or the target cannot resolve those plugins.",
      secretNote: "Credentials (.credentials.yaml) are never saved in any form. The passphrase below is used in memory for this migration run only.",
      readOnly: "Settings are read-only here.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      saveFailed: "Save failed. Try again.",
      discard: "Discard",
      reset: "Reset to default",
      overridden: "Overridden",
      statusTitle: "This machine",
      statusRefresh: "Refresh",
      statusLoading: "Reading…",
      statusFailed: "No status available (the host does not expose the route, or it is an older build). The configuration above still works.",
      statusRetry: "Retry",
      rowMachine: "Machine",
      rowRuntime: "dsh",
      rowState: "State layer",
      rowBundle: "Output directory",
      rowLan: "LAN",
      unknown: "—",
      noBundle: "No bundle yet",
      bundleOk: "Bundle present",
      bundleFrom: "from",
      bundleFiles: "files",
      bundleEncrypted: "encrypted",
      bundlePlain: "plain credentials",
      lanIdle: "Host not running",
      lanRunning: "Running · port {port}",
      lanPair: "Pairing code {code}",
      lanJobs: "{total} jobs ({running} running)",
      sessions: "{n} sessions",
      workspaces: "{n} workspaces",
      skills: "{n} skills",
      profiles: "{n} profiles",
      sourceDesktop: "desktop app",
      sourceRuntimes: "runtime snapshot",
      sourceModules: "profile deps",
      sourceCli: "CLI",
      devicesTitle: "Devices on this network",
      devicesScan: "Scan",
      devicesScanning: "Scanning…",
      devicesHint: "Only machines already serving a bundle appear. Opening the card broadcasts once; press scan for a full sweep.",
      devicesIdle: "Press scan to look for machines on this network",
      devicesEmpty: "No machine is serving a bundle",
      devicesEmptyWhy: "Usual causes: the source has not started the host yet, the two machines are on different subnets, or a firewall blocks UDP 38472 and TCP 38473.",
      devicesSelected: "Selected",
      devicesAutoPicked: "Only one machine found — selected automatically",
      devicesPick: "Click a machine to select it",
      devicesStale: "The selected machine is no longer in the latest list (it may have stopped serving). Scan again.",
      devicesNext: "Selected {alias}: enter the code below → start → accept on the source machine's page.",
      devicesFiles: "{files} files · {bytes}",
      devicesNoBundle: "size not reported",
      devStatePairing: "waiting to pair",
      devStateWaiting: "request pending",
      devicesFailed: "No device list available (the host does not expose the route, or it is an older build)",
      migrateTitle: "Start the migration",
      migrateHint: "Pull the bundle from the selected machine and land it here. The pairing code is on the source machine's page.",
      migrateCode: "Pairing code",
      migrateCodeHint: "The 6 digits from the source page / dshsync_lan_host output",
      migrateDest: "Receive into",
      migrateDestHint: "Where the bundle lands on this machine; must not be inside $DSH_HOME",
      migrateRoot: "Project code lands in",
      migrateRootHint: "Required when the bundle carries workspaces; each project expands here under its own name",
      migratePass: "Credential passphrase (optional)",
      migratePassHint: "Same passphrase used at export. Used in memory for this run only — never saved",
      migrateStart: "Start migration",
      migrateStarting: "Starting…",
      migrateNeedSelect: "Select a machine above first",
      migrateNeedCode: "Enter the pairing code from the source page",
      migrateWait: "One step left: click \"accept and start\" on the source machine's page — nothing moves until you do.",
      migrateProgressPage: "Open the progress page",
      migratePercent: "{percent}%",
      migrateFiles: "{done} / {total} files",
      migrateSkip: "（{n} skipped）",
      migrateEta: "{eta} left",
      migrateDone: "Migration finished",
      migrateFailed: "Migration failed",
      migrateNoJob: "No migration job yet",
      migrateLogs: "Recent log",
      willLine: "Will migrate: {sessions} sessions · {plugins} plugins · {workspaces} workspaces · {bytes}",
      willEncrypted: "🔒 encrypted (passphrase needed to land)",
      devicesNextAuto: "Selected {alias}: enter the code → start. Transfer and landing then run hands-free — nothing to click on either machine.",
      migrateWaitAuto: "Transfer is running automatically; nothing to do on the source machine.",
      verdictTitle: "Result",
      verdictOkLine: "Migration complete: plugins OK, dsh config OK, ready to use",
      verdictRestart: "Restart dsh (quit fully from the tray, then reopen) to finish becoming identical.",
      verdictBad: "Some items did not pass. Handle them via \"next steps\" and rerun (already-received files are skipped):",
    };

    /** 样式复刻官方 PluginCard / fields 的规则，类名加 dsh-sync- 前缀避免冲突。 */
    const CSS_TEXT = [
      ".dsh-sync-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}",
      ".dsh-sync-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-sync-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-sync-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}",
      ".dsh-sync-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dsh-sync-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
      ".dsh-sync-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}",
      ".dsh-sync-chevronOpen{transform:rotate(180deg)}",
      ".dsh-sync-badge{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-badgeOk{color:#2f9e44}",
      ".dsh-sync-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
      ".dsh-sync-groupTitle{display:flex;align-items:center;gap:8px;margin:14px 0 0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-groupHint{margin:2px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
      ".dsh-sync-field+.dsh-sync-field{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sync-head{display:flex;align-items:center;gap:8px}",
      ".dsh-sync-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dsh-sync-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
      ".dsh-sync-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-toggleRow{display:flex;align-items:flex-start;gap:10px;padding:12px 0}",
      ".dsh-sync-toggleRow+.dsh-sync-toggleRow{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sync-check{margin:3px 0 0;flex:none;width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}",
      ".dsh-sync-note{margin:12px 0 0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-kv{display:flex;gap:12px;padding:7px 0;font-size:13px;line-height:1.5}",
      ".dsh-sync-kv+.dsh-sync-kv{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sync-kvKey{flex:none;width:82px;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-kvValue{flex:1;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-all}",
      ".dsh-sync-kvMuted{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-tag{display:inline-block;margin-left:6px;border-radius:999px;padding:0 6px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-tagWarn{color:var(--dsw-alias-label-error)}",
      ".dsh-sync-actions{display:flex;align-items:center;gap:8px;padding-top:8px}",
      ".dsh-sync-link{appearance:none;border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline}",
      ".dsh-sync-link:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sync-msg{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}",
      ".dsh-sync-discard,.dsh-sync-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}",
      ".dsh-sync-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-sync-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
      ".dsh-sync-discard:disabled,.dsh-sync-save:disabled{opacity:.4;cursor:default}",
      ".dsh-sync-discard:focus-visible,.dsh-sync-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dsh-sync-devList{list-style:none;margin:6px 0 0;padding:0}",
      ".dsh-sync-dev{width:100%;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:10px;margin-top:6px;padding:8px 10px;transition:border-color .16s,background .16s}",
      ".dsh-sync-dev:hover{border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-sync-dev:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dsh-sync-devOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform)}",
      ".dsh-sync-devMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsh-sync-devName{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".dsh-sync-devMeta{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sync-devTag{margin-left:6px;border-radius:999px;padding:0 6px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);overflow:hidden;margin-top:10px}",
      ".dsh-sync-barFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .24s}",
      ".dsh-sync-start{appearance:none;border:1px solid transparent;border-radius:8px;padding:6px 16px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
      ".dsh-sync-start:disabled{opacity:.4;cursor:default}",
      ".dsh-sync-start:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dsh-sync-log{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;max-height:130px;overflow:auto}",
      ".dsh-sync-steps{margin:10px 0 0;padding:10px 12px 10px 28px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}",
      ".dsh-sync-stepsTitle{margin:10px 0 0;font-size:12px;line-height:1.5;font-weight:600;color:var(--dsw-alias-label-primary)}",
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-sync-styles")) return;
      const style = document.createElement("style");
      style.id = "dsh-sync-styles";
      style.setAttribute("data-plugin", "dsh-sync");
      style.setAttribute("data-plugin-css", "dsh-sync");
      style.textContent = CSS_TEXT;
      document.head.appendChild(style);
    }

    /** 极简 SnapshotStore：满足槽位渲染器对 hooks 的 getSnapshot/subscribe 契约。 */
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set: (next) => {
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * 表单控制器：把 configForms 的快照投影成卡片状态，提供 edit/toggle/reset/save/discard。
     * 写回只走 form.set(key, value)（0.2.0 的唯一写入面）；旧宿主的 scope.set/unset 不再兼容，
     * 因为 0.2.0 已经删掉 settingsScope —— 没有就如实显示只读，而不是猜一个能写的方法。
     */
    function createController(form) {
      const live = form !== null && form !== undefined && typeof form.getSnapshot === "function";
      let draft = {};
      let saving = false;
      let failed = false;
      let saved = false;

      const snapOf = () => {
        if (!live) return {};
        try { return form.getSnapshot() || {}; } catch { return {}; }
      };
      // 0.2.0 的 value 已是普通值；旧宿主可能给 Volatile 包装。双形态取值。
      const readValue = (v) => (v !== null && typeof v === "object" && typeof v.get === "function" ? v.get() : v);

      const store = createStore({
        available: live,
        writable: live && typeof form.set === "function",
        dirty: false,
        saving: false,
        failed: false,
        saved: false,
        configured: false,
        outDir: "",
        profile: "",
        includeState: true,
        includePlugins: true,
      });

      function project() {
        const snap = snapOf();
        const value = snap.value && typeof snap.value === "object" ? snap.value : {};
        const user = snap.user && typeof snap.user === "object" ? snap.user : {};
        const pick = (name) => {
          if (draft[name] !== undefined) return draft[name];
          return readValue(value[name]);
        };
        return {
          available: live,
          writable: live && typeof form.set === "function",
          dirty: Object.keys(draft).length > 0,
          saving,
          failed,
          saved,
          // 「已配置」= 用户显式覆盖过至少一个字段。value 恒含 schema 默认值，
          // 拿它判非空会让徽章永远是「已配置」，没有信息量。
          configured: Object.keys(user).length > 0,
          overridden: Object.keys(user),
          outDir: typeof pick("outDir") === "string" ? pick("outDir") : "",
          profile: typeof pick("profile") === "string" ? pick("profile") : "",
          includeState: pick("includeState") !== false,
          includePlugins: pick("includePlugins") !== false,
        };
      }

      const emit = () => store.set(project());
      if (live && typeof form.subscribe === "function") form.subscribe(() => emit());
      emit();

      const clearTransient = () => { saved = false; failed = false; };

      return {
        store,
        actions: {
          edit: (name, next) => {
            draft[name] = next;
            clearTransient();
            emit();
          },
          resetField: (name) => {
            // 0.2.0 没有 unset：写回 schema 默认值即等价（用户层不再覆盖该键由宿主决定）。
            draft[name] = TEXT_FIELDS.indexOf(name) >= 0 ? "" : true;
            clearTransient();
            emit();
          },
          discard: () => {
            draft = {};
            clearTransient();
            emit();
          },
          save: () => {
            if (saving || !live || typeof form.set !== "function") return;
            const ops = Object.keys(draft).map((name) => ({ name, value: draft[name] }));
            if (ops.length === 0) return;
            saving = true;
            failed = false;
            saved = false;
            emit();
            Promise.all(ops.map((op) => form.set(op.name, op.value))).then(
              () => { draft = {}; saving = false; saved = true; emit(); },
              () => { saving = false; failed = true; emit(); },
            );
          },
        },
      };
    }

    /**
     * 拉一次状态。
     * 双重校验（HTTP 状态 + body.ok）后才采纳：把错误对象当数据渲染是本项目踩过的坑。
     */
    async function fetchOverview() {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      if (body === null || typeof body !== "object" || body.ok !== true) throw new Error("route returned no status");
      if (body.counts === null || typeof body.counts !== "object") throw new Error("status payload is incomplete");
      return body;
    }

    function fmtCount(n) {
      return typeof n === "number" && n >= 0 ? String(n) : "—";
    }

    function fmtBytes(n) {
      if (typeof n !== "number" || !(n > 0)) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      let v = n;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return (i === 0 ? v : Math.round(v * 10) / 10) + " " + units[i];
    }

    function fmtTime(iso) {
      if (typeof iso !== "string" || iso === "") return "";
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return iso;
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (m, key) => (vars[key] === undefined ? m : String(vars[key])));
    }

    function ChevronIcon(props) {
      return React.createElement(
        "svg",
        {
          className: "dsh-sync-chevron" + (props.open ? " dsh-sync-chevronOpen" : ""),
          width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": true,
        },
        React.createElement("path", {
          d: "M4 6l4 4 4-4",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    function TextField(props) {
      return React.createElement(
        "div", { className: "dsh-sync-field" },
        React.createElement(
          "div", { className: "dsh-sync-head" },
          React.createElement("label", { className: "dsh-sync-label", htmlFor: props.id }, props.label),
          props.overridden
            ? React.createElement("span", { className: "dsh-sync-badge" }, props.overriddenLabel)
            : null,
          props.overridden && !props.disabled
            ? React.createElement("button", {
              type: "button", className: "dsh-sync-link", onClick: props.onReset,
            }, props.resetLabel)
            : null,
        ),
        React.createElement("input", {
          id: props.id,
          className: "dsh-sync-input",
          type: props.inputType || "text",
          value: props.value,
          placeholder: props.placeholder || "",
          disabled: props.disabled,
          onChange: (event) => { props.onEdit(event.currentTarget.value); },
        }),
        React.createElement("p", { className: "dsh-sync-hint" }, props.hint),
      );
    }

    function ToggleRow(props) {
      const id = props.id;
      return React.createElement(
        "div", { className: "dsh-sync-toggleRow" },
        React.createElement("input", {
          id,
          className: "dsh-sync-check",
          type: "checkbox",
          checked: props.checked,
          disabled: props.disabled,
          onChange: (event) => { props.onToggle(event.currentTarget.checked); },
        }),
        React.createElement(
          "div", { className: "dsh-sync-headText" },
          React.createElement("label", { className: "dsh-sync-label", htmlFor: id }, props.label),
          React.createElement("p", { className: "dsh-sync-hint" }, props.hint),
        ),
      );
    }

    function KvRow(props) {
      return React.createElement(
        "div", { className: "dsh-sync-kv" },
        React.createElement("span", { className: "dsh-sync-kvKey" }, props.label),
        React.createElement("span", {
          className: "dsh-sync-kvValue" + (props.muted ? " dsh-sync-kvMuted" : ""),
        }, props.children),
      );
    }

    /** 状态区：加载中 / 失败 / 就绪三态，任何一态都不影响上面的配置区。 */
    function StatusBlock(props) {
      const t = props.t;
      const status = props.status;
      const data = props.data;
      const head = React.createElement(
        "div", { className: "dsh-sync-actions" },
        React.createElement("p", { className: "dsh-sync-groupTitle", style: { flex: 1, margin: 0 } }, t("statusTitle")),
        React.createElement("button", {
          type: "button",
          className: "dsh-sync-link",
          disabled: status === "loading",
          onClick: props.onRefresh,
        }, status === "error" ? t("statusRetry") : t("statusRefresh")),
      );

      if (status === "loading") {
        return React.createElement("div", null, head,
          React.createElement("p", { className: "dsh-sync-hint", role: "status" }, t("statusLoading")));
      }
      if (status === "error") {
        return React.createElement("div", null, head,
          React.createElement("p", { className: "dsh-sync-hint", role: "status" }, t("statusFailed")));
      }
      if (!data) return React.createElement("div", null, head);

      const machine = data.machine || {};
      const runtime = data.runtime || {};
      const counts = data.counts || {};
      const bundle = data.bundle || null;
      const lan = data.lan || {};
      const rows = [];

      const machineText = [machine.hostname, machine.user ? "(" + machine.user + ")" : ""]
        .filter((s) => s !== "").join(" ");
      rows.push(React.createElement(KvRow, { key: "machine", label: t("rowMachine"), muted: machineText === "" },
        machineText === "" ? t("unknown") : machineText));

      const sourceMap = {
        "desktop-app": t("sourceDesktop"),
        "dsh-runtimes": t("sourceRuntimes"),
        "profile-node-modules": t("sourceModules"),
        "dsh-cli": t("sourceCli"),
      };
      const runtimeText = runtime.version
        ? runtime.version + (runtime.source && sourceMap[runtime.source] ? " · " + sourceMap[runtime.source] : "")
        : t("unknown");
      rows.push(React.createElement(KvRow, { key: "runtime", label: t("rowRuntime"), muted: !runtime.version },
        runtimeText));

      const parts = [];
      if (counts.sessions >= 0) parts.push(fill(t("sessions"), { n: fmtCount(counts.sessions) }));
      if (counts.workspaces >= 0) parts.push(fill(t("workspaces"), { n: fmtCount(counts.workspaces) }));
      if (counts.skills >= 0) parts.push(fill(t("skills"), { n: fmtCount(counts.skills) }));
      if (counts.profiles >= 0) parts.push(fill(t("profiles"), { n: fmtCount(counts.profiles) }));
      rows.push(React.createElement(KvRow, { key: "state", label: t("rowState"), muted: parts.length === 0 },
        parts.length === 0 ? t("unknown") : parts.join(" · ")));

      if (bundle === null) {
        rows.push(React.createElement(KvRow, { key: "bundle", label: t("rowBundle"), muted: true }, t("unknown")));
      } else if (!bundle.valid) {
        rows.push(React.createElement(KvRow, { key: "bundle", label: t("rowBundle"), muted: true },
          React.createElement("span", null,
            t("noBundle"),
            React.createElement("span", { className: "dsh-sync-tag" }, bundle.dir || ""))));
      } else {
        rows.push(React.createElement(KvRow, { key: "bundle", label: t("rowBundle") },
          React.createElement("span", null,
            t("bundleOk") + " · " + fmtTime(bundle.exportedAt),
            React.createElement("span", { className: "dsh-sync-tag" }, fill(t("bundleFiles"), { n: fmtCount(bundle.files) })),
            bundle.sourceHost
              ? React.createElement("span", { className: "dsh-sync-tag" }, t("bundleFrom") + " " + bundle.sourceHost)
              : null,
            bundle.encrypted
              ? React.createElement("span", { className: "dsh-sync-tag" }, t("bundleEncrypted"))
              : null,
            bundle.includesCredentials
              ? React.createElement("span", { className: "dsh-sync-tag dsh-sync-tagWarn" }, t("bundlePlain"))
              : null)));
      }

      const lanHost = lan.host;
      let lanText;
      if (!lanHost) {
        lanText = t("lanIdle");
      } else {
        const bits = [fill(t("lanRunning"), { port: lanHost.port })];
        if (lanHost.pair && lanHost.pair.code) {
          const code = String(lanHost.pair.code);
          bits.push(fill(t("lanPair"), {
            code: code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code,
          }));
        }
        lanText = bits.join(" · ");
      }
      if (typeof lan.total === "number" && lan.total > 0) {
        lanText += " · " + fill(t("lanJobs"), { total: lan.total, running: lan.running || 0 });
      }
      rows.push(React.createElement(KvRow, { key: "lan", label: t("rowLan"), muted: !lanHost }, lanText));

      return React.createElement("div", null, head, rows);
    }

    /**
     * 调设备端点。
     * 与状态端点同样双重校验（HTTP 状态 + body.ok）；但选错设备的报错要**显示给用户**
     * （「没匹配 / 匹配到多台」都是正常的输入错误），所以把 error.message 带出来。
     */
    async function postDevices(payload) {
      const response = await fetch(DEVICES_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      if (body === null || typeof body !== "object" || body.ok !== true) {
        const detail = body && body.error && body.error.message ? body.error.message : "devices route failed";
        throw new Error(detail);
      }
      return body;
    }

    function fmtEta(ms) {
      if (typeof ms !== "number" || !(ms > 0)) return "";
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + "s";
      return Math.floor(sec / 60) + "m" + (sec % 60) + "s";
    }

    function fmtSpeed(bps) {
      return typeof bps === "number" && bps > 0 ? fmtBytes(bps) + "/s" : "";
    }

    /** 调迁移通道。校验同设备端点；错误消息直接显示给用户。 */
    async function postMigrate(payload) {
      const response = await fetch(MIGRATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      if (body === null || typeof body !== "object" || body.ok !== true) {
        const detail = body && body.error && body.error.message ? body.error.message : "migrate route failed";
        throw new Error(detail);
      }
      return body;
    }

    /** 进度那一行：百分比 · 文件数 · 速率 · 剩余。缺哪段就少哪段，不补占位符。 */
    function progressText(t, job) {
      const p = job && job.progress ? job.progress : null;
      const files = p && p.files ? p.files : {};
      const bits = [fill(t("migratePercent"), { percent: Math.round(typeof p.percent === "number" ? p.percent : 0) })];
      if (typeof files.total === "number" && files.total > 0) {
        let text = fill(t("migrateFiles"), { done: fmtCount(files.done), total: fmtCount(files.total) });
        if (files.skipped > 0) text += fill(t("migrateSkip"), { n: fmtCount(files.skipped) });
        bits.push(text);
      }
      const speed = fmtSpeed(p && p.bps);
      if (speed !== "") bits.push(speed);
      const eta = fmtEta(p && p.etaMs);
      if (eta !== "") bits.push(fill(t("migrateEta"), { eta }));
      return bits.join("   ");
    }

    function devStateLabel(t, state) {
      if (state === "pairing") return t("devStatePairing");
      if (state === "waiting") return t("devStateWaiting");
      return state === null || state === undefined ? "" : String(state);
    }

    /** 设备行要显示的三段：地址:端口 · 体积 · 状态。 */
    function deviceMeta(t, d) {
      const parts = [
        d.address + ":" + d.port,
        d.files > 0 ? fill(t("devicesFiles"), { files: fmtCount(d.files), bytes: fmtBytes(d.bytes) }) : t("devicesNoBundle"),
        devStateLabel(t, d.state),
      ].filter((s) => s !== "").join("   ");
      // 0.18 起广播里带内容计数：选中之前就知道「将迁移什么」——旧发送端没有这些
      // 字段时是 undefined，这一行就不出现。
      let will = "";
      if (d.sessions !== undefined && d.plugins !== undefined) {
        will = " " + fill(t("willLine"), {
          sessions: fmtCount(d.sessions),
          plugins: fmtCount(d.plugins),
          workspaces: d.workspaces !== undefined ? fmtCount(d.workspaces) : "—",
          bytes: fmtBytes(d.bytes),
        });
        if (d.encrypted) will += " · " + t("willEncrypted");
      }
      return parts + will;
    }

    /**
     * 设备区：扫描 → 列表 → 点选。
     * 「迁移」本身不在这里发起 —— 它需要源机页面上的 6 位配对码和一次人工点「接受」，
     * 放在对话里由工具承担更稳（卡片只负责把目标机器定下来）。
     */
    function DevicesBlock(props) {
      const t = props.t;
      const dev = props.dev;
      const head = React.createElement(
        "div", { className: "dsh-sync-actions" },
        React.createElement("p", { className: "dsh-sync-groupTitle", style: { flex: 1, margin: 0 } }, t("devicesTitle")),
        React.createElement("button", {
          type: "button",
          className: "dsh-sync-link",
          disabled: dev.status === "loading",
          onClick: props.onScan,
        }, dev.status === "loading" ? t("devicesScanning") : t("devicesScan")),
      );
      const hint = React.createElement("p", { className: "dsh-sync-hint" }, t("devicesHint"));
      const errLine = dev.error
        ? React.createElement("p", { className: "dsh-sync-failed", role: "status" }, dev.error)
        : null;

      if (dev.status === "error" && dev.data === null) {
        return React.createElement("div", null, head, hint, errLine,
          React.createElement("p", { className: "dsh-sync-hint", role: "status" }, t("devicesFailed")));
      }

      const snapshot = dev.data;
      const list = snapshot && Array.isArray(snapshot.devices) ? snapshot.devices : [];
      const selection = snapshot && snapshot.selection ? snapshot.selection : { id: "", stale: false, device: null };

      if (list.length === 0) {
        // 三态分开说：正在找（快扫也在内）/ 还没找过 / 找过了但没有。
        // 混成一句「点扫描查找」会让正在扫描的那 1.2 秒看起来像卡住了。
        let empty;
        if (dev.status === "loading") empty = t("devicesScanning");
        else if (dev.status !== "ready") empty = t("devicesIdle");
        else empty = t("devicesEmpty");
        return React.createElement("div", null, head, hint, errLine,
          React.createElement("p", { className: "dsh-sync-hint", role: "status" }, empty),
          dev.status === "ready"
            ? React.createElement("p", { className: "dsh-sync-hint" }, t("devicesEmptyWhy"))
            : null);
      }

      const rows = list.map((d) => {
        const on = selection.id !== "" && selection.id === d.id;
        return React.createElement("li", { key: d.id },
          React.createElement("button", {
            type: "button",
            className: "dsh-sync-dev" + (on ? " dsh-sync-devOn" : ""),
            "aria-pressed": on,
            onClick: () => { props.onSelect(d.id); },
          },
          React.createElement("span", { className: "dsh-sync-devMain" },
            React.createElement("span", { className: "dsh-sync-devName" },
              d.index + ". " + d.alias,
              on ? React.createElement("span", { className: "dsh-sync-devTag" }, t("devicesSelected")) : null),
            React.createElement("span", { className: "dsh-sync-devMeta" }, deviceMeta(t, d)))));
      });

      let tail;
      if (selection.stale) {
        tail = React.createElement("p", { className: "dsh-sync-hint", role: "status" }, t("devicesStale"));
      } else if (selection.device) {
        tail = React.createElement("p", { className: "dsh-sync-note" },
          // 源机开了一条龙（autoAccept）就说清「之后不用再管」；旧发送端仍要点接受。
          fill(selection.device.autoAccept ? t("devicesNextAuto") : t("devicesNext"), { alias: selection.device.alias }),
          // 自动选中要说明：否则用户会以为自己（或别人）点过这一台。
          selection.auto
            ? React.createElement("span", { className: "dsh-sync-tag" }, t("devicesAutoPicked"))
            : null);
      } else {
        tail = React.createElement("p", { className: "dsh-sync-hint" }, t("devicesPick"));
      }

      return React.createElement("div", null, head, hint, errLine,
        React.createElement("ul", { className: "dsh-sync-devList" }, rows), tail);
    }

    /**
     * 迁移区：填配对码与两个路径 → 点开始 → 看进度与结果。
     *
     * 与对话里 `dshsync_lan_pull` 是**同一条执行路径**（宿主侧共用 lib/lan/pull-runner.js），
     * 这里只是把「结果长什么样」换成了进度条与结果行。
     * 传输在后台跑，卡片每秒轮询一次 `status` —— 不做成长连接，因为设置页随时会被关掉。
     */
    function MigrateBlock(props) {
      const t = props.t;
      const mig = props.mig;
      const form = props.form;
      const selected = props.selected;
      const job = mig.job;
      const running = Boolean(job && job.state === "running");
      const locked = running || mig.busy === true;

      const head = React.createElement(
        "div", { className: "dsh-sync-actions" },
        React.createElement("p", { className: "dsh-sync-groupTitle", style: { flex: 1, margin: 0 } }, t("migrateTitle")),
      );
      const hint = React.createElement("p", { className: "dsh-sync-hint" }, t("migrateHint"));
      const errLine = mig.error
        ? React.createElement("p", { className: "dsh-sync-failed", role: "status" }, mig.error)
        : null;

      // 免填化：口令框只在选中的设备报告「bundle 已加密」时出现 —— 不加密的 bundle
      // 这个框纯属吓人；而加密的 bundle 不填它，落地必然失败。没选中设备时先不显示。
      const needsPass = Boolean(selected && selected.encrypted);
      const inputs = [
        React.createElement(TextField, {
          key: "code", id: "dsh-sync-code", label: t("migrateCode"), hint: t("migrateCodeHint"),
          value: form.code, disabled: locked, onEdit: (value) => { props.onEdit("code", value); },
        }),
        React.createElement(TextField, {
          key: "dest", id: "dsh-sync-dest", label: t("migrateDest"), hint: t("migrateDestHint"),
          value: form.destDir, disabled: locked, onEdit: (value) => { props.onEdit("destDir", value); },
        }),
        React.createElement(TextField, {
          key: "root", id: "dsh-sync-root", label: t("migrateRoot"), hint: t("migrateRootHint"),
          value: form.workspaceRoot, disabled: locked, onEdit: (value) => { props.onEdit("workspaceRoot", value); },
        }),
        needsPass
          ? React.createElement(TextField, {
            key: "pass", id: "dsh-sync-pass", label: t("migratePass"), hint: t("migratePassHint"),
            inputType: "password",
            value: form.passphrase || "", disabled: locked, onEdit: (value) => { props.onEdit("passphrase", value); },
          })
          : null,
      ].filter(Boolean);

      let gate = null;
      if (selected === null) gate = t("migrateNeedSelect");
      else if (form.code.trim() === "") gate = t("migrateNeedCode");
      const startRow = React.createElement(
        "div", { className: "dsh-sync-actions" },
        React.createElement("button", {
          type: "button", className: "dsh-sync-start",
          disabled: locked || gate !== null,
          onClick: props.onStart,
        }, mig.busy ? t("migrateStarting") : t("migrateStart")),
        gate === null ? null : React.createElement("p", { className: "dsh-sync-hint" }, gate),
      );

      let tail;
      if (job === null) {
        tail = React.createElement("p", { className: "dsh-sync-hint" }, t("migrateNoJob"));
      } else if (running) {
        const percent = job.progress && typeof job.progress.percent === "number" ? job.progress.percent : 0;
        // autoAccept 的源机不用再叮嘱「去源机页面点接受」——那条提示会让人白跑一趟。
        const waitText = selected && selected.autoAccept ? t("migrateWaitAuto") : t("migrateWait");
        tail = React.createElement("div", null,
          React.createElement("div", { className: "dsh-sync-bar" },
            React.createElement("div", { className: "dsh-sync-barFill", style: { width: Math.max(2, Math.round(percent)) + "%" } })),
          React.createElement("p", { className: "dsh-sync-hint", role: "status" }, progressText(t, job)),
          React.createElement("p", { className: "dsh-sync-note" }, waitText));
      } else {
        const ok = Boolean(job.result && job.result.ok);
        const rows = job.result && Array.isArray(job.result.rows) ? job.result.rows : [];
        // 「下一步」来自 apply 报告（最要紧的一条是重启 dsh）。卡片上不说，
        // 用户就会以为「迁移完成」等于「现在能用」，然后在旧配置下继续干活。
        const steps = job.result && Array.isArray(job.result.nextSteps) ? job.result.nextSteps : [];
        const verdict = job.result && job.result.verdict && Array.isArray(job.result.verdict.items)
          ? job.result.verdict : null;
        tail = React.createElement("div", null,
          React.createElement("p", { className: ok ? "dsh-sync-msg" : "dsh-sync-failed", role: "status" },
            ok ? t("migrateDone") : t("migrateFailed")),
          verdict !== null
            ? React.createElement("div", { className: "dsh-sync-verdict" },
              React.createElement("p", {
                className: verdict.ok ? "dsh-sync-msg" : "dsh-sync-failed", style: { fontWeight: 600 },
              }, verdict.ok ? t("verdictOkLine") : t("verdictBad")),
              verdict.ok
                ? React.createElement("p", { className: "dsh-sync-note" }, t("verdictRestart"))
                : verdict.items.filter((it) => !it.ok).map((it, i) =>
                  React.createElement("p", { key: String(i), className: "dsh-sync-failed" },
                    "· " + it.label + (it.note ? "：" + it.note : ""))))
            : null,
          rows.map((row, i) => React.createElement(KvRow, {
            key: String(i), label: Array.isArray(row) ? String(row[0]) : "",
          }, Array.isArray(row) ? String(row[1]) : "")),
          steps.length > 0
            ? React.createElement("div", null,
              React.createElement("p", { className: "dsh-sync-stepsTitle" }, t("migrateNext")),
              React.createElement("ol", { className: "dsh-sync-steps" },
                steps.map((step, i) => React.createElement("li", { key: String(i) }, String(step)))))
            : null,
          Array.isArray(job.logs) && job.logs.length > 0
            ? React.createElement("p", { className: "dsh-sync-log" }, job.logs.slice(-8).join("\n"))
            : null);
      }

      const pageLink = mig.progressUrl
        ? React.createElement("p", { className: "dsh-sync-hint" },
          React.createElement("a", { className: "dsh-sync-link", href: mig.progressUrl, target: "_blank", rel: "noreferrer" },
            t("migrateProgressPage")))
        : null;

      return React.createElement("div", null, head, hint, errLine, inputs, startRow, tail, pageLink);
    }

    /** 卡片本体。hooks 全部在条件返回之前调用（顺序不能变）。 */
    function SyncCard(props) {
      const t = props.t;
      const state = props.useSyncCard((s) => s);
      const [open, setOpen] = React.useState(false);
      const [status, setStatus] = React.useState("idle");
      const [data, setData] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      const [dev, setDev] = React.useState({ status: "idle", data: null, error: "" });
      const [mig, setMig] = React.useState({ job: null, defaults: null, error: "", busy: false, progressUrl: "" });
      const [migForm, setMigForm] = React.useState({ code: "", destDir: "", workspaceRoot: "", passphrase: "" });

      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        setStatus("loading");
        fetchOverview().then(
          (body) => { if (alive) { setData(body); setStatus("ready"); } },
          () => { if (alive) { setData(null); setStatus("error"); } },
        );
        return () => { alive = false; };
      }, [open, nonce]);

      const quickDone = React.useRef(false);

      // 第一次展开顺手做一次「仅广播」快扫：一次 UDP 广播 + 等 1.2 秒，不打 254 个地址。
      // 用户打开这张卡片就是为了看局域网里有什么机器，让他先点一下「扫描」是白走一步；
      // 而全量扫描（广播 + 逐 IP 兜底，最长 4 秒）仍然只在点「扫描」时才走 ——
      // 「看一眼设置页」不该顺带打一整段网段。
      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        const action = quickDone.current ? "snapshot" : "quick";
        quickDone.current = true;
        if (action === "quick") setDev({ status: "loading", data: null, error: "" });
        postDevices({ action }).then(
          (body) => { if (alive) setDev({ status: "ready", data: body, error: "" }); },
          () => { if (alive) setDev({ status: "error", data: null, error: "" }); },
        );
        return () => { alive = false; };
      }, [open]);

      const scanDevices = () => {
        setDev({ status: "loading", data: null, error: "" });
        postDevices({ action: "scan" }).then(
          (body) => setDev({ status: "ready", data: body, error: "" }),
          () => setDev({ status: "error", data: null, error: "" }),
        );
      };

      // 迁移区：展开时取一次「最近任务 + 默认目录」，顺便把默认目录填进表单。
      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        postMigrate({ action: "status" }).then((body) => {
          if (!alive) return;
          setMig((s) => ({ ...s, defaults: body.defaults || s.defaults, job: body.job || s.job }));
          const defs = body.defaults || {};
          const dir = defs.destDir ? defs.destDir : "";
          const root = defs.workspaceRoot ? defs.workspaceRoot : "";
          if (dir !== "" || root !== "") {
            // 两个目录都预填默认值（配置里填过 workspaceRoot 就用它）——
            // 免填的目标是「多数人只填一个配对码」。
            setMigForm((f) => ({
              ...f,
              destDir: f.destDir === "" ? dir : f.destDir,
              workspaceRoot: f.workspaceRoot === "" ? root : f.workspaceRoot,
            }));
          }
        }, () => {});
        return () => { alive = false; };
      }, [open]);

      // 只在**有运行中任务**时才轮询；跑完就停。1 秒一次，够看又不至于刷屏。
      const jobId = mig.job === null ? "" : mig.job.id;
      const jobRunning = mig.job !== null && mig.job.state === "running";
      React.useEffect(() => {
        if (!open || !jobRunning) return undefined;
        const timer = setInterval(() => {
          postMigrate({ action: "status", jobId }).then(
            (body) => setMig((s) => ({ ...s, job: body.job || s.job })),
            () => {},
          );
        }, 1000);
        return () => clearInterval(timer);
      }, [open, jobId, jobRunning]);

      const startMigrate = () => {
        setMig((s) => ({ ...s, busy: true, error: "" }));
        postMigrate({
          action: "start",
          code: migForm.code,
          destDir: migForm.destDir,
          workspaceRoot: migForm.workspaceRoot,
          passphrase: migForm.passphrase,
        }).then(
          (body) => setMig((s) => ({
            ...s,
            busy: false,
            progressUrl: body.progressUrl || "",
            // 先放一个只有 id/state 的壳，轮询会把它补全 —— 不在这里等第一次查。
            job: { id: body.jobId, state: body.state || "running" },
          })),
          (err) => setMig((s) => ({
            ...s,
            busy: false,
            error: String(err && err.message ? err.message : err),
          })),
        );
      };

      // 选中失败不算致命：列表还在，把错误显示出来让用户改口即可。
      const pickDevice = (id) => {
        postDevices({ action: "select", id }).then(
          (body) => setDev({ status: "ready", data: body, error: "" }),
          (err) => setDev((prev) => ({
            ...prev,
            error: String(err && err.message ? err.message : err),
          })),
        );
      };

      if (!state.available) return null;

      const disabled = !state.writable || state.saving;
      const blocked = !state.dirty || state.saving;
      const overridden = Array.isArray(state.overridden) ? state.overridden : [];

      return React.createElement(
        "li", { className: "dsh-sync-card" + (open ? " dsh-sync-open" : "") },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-sync-header",
            "aria-expanded": open,
            "aria-label": t(open ? "collapse" : "expand") + ": " + t("cardTitle"),
            onClick: () => { setOpen(!open); },
          },
          React.createElement(
            "span", { className: "dsh-sync-headText" },
            React.createElement("span", { className: "dsh-sync-name" }, t("cardTitle")),
            React.createElement("span", { className: "dsh-sync-description" }, t("cardDescription")),
          ),
          React.createElement("span", {
            className: "dsh-sync-badge" + (state.configured ? " dsh-sync-badgeOk" : ""),
            role: "status",
          }, state.configured ? t("configured") : t("defaults")),
          state.dirty
            ? React.createElement("span", { className: "dsh-sync-pending" }, t("unsaved"))
            : null,
          React.createElement(ChevronIcon, { open }),
        ),
        open
          ? React.createElement(
            "div", { className: "dsh-sync-body" },
            !state.writable
              ? React.createElement("p", { className: "dsh-sync-hint", role: "status" }, t("readOnly"))
              : null,

            React.createElement("p", { className: "dsh-sync-groupTitle" }, t("policyTitle")),
            React.createElement("p", { className: "dsh-sync-groupHint" }, t("policyHint")),

            React.createElement(TextField, {
              id: "dsh-sync-outDir",
              label: t("outDir"),
              hint: t("outDirHint"),
              value: state.outDir,
              placeholder: "…/dsh-sync-bundle",
              disabled,
              overridden: overridden.indexOf("outDir") >= 0,
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              onEdit: (text) => { props.edit("outDir", text); },
              onReset: () => { props.resetField("outDir"); },
            }),
            React.createElement(TextField, {
              id: "dsh-sync-profile",
              label: t("profileName"),
              hint: t("profileNameHint"),
              value: state.profile,
              placeholder: "*",
              disabled,
              overridden: overridden.indexOf("profile") >= 0,
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              onEdit: (text) => { props.edit("profile", text); },
              onReset: () => { props.resetField("profile"); },
            }),
            React.createElement(ToggleRow, {
              id: "dsh-sync-includeState",
              label: t("includeState"),
              hint: t("includeStateHint"),
              checked: state.includeState,
              disabled,
              onToggle: (checked) => { props.edit("includeState", checked); },
            }),
            React.createElement(ToggleRow, {
              id: "dsh-sync-includePlugins",
              label: t("includePlugins"),
              hint: t("includePluginsHint"),
              checked: state.includePlugins,
              disabled,
              onToggle: (checked) => { props.edit("includePlugins", checked); },
            }),
            React.createElement("p", { className: "dsh-sync-note" }, t("secretNote")),
            React.createElement(
              "div", { className: "dsh-sync-footer" },
              state.failed
                ? React.createElement("p", { className: "dsh-sync-failed", role: "status" }, t("saveFailed"))
                : null,
              state.saved && !state.dirty
                ? React.createElement("p", { className: "dsh-sync-msg", role: "status" }, t("saved"))
                : null,
              React.createElement("button", {
                type: "button", className: "dsh-sync-discard",
                disabled: !state.dirty || state.saving,
                onClick: props.discard,
              }, t("discard")),
              React.createElement("button", {
                type: "button", className: "dsh-sync-save",
                disabled: blocked,
                onClick: props.save,
              }, t(state.saving ? "saving" : "save")),
            ),

            React.createElement(StatusBlock, {
              t,
              status,
              data,
              onRefresh: () => { setNonce(nonce + 1); },
            }),

            React.createElement(DevicesBlock, {
              t,
              dev,
              onScan: scanDevices,
              onSelect: pickDevice,
            }),

            React.createElement(MigrateBlock, {
              t,
              mig,
              form: migForm,
              selected: dev.data && dev.data.selection && !dev.data.selection.stale
                ? dev.data.selection.device
                : null,
              onEdit: (name, value) => { setMigForm((f) => ({ ...f, [name]: value })); },
              onStart: startMigrate,
            }),
          )
          : null,
      );
    }

    function tryActivate(ctx) {
      injectStyles();
      const slots = ctx.slots;
      const locale = ctx.locale;
      if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        console.warn("[dsh-sync] ctx.slots unavailable; settings card not registered");
        return false;
      }
      if (locale === undefined || typeof locale.register !== "function") {
        console.warn("[dsh-sync] ctx.locale unavailable; settings card not registered");
        return false;
      }
      const configForms = ctx.configForms;
      if (configForms === undefined || typeof configForms.get !== "function") {
        // 没有共享表单就没有可编辑的配置；此时注册一张只读卡片仍然有价值（状态照常显示）。
        console.warn("[dsh-sync] ctx.configForms unavailable; settings card will be read-only");
      }
      try {
        ctx.effect(() => locale.register(NS, { zh, en }), "dsh-sync: settings card locale");
        const t = typeof locale.bind === "function" ? locale.bind(NS) : null;
        const form = configForms && typeof configForms.get === "function" ? configForms.get(NS_KEY) : null;
        const controller = createController(form);
        slots.inject("settings.plugins.tab", () => slots.register({
          name: "settings.plugins.tab",
          id: NS_KEY,
          // 排在 AList(103) 之后：第三方插件卡片按 order 升序，本包是「迁移」类，放最后不抢位。
          order: 104,
          // locale 必须声明：渲染器只对声明了字典命名空间的条目注入 props.t，
          // 缺了它卡片里 t(...) 会抛错，整张卡片被错误边界摘掉 —— 表现为页签一片空白。
          locale: NS,
          label: t === null ? () => zh.cardTitle : () => t("cardTitle"),
          inject: () => ({ hooks: { syncCard: controller.store }, ...controller.actions }),
        }, SyncCard));
        return true;
      } catch (err) {
        console.warn("[dsh-sync] activation failed: " + (err && err.message ? err.message : err));
        return false;
      }
    }

    function apply(ctx) {
      if (tryActivate(ctx)) return;
      // 服务可能晚到（宿主启动顺序不固定）：等一等再试，而不是永久放弃。
      if (typeof ctx.on === "function") {
        ctx.on("service-added", (name) => {
          if (name === "slots" || name === "locale" || name === "configForms") tryActivate(ctx);
        });
      }
    }

    const inject = ["slots", "locale", "configForms"];

    exports.name = "dsh-sync";
    exports.inject = inject;
    exports.apply = apply;
    exports.internals = Object.freeze({
      NS,
      NS_KEY,
      ROUTE,
      DEVICES_ROUTE,
      MIGRATE_ROUTE,
      zh,
      en,
      CSS_TEXT,
      SyncCard,
      StatusBlock,
      DevicesBlock,
      MigrateBlock,
      progressText,
      postDevices,
      devStateLabel,
      deviceMeta,
      createController,
      createStore,
      fetchOverview,
      fmtBytes,
      fmtTime,
    });
    return module.exports;
  },
});
