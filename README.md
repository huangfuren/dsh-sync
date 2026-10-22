# dsh-sync

中文 | [English](README.en.md)

把**整台机器的 dsh 状态**搬到另一台机器 —— 换机后新机不只是"能跑",而是**跟旧机一样**:
同样的设置、同样的插件、同样的历史会话、同样的工作区列表、同样的 skills 链接。

分两层,缺一层都不是"一致":

| 层 | 内容 | 缺了会怎样 |
|---|---|---|
| **声明层** | `settings.yaml`、凭据(可选)、home 级 `cordis.patch.yml`、`AGENTS.md`、每个 profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.dsh-market/state.json`(插件停用清单、自建分组、市场区域)、每个 `link:` 插件的源码 | dsh 起不来 / **插件全丢** / 插件停用与分组状态回到默认 / agent 行为与旧机不同 |
| **状态层** | `sessions/`、`storages/`、`skills/`、`attachments/`、`background/`、`dsh-market/`、`llm-deepseek/` | dsh 能跑,但**历史会话全空、工作区列表空、skills 空、附件与背景图全没** |

其中 `profiles/<n>/package.json` 是「插件情况」的真相:它同时决定装什么(`dependencies`)与
实际加载什么(`dsh.profile.bundles`)。**它必须带走**,否则插件源码躺在 `plugins/` 里也没有东西去加载;
而且不能照抄 —— 里面的 `link:` 是源机绝对路径,导出时会改写成 `link:../../plugins/<name>`,
指向 bundle 里 vendored 的那份源码,这样目标机换任何位置都成立。

可重建的产物**不搬**(搬了反而是错的):`node_modules`(按 package.json 重装)、
`dsh-runtimes`(随宿主安装包重建)、`cache`、`logs`、`.anonymous-user-id`(机器身份)。

## 两种落地方式

| 方式 | 需要目标机装 dsh-sync | 能做到 |
|---|---|---|
| `apply.ps1` / `apply.sh`(bundle 自带) | **不需要** | 声明层落地 + 整包校验 + 备份 + 回滚 |
| `dshsync_apply` 工具 | 需要 | 上面全部 **+ 路径重映射 + 会话 cwd 改写 + 工作区路径改写 + 软链重建** |
| `dshsync_verify` 工具 | 需要 | 逐条核对目标机是否真的与源机一致 |

脚本做不了后两项:改写会话需要 **zstd 帧级读写**,PowerShell 里没有现成能力。
两条路径共用同一套映射口径(`lib/path-map.js`),不会出现"脚本改一种、工具改另一种"。

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

## 用法

### 旧电脑:导出

```
dshsync_export(profile="*", includeCredentials=true, credentialPassphrase="<你记得住的口令>", preview=true)
```

先 `preview=true` 看一眼(只扫描、不写文件),确认无误后去掉它真跑。

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
  tools/dsync-helper.mjs
  apply.ps1  apply.sh    # 零依赖兜底脚本
  APPLY.md
```

**软链不复制实体,只记清单**。原因是 bundle 一旦被 zip / 网盘 / 聊天软件搬运,
符号链接会被摊平或直接丢弃;记清单再重建,传输方式再粗暴也不会丢信息。

### 拷走

整个文件夹拷到新电脑(U 盘 / 网盘 / 局域网都行)。
用 `dsh-localsend` 的通道时:目录树走 `localsend_smb_push`,注意它的打包器**会跳过软链** ——
本插件的 links.json 机制正是为此设计,不受影响。

### 新电脑:落地

路径不一致(换了盘符 / 用户名)时必须给映射,否则会话指向不存在的目录:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              mappings=[{"from":"D:/deepseek","to":"E:/code"}],
              dryRun=true)      # 先预演
```

确认预演结果后 `dryRun=false` 真跑。两台机器目录结构完全相同时可省略 `mappings`。

映射规则:**按顺序应用、首条命中即返回、命中必须落在路径段边界**
(`D:/deep` 不会碰到 `D:/deepseek/...`)。不要自创"最长前缀优先"—— 多条规则重叠时会算出
与你书写顺序不同的结果。

### 新电脑:核对

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

逐条核对 10 项不变量,每项给 PASS / FAIL / WARN:

| ID | 核对内容 |
|---|---|
| I1 | bundle 自身 sha256 全部对得上 |
| I2 | 会话目录数与**日志份数**都与源机一致（后者能抓到「目录在、某一版日志丢了」） |
| I3 | 每个会话目录名 = 其 header cwd 的编码 |
| I4 | 会话容器结构完好(header 可解、帧链完整)；源机自带的损坏文件按原样复制,只判 WARN |
| I5 | `workspace.json` 路径与会话 cwd 逐字对齐（源机原有的孤立会话只算 WARN，迁移新增的孤立才算 FAIL） |
| I6 | 软链按清单重建(内部必须成功且可解引用;外部允许缺路径但必须可见) |
| I7 | vendored 插件源码在 bundle 中完好 |
| I8 | 会话 cwd 指向的**工作区目录在目标机真的存在**(工作区代码不在 `$DSH_HOME` 内,缺了会话能列出但打不开) |
| I9 | profile 的 `link:` 依赖在目标机可解析;`node_modules` 是否已装 |
| I10 | 状态层 7 个部分全部落地,文件数与源机一致 |
| I11 | 宿主运行时一致(dsh 版本 / 平台 / 架构 / node 大版本);版本跨代会让插件被**启动时拒装** |

`FAIL` 的含义是:**这部分状态 dsh 看不到**。不是"可能有点问题",是确定对不上。

I11 判 `WARN` 而不是 `FAIL`:换机顺带升级 dsh 是正当操作,不该被工具拦下。但它挡的是最阴的一种失败 ——
宿主启动时做 peer 兼容性裁决,版本对不上时插件是 `stays installed but startup denies it`:
文件都在、sha256 全对、I1–I10 全绿,**界面里插件却是空的**。这条提示不给,用户会以为是 dsh-sync 搬丢了东西。

版本取不到时不猜:两端任一取不到就报「需人工确认」,不假判 `PASS`。

## 工具

| 工具 | 在哪跑 | 说明 |
|---|---|---|
| `dshsync_export` | 源机 | 导出 bundle。源机**只读**(只复制,从不改配置) |
| `dshsync_apply` | 目标机 | 落地 + 路径重映射 + 会话改写 + 软链重建。支持 `dryRun` |
| `dshsync_verify` | 目标机 | 逐条核对一致性 |

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

## 已知限制

- **目标机需自重建依赖**:`node_modules` 不随行。落地后必须在目标机跑一次
  `pnpm install`(或 `dsh plugin add`),否则 dsh 起不来 —— verify 的 I9 会把这件事报成 WARN,不会让您以为完事了。
- **目标机 node 需 ≥22.15**才有内建 zstd;否则会话不迁移(会明确告警,不静默跳过)。
- **宿主版本由 `dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion` 判定**,
  它不是安装包的版本,宿主升级后若没重装运行时就会差一个 patch —— 所以同 `major.minor` 内的差异只作弱提示。
  跨 `major.minor` 时插件可能被启动时拒装,需在插件管理器逐个授予精确版本豁免。
  版本一号都取不到时(既没有 `dsh-runtimes` 也没有 `dsh` 命令)如实报「需人工确认」,不猜。
- **工作区代码不在 `$DSH_HOME` 内**:会话 cwd 指向的是项目目录(独立仓库)。
  目标机没有那些目录时,会话能列出但打不开 —— I8 会把缺失的目录逐个报出来。
  要用同一批历史,需把这些仓库也拷过去,或用 `mappings` 指到目标机上已有的等价目录。
- **`link:` 依赖已自动改写**:指向 `$DSH_HOME/plugins/<name>` 的相对路径,换位置也成立;
  只有**未 vendoring** 的 `link:`(源码缺失或 `includePlugins=false`)才保留源机路径,并在报告里点出来。
- **外部软链需要目标机有对应路径**:`skills/` 下指向 `$DSH_HOME` 外部的链接,
  目标机没有那个目录时链接会重建失败并**如实报告**,不会偷改指向。
- **git 依赖需构建授权**:`github:` 依赖在目标机首次 `add` 可能因 pnpm ≥10 的构建门被拒。
- **不搬 `pnpm-lock.yaml`**:其中含源机绝对 `link:` 路径。
- **`settings.yaml` 不存在时会静默通过**:本机就没有该文件(只有历史 `.bak`),导出不会凭空造一份;
  若要确认设置是否搬了,看导出报告的 `homeFiles` 列表。

## 开发与测试

```bash
npm run check   # node --check 全部源文件
npm test        # 86 个测试:纯函数 + zstd 帧 + 会话迁移 + 宿主运行时指纹 + 全链路 export→apply→verify
npm run verify
```

测试全部使用**合成数据**(自建 zstd 多帧文件 + 临时 dshHome),不读真实 `$DSH_HOME`、不联网。
负向用例证明校验真的会报错(篡改 bundle → apply 拒绝执行且零写入;破坏 cwd → verify 报 FAIL)。

## License

MIT。

实现为原创 JavaScript,零第三方运行时依赖(仅 Node 内置模块)。
设计过程中参考过几个公开的 MIT 项目,参考的是**设计结论**而非源码,详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
