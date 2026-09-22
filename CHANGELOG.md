# Changelog

## 0.3.0 (2026-09-22)

对标社区同类插件,补齐换机场景的四个短板(功能从零实现,不含任何第三方代码):

- **路径自动映射**:导出时扫描 `settings.yaml` 和 `cordis.patch.yml` 中的绝对路径(Windows 盘符路径
  + POSIX 路径),记录到 manifest 的 `pathHints` 字段。apply 时新增 `prepare-settings` 命令,检测哪些
  路径在目标机上不存在,交互式提示用户做前缀映射(如 `D:\deepseek → C:\code`),映射后写入 settings。
  解决换机后用户名/盘符/OS 不同导致路径全废的头号痛点。
- **增强凭据筛查**:除字段名匹配外,新增值模式筛查——`ghp_`(GitHub PAT)、`sk-`(OpenAI/DeepSeek)、
  `AKIA`(AWS)、`AIza`(Google)、`xox`(Slack)、JWT、`-----BEGIN PRIVATE KEY-----`(PEM 私钥)。
  即使字段名不含 key/token 等关键词,值匹配已知密钥格式也判为明文密钥。
- **导出预览**:新增 `preview=true` 参数,扫描并报告将要导出什么(profile 清单、插件数、估算体积、
  路径提示、排除项),不写任何文件。确认无误后去掉 preview 参数执行导出。
- **残留锁恢复**:apply 脚本在目标机上检测 `.lock` 文件(dsh 被强杀后残留),自动清除,避免新机启动卡住。

## 0.2.1 (2026-09-20)

针对"换机不能搞坏任何一台机器"的三道防线:

- **目标目录手动确认**:向导新增一步,显示默认 `~/.dsh` 并允许改;确认后的路径透传给 apply。
- **覆盖前询问**:目标已存在配置时必须输入 `yes`(旧文件先备份);取消返回 0 且一个字节都不改。
  非交互场景用 `-Force` / `--force` 跳过。
- **版本兼容预警**:导出时记录源机 `dsh --version`/node/平台,apply 时与目标机比对不一致即明确提示
  (取不到版本时如实写 null,不猜)。
- **未迁移清单**:`sessions` / `storages` / `background` / `skills` 的数量与原因写进 manifest、`APPLY.md`,
  apply 结束时再念一遍 —— 消除"以为全搬了"的静默丢失。
- 修复:`apply.ps1` 用 `Get-Content` 读 UTF-8 的 `manifest.json` 时被 PS 5.1 按 ANSI 解码,
  GBK 次字节吃掉转义反斜杠导致 `ConvertFrom-Json` 抛错(整脚本崩在启动阶段)。改为显式 UTF-8 读取,
  且读取失败只降级跳过版本检查。由真实执行测试发现。
- 修复:`apply.ps1` 缺 UTF-8 BOM(PS 5.1 会按 ANSI 解析导致中文乱码)。
- 新增测试:导出对源机 `DSH_HOME` **逐字节只读**的证明性断言、源环境记录、覆盖确认与目录确认的脚本断言。22 项全过。

## 0.2.0 (2026-09-20)

面向"换机不停工":从能导出进化到**敢在新机上跑**。

- **多 profile 导出**:`profile="*"` 一次搬走全部 profile;多个 profile 共用的 `link:` 源码只打包一份。
- **凭据加密搬运**:新增 `credentialPassphrase`(≥6 位),settings 与 `.credentials.yaml` 以
  AES-256-GCM 密文进 bundle(scrypt 派生、随机 salt/iv、带认证标签)。口令错或被篡改会直接失败,
  不会解出错误明文。**明文密钥既不丢也不裸奔**,换机后不必挨个重填插件 key。
- **完整性校验**:全量 sha256 清单(含 `manifest.json` 自身),apply 第一步先整包校验,
  传坏了就停手,不会带着坏数据去覆盖目标机配置。
- **跨平台**:除 `apply.ps1` 外新增 `apply.sh`(macOS / Linux),两者由同一份 plan 渲染,行为不漂移。
- **apply 安全网**:`-WhatIf` / `--dry-run` 预演;覆盖前逐个备份到 `$DSH_HOME/.dsh-sync-backup-<时间戳>`;
  任一步失败**自动回滚**。
- **按需安装**:`-SkipSettings` / `-SkipPlugins` / `-Only a,b` / `-TargetHome <dir>`。
- **profile 声明文件真正落地**:`cordis.patch.yml` / `.npmrc` / `pnpm-workspace.yaml` 在 `plugin add`
  **之前**写入目标 profile 目录 —— 此前导出却从不使用,`pnpm-workspace.yaml` 里的 `allowBuilds`
  恰恰是 git 依赖能否通过 pnpm 构建门的关键。
- **修复**:`@deepseek-ai/*` 前缀的**本地** `link:` 插件被误判为官方内置组合包而跳过安装,
  源码进了 bundle 却没人装,换机后插件凭空消失。改为先查依赖表再判定内置。
- **修复**:`profiles/` 下 pnpm 提升产物目录(如 `node_modules`)被当成 profile,且缺 `package.json`
  时直接崩溃。改为过滤 + 告警跳过,导出不再中断。
- 格式版本升至 v2(多 profile + 校验 + 加密)。

## 0.1.0 (2026-09-12)

- 首版:`dshsync_export` —— 把本机 dsh 配置导出成**可移植 bundle**,同步到另一台机器后 dsh 可继续使用。
- 只导出**声明**(settings / 可选凭据 / profile 清单文件 / `link:` 插件源码),
  **排除机器绑定产物**(`node_modules`、`sessions`、`storages`、`background`、`.anonymous-user-id`、pnpm lockfile),
  由目标机 `dsh plugin add` + pnpm 重建 —— 这是唯一能跨机成立的模型。
- 生成自安装 `apply.ps1`(UTF-8 BOM,兼容 PowerShell 5.1):拷贝 home 级声明(先备份 `.bak-<时间戳>`)→
  按 bundles 顺序逐个 `dsh plugin add` → 提示重启。
- **解决引导悖论**:apply 侧不依赖 dsh-sync 已安装,故只做导出工具 + 独立脚本。
- **凭据策略**:`.credentials.yaml` 默认不导出,需显式 `includeCredentials`。
- **明文密钥检测**:`apiKeyEnv` 填明文会被扫出并告警,只给脱敏预览。
- 源机**只读**:只复制,从不修改本机 dsh 配置。
