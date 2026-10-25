# dsh-sync

中文 | [English](README.en.md)

把**整台机器的 dsh 状态**搬到另一台机器 —— 换机后新机不只是"能跑",而是**跟旧机一样**:
同样的设置、同样的插件、同样的历史会话、同样的工作区列表、同样的 skills 链接。

- **三层一起走**:声明层(设置 / 凭据 / 插件源码)→ 状态层(会话 / 工作区记录 / skills / 附件)→ 可选的工作区代码。
- **会话改不坏**:zstd 多帧日志只重写首帧里的 `cwd`,事件区逐字节原样保留。
- **落地就核对**:15 项检查(I1–I14 另含 I6b)逐条给 PASS / FAIL / WARN,不是"应该没问题"。
- **能再迁一次**:`merge=true` 先出分歧清单,未决议就停在写盘之前,不静默盖掉目标机这期间的新东西。

两条路:手动搬 bundle(导出 → 拷 → 落地 → 核对),或**局域网直传**(配对后一条命令拉过去、自动落地并核验,不用 U 盘也不用网盘)。

> **术语(全文与工具输出统一按此方向)**:**源机 = 旧机** —— 有历史、要搬出去的那台,跑
> `dshsync_export` / `dshsync_lan_host`,全程只读;**目标机 = 新机** —— 刚装好、要变成跟旧机一样的
> 那台,跑 `dshsync_apply` / `dshsync_lan_pull` / `dshsync_verify`。「source」永远不指「正在配置的这台」。
>
> 方向不靠插件猜:在哪台跑导出,哪台就是源机。搞反的后果与拦截见
> 文末折叠块「先确认哪台是新机」。

## 安装

```sh
dsh plugin --profile web add github:huangfuren/dsh-sync
```

把 `web` 换成你实际使用的 profile(桌面端是 `desktop`)。**新旧两台机器都要装** —— 发送端与落地端
都在这个包里。装完**重启 dsh**:8 个工具与 3 条同源路由都在启动时注册,不重启既看不见也调不到。

也可以在插件市场(dsh-market)里搜 `dsh-sync`,从详情页一键安装。

要求:node ≥ 22.19(要有内建 zstd);走局域网直传时两台机器需在同一网段。

## 快速开始

三步:旧机导出 → 搬过去 → 新机落地并核对。

### 1. 旧机:导出

```
dshsync_export(profile="*", includeWorkspaces=true, includeCredentials=true,
              credentialPassphrase="<你记得住的口令>", preview=true)
```

先 `preview=true` 看一眼(只扫描、不写文件),确认清单后再去掉它真跑。预览会列出**工作区候选**
(路径 + 体积 + 是否含 git),按名字勾选:

```
dshsync_export(profile="*", includeWorkspaces=true, workspaces=["dsh-chat","dsh-plugin"])
dshsync_export(profile="*", includeWorkspaces=true, workspaces=["*"])   # 全选
```

不传 `workspaces` 就是全选所有**源机上存在**的候选;`includeGit=false` 可丢掉 `.git` 换体积。
产出 `dsh-sync-bundle/`,目录结构见文末折叠块「bundle 里有什么」。源机**全程只读**。

**一条龙(推荐)**:真跑那次加上 `autoHost=true` —— bundle 写完后**立刻就地起局域网发送端**,
配对码与进度页地址出现在同一次输出里,不需要再单独跑 `dshsync_lan_host`,也不需要去页面点
「接受」。之后旧机就不需要任何人守着了:

```
dshsync_export(profile="*", includeWorkspaces=true, autoHost=true)
```

### 2. 搬过去

**A. 局域网直传(推荐)** —— 不占 U 盘、不过网盘,两台机器在同一网络下走完。

`autoHost=true` 一条龙时发送端已经起好了;分开跑也可以:

```
dshsync_lan_host()                     # bundleDir 缺省取配置里的「输出目录」(= 导出时的落点)
dshsync_lan_host(bundleDir="D:/其它")  # 也可以显式指定
```

它打印 6 位配对码和进度页地址(`http://<源机IP>:38473/`),然后**立即返回** —— 服务在后台跑,
对话不会被卡十几分钟。默认要你在源机页面上点一次「接受」;加 `autoAccept=true` 则配对码对上
即开传(一条龙就是用这个模式)。

新机器上两种发起方式,任选:

- **卡片里点(推荐)**:设置 → 内置插件 → dsh-sync 迁移 → 局域网设备(**展开卡片时已经广播过一次**,
  没找到再点「扫描」全量找)→ 点选一台(**每台机器都带出「将迁移:会话 X · 插件 Y · 工作区 Z · 体积」**,
  bundle 加密的会标 🔒)→ 填配对码(**接收目录与项目根已预填默认值;口令框只在 bundle 加密时出现**)
  → 点「开始迁移」。之后卡片里直接看进度与结果,结束时先给汇总判定——全过就是
  「迁移完毕:插件正常,dsh 配置正常,可以使用」,再列落地后的下一步(最重要的一条是重启 dsh)。
- **对话里说**:先 `dshsync_lan_discover()` 列出开着发送端的机器,再
  `dshsync_lan_pull(deviceId="1", code="123456", destDir="...", workspaceRoot="E:/code")`。

两条路走的是同一份执行逻辑,负责:配对 → (手动模式)等你在**源机页面**上点「接受」→ 逐文件接收并核对
sha256 → 自动 `apply`(含依赖自动重装)→ 自动 `verify`。`dshsync_lan_status(jobId="...")` 随时查。
**中断了直接重跑同一条命令**,已收到且哈希一致的文件自动跳过。

**B. 手动拷** —— 整个文件夹拷到新电脑(U 盘 / 网盘 / 局域网共享都行)。
用 `dsh-localsend` 的通道时,目录树走 `localsend_smb_push`;它的打包器**会跳过软链**,本插件的
`links.json` 机制正是为此设计,不受影响。

> bundle 自带 `apply.ps1` / `apply.sh`,目标机**不装 dsh-sync** 也能落地声明层与状态层(含整包校验、
> 备份、回滚),但**不解包工作区代码、也不改写会话** —— 改写会话需要 zstd 帧级读写,脚本里没有现成能力。
> 要全功能请用工具;两者共用同一套映射口径,不会"脚本改一种、工具改另一种"。

### 3. 新机:落地

**bundle 里带了工作区代码时,一个 `workspaceRoot` 就够了** —— 这是换机推荐的用法:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              workspaceRoot="E:/code",     # 你在新机器上选的项目根目录
              dryRun=true)                 # 先预演
```

会话 cwd、工作区路径、skills 软链会自动改到 `workspaceRoot/<原名>` 下,不用再写映射。
预演会逐个打印「哪个工作区 → 落到哪」「哪些会话的 cwd 会被改成什么」,确认后再 `dryRun=false`。

只搬 `.dsh`、没带工作区代码时,路径不一致就给映射,否则会话指向不存在的目录:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              mappings=[{"from":"D:/deepseek","to":"E:/code"}],
              dryRun=true)
```

映射规则:**按顺序应用、首条命中即返回、命中必须落在路径段边界**
(`D:/deep` 不会碰到 `D:/deepseek/...`)。不要自创"最长前缀优先" —— 多条规则重叠时会算出
与你书写顺序不同的结果。

**目标机的 `$DSH_HOME` 可以放在任意位置。** 与源机不同时,内部软链(指向 `$DSH_HOME` 里的那些)
会从源前缀重定位到目标前缀、保留相对路径,并报告数量。用环境变量 `DSH_HOME` 指定,或在插件配置里填 `dshHome`。

**落地之后:**

1. 完全退出 dsh(桌面版从托盘退出)→ 重开,宿主按新的 `package.json` 重建依赖;
2. 重开后插件列表若是空的,去插件管理器点一次「重新安装 / 修复」再重启;
3. **先别在界面里改设置** —— 免得宿主把内存里的旧配置写回,盖掉刚落地的文件;
4. 想确认搬对了:`dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")`,
   14 项检查逐条给结论,详见文末折叠块「核对项」。

`FAIL` 的含义是:**这部分状态 dsh 看不到**。不是"可能有点问题",是确定对不上。

### 再迁一次(第二次及以后)

第一次迁移的目标机是空的,覆盖写怎么写都无所谓。**第二次不是** —— 目标机已经用了一段时间,
它自己装过插件、注册过工作区、改过设置,而这些**不在源机的快照里**,一盖就没了(备份目录里有,
但没人会去翻)。

第二次开始请加 `merge=true`:它先把 bundle 与**本机现状**比一遍,**只要还有一项没决定就停在写盘之前**,
本机一个字节都不会动:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle", workspaceRoot="E:/code", merge=true)
```

它会列出四类分歧:

| 类别 | 什么情况算分歧 |
|---|---|
| `plugins` | 本机声明里有、bundle 里没有(落地后**从声明中消失**,源码还躺在 `plugins/` 里但没人加载它);或两边都有但版本不同 |
| `workspaces` | 本机注册过、bundle 里没有的工作区记录 |
| `settings` | 两边 settings.yaml 不一样(**不做三方合并**:锚点、注释、键序在不知道 schema 的情况下并对不了,合坏的结果比任一边都糟) |
| `sessions` | 汇总一条:多少个会话两边都有但日志份数不同(会话可以有几百个,逐条列等于没列) |

然后照着清单填 `resolutions` 再跑一次(其他参数不变):

```
dshsync_apply(..., merge=true, resolutions={
  plugins:    {"desktop/dsh-outline": "keep-target"},   # 留本机装的
  workspaces: {"w-new": "keep-target"},
  settings:   "target",                                 # 保留本机设置
  sessions:   "append-missing",                         # 只补本机缺的日志
})
```

- `keep-target` = 留本机的;`take-source` = 跟源机走(本机这项就没了)。
- `settings` 是 `target` / `source` 二选一。
- `sessions` 统一给一个策略:`skip`(不动)/ `append-missing`(**只补本机缺的那几份日志**,
  已有的一个字节都不碰,包括本机自己追加的)/ `prefer-source`(以源机为准,会覆盖)/ `prefer-target`(同 skip)。
- **没填的项没有默认值** —— 这就是 merge 的意义,宁可让你多看一眼,也不能替你猜。

会话一律是**文件级**操作:绝不拆帧再重组,否则"历史不可能被破坏"这条保证就不成立了。
目标机还是空的(第一次迁移)不用开 merge,没有东西可冲突,直接覆盖更简单。

## 工具

| 工具 | 在哪跑 | 说明 |
|---|---|---|
| `dshsync_export` | 源机 | 导出 bundle。源机**只读**(只复制,从不改配置)。`autoHost=true` 时打包完立刻就地起发送端(autoAccept 模式),配对码与进度页随同一次输出返回 —— 一条龙路径 |
| `dshsync_apply` | 目标机 | 落地 + 工作区解包 + 路径重映射 + 会话改写 + 软链重建 + 依赖自动重装。支持 `dryRun`;`merge=true` 用于第二次及以后的迁移(先出分歧清单,未决即停)。每一笔变动都记进落地账本 |
| `dshsync_undo` | 目标机 | **后悔药**:按落地账本整体撤销最近一次 apply —— 新建的删、覆盖的从备份还原、软链还原旧指向、分组名改回去。落地之后内容变过的文件自动跳过并逐条报告。支持 `dryRun` |
| `dshsync_verify` | 目标机 | 逐条核对一致性 |
| `dshsync_lan_host` | 源机 | 起局域网发送端,给出配对码与进度页。`bundleDir` 缺省取配置的输出目录。`autoAccept=true` 配对即开传(默认要本机点接受)。`action="renew"` 换码、`action="stop"` 关停 |
| `dshsync_lan_discover` | 目标机 | 找局域网里开着的发送端。UDP 广播优先,逐地址扫描兜底。结果带 `id` 与序号,会被记住 |
| `dshsync_lan_pull` | 目标机 | 配对 → 等确认 → 接收 → 落地 → 核验,一条命令。可用 `deviceId` 指定(或用卡片里选中的那台)。后台执行,立即返回 jobId |
| `dshsync_lan_status` | 两端 | 查进度、速率、剩余时间,以及落地与核验的最终结果 |
| `dshsync_remap` | 本机 | **迁移完成后目录又动了**的补救:就地重映射五个落点(会话首帧 cwd → 分组目录名 → workspace.json → projcache 两层 → 软链目标),不拷任何数据。支持 `dryRun` |

### 后悔了?dshsync_undo

apply 把**每一笔**变动(新建 / 覆盖 / 软链 / 分组改名)记进备份目录里的落地账本(`journal.json`)。
`dshsync_undo` 倒序回放:新建的删掉、覆盖的从备份还原、软链还原旧指向、分组名改回去。
安全网是内容指纹:每笔操作记着「apply 写完那一刻」的 sha256,当前内容对不上的文件(典型是
你已经继续用 dsh、会话追加了新帧)**绝不碰**,逐条报告 —— 撤销永远不会拿旧快照盖掉你新产生的数据。
所以 apply 刚跑完就撤销是干净的全量回退;用过之后再撤销是"部分撤销 + 精确跳过清单"。
缺省撤最近一次(回执定位);更早的备份在存在更新 apply 时拒绝撤销 —— 一层一层退。
`dryRun=true` 先看。**删除备份目录 = 宣布这次迁移定稿**,账本随它一起消失。

`deviceId` 认 id / 1 基序号 / 别名 / IP 四种写法;`host` 与 `deviceId` 都不给时,用卡片里选中的那台。
**一个都没选过就报错并说清三条路,不会替你挑** —— 把 bundle 传给错的一方不可挽回。唯一的例外是
「只发现一台、且你还没选过」,这时自动选中并在界面上标出来;**已经选过就绝不自动改选**。

## 配置(settings 命名空间 `sync`)

设置在 **设置 → 内置插件 → dsh-sync 迁移** 这张卡片里改。卡片上半是下面标了「可编辑」的四项,
下半两块:只读的**本机状态**(会话 / 工作区 / skills 数量、默认输出目录里的 bundle、局域网发送端与任务),
以及**局域网设备 + 开始迁移**(展开即广播一次 → 点选一台 → 填配对码与两个路径 → 点开始 → 看进度、
结果与「接下来」)。整趟迁移可以在设置页里完成,不用回对话。

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | harness home |
| `profile` | `*` | 默认导出的 profile;`"*"` = 全部。**可编辑** |
| `outDir` | 临时目录 `dsh-sync-bundle` | bundle 输出目录。**可编辑** |
| `includePlugins` | `true` | 是否 vendoring `link:` 插件源码。**可编辑** |
| `includeState` | `true` | 是否带 sessions / storages / skills(关掉就只是"能用的空环境")。**可编辑** |
| `includeCredentials` | `false` | 是否带 `.credentials.yaml`(真实密钥)。**故意不可编辑**,只能按次传参 |
| `credentialPassphrase` | 空 | ≥6 位:把 settings + 凭据**加密**搬运(推荐)。**故意不可编辑**,只能按次传参 |
| `includeWorkspaces` | `false` | 是否把会话的项目目录一起打包。换机自用建议打开 |
| `includeGit` | `true` | 打包工作区时保留 `.git`(完整仓库);关掉只为省体积 |
| `workspaceRoot` | 空 | **目标机**上的项目根目录,落地时用它决定一切落位 |

后两项(`includeCredentials` / `credentialPassphrase`)不在卡片里是有意的:前者一键把明文凭据打进
bundle,后者若进表单就会明文落在 `settings.yaml` 里。它们仍然可以用工具参数按次传入。

## 密钥策略(重要)

三条路线,按推荐度排序:

1. **加密搬运(推荐)**:给 `credentialPassphrase`。settings 与凭据以 AES-256-GCM 密文进 bundle
   (scrypt 派生密钥,每包随机 salt / iv,带认证标签)。口令错或文件被改都会在解密时直接失败,
   不会解出一份错误明文。明文密钥**既不丢也不裸奔**,换机后不用挨个重填插件 key。
2. **不带凭据(默认)**:`.credentials.yaml` 不导出;settings 里的明文密钥行会被剔除并告警。
3. **明文携带(不推荐)**:`includeCredentials=true` 且不给口令 —— bundle 含裸密钥,
   只适用于可信信道,用完立刻删。

补充规则:明文密钥判据是 `*Env` 字段必须是合法引用名(`^[A-Za-z_][A-Za-z0-9_]*$`),否则视为填了明文;
`key/token/secret/password` 类字段值较长也会告警。工具**只输出脱敏预览**(前缀 + 长度),从不回显完整密钥。

## 已知限制

- **目标机需自重建依赖**:`node_modules` 不随行。落地后要在目标机装一次依赖
  (桌面版:退出重开,宿主自动重建;web:`pnpm install` 或 `dsh plugin add`),否则 dsh 起不来 ——
  verify 的 I9 会把这件事报成 WARN,不会让你以为完事了。
- **目标机 node 需 ≥ 22.15** 才有内建 zstd;否则会话不迁移(会明确告警,不静默跳过)。
- **工作区代码默认不进 bundle**:不打开 `includeWorkspaces` 时会话能列出但打不开(I8 逐个报出)。
  打开后按根打包(默认带 `.git`、排除 `node_modules`),体积会从百 MB 级涨到 GB 级,先 `preview=true` 看候选再决定。
  落位目录已存在且非空时会**拒绝**覆盖,要显式 `overwriteWorkspaces=true`。
- **外部软链需要目标机有对应路径**:`skills/` 下指向 `$DSH_HOME` 外部的链接,目标机没有那个目录时
  链接会重建失败并**如实报告**(I6b 单独报),不会偷改指向。
- **宿主版本跨 `major.minor` 时插件可能被启动时拒装**,需在插件管理器逐个授予精确版本豁免。
  版本一个都取不到时(既没有 `dsh-runtimes` 也没有 `dsh` 命令)如实报「需人工确认」,不猜。
- **`github:` 依赖在目标机首次 `add` 可能因 pnpm ≥10 的构建门被拒**;不搬 `pnpm-lock.yaml`(含源机绝对 `link:` 路径)。
- **`link:` 依赖已自动改写**为指向 `$DSH_HOME/plugins/<name>` 的相对路径,换位置也成立;
  只有**未 vendoring** 的 `link:`(源码缺失或 `includePlugins=false`)才保留源机路径,并在报告里点出来。
- **`settings.yaml` 不存在时会静默通过**:本机就没有该文件(只有历史 `.bak`),导出不会凭空造一份;
  要确认设置是否搬了,看导出报告的 `homeFiles` 列表。
- **局域网进度页是浏览器页面,不是 DSH 界面里的面板**:宿主工具接口没有执行期流式通道
  (`execute()` 只在结束时返回一次),所以进度走本机 HTTP + SSE。
- **传输任务的状态在内存里**:插件重载(改配置、升级、重启 DSH)后 `jobId` 就查不到了。已收到的文件
  留在盘上,重跑一次 `dshsync_lan_pull` 会按哈希续传。传输期间别退出 DSH。
- **Windows 首次监听会弹防火墙提示**,要选「专用网络」允许;选公用网络或取消,对方就连不上(报错会指到这一条)。
  UDP 38472 被拦时 `dshsync_lan_discover` 会自动改成逐地址扫描,只是慢两三秒。

## 开发与测试

```bash
npm run check   # node --check 全部源文件
npm test        # 247 个测试
npm run verify
```

测试全部使用**合成数据**(自建 zstd 多帧文件 + 临时 dshHome),不读真实 `$DSH_HOME`、不访问外部网络;
局域网那组起真实 HTTP 服务,但只走 `127.0.0.1` 回环。负向用例证明校验真的会报错
(篡改 bundle → apply 拒绝执行且零写入;破坏 cwd → verify 报 FAIL;未获确认就开流 → 403;
帧里给 `../../.ssh/...` → 拒绝)。

## License

MIT。实现为原创 JavaScript,零第三方运行时依赖(仅 Node 内置模块)。设计过程中参考过几个公开的 MIT 项目,
参考的是**设计结论**而非源码,详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 深入：设计与细节

以下是「为什么要这么设计」与逐条细节。**只用不改的人不必读**;出问题时对着这里查。

<details>
<summary><b>三层结构</b></summary>

分三层,缺一层都不是"一致":

| 层 | 内容 | 缺了会怎样 |
|---|---|---|
| **声明层** | `settings.yaml`、凭据(可选)、home 级 `cordis.patch.yml`、`AGENTS.md`、每个 profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.dsh-market/state.json`(插件停用清单、自建分组、市场区域)、每个 `link:` 插件的源码 | dsh 起不来 / **插件全丢** / 插件停用与分组状态回到默认 / agent 行为与旧机不同 |
| **状态层** | `sessions/`、`storages/`、`skills/`、`attachments/`、`background/`、`dsh-market/`、`llm-deepseek/` | dsh 能跑,但**历史会话全空、工作区列表空、skills 空、附件与背景图全没** |
| **工作区层** | 会话真正打开的那些项目目录(`includeWorkspaces`,默认**不**带) | 会话能列出来、点开是**空目录** |

其中 `profiles/<n>/package.json` 是「插件情况」的真相:它同时决定装什么(`dependencies`)与
实际加载什么(`dsh.profile.bundles`)。**它必须带走**,否则插件源码躺在 `plugins/` 里也没有东西去加载;
而且不能照抄 —— 里面的 `link:` 是源机绝对路径,导出时会改写成 `link:../../plugins/<name>`,
指向 bundle 里 vendored 的那份源码,这样目标机换任何位置都成立。

可重建的产物**不搬**(搬了反而是错的):`node_modules`(按 package.json 重装)、
`dsh-runtimes`(随宿主安装包重建)、`cache`、`logs`、`.anonymous-user-id`(机器身份)。

</details>

<details>
<summary><b>为什么不能直接复制 `~/.dsh`</b></summary>

| 内容 | 能否直接搬 | 原因 |
|---|---|---|
| `settings.yaml` | ⚠️ 可搬但可能含明文密钥 | 配置本应只带**引用**不带密钥;含明文时默认剔除(或整份加密) |
| `.credentials.yaml` | ⚠️ 可搬但是**真实密钥** | 默认**不带**;带上时应加密传输 |
| `profiles/*/package.json` | ✅ **必须搬,但要改写** | 它决定装什么(`dependencies`)与加载什么(`dsh.profile.bundles`);`link:` 是**绝对路径**,导出时改写成指向 vendored 副本 |
| `profiles/*/node_modules` | ❌ **绝不能搬** | 含原生二进制(`pty.node` / `conpty.node`),绑 OS / 架构 / Node ABI |
| `sessions/` | ✅ **可以搬,但要改写** | 目录名编码了工作区路径,权威 `cwd` 在会话首帧 header 里,可改写 |
| `storages/workspace.json` | ✅ **可以搬,但要改写** | 工作区记录**不会自行重建**;不改写则历史会话全变孤立 |
| `skills/` | ✅ **可以搬,按清单重建** | 多为指向 `$DSH_HOME` 外部的软链,**不会自动重建** |
| `attachments/` `background/` `dsh-market/` `llm-deepseek/` `AGENTS.md` | ✅ 可搬 | 用户自己的东西(附件库 / 背景图 / 市场状态 / 全局指令),合计不到 10 MB |
| `.anonymous-user-id` | ❌ 不能 | 机器身份:目标机该有自己的,不该继承旧机的 |

</details>

<details>
<summary><b>bundle 里有什么</b></summary>

```
dsh-sync-bundle/
  manifest.json          # 格式版本、profile 列表、状态层统计、告警
  checksums.json         # 全部文件的 sha256
  settings.yaml          # 或 settings.enc
  .credentials.yaml      # 或 .credentials.enc;需 includeCredentials
  AGENTS.md              # $DSH_HOME 根下的全局指令
  profiles/<name>/       # package.json(link: 已改写) / cordis.patch.yml / cordis.yml /
                         #   .npmrc / pnpm-workspace.yaml / .dsh-market/state.json
  plugins/<name>/        # 每个 link: 插件的源码(已排除 node_modules/.git)
  state/
    sessions/            # 会话文件(真实文件;软链不在此)
    storages/            # workspace.json、session_projcache 等
    skills/              # 真实文件;软链不在此
    attachments/         # 附件库
    background/          # 自定义背景图
    dsh-market/          # 市场本地状态
    llm-deepseek/        # 模型文件索引
    links.json           # 软链清单:rel → target(迁移时按此重建)
    sessions.json        # 会话索引摘要
  workspaces/<name>/     # 会话真正打开的项目目录(需 includeWorkspaces;含 .git,不含 node_modules)
  tools/dsync-helper.mjs
  apply.ps1  apply.sh    # 零依赖兜底脚本
  APPLY.md
```

**软链不复制实体,只记清单**。原因是 bundle 一旦被 zip / 网盘 / 聊天软件搬运,符号链接会被摊平或
直接丢弃;记清单再重建,传输方式再粗暴也不会丢信息。

</details>

<details>
<summary><b>会话是怎么被改写的</b></summary>

一个会话长这样:`sessions/<编码后的cwd>/<session-id>/session.jsonl.zstd`

日志文件名**不止一个**,宿主随版本演进留下了三种形态,同一次会话可能同时存在多份:

| 文件名 | header 特征 | 本机实测 |
|---|---|---|
| `session.jsonl.zstd` | 无 `version` 字段 | 33 份 |
| `session.v3.jsonl.zstd` | `version: 3` | 45 份 |
| `session.v4.jsonl.zstd` | `version: 4` | 25 份 |

三者结构完全相同(zstd 多帧串接),只是文件名与 header 的 `version` 不同;同一次会话的多份日志
`cwd` 一致。所以**全部变体一起改写**,只认其中一种会漏掉大量会话。

它不是普通压缩文件,而是 **zstd 多帧串接**:首帧是一行 JSON header(含权威 `cwd`),其后每帧是一行事件。
所以改写只替换**首帧**,其余帧**逐字节原样保留** —— 历史内容不可能被改坏,也无法被"悄悄重压"。

必须同时满足两个不变量,DSH 才能找到会话:① `header.cwd` 等于目标机上的真实工作区路径;
② 目录名等于 `encode(header.cwd)`。目录名编码是**有损**的(`:` `\` `/` `-` 都折叠成 `-`),
所以只能从 header 正向计算,**绝不反向解析目录名**。`storages/workspace.json` 里也存了每个工作区的
`path`,它必须与会话 `cwd` 逐字一致 —— 因此同一套映射同时作用于两者。

</details>

<details>
<summary><b>工作区代码怎么搬</b></summary>

会话的 cwd 指向的是 `$DSH_HOME` **之外**的项目目录(`D://deepseek//dsh-chat` 这种)。
只搬 `.dsh` 时,这些会话在目标机上能列出来,点开是空的 —— 换机不算成功。

打开 `includeWorkspaces` 后按**根**打包:

| 事实 | 本机实测 |
|---|---|
| 会话 cwd 条数 | 8 |
| 去嵌套后的根 | **5**(`D://a` 与 `D://a//b` 只搬一次) |
| `D://deepseek` 整盘 | 5.4G(大部分是 DSH 源码检出与临时目录,与换机无关) |
| 真正被引用的 5 个根 | 净 1.18G |

规则只有三条:

1. **按根搬,不按盘搬** —— 候选来自会话 cwd 与 `storages/workspace.json` 两处,去嵌套后才是根。
2. **默认带 `.git`**,必排 `node_modules` —— 目标机上仓库是完整的,能 `git log` / `git pull`;
   依赖重装一次即可。容器目录里是多个子仓库(`dsh-plugin/mine/` 下 9 个)时也能认出来。
3. **落位只要一个参数** —— `workspaceRoot` 是你在新机器上选的根目录,目录名保持不变。

会话 cwd、`workspace.json` 里的工作区路径、`skills/` 下指向项目目录的软链,**三者会一起改到
`workspaceRoot` 下**。想单独放某个项目就用 `workspaceMap={"dsh-chat":"E:/projects/dsh-chat"}`。

为什么落位参数必须压过一个:这三处只要有一处对不上,就是「会话在、内容是空的」。所以派生映射排在
**手写 `mappings` 之前**;手写规则与已搬工作区重叠时,报告会明确告诉你「这条规则对它不生效」,
而不是让你以为生效了。

</details>

<details>
<summary><b>先确认哪台是新机</b></summary>

这件事**不能靠插件判断**:方向完全由「在哪台机器上跑哪个工具」决定 —— 跑 `dshsync_export` 的那台
就是源机(旧),跑 `dshsync_apply` 的那台就是目标机(新)。搞反了有两种结局,都不会自然报错:

| 搞反的方式 | 结果 | 现在怎么拦 |
| --- | --- | --- |
| 在**新机**上跑导出 | bundle 几乎是空的;拿回旧机 apply 会把设置与插件覆盖成默认值,而旧机的会话因为新 bundle 里没有反而留着 → 「历史都在、配置全没」 | 导出与预览都会报「这台机器没有任何会话、也没有工作区记录,看起来像刚装好的空壳」 |
| 在**旧机**上跑落地 | 用一份旧快照改写自己的会话首帧(cwd 与目录名),不可逆 | apply 检测到「同主机 + 同 `$DSH_HOME`」直接拒绝,要 `allowSameMachine=true` 才继续 |

判断哪台是新机,三个信号,按不易出错的顺序:

1. **项目代码在不在** —— 最硬的一条。旧机有那批项目目录,新机刚装完是没有的。
2. **`dshsync_export(preview=true)` 的清单** —— 它会列出会话数、涉及的工作区路径、profile 里自装的
   插件数。**有历史的那个就是旧机**。本机实测基准:84 个会话 / 8 个工作区路径 / 11 个 vendored 插件。
3. **`$DSH_HOME` 体积** —— 旧机 630 MB 左右;刚装好的新机通常不到 100 MB。

导出时 bundle 会记下源机的 `主机名 + 用户名 + DSH_HOME`,落地时据此核对方向并打印一行:

```
✓ 方向：源机 DESKTOP-OLD/jichen.huang → 本机 DESKTOP-NEW/jichen.huang
```

同机但 `DSH_HOME` 不同(就地预演、一台机器上两套环境)会照常放行并注明;同机同 `DSH_HOME` 会被拦下。
0.6.0 之前导出的 bundle 没有这个字段,就如实说「判不了方向」,而不是假装通过。
记录里**只有这三项**,不含 MAC、机器 GUID、磁盘序列号 —— 那些是硬件指纹,搬配置的工具有意不碰。

</details>

<details>
<summary><b>桌面版与 web 宿主</b></summary>

同一个插件、同样八个工具:这里没有客户端半,也不需要构建链,所以桌面版与 web 宿主的加载路径完全一样。
真正不同的是下面两件事,两件都踩过:

**① 你在用的 profile 不一定是 `web`。** 桌面版加载的是 `profiles/desktop`;只装进 `profiles/web` 的
插件在桌面版里就是不存在(文件都在、界面里没有)。两处对应的处理:本插件的 `profile` 默认值是 `*`
(导全部),不是 `web`,不传也不会漏掉你真正在用的那份;插件本身则要装进你实际运行的那个 profile,
检查一条命令即可:

```bash
dsh plugin --profile desktop list     # 桌面版自带 CLI,列出该 profile 的实际依赖
```

**② 桌面版机器上没有 PATH 上的 `pnpm` 和 `dsh`。** 宿主内部自带一份(实测 pnpm 11.28.5),所以落地后
**不要**照着 web 的习惯去命令行跑 `pnpm install` —— 落好 profile 文件后完全退出桌面版(托盘退出)再重开,
宿主会按新的 `package.json` 重建依赖;重开后插件列表若是空的,去插件管理器点一次「重新安装 / 修复」再重启;
落地后先别在界面里改设置,直接退出重开。

**③ 宿主版本从装好的应用里读,不从 `dsh-runtimes` 快照读。** 那份快照是**安装时**写的,应用升级不会
刷新它:本机实测应用已是 `0.2.1-rc.2`(内置 node 24.21.0 / pnpm 11.28.5),快照还停在 `0.2.0-rc.2` /
pnpm 11.7.0,时间停在十天前。拿陈旧快照比对,会让「换到刚装好的新机」这种最常见场景误报版本不一致;
两边都快照陈旧时,又会把真的跨代差异抹平 —— 而那正是「插件装上了但不加载」的前兆。现在优先读正在运行的
桌面版自己的 `resources/app.asar/dsh/desktop-runtime.json`,读不到才回退到快照。

</details>

<details>
<summary><b>核对项</b></summary>

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

逐条核对 15 项检查(I1–I14,其中 I6 另含子项 I6b),每项给 PASS / FAIL / WARN:

| ID | 核对内容 |
|---|---|
| I1 | bundle 自身 sha256 全部对得上 |
| I2 | 会话目录数与**日志份数**都与源机一致(后者能抓到「目录在、某一版日志丢了」) |
| I3 | 每个会话目录名 = 其 header cwd 的编码 |
| I4 | 会话容器结构完好(header 可解、帧链完整);源机自带的损坏文件按原样复制,只判 WARN |
| I5 | `workspace.json` 路径与会话 cwd 逐字对齐(源机原有的孤立会话只算 WARN,迁移新增的孤立才算 FAIL) |
| I6 | 软链按清单重建(内部必须成功且可解引用;外部允许缺路径但必须可见) |
| I6b | I6 的子检查:指向 `$DSH_HOME` 之外的软链在目标机缺对应路径时单独报 WARN(最多列 5 个) |
| I7 | vendored 插件源码在 bundle 中完好 |
| I8 | 会话 cwd 指向的**工作区目录在目标机真的存在**(打开 `includeWorkspaces` 后应当全绿;不打开时缺的会逐个列出) |
| I9 | profile 的 `link:` 依赖在目标机可解析;`node_modules` 是否已装 |
| I10 | 状态层 7 个部分全部落地,文件数与源机一致 |
| I11 | 宿主运行时一致(dsh 版本 / 平台 / 架构 / node 大版本);跨 `major.minor` 时插件会被启动时拒装 |
| I12 | 工作区代码真的落地了(传 `workspaceRoot` 才核对;不传只报 WARN,不猜) |
| I13 | 落地后回写:apply 写入的 settings / 凭据 / workspace.json 自落地起未被宿主写回盖掉(依据落地回执 `.dsh-sync-apply-receipt.json`;宿主原样重写不算,内容变了才 FAIL) |
| I14 | projcache 身份残留:session_projcache 两层(dump + 逐会话记录)里不再有指向源机 home 的日志路径 —— 残留即宿主报 `corrupt session log` 并整棵拒绝激活 workspaceRegistry |

I11 判 `WARN` 而不是 `FAIL`:换机顺带升级 dsh 是正当操作,不该被工具拦下。但它挡的是最阴的一种失败 ——
宿主启动时做 peer 兼容性裁决,版本对不上时插件是 `stays installed but startup denies it`:
文件都在、sha256 全对、全部检查全绿,**界面里插件却是空的**。这条提示不给,用户会以为是 dsh-sync 搬丢了东西。

</details>

<details>
<summary><b>安全设计</b></summary>

| 机制 | 作用 |
|---|---|
| **只读导出** | 导出只复制、从不改源机配置 |
| **整包 sha256 校验** | apply 前先验;传坏就在写第一个字节之前停手 |
| **覆盖前备份** | 逐个备份到 `$DSH_HOME/.dsh-sync-backup-<时间戳>/`,保留相对路径 |
| **原子换入** | 会话改写走 tmp + rename,中途失败不会留下半个文件 |
| **有损操作要显式放行** | 帧链不完整的会话**拒绝改写**(可能是可自愈的撕裂尾帧,硬写会弄坏) |
| **重跑幂等** | 会话落地前先按映射算落点:目标机已是迁移后状态的会话**跳过复制**(顺带保住迁移后新增的聊天帧),重跑不会留下「旧目录名 + 新 cwd」的孤儿分组 |
| **回写检测** | apply 记下 settings / 凭据 / workspace.json 落地内容的 sha256:落地结束时当场复核(抓并发回写),并写成落地回执供 `dshsync_verify` 的 I13 随时复核(抓「落地之后、重启之前」宿主把内存旧配置写回) |

局域网直传这一层额外加了五道,理由都是「同网段的人不是默认可信」:

| 机制 | 作用 |
|---|---|
| **接受只能由源机本机点** | `/decide` 校验请求源地址是否属于本机网卡;别人从局域网打开页面只拿到只读视图。`autoAccept=true`（一条龙模式）改为配对即接受 —— 配对码成为唯一一道门,但一次性 / 5 分钟 / 5 次锁定 / 仅私有网段四道兜底都在;自动接受在日志与页面上留痕 |
| **配对码不发到远端** | 进度页按「本地 / 远端」两种形态渲染,远端快照里连 `pair.code` 字段都没有 |
| **计数公开,名字不公开** | `/info` 与 UDP 广播只带会话 / 插件 / 工作区**计数**;带名单的完整摘要走 `/summary`,与文件清单一样要配对 token —— 项目名拼起来能描绘这台机器的使用画像 |
| **码一次性 + 5 分钟 + 5 次试错锁定** | 6 位数字 5 次机会,穷举概率 5e-6;锁定后连正确的码也不放行,必须换码 |
| **只接受私有网段来源** | 10/8、172.16/12、192.168/16、169.254/16 与回环之外一律 403 —— 挡的是「机器直接暴露在公网」的配置事故 |
| **逐文件校验后才落地** | 写 `*.dshsync-part`,sha256 与长度都对上才 rename;帧里的路径一律 resolve 后确认没越出目标目录 |

配对码的「一次性」有一处刻意豁免:**同一台机器可以复用同一个码**(不同来源仍拒绝)。理由是实测发现的:
码在第一次配对后即标记已用,而「传一半断了、重跑接着传」必须再配一次对 —— 不给同源豁免,续传在用户视角
就是走不通的。旁人的码一定来自另一个地址,仍然被拒。

实测:2516 个文件 / 172 MB 走回环 11 秒(15.6 MB/s),续传实传 0 字节。

</details>

<details>
<summary><b>为什么设置卡片要自己写</b></summary>

宿主从插件的 `Config` schema 自动生成设置页这件事,0.2.x 的 `dsh-settings` 写得很清楚:
`autoGenerate` 默认开,**但「no shipped client does so yet」** —— 没有任何客户端实现自动页。
所以只导出 `Config` 的插件在设置里不会出现任何卡片,只能自己注册一个 `settings.plugins.tab`。
本包因此带一个手写的 `client.js`(单文件 IIFE,不用构建链):配置走 `configForms` 共享表单,
只读状态走宿主已认证的 `/api/dsh-sync/overview`。

状态通道挂不上(旧宿主没有 `connection.fetch.register`)时,卡片退化成「只有配置区」;
配置表单不可用时,卡片退化成「只读状态」。两边互不连累。

</details>

