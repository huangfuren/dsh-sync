# dsh-sync

把**本机 dsh 配置**搬到另一台机器 ——换机不停工。
接收方**不需要先装 dsh-sync**:bundle 自带自安装脚本和一个零依赖小工具,跑一次即可继续用 dsh。

## 换机只要三步(不用记任何命令)

**旧电脑** — 双击插件目录下的 `一键导出.bat`,回答两个问题(存到哪、口令),得到一个文件夹。

**拷走** — 把整个文件夹拷到新电脑( U 盘 / 网盘 / 局域网都行)。

**新电脑** — 双击文件夹里的 `一键恢复.bat`(打不开就用 `RESTORE.bat`,内容一样),跟着提示走完,重启 dsh 即可。

向导顺序:检查 node / pnpm / dsh → **确认恢复到哪个目录**(默认 `~/.dsh`,可手改)→ 校验包是否拷坏 →
**先给你看将要做什么** → 问口令 → 执行。任一步失败都会自动回滚,随时取消,不会留下半成品。

### 三道安全防线

| 防线 | 作用 |
|---|---|
| **只读导出** | 导出只复制、从不改源机配置(有测试逐字节比对整个 `DSH_HOME` 来证明) |
| **覆盖前询问** | 目标目录已有配置时,必须输入 `yes` 才继续;旧文件先备份到 `.dsh-sync-backup-<时间戳>` |
| **版本预警** | 记录源机 dsh 版本,与目标机不一致时明确提示(不猜、不静默通过) |

另外:整包 sha256 校验(传坏就拒绝执行)、参数错/口令错**绝不写坏目标机**、失败自动回滚。
需要非交互执行时加 `-Force`(ps1)/ `--force`(sh)跳过覆盖询问。

> 新电脑必须先让 `dsh` 命令可用(`node -v`、`pnpm -v`、`dsh --version` 三个都要有输出)。
> 没装 dsh 也没关系:向导会问你要不要**只先恢复设置和密钥**,等装好 dsh 再跑一次补上插件。

零第三方运行时依赖(仅 Node 内置模块 + `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` peer)。

## 为什么不能直接复制 `~/.dsh`

| `$DSH_HOME` 内容 | 能否直接搬 | 原因 |
|---|---|---|
| `settings.yaml` | ⚠️ 可搬但可能含明文密钥 | 配置本应只带**引用**不带密钥;含明文时默认会剔除(或整份加密,见下) |
| `.credentials.yaml` | ⚠️ 可搬但是**真实密钥** | 默认**不带**;带上时应加密传输 |
| `profiles/*/package.json` | ⚠️ 需重写 | `link:` 是**绝对路径**,新机布局不同即失效 |
| `profiles/*/node_modules` | ❌ **绝不能搬** | 含原生二进制(`pty.node`/`conpty.node`),绑 OS/架构/Node ABI;Junction 绑绝对路径 |
| `sessions/` | ❌ 不建议 | 目录名编码了工作区绝对路径 |
| `storages/` `background/` `.anonymous-user-id` | ❌ 不能 | 机器运行时状态 / 机器身份 |

| `skills/` | ⚠️ 通常不用搬 | 多为指向工作区目录的联接(junction),打开该工作区时 dsh 自动重建 |

**结论:同步"声明",让目标机"重建"。**

这些东西导出时会被逐个盘点,带着数量与原因写进 manifest / `APPLY.md`,并在 apply 结束时再提示一遍 ——
迁移工具最忌讳静默丢失:用户以为全搬了,其实少了什么根本无从察觉。

## 用法

换机请直接搬全部 profile:

```
dshsync_export(profile="*", includeCredentials=true, credentialPassphrase="<你记得住的口令>")
```

单个 profile:`profile="web"`。

产出 bundle:

```
dsh-sync-bundle/
  manifest.json          # 格式版本 2、profile 列表、依赖分类、告警
  checksums.json         # 全部文件的 sha256(含 manifest 自身)
  settings.yaml          # 或 settings.enc(加密搬运时)
  .credentials.yaml      # 或 .credentials.enc;需 includeCredentials
  profiles/<name>/       # cordis.patch.yml / .npmrc / pnpm-workspace.yaml
  plugins/<name>/        # 每个 link: 插件的**源码**(已排除 node_modules/.git)
  tools/dsync-helper.mjs # 目标机校验与解密用的零依赖小工具
  apply.ps1  apply.sh    # Windows / macOS·Linux 自安装脚本
  APPLY.md
```

传输(bundle 是目录,交给 dsh-localsend 会自动打包):

```
localsend_smb_push(target="10.0.0.30", share="共享文件夹", destDir="dsh-sync", files=["<bundleDir>"])
# 或无需接收方装任何软件:
localsend_share(files=["<bundleDir>"])
```

目标机执行(需已装 dsh + node + pnpm + 网络):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\apply.ps1 -WhatIf     # 先看计划,不动任何文件
.\apply.ps1             # 确认后真跑
```

macOS / Linux:

```bash
chmod +x ./apply.sh
./apply.sh --dry-run
./apply.sh
```

`apply` 会依次做:

1. **整包 sha256 校验** —— 传坏了就在这里停手,绝不带着坏数据去覆盖你的配置。
2. 落地 home 级声明(settings / 可选凭据),覆盖前逐个备份到 `$DSH_HOME/.dsh-sync-backup-<时间戳>`。
3. 落地每个 profile 的声明文件(cordis.patch.yml / .npmrc / **pnpm-workspace.yaml**)。
4. 按 bundles 顺序逐个 `dsh plugin add`(跳过真正的官方内置组合包;`link:` 依赖指向 bundle 内源码)。
5. 任一步失败 → **自动回滚**,告诉你备份在哪。

它**不手写** profile 的 `package.json` / `dsh.profile.bundles` —— 那些由官方 `dsh plugin add` 自己维护,少一处出错。

开关:`-SkipSettings` / `-SkipPlugins` / `-Only a,b` / `-TargetHome <dir>`(sh 侧:`--skip-settings` / `--skip-plugins` / `--only` / `--home`)。

## 工具

| 工具 | 说明 |
|---|---|
| `dshsync_export` | 导出本机 dsh 配置为可移植 bundle + 生成 apply 脚本。源机**只读**(只复制,从不改配置) |

## 配置(settings 命名空间 `sync`)

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 源机 harness home |
| `profile` | `web` | 默认导出的 profile;`"*"` = 全部 profile |
| `outDir` | 临时目录 `dsh-sync-bundle` | bundle 输出目录 |
| `includeCredentials` | `false` | 是否带 `.credentials.yaml`(真实密钥) |
| `credentialPassphrase` | 空 | ≥6 位:把 settings + 凭据**加密**搬运(推荐) |
| `includePlugins` | `true` | 是否 vendoring `link:` 插件源码 |

## 密钥策略(重要)

三条路线,按推荐度排序:

1. **加密搬运(推荐)**:给 `credentialPassphrase`。settings 与凭据以 AES-256-GCM 密文进 bundle(scrypt 派生密钥,每包随机 salt/iv,带认证标签)。口令错或文件被改都会在解密时直接失败,不会解出一份错误明文。好处是明文密钥**既不丢也不裸奔**,换机后不用挨个重填插件 key。
2. **不带凭据(默认)**:`.credentials.yaml` 不导出;settings 里的明文密钥行会被剔除并告警,到目标机重新填。
3. **明文携带(不推荐)**:`includeCredentials=true` 且不给口令 —— bundle 含裸密钥,只适用于可信信道,用完立刻删。

补充规则:
- 明文密钥检测的判据:`*Env` 字段必须是合法引用名(`^[A-Za-z_][A-Za-z0-9_]*$`,不允许连字符),否则视为填了明文;`key/token/secret/password` 类字段值较长也会告警。
- 工具**只输出脱敏预览**(前缀 + 长度),从不回显完整密钥。
- 目标机也可以先 `export DSH_SYNC_PASSPHRASE=...` 再跑 apply,免交互。

## 已知限制

- **目标机需自重建依赖**:`node_modules` 不随行,需 pnpm 联网安装。
- **git 依赖需构建授权**:`github:` 依赖在目标机首次 `add` 可能因 pnpm ≥10 的构建门被拒;bundle 会带上 profile 的 `pnpm-workspace.yaml`,其中 `allowBuilds` 若已配置即可直接通过,否则按提示补上重试。
- **不搬 `pnpm-lock.yaml`**:其中含源机绝对 `link:` 路径;目标机重新解析。要完全可复现需另行处理。
- **不支持完全离线目标机**:离线需额外打包 pnpm store 或 `npm pack` 全量依赖。
- 源机的 `link:` 路径若已失效(插件被删/移动),导出会告警并跳过该插件 —— 目标机需要这些源码请在源机先修好。

## 开发与测试

```bash
npm run check   # node --check 全部入口(含 bundle 内小工具)
npm test        # 纯函数 + 端到端导出/加密/校验/脚本生成测试(构造假 dshHome,不联网)
npm run verify
```

## License

MIT。

本项目为原创实现,仅使用 Node 内置模块;脚本生成与安全回滚等设计参考了社区同类插件的**公开使用习惯与通用工程实践**,不含任何第三方源码。
