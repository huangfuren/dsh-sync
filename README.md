# dsh-sync

中文 | [English](README.en.md)

把**整台机器的 dsh 状态**搬到另一台机器 —— 换机后新机不只是"能跑",而是**跟旧机一样**:
同样的设置、同样的插件、同样的历史会话、同样的工作区列表、同样的 skills 链接。

搬这一趟有两条路:手动搬 bundle(导出 → 拷 → 落地 → 核对),或者**局域网直传**
(`dshsync_lan_host` + `dshsync_lan_pull`:配对后一条命令拉过去、自动落地并核验,不用 U 盘也不用网盘)。

分三层,缺一层都不是"一致":

| 层 | 内容 | 缺了会怎样 |
|---|---|---|
| **声明层** | `settings.yaml`、凭据(可选)、home 级 `cordis.patch.yml`、`AGENTS.md`、每个 profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.dsh-market/state.json`(插件停用清单、自建分组、市场区域)、每个 `link:` 插件的源码 | dsh 起不来 / **插件全丢** / 插件停用与分组状态回到默认 / agent 行为与旧机不同 |
| **状态层** | `sessions/`、`storages/`、`skills/`、`attachments/`、`background/`、`dsh-market/`、`llm-deepseek/` | dsh 能跑,但**历史会话全空、工作区列表空、skills 空、附件与背景图全没** |
| **工作区层** | 会话真正打开的那些项目目录(`includeWorkspaces`,默认**不**带) | 会话能列出来、点开是**空目录** —— 会话 cwd 指向的是 `$DSH_HOME` 之外的项目目录 |

其中 `profiles/<n>/package.json` 是「插件情况」的真相:它同时决定装什么(`dependencies`)与
实际加载什么(`dsh.profile.bundles`)。**它必须带走**,否则插件源码躺在 `plugins/` 里也没有东西去加载;
而且不能照抄 —— 里面的 `link:` 是源机绝对路径,导出时会改写成 `link:../../plugins/<name>`,
指向 bundle 里 vendored 的那份源码,这样目标机换任何位置都成立。

可重建的产物**不搬**(搬了反而是错的):`node_modules`(按 package.json 重装)、
`dsh-runtimes`(随宿主安装包重建)、`cache`、`logs`、`.anonymous-user-id`(机器身份)。

## 两种落地方式

| 方式 | 需要目标机装 dsh-sync | 能做到 |
|---|---|---|
| `apply.ps1` / `apply.sh`(bundle 自带) | **不需要** | 声明层 + 状态层落地 + 整包校验 + 备份 + 回滚。**不解包工作区代码** |
| `dshsync_apply` 工具 | 需要 | 上面全部 **+ 工作区代码解包 + 路径重映射 + 会话 cwd 改写 + 工作区路径改写 + 软链重建** |
| `dshsync_verify` 工具 | 需要 | 逐条核对目标机是否真的与源机一致 |

脚本做不了后两项:改写会话需要 **zstd 帧级读写**,PowerShell 里没有现成能力。
两条路径共用同一套映射口径(`lib/path-map.js`),不会出现"脚本改一种、工具改另一种"。

## 工作区代码怎么搬

会话的 cwd 指向的是 `$DSH_HOME` **之外**的项目目录（`D://deepseek//dsh-chat` 这种）。
只搬 `.dsh` 时，这些会话在目标机上能列出来，点开是空的 —— 换机不算成功。

打开 `includeWorkspaces` 后按**根**打包：

| 事实 | 本机实测 |
|---|---|
| 会话 cwd 条数 | 8 |
| 去嵌套后的根 | **5**（`D://a` 与 `D://a//b` 只搬一次） |
| `D://deepseek` 整盘 | 5.4G（大部分是 DSH 源码检出与临时目录，与换机无关） |
| 真正被引用的 5 个根 | 净 1.18G |

规则只有三条：

1. **按根搬，不按盘搬** —— 候选来自会话 cwd 与 `storages/workspace.json` 两处，去嵌套后才是根。
2. **默认带 `.git`**，必排 `node_modules` —— 目标机上仓库是完整的，能 `git log` / `git pull`；
   依赖重装一次即可。容器目录里是多个子仓库（`dsh-plugin/mine/` 下 9 个）时也能认出来。
3. **落位只要一个参数** —— `workspaceRoot` 是你在新机器上选的根目录，目录名保持不变：

```
dshsync_apply(bundleDir="<bundle>", workspaceRoot="E:/code", dryRun=true)
```

会话 cwd、`workspace.json` 里的工作区路径、`skills/` 下指向项目目录的软链，**三者会一起改到
`workspaceRoot` 下**。想单独放某个项目就用 `workspaceMap={"dsh-chat":"E:/projects/dsh-chat"}`。

为什么落位参数必须压过一个：这三处只要有一处对不上，就是「会话在、内容是空的」。
所以派生映射排在**手写 `mappings` 之前**；如果你的手写规则与已搬工作区重叠，报告会明确告诉你
「这条规则对它不生效」，而不是让你以为生效了。

目标机上落位目录已存在且非空时会**拒绝**解包（工作区太大，进不了备份），要覆盖得显式传
`overwriteWorkspaces=true`。

## 为什么不能直接复制 `~/.dsh`

| 内容 | 能否直接搬 | 原因 |
|---|---|---|
| `settings.yaml` | ⚠️ 可搬但可能含明文密钥 | 配置本应只带**引用**不带密钥;含明文时默认剔除(或整份加密) |
| `.credentials.yaml` | ⚠️ 可搬但是**真实密钥** | 默认**不带**;带上时应加密传输 |
| `profiles/*/package.json` | ✅ **必须搬,但要改写** | 它决定装什么(`dependencies`)与加载什么(`dsh.profile.bundles`);`link:` 是**绝对路径**,导出时改写成指向 vendored 副本 |
| `profiles/*/node_modules` | ❌ **绝不能搬** | 含原生二进制(`pty.node`/`conpty.node`),绑 OS/架构/Node ABI |
| `sessions/` | ✅ **可以搬,但要改写** | 目录名编码了工作区路径,权威 `cwd` 在会话首帧 header 里,可改写 |
| `storages/workspace.json` | ✅ **可以搬,但要改写** | 工作区记录**不会自行重建**;不改写则历史会话全变孤立 |
| `skills/` | ✅ **可以搬,按清单重建** | 多为指向 `$DSH_HOME` 外部的软链,**不会自动重建** |
| `attachments/` `background/` `dsh-market/` `llm-deepseek/` `AGENTS.md` | ✅ 可搬 | 用户自己的东西(附件库 / 背景图 / 市场状态 / 全局指令),合计不到 10 MB |
| `.anonymous-user-id` | ❌ 不能 | 机器身份:目标机该有自己的,不该继承旧机的 |

## 会话是怎么被改写的

一个会话长这样:`sessions/<编码后的cwd>/<session-id>/session.jsonl.zstd`

日志文件名**不止一个**,宿主随版本演进留下了三种形态,同一次会话可能同时存在多份:

| 文件名 | header 特征 | 本机实测 |
|---|---|---|
| `session.jsonl.zstd` | 无 `version` 字段 | 33 份 |
| `session.v3.jsonl.zstd` | `version: 3` | 45 份 |
| `session.v4.jsonl.zstd` | `version: 4` | 25 份 |

三者结构完全相同(zstd 多帧串接),只是文件名与 header 的 `version` 不同;
同一次会话的多份日志 `cwd` 一致。所以**全部变体一起改写**,只认其中一种会漏掉大量会话。

它不是普通压缩文件,而是 **zstd 多帧串接**:首帧是一行 JSON header(含权威 `cwd`),
其后每帧是一行事件。所以改写只替换**首帧**,其余帧**逐字节原样保留** ——
历史内容不可能被改坏,也无法被"悄悄重压"。

必须同时满足两个不变量,DSH 才能找到会话:

1. `header.cwd` 等于目标机上的真实工作区路径;
2. 目录名等于 `encode(header.cwd)`。

目录名编码是**有损**的(`:` `\` `/` `-` 都折叠成 `-`),所以只能从 header 正向计算,
**绝不反向解析目录名**。`storages/workspace.json` 里也存了每个工作区的 `path`,
它必须与会话 `cwd` 逐字一致 —— 因此同一套映射同时作用于两者。

## 先确认哪台是「新机」

这件事**不能靠插件判断**：dsh-sync 不知道哪台是新机，方向完全由「在哪台机器上跑哪个工具」决定
—— 跑 `dshsync_export` 的那台就是源机（旧），跑 `dshsync_apply` 的那台就是目标机（新）。搞反了
有两种结局，而且都不会自然报错：

| 搞反的方式 | 结果 | 现在怎么拦 |
| --- | --- | --- |
| 在**新机**上跑导出 | bundle 几乎是空的；拿回旧机 apply 会把设置与插件覆盖成默认值，而旧机的会话因为新 bundle 里没有反而留着 → 「历史都在、配置全没」 | 导出与预览都会报「这台机器没有任何会话、也没有工作区记录，看起来像刚装好的空壳」 |
| 在**旧机**上跑落地 | 用一份旧快照改写自己的会话首帧（cwd 与目录名），不可逆 | apply 检测到「同主机 + 同 `$DSH_HOME`」直接拒绝，要 `allowSameMachine=true` 才继续 |

判断哪台是新机，三个信号，按不易出错的顺序：

1. **项目代码在不在** —— 最硬的一条。旧机有那批项目目录（本机是 `D:\deepseek\dsh-plugin\mine\`），
   新机刚装完是没有的。
2. **`dshsync_export(preview=true)` 的清单** —— 它会列出会话数、涉及的工作区路径、profile 里自装的
   插件数。**有历史的那个就是旧机**。本机实测基准：84 个会话 / 8 个工作区路径 / 11 个 vendored 插件。
3. **`$DSH_HOME` 体积** —— 旧机 630 MB 左右；刚装好的新机通常不到 100 MB。

导出时 bundle 会记下源机的 `主机名 + 用户名 + DSH_HOME`，落地时据此核对方向并打印一行：

```
✓ 方向：源机 DESKTOP-OLD/jichen.huang → 本机 DESKTOP-NEW/jichen.huang
```

同机但 `DSH_HOME` 不同（就地预演、一台机器上两套环境）会照常放行并注明；同机同 `DSH_HOME` 会被
拦下。0.6.0 之前导出的 bundle 没有这个字段，就如实说「判不了方向」，而不是假装通过。

记录里**只有这三项**，不含 MAC、机器 GUID、磁盘序列号 —— 那些是硬件指纹，搬配置的工具有意不碰。

## 桌面版与 web 宿主

同一个插件、同样七个工具：这里没有客户端半，也不需要构建链，所以桌面版与 web 宿主的加载路径完全一样。
真正不同的是下面两件事，两件都踩过：

**① 你在用的 profile 不一定是 `web`。** 桌面版加载的是 `profiles/desktop`；只装进 `profiles/web` 的
插件在桌面版里就是不存在（文件都在、界面里没有）。两处对应的处理：

- 本插件的 `profile` 默认值是 `*`（导全部），不是 `web` —— 不传 profile 也不会漏掉你真正在用的那份；
- 插件本身要装进你实际运行的那个 profile。检查一条命令即可：

```bash
dsh plugin --profile desktop list     # 桌面版自带 CLI，列出该 profile 的实际依赖
```

**② 桌面版机器上没有 PATH 上的 `pnpm` 和 `dsh`。** 宿主内部自带一份（实测 pnpm 11.28.5），
所以落地后**不要**照着 web 的习惯去命令行跑 `pnpm install`：

- 落好 profile 文件 → 完全退出桌面版（托盘退出）→ 重开，宿主会按新的 `package.json` 重建依赖；
- 重开后插件列表若是空的，去插件管理器点一次「重新安装/修复」再重启；
- 落地后先别在界面里改设置，直接退出重开 —— 免得宿主把内存里的旧配置写回，盖掉刚落地的文件。

**③ 宿主版本从装好的应用里读，不从 `dsh-runtimes` 快照读。** 那份快照是**安装时**写的，应用升级不会
刷新它：本机实测应用已是 `0.2.1-rc.2`（内置 node 24.21.0 / pnpm 11.28.5），快照还停在
`0.2.0-rc.2` / pnpm 11.7.0，时间停在十天前。拿陈旧快照比对，会让「换到刚装好的新机」这种最常见场景
误报版本不一致；两边都快照陈旧时，又会把真的跨代差异抹平 —— 而那正是「插件装上了但不加载」的前兆。
现在优先读正在运行的桌面版自己的 `resources/app.asar/dsh/desktop-runtime.json`，读不到才回退到快照。

## 用法

### 旧电脑:导出

```
dshsync_export(profile="*", includeWorkspaces=true, includeCredentials=true,
              credentialPassphrase="<你记得住的口令>", preview=true)
```

先 `preview=true` 看一眼(只扫描、不写文件),确认无误后去掉它真跑。

预览会列出**工作区候选**（路径 + 体积 + 是否含 git），按名字或路径勾选：

```
dshsync_export(profile="*", includeWorkspaces=true, workspaces=["dsh-chat","dsh-plugin"])
dshsync_export(profile="*", includeWorkspaces=true, workspaces=["*"])   # 全选
```

不传 `workspaces` 就是全选所有**源机上存在**的候选。`includeGit=false` 可丢掉 `.git` 换体积。

产出 bundle:

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

**软链不复制实体,只记清单**。原因是 bundle 一旦被 zip / 网盘 / 聊天软件搬运,
符号链接会被摊平或直接丢弃;记清单再重建,传输方式再粗暴也不会丢信息。

### 搬过去

两条路,任选一条。

**A. 局域网直传(推荐)** —— 不占 U 盘、不过网盘,两台机器在同一网络下一条命令走完。

源机导出完成后起一个发送端:

```
dshsync_lan_host(bundleDir="D:/dsh-bundle")
```

它打印 6 位配对码和进度页地址(`http://<源机IP>:38473/`),然后**立即返回** —— 服务在后台跑,
对话不会被卡十几分钟。

新机器上:

```
dshsync_lan_pull(host="192.168.1.23", code="123456",
                 destDir="D:/incoming/dsh-sync-bundle",
                 workspaceRoot="E:/code")
```

它负责:配对 → 等你在**源机页面**上点「接受」→ 逐文件接收并核对 sha256 → 自动 `apply` → 自动 `verify`。
全程后台执行,进度页在 `http://127.0.0.1:38474/`,`dshsync_lan_status(jobId="...")` 随时查。

**配对码不是授权。** 知道码也拉不走:传输只在源机页面上点了「接受」之后才开始,而那个按钮只对源机
本机有效 —— 别人从局域网打开同一个地址,看到的是只读进度页,连配对码都拿不到。码 5 分钟过期,
换一台机器用不了第二次(同一台机器可以复用,这是续传的前提)。

**中断了直接重跑同一条命令即可**,已收到且哈希一致的文件自动跳过。实测 2516 个文件 / 172 MB 走回环
11 秒(15.6 MB/s),续传实传 0 字节。

不知道源机 IP 时,在新机器上先 `dshsync_lan_discover()`:先发 UDP 广播(约 1 秒),广播被防火墙拦了
就自动改成逐个地址扫描(约 3 秒),并把「是哪一层挡住的」讲清楚。

**B. 手动拷**

整个文件夹拷到新电脑(U 盘 / 网盘 / 局域网共享都行)。
用 `dsh-localsend` 的通道时:目录树走 `localsend_smb_push`,注意它的打包器**会跳过软链** ——
本插件的 links.json 机制正是为此设计,不受影响。

### 新电脑:落地

**bundle 里带了工作区代码时,一个 `workspaceRoot` 就够了** —— 这是换机推荐的用法:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              workspaceRoot="E:/code",     # 你在新机器上选的项目根目录
              dryRun=true)                 # 先预演
```

会话 cwd、工作区路径、skills 软链会自动改到 `workspaceRoot/<原名>` 下，不用再写映射。
预演会逐个打印「哪个工作区 → 落到哪」「哪些会话的 cwd 会被改成什么」，确认后再
`dryRun=false`。

没带工作区代码时（只搬 `.dsh`），路径不一致就给映射，否则会话指向不存在的目录:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              mappings=[{"from":"D:/deepseek","to":"E:/code"}],
              dryRun=true)
```

映射规则:**按顺序应用、首条命中即返回、命中必须落在路径段边界**
(`D:/deep` 不会碰到 `D:/deepseek/...`)。不要自创"最长前缀优先"—— 多条规则重叠时会算出
与你书写顺序不同的结果。

### 新电脑:核对

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

逐条核对 12 项不变量,每项给 PASS / FAIL / WARN:

| ID | 核对内容 |
|---|---|
| I1 | bundle 自身 sha256 全部对得上 |
| I2 | 会话目录数与**日志份数**都与源机一致（后者能抓到「目录在、某一版日志丢了」） |
| I3 | 每个会话目录名 = 其 header cwd 的编码 |
| I4 | 会话容器结构完好(header 可解、帧链完整)；源机自带的损坏文件按原样复制,只判 WARN |
| I5 | `workspace.json` 路径与会话 cwd 逐字对齐（源机原有的孤立会话只算 WARN，迁移新增的孤立才算 FAIL） |
| I6 | 软链按清单重建(内部必须成功且可解引用;外部允许缺路径但必须可见) |
| I7 | vendored 插件源码在 bundle 中完好 |
| I8 | 会话 cwd 指向的**工作区目录在目标机真的存在**（打开 `includeWorkspaces` 后应当全绿；不打开时缺的会逐个列出，会话能列出但打不开） |
| I9 | profile 的 `link:` 依赖在目标机可解析;`node_modules` 是否已装 |
| I10 | 状态层 7 个部分全部落地,文件数与源机一致 |
| I11 | 宿主运行时一致（dsh 版本 / 平台 / 架构 / node 大版本）；跨 `major.minor` 时插件会被启动时拒装 |
| I12 | 工作区代码真的落地了（传 `workspaceRoot` 才核对；不传只报 WARN，不猜） |

`FAIL` 的含义是:**这部分状态 dsh 看不到**。不是"可能有点问题",是确定对不上。

I11 判 `WARN` 而不是 `FAIL`:换机顺带升级 dsh 是正当操作,不该被工具拦下。但它挡的是最阴的一种失败 ——
宿主启动时做 peer 兼容性裁决,版本对不上时插件是 `stays installed but startup denies it`:
文件都在、sha256 全对、I1–I12 全绿,**界面里插件却是空的**。这条提示不给,用户会以为是 dsh-sync 搬丢了东西。

版本取不到时不猜:两端任一取不到就报「需人工确认」,不假判 `PASS`。

## 工具

| 工具 | 在哪跑 | 说明 |
|---|---|---|
| `dshsync_export` | 源机 | 导出 bundle。源机**只读**(只复制,从不改配置) |
| `dshsync_apply` | 目标机 | 落地 + 工作区解包 + 路径重映射 + 会话改写 + 软链重建。支持 `dryRun` |
| `dshsync_verify` | 目标机 | 逐条核对一致性 |
| `dshsync_lan_host` | 源机 | 起局域网发送端,给出配对码与进度页。`action="renew"` 换码、`action="stop"` 关停 |
| `dshsync_lan_discover` | 目标机 | 找局域网里开着的发送端。UDP 广播优先,逐地址扫描兜底 |
| `dshsync_lan_pull` | 目标机 | 配对 → 等确认 → 接收 → 落地 → 核验,一条命令。后台执行,立即返回 jobId |
| `dshsync_lan_status` | 两端 | 查进度、速率、剩余时间,以及落地与核验的最终结果 |

## 配置(settings 命名空间 `sync`)

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | harness home |
| `profile` | `web` | 默认导出的 profile;`"*"` = 全部 |
| `outDir` | 临时目录 `dsh-sync-bundle` | bundle 输出目录 |
| `includeCredentials` | `false` | 是否带 `.credentials.yaml`(真实密钥) |
| `credentialPassphrase` | 空 | ≥6 位:把 settings + 凭据**加密**搬运(推荐) |
| `includePlugins` | `true` | 是否 vendoring `link:` 插件源码 |
| `includeState` | `true` | 是否带 sessions / storages / skills(关掉就只是"能用的空环境") |
| `includeWorkspaces` | `false` | 是否把会话的项目目录一起打包。换机自用建议打开 |
| `includeGit` | `true` | 打包工作区时保留 `.git`（完整仓库）；关掉只为省体积 |
| `workspaceRoot` | 空 | **目标机**上的项目根目录，落地时用它决定一切落位 |

## 密钥策略(重要)

三条路线,按推荐度排序:

1. **加密搬运(推荐)**:给 `credentialPassphrase`。settings 与凭据以 AES-256-GCM 密文进 bundle
   (scrypt 派生密钥,每包随机 salt/iv,带认证标签)。口令错或文件被改都会在解密时直接失败,
   不会解出一份错误明文。明文密钥**既不丢也不裸奔**,换机后不用挨个重填插件 key。
2. **不带凭据(默认)**:`.credentials.yaml` 不导出;settings 里的明文密钥行会被剔除并告警。
3. **明文携带(不推荐)**:`includeCredentials=true` 且不给口令 —— bundle 含裸密钥,
   只适用于可信信道,用完立刻删。

补充规则:
- 明文密钥判据:`*Env` 字段必须是合法引用名(`^[A-Za-z_][A-Za-z0-9_]*$`),否则视为填了明文;
  `key/token/secret/password` 类字段值较长也会告警。
- 工具**只输出脱敏预览**(前缀 + 长度),从不回显完整密钥。

## 安全设计

| 机制 | 作用 |
|---|---|
| **只读导出** | 导出只复制、从不改源机配置 |
| **整包 sha256 校验** | apply 前先验;传坏就在写第一个字节之前停手 |
| **覆盖前备份** | 逐个备份到 `$DSH_HOME/.dsh-sync-backup-<时间戳>/`,保留相对路径 |
| **原子换入** | 会话改写走 tmp + rename,中途失败不会留下半个文件 |
| **有损操作要显式放行** | 帧链不完整的会话**拒绝改写**(可能是可自愈的撕裂尾帧,硬写会弄坏) |

局域网直传这一层额外加了五道,理由都是「同网段的人不是默认可信」:

| 机制 | 作用 |
|---|---|
| **接受只能由源机本机点** | `/decide` 校验请求源地址是否属于本机网卡;别人从局域网打开页面只拿到只读视图 |
| **配对码不发到远端** | 进度页按「本地 / 远端」两种形态渲染,远端快照里连 `pair.code` 字段都没有 |
| **码一次性 + 5 分钟 + 5 次试错锁定** | 6 位数字 5 次机会,穷举概率 5e-6;锁定后连正确的码也不放行,必须换码 |
| **只接受私有网段来源** | 10/8、172.16/12、192.168/16、169.254/16 与回环之外一律 403 —— 挡的是「机器直接暴露在公网」的配置事故 |
| **逐文件校验后才落地** | 写 `*.dshsync-part`,sha256 与长度都对上才 rename;帧里的路径一律 resolve 后确认没越出目标目录 |

配对码的「一次性」有一处刻意豁免:**同一台机器可以复用同一个码**(不同来源仍拒绝)。理由是实测发现的:
码在第一次配对后即标记已用,而「传一半断了、重跑接着传」必须再配一次对 —— 不给同源豁免,
续传在用户视角就是走不通的。旁人的码一定来自另一个地址,仍然被拒。

## 已知限制

- **目标机需自重建依赖**:`node_modules` 不随行。落地后必须在目标机跑一次
  `pnpm install`(或 `dsh plugin add`),否则 dsh 起不来 —— verify 的 I9 会把这件事报成 WARN,不会让您以为完事了。
- **目标机 node 需 ≥22.15**才有内建 zstd;否则会话不迁移(会明确告警,不静默跳过)。
- **宿主版本由 `dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion` 判定**,
  它不是安装包的版本,宿主升级后若没重装运行时就会差一个 patch —— 所以同 `major.minor` 内的差异只作弱提示。
  跨 `major.minor` 时插件可能被启动时拒装,需在插件管理器逐个授予精确版本豁免。
  版本一号都取不到时(既没有 `dsh-runtimes` 也没有 `dsh` 命令)如实报「需人工确认」,不猜。
- **工作区代码默认不进 bundle**:会话 cwd 指向的是 `$DSH_HOME` 之外的项目目录。
  不打开 `includeWorkspaces` 时它们不会随行,目标机上会话能列出但打不开（I8 逐个报出）。
  打开后按根打包（默认带 `.git`、排除 `node_modules`），落地用一个 `workspaceRoot` 指到新位置；
  落位目录已存在且非空时会**拒绝**覆盖，要显式 `overwriteWorkspaces=true`。
  体积会从百 MB 级涨到 GB 级，先 `preview=true` 看候选与大小再决定勾哪些。
- **`link:` 依赖已自动改写**:指向 `$DSH_HOME/plugins/<name>` 的相对路径,换位置也成立;
  只有**未 vendoring** 的 `link:`(源码缺失或 `includePlugins=false`)才保留源机路径,并在报告里点出来。
- **外部软链需要目标机有对应路径**:`skills/` 下指向 `$DSH_HOME` 外部的链接,
  目标机没有那个目录时链接会重建失败并**如实报告**,不会偷改指向。
- **git 依赖需构建授权**:`github:` 依赖在目标机首次 `add` 可能因 pnpm ≥10 的构建门被拒。
- **不搬 `pnpm-lock.yaml`**:其中含源机绝对 `link:` 路径。
- **`settings.yaml` 不存在时会静默通过**:本机就没有该文件(只有历史 `.bak`),导出不会凭空造一份;
  若要确认设置是否搬了,看导出报告的 `homeFiles` 列表。
- **局域网传输的进度页是浏览器页面,不是 DSH 界面里的面板**:宿主工具接口没有执行期流式通道
  (`execute()` 只在结束时返回一次),想在对话里看实时进度只能等它结束。所以进度走本机 HTTP + SSE。
- **传输任务的状态在内存里**:插件重载(改配置、升级、重启 DSH)后 `jobId` 就查不到了。已经收到的文件
  留在盘上,重跑一次 `dshsync_lan_pull` 会按哈希续传,不会从头再来。传输期间别退出 DSH。
- **Windows 首次监听会弹防火墙提示**,要选「专用网络」允许;选「公用网络」或点取消,对方就连不上
  (报错会指到这一条)。UDP 38472 被拦时 `dshsync_lan_discover` 会自动改成逐地址扫描,只是慢两三秒。

## 开发与测试

```bash
npm run check   # node --check 全部源文件
npm test        # 152 个测试:纯函数 + zstd 帧 + 会话迁移 + 工作区打包 + 宿主运行时指纹 + 局域网直传 + 全链路 export→apply→verify
npm run verify
```

测试全部使用**合成数据**(自建 zstd 多帧文件 + 临时 dshHome),不读真实 `$DSH_HOME`、不访问外部网络;
局域网那组起真实 HTTP 服务,但只走 `127.0.0.1` 回环。
负向用例证明校验真的会报错(篡改 bundle → apply 拒绝执行且零写入;破坏 cwd → verify 报 FAIL;
未获确认就开流 → 403;帧里给 `../../.ssh/...` → 拒绝)。

## License

MIT。

实现为原创 JavaScript,零第三方运行时依赖(仅 Node 内置模块)。
设计过程中参考过几个公开的 MIT 项目,参考的是**设计结论**而非源码,详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
