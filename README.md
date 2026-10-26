# dsh-sync

中文 | [English](README.en.md)

把**整台机器的 dsh 状态**搬到另一台机器。换机后新机不是"能跑",而是**跟旧机一样**:
同样的设置、同样的插件、同样的历史会话、同样的工作区列表、同样的 skills 链接。

- **三层一起走**:声明层(设置 / 凭据 / 插件源码)→ 状态层(会话 / 工作区记录 / skills / 附件)→ 可选的工作区代码。
- **会话改不坏**:zstd 多帧日志只重写首帧里的 `cwd`,事件帧逐字节原样保留。
- **落地即核对**:15 项检查逐条给 PASS / FAIL / WARN,不给"应该没问题"。
- **能再迁一次**:`merge=true` 先出分歧清单,未决议就停在写盘之前。
- **可撤销**:`dshsync_undo` 按落地账本回退一次导入,内容改过的文件自动跳过。

两条路:手动搬 bundle(导出 → 拷 → 落地 → 核对),或**局域网直传**(配对后一条命令拉过去、落地并核验)。

> **方向**:跑 `dshsync_export` 的那台是**源机(旧)**;跑 `dshsync_apply` / `dshsync_lan_pull` 的那台是**目标机(新)**。
> 方向由"在哪台跑哪个工具"决定,不靠猜。

## 安装

```sh
dsh plugin --profile web add github:huangfuren/dsh-sync
```

桌面端把 `web` 换成 `desktop`。**新旧两台都要装**,发送端与落地端在同一个包里;装完**重启 dsh**
(9 个工具与 3 条同源路由在启动时注册)。也可在插件市场搜 `dsh-sync`。

要求 node ≥ 22.19(包声明);会话改写依赖内建 zstd(22.15+ 或 24)。局域网直传需两台在同一网段。

## 快速开始

三步:旧机导出 → 搬过去 → 新机落地。

### 1. 旧机导出

```
dshsync_export(profile="*", includeWorkspaces=true, credentialPassphrase="<口令>", preview=true)
```

`preview=true` 只扫描不写盘,确认清单后去掉它真跑。工作区按名勾选(`workspaces=["dsh-chat"]`),
不传即全选。真跑那次加 `autoHost=true`,bundle 写完后**立刻就地起发送端**,配对码与进度页在同一次输出里返回。

### 2. 搬过去

**A. 局域网直传(推荐)** —— 旧机已起发送端(`autoHost`,或单独 `dshsync_lan_host()`)。新机上:

- 卡片里点:设置 → 内置插件 → **dsh-sync 迁移** → 扫描 → 选一台 → 填配对码 → 开始迁移;
- 或对话里:`dshsync_lan_discover()` 找机器,再
  `dshsync_lan_pull(deviceId="1", code="123456", destDir="...")`。

接收逐文件核 sha256 → 自动 `apply`(含依赖重装)→ 自动 `verify`。**中断了重跑同一条命令**,已收且哈希一致的文件自动跳过。

**B. 手动拷** —— 整个目录拷到新机(U 盘 / 共享盘都行)。bundle 自带 `apply.ps1` / `apply.sh`,
目标机不装插件也能落地声明层与状态层,但**不解包工作区、也不改写会话**。

### 3. 新机落地

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              workspaceRoot="E:/code",     # 新机上的项目根目录
              dryRun=true)                 # 先预演
```

带了工作区代码时,**一个 `workspaceRoot` 就够**:会话 cwd、工作区路径、skills 软链一起改到它下面。
只搬 `.dsh` 时给映射:`mappings=[{"from":"D:/deepseek","to":"E:/code"}]`。

**落地之后**:完全退出 dsh(桌面版从托盘退出)→ 重开,宿主按新 `package.json` 重建依赖;插件列表若是空的,
去插件管理器点一次「重新安装 / 修复」再重启;**先别在界面里改设置**,免得宿主把内存里的旧配置写回。

### 核对

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

15 项检查逐条给结论。`FAIL` 的含义是**这部分状态 dsh 看不到**,不是"可能有点问题"。

## 再迁一次(第二次及以后)

目标机已经用过一段时间时,它装过的插件、注册的工作区、改过的设置**不在源机快照里**,直接覆盖就没了。
所以第二次开始加 `merge=true`:先比 bundle 与本机现状,**任一项未决议就停在写盘之前**。

分歧分四类,用 `resolutions` 逐项决定:

| 类别 | 取值 |
|---|---|
| `plugins` | `keep-target`(留本机装的)/ `take-source` |
| `workspaces` | `keep-target` / `take-source` |
| `settings` | `target` / `source` 二选一 |
| `sessions` | `skip` / `append-missing`(只补本机缺的日志)/ `prefer-source` / `prefer-target` |

**没填的项没有默认值** —— 宁可让你多看一眼,也不替你猜。第一次迁移目标机是空的,不用开 merge。

## 工具

| 工具 | 在哪跑 | 说明 |
|---|---|---|
| `dshsync_export` | 源机 | 导出 bundle(源机只读)。`autoHost=true` 打包完就地起发送端 |
| `dshsync_apply` | 目标机 | 落地 + 工作区解包 + 路径映射 + 会话改写 + 软链重建 + 依赖重装。支持 `dryRun`、`merge` |
| `dshsync_undo` | 目标机 | 按落地账本撤销最近一次 apply:新建的删、覆盖的还原、软链还原。内容变过的自动跳过 |
| `dshsync_verify` | 目标机 | 逐条核对一致性 |
| `dshsync_lan_host` | 源机 | 起发送端,给配对码与进度页。`action="renew"` 换码、`"stop"` 关停 |
| `dshsync_lan_discover` | 目标机 | 找局域网里开着的发送端(UDP 广播,兜底逐地址扫描) |
| `dshsync_lan_pull` | 目标机 | 配对 → 接收 → 落地 → 核验,一条命令;后台执行,立即返回 jobId |
| `dshsync_lan_status` | 两端 | 查进度、速率与最终结果 |
| `dshsync_remap` | 本机 | 迁移完成后目录又动了:就地重映射五个落点,不拷数据 |

## 配置

**设置 → 内置插件 → dsh-sync 迁移**。卡片里的四项可编辑:`profile`(`*` = 全部)、`outDir`、
`includePlugins`、`includeState`。其余按次传参:

| 参数 | 默认 | 说明 |
|---|---|---|
| `includeCredentials` | `false` | 是否带 `.credentials.yaml`(真实密钥) |
| `credentialPassphrase` | 空 | ≥6 位:settings 与凭据**加密**搬运(AES-256-GCM) |
| `includeWorkspaces` | `false` | 是否把会话的项目目录一起打包 |
| `includeGit` | `true` | 打包工作区时保留 `.git` |
| `workspaceRoot` | 空 | 目标机上的项目根目录 |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | harness home |

前两项**故意不进表单**:前者一键把明文凭据打进 bundle,后者若进表单会把口令明文写进 `settings.yaml`。

**密钥策略**:推荐给 `credentialPassphrase`(口令错或文件被改,解密直接失败);默认不带凭据(settings 里的明文密钥行剔除并告警);
仅在可信信道才用 `includeCredentials` 明文携带,用完立刻删。

## 已知限制

- **`node_modules` 不随行**:目标机要重建依赖(桌面版退出重开自动重建;web 跑 `pnpm install` 或 `dsh plugin add`)。
- **目标机 node 要够新**:包要求 ≥ 22.19,会话改写还需要内建 zstd(22.15+ 或 24)。不满足时会话不迁移并明确告警,不静默跳过。
- **工作区代码默认不带**:不打开 `includeWorkspaces` 时会话能列出但打不开;打开后体积从百 MB 涨到 GB 级。
  落位目录已存在且非空时**拒绝覆盖**,要显式 `overwriteWorkspaces=true`。
- **外部软链要有对应路径**:`skills/` 下指向 `$DSH_HOME` 外的链接,目标机缺目录时如实报 WARN(I6b),不偷改指向。
- **宿主跨 `major.minor`** 时插件可能被启动时拒装,需在插件管理器逐个授予精确版本豁免。
- **传输任务状态在内存里**:插件重载或重启 DSH 后 `jobId` 失效,重跑 `dshsync_lan_pull` 按哈希续传。
- **Windows 首次监听会弹防火墙**,选「专用网络」允许;进度页是浏览器页面,不在 DSH 界面里。

## 开发

```bash
npm run check   # node --check 全部源文件
npm test        # 261 个测试
```

测试用合成数据(自建 zstd 多帧 + 临时 dshHome),不读真实 `$DSH_HOME`、不访外网;局域网用例只走 `127.0.0.1`。

## License

MIT。原创 JavaScript,零第三方运行时依赖(仅 Node 内置模块);设计上参考过若干公开 MIT 项目的结论而非源码,
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
