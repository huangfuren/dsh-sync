# Changelog

## 0.4.0 (2026-10-18)

从「同步配置」升级为「整机迁移」。此前 `sessions` / `storages` / `skills` 被列为"故意不带走"，
理由是"目录名编码了绝对路径搬过去也读不出来""运行态会自行重建""junction 会自动重建"——
**三条理由经实测都不成立**，本次逐个推翻并实现。

新增能力：

- **会话历史迁移（新）**。`sessions/<编码cwd>/<session-id>/session.jsonl.zstd` 是 **zstd 多帧串接**：
  首帧为一行 JSON header（含权威 `cwd`），其后每帧是一行事件。改写只替换**首帧**，其余帧
  **逐字节原样保留**（实测 893 帧样本：帧数不变、事件区 sha256 不变、header 其余字段不变）。
  整体解压再重压是错的做法——那会改掉全部事件帧的字节。
  - 目录名编码规则逆向确认：`:` 丢弃、`\` `/` → `-`、`[A-Za-z0-9_.-]` 保留、
    其余 → `~XXXX`（UTF-16 码元），整体包 `--`。用 `workspace.json` 的全部工作区交叉验证，**3/3 命中**。
  - 该编码**有损**（`\` 与 `-` 都折叠成 `-`），因此只做正向计算，绝不反解目录名；
    权威 `cwd` 只从 header 读。
- **工作区记录迁移（新）**。`storages/` 随行，`workspace.json` 的 `workspaces[*].path`
  按同一套映射改写。不搬则历史会话全部显示为孤立。
- **skills 链接迁移（新）**。软链**不复制实体，只记清单**（`state/links.json`），
  在目标机按清单重建。理由：bundle 经 zip / 网盘 / 聊天软件搬运时链接会被摊平或丢弃，
  靠"复制链接"保结构必然失败。外部链接目标机缺路径时**如实报告，不偷改指向**。
- **`dshsync_apply`（新工具）**。目标机侧落地：整包 sha256 校验 → 逐文件备份 → 声明层落盘 →
  状态层落盘 → 会话 header 改写 + 分组目录重编码 → `workspace.json` 改写 → 软链重建。
  支持 `dryRun`。
- **`dshsync_verify`（新工具）**。逐条核对不变量（初始 7 项：bundle 完整性 / 会话数 / 目录名=cwd编码 /
  容器结构 / 工作区对齐 / 软链重建 / 插件源码；后续又补 I8–I10 三项，见下），每项 PASS / FAIL / WARN。
  「一致」从此可以被证伪，而不是只能靠感觉。
- **有序路径映射**。按顺序应用、首条命中即返回、命中必须在**路径段边界**
  （`D:/deep` 不会碰到 `D:/deepseek/...`）。同一套映射同时作用于会话 `cwd` 与工作区 `path`，
  因为宿主会校验 `realpath(cwd) === workspace.path`，两者必须逐字一致。
  `mappings` 也接受 `"D:/a=>E:/b;D:/c=>E:/d"` 文本形式。
- **目标机 `$DSH_HOME` 可自由换位置**。软链清单里标记为 `internal` 的链接（目标在源机 `$DSH_HOME` 内），
  在目标 `$DSH_HOME` 不同时会按「源前缀 → 目标前缀」重定位并保留相对路径，报告里给出重定位条数。
  此前会把源机绝对路径原样重建 → 链接当场变断链。verify 的 I6 也随之收紧：
  内部链接必须**既能链接又能解引用**才算 PASS，只存在不合格。
- **「插件情况」真正被搬走（补正）**。此前 `profiles/<n>/package.json` **根本没进 bundle**，
  而它同时决定装什么（`dependencies`）与加载什么（`dsh.profile.bundles`）—— 插件源码躺在
  `plugins/` 里，目标机却没有东西去加载它们。现在：
  - 带走每个 profile 的 `package.json` 与 `cordis.yml`；
  - `link:` 依赖在**导出时**改写成 `link:../../plugins/<name>`，指向 vendored 副本，
    目标机换任何位置都成立（不再依赖源机绝对路径）；
  - 未 vendoring 的 `link:` 保留原样并在告警里点名，不假装能用。
- **home 级声明真正落地（补正）**。导出一直把 `$DSH_HOME/cordis.patch.yml`、`AGENTS.md` 打进 bundle，
  但 apply 从未落地过 —— 目标机的全局补丁与全局指令静默丢失，而报告一切正常。现按
  `manifest.homeFiles` 逐项落地。
- **状态层从 3 项扩到 7 项**。新增 `attachments`（附件库）、`background`（自定义背景图）、
  `dsh-market`（市场本地状态）、`llm-deepseek`（模型文件索引）。清单集中在
  `constants.STATE_PARTS`，导出与落地共用同一份 —— 两侧各写一份清单，正是「导出了但没落地」的温床。
- **verify 新增 3 项不变量**：
  - I8 工作区目录存在性：会话 cwd 字符串对得上不等于目录存在。工作区代码是独立仓库、不在
    `$DSH_HOME` 内，目标机缺目录时会话能列出却打不开，现在逐个点名。
  - I9 profile 依赖可解析：`link:` 是否解析得到、`node_modules` 是否已装（未装则明确要求跑 `pnpm install`）。
  - I10 状态层覆盖：7 个部分的文件数与源机逐一比对，「导出了但没落地」直接 FAIL。

修复：

- **`verifyBundleIntegrity` 漏掉 `await`（严重）**。`sha256File` 返回 Promise，此前直接与字符串比较，
  `Promise !== string` 恒真 → **所有文件都被判为损坏**，apply 必然拒绝执行。
  由全链路测试发现（50 个文件全部误报），已改为 `async` 并补 `await`。
- **`applyBundle` 提前返回时缺 `ok` 字段**。完整性失败 / 映射非法 / 建备份失败三条路径
  直接 `return report`，而 `ok` 只在函数末尾赋值，调用方拿到的是 `undefined` 而不是 `false`。
  已改为构造时即置 `ok: false`。
- **`inspectNotMigrated` 的三条错误理由**（见上），已删除并归入正常迁移。
- **verify 的 I5 把「源机既有的孤立会话」判成迁移失败**。真实机器上确实存在会话的工作区
  从未进过 `workspace.json`（本次实测 3 个），迁移只是忠实复现；原实现见到孤立就直接 FAIL，
  等于**迁移成功却报失败**，用户无从判断真假。现改为以 bundle 里的源机副本算出基线
  （`state/sessions` + `state/storages/workspace.json` 处在同一路径空间，可直接比对），
  不超过基线判 WARN 并注明「源机本来就有 N 个」，超过基线才 FAIL 并提示「检查 mappings 是否漏了一条」。
- **`applyBundle` 报告补 `errorCount` / `warningCount`**。工具层本来是自己数数组长度的，
  但直接调用引擎的脚本拿到的是 `undefined`（本次演练即踩到），改为引擎自己给出口径。
- **步骤 ⑧ 的 `link:` 断链检查是永久误报**。它用 `path.resolve(spec)` 按**进程工作目录**解析，
  而 `link:` 的相对路径基准是 profile 目录 → 永远对不上，于是每次 apply 都会报
  「desktop 有 5 个 / web 有 12 个 link: 依赖指向不存在的路径」，而同一时刻 verify 的 I9 显示
  17/17 全部可解析。已改为以 profile 目录为基准解析。
- **同类告警合并**。真实机器上有 49 个会话目录缺 `session.jsonl.zstd`（目录还在、日志已没），
  原先逐条上报 → apply 的 52 条告警里有 49 条是同一件事，真正需要看的两三条被埋掉。
  合并为「49 处同类：…（例：…）」，告警数 52 → 2，信息一条不少。

已知取舍：

- `link:` 依赖在目标机仍是断链（插件源码落到 `$DSH_HOME/plugins/<name>`，但 profile 的
  `package.json` 还指向源机绝对路径）。apply 会**报告**但不擅自改写——改法取决于开发流程。
  这是刻意选择：自动改成 `file:` 会切断本地开发循环。
- 帧链不完整的会话**拒绝改写**（可能是可自愈的撕裂尾帧，硬写会弄坏），原样复制并告警。
- `includeState=false` 仍可用，得到的是"能用的空环境"。

文档：

- README 重写：修正"能不能直接搬"的三条判断；新增会话改写原理、软链清单机制、verify 的不变量清单。
- `README.en.md` 同步重写（此前仍写着"只搬配置"，已与新设计对齐）。
- `scripts/export-cli.mjs`（双击导出那个）补状态层汇报：会话数 / 工作区 / skills / 软链分类，
  并列出**被写进会话的工作区路径**，明确告知「一键恢复只落地声明层、不改写路径」——
  路径不同时用户必须再用 `dshsync_apply`，否则会话文件在硬盘上但 DSH 找不到（表现为历史全空）。
- 新增 `THIRD_PARTY_NOTICES.md`：列明参考过的 MIT 项目、版权人、许可证全文、**具体参考了哪些设计点**、
  以及**没有沿用什么**。实现为原创 JavaScript，参考的是设计结论而非源码。

测试：34 → 64。新增 `test/state.test.js`（30 个用例），含**负向验证**：
篡改 bundle 后 apply 必须拒绝执行且零写入；破坏 cwd 后 verify 必须报 FAIL；
目标机换 `$DSH_HOME` 后内部链接必须重定位（断言解引用落在新位置、且旧路径不再出现）；
源机既有孤立只判 WARN、迁移新增孤立才判 FAIL；`link:` 在目标机上必须解析得到真实文件；
删掉已落地的 `attachments` 后 I10 必须由 PASS 变 FAIL。

真实机器演练（不是合成数据）：对本机 `~/.dsh` 全量走 export → apply → verify，
**目标 `$DSH_HOME` 换到另一个目录 + 工作区路径整体重映射**：

| 环节 | 实测结果 |
|---|---|
| bundle 完整性 | 783 个文件 sha256 全部通过 |
| 插件源码 | 12 个 vendored（含 `@deepseek-ai/*` 三个内置包） |
| 插件声明 | 两个 profile 共 **17 个 `link:` 依赖全部改写并逐个验证可解析**（desktop 5 / web 12） |
| 会话 | 103 文件 / 112.8 MB / 33 个会话 / 5 个工作区路径 |
| 会话改写 | 改写 19 个 header、改名 2 个分组目录、失败 0 |
| 状态层 | sessions / storages / skills / attachments / background / dsh-market / llm-deepseek 全部落地，文件数一致 |
| 工作区记录 | `workspace.json` 改写 2 条路径，会话 cwd 与之一致 |
| 软链 | 10 个：外部 7 个全部重建，3 个源机即断链（跳过并说明） |
| verify | I1–I4、I6、I7、I10 PASS；I5/I8/I9 WARN → `ok = true`，failed = 0 |
| apply 告警 | 52 条 → 合并后 **2 条**，且都属实 |

## 0.3.1 (2026-10-06)

修三个会影响换机结果的缺陷(全部由真实端到端执行发现,不是读代码推断):

- **修复(重要):apply 未把 `DSH_HOME` 指给目标目录 → 配置分裂。** dsh 通过 `$DSH_HOME` 定位
  profile(`$DSH_HOME/profiles/<name>`),而 apply 生成的脚本此前只在解析默认值时读过它一次,
  **从未导给 `dsh plugin add`**。后果:向导里改过"恢复到哪个目录"(或用 `-TargetHome` / `--home`)
  时,`settings.yaml` 落到目标目录,插件却被装进 `~/.dsh` —— 目标机拿到半份配置。
  现在 `apply.ps1` 在装插件前 `$env:DSH_HOME = $TargetHome`、`apply.sh` 在 `--skip-plugins` 分支外
  `export DSH_HOME="$TARGET_HOME"`,两侧行为一致。
  *实测证明*:令 `--home` 指向 T、`DSH_HOME` 指向无关目录 D,dsh 输出
  `initialized profile web at <T>/profiles/web`,且 D 全程未被创建。
- **修复(重要,仅 Windows):PS 5.1 把 dsh 的 stderr 当致命错误 → 装完插件却回滚。** `dsh` 把进度写到
  **stderr**(`dsh: initialized profile ...`),而 `apply.ps1` 的 `$ErrorActionPreference = "Stop"`
  会让 Windows PowerShell 5.1 把原生命令的 stderr 视为**终止错误**。于是 `dsh plugin add` 明明成功
  (profile 已初始化、依赖已写入、bundles 已注册),脚本却抛 `NativeCommandError` 进入回滚分支并以 1 退出。
  node helper 提示口令时同样写 stderr,受影响面一致。
  现在所有原生命令统一走新增的 `Invoke-Native` 包装:执行期间把 `$ErrorActionPreference` 降为
  `Continue`,只以 `$LASTEXITCODE` 论成败。判定点从 `$LASTEXITCODE` 改为 `$script:NativeExit`。
  *此前未暴露的原因*:那一轮 Windows 验证用的是 `-SkipPlugins`,插件安装路径没被真正执行到。
- **修复:`export-cli.mjs` 收尾自检在部分环境以 `EBUSY` 异常退出。** 它原本 spawn 一个 node 子进程
  跑 `dsync-helper.mjs verify`,在便携版 / 可执行文件被安全软件或自身占用时会拿到
  `EBUSY: resource busy or locked`,且异常未捕获 —— bundle 明明导出成功却抛栈退出。
  改为**在本进程内**用同一份 `checksums.json` 完成校验(`lib/checksum.js` 的 `verifyChecksums`),
  不再 spawn;并加 try/catch 兜底,自检环节永不把一次成功的导出变成异常。
- 把 `scripts/export-cli.mjs` 纳入 `npm run check` 的语法检查范围。
- 新增回归断言:ps1 / sh 必须把 `DSH_HOME` 指向目标目录;ps1 必须包含 `Invoke-Native` 包装、
  以 `$script:NativeExit` 判定,且**不得**再出现裸 `if ($LASTEXITCODE`(PS 5.1 会在读到它之前就抛错)。
- 文档:新增英文 README,默认语言为中文。语言约定统一为 `README.md`(中文,默认入口)+
  `README.en.md`(英文),两版顶部互链;`files` 补入 `README.en.md`。

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
