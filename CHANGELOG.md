# Changelog

## 0.18.0 (2026-10-25)

**一句话迁移:迁移全程零中途插手。** 用户在旧机说一句「我要迁移」,确认一次清单;新机选中机器、
填一次码、点一次「开始迁移」;之后传输、落地、依赖重装、核验全部自动走完,新机卡片以一句
汇总判定收尾——「迁移完毕:插件正常,dsh 配置正常,可以使用」。261 个测试全绿。

### 旧机:export 加 `autoHost`,导出与起发送端合并成一次调用

原来「导出完 → 再跑 dshsync_lan_host → 再到页面点接受」是三步。现在
`dshsync_export(autoHost=true)` 在 bundle 写完后**立刻就地起发送端**,配对码与进度页地址
直接出现在同一次工具输出里,agent 不必记得串第二个工具。发送端以 autoAccept 模式启动,
配套对码即开传——旧机侧从「确认清单」之后就不需要任何人守着。发送端起不来时降级为提示
手动路径(bundle 已完好落盘,不推翻导出结果)。

### 发送端:`autoAccept` 自动接受配对

`startHost` / `dshsync_lan_host` 新增 `autoAccept` 参数(默认 false,手动模式行为不变)。
开启后配对码对上即接受并进入等待拉取,不再要求在本机进度页点「接受」。安全面收窄了多少,
说得清:此前「码 + 本机确认」是两道门,现在配对码是唯一一道——它仍然是一次性、5 分钟过期、
5 次试错锁定、仅私有网段;丢掉的只是「拿到码的人还必须坐在这台机器前」这一条。自动接受在
日志与页面上留痕(`autoAccept` 标志随 /info 广播)。

### 广播带内容计数:新机在配对前就知道「将迁移什么」

`/info` 与 UDP 广播新增 `bundle: { sessions, plugins, workspaces, encrypted }` 计数
(从 manifest 一次算好,扫描打多少次都不读盘)。**计数公开、名字不公开**:工作区与插件的
名单能拼出这台机器的使用画像,所以带名字的完整摘要走新的 `/summary` 端点,与 `/entries`
同一条边界——需要配对 token。旧发送端没有这些字段时,卡片就不渲染那一行,不显示误导性的 0。

### 新机卡片:免填化 + 完成态汇总判定

- 设备列表每行带出「将迁移:会话 X · 插件 Y · 工作区 Z · 体积」,加密的 bundle 标 🔒;
- **口令输入框只在选中的设备报告「已加密」时出现**——不加密的 bundle 这个框纯属吓人,
  加密的不填它落地必然失败;没选中设备时先不显示;
- `workspaceRoot` 从插件配置带出默认值(与 destDir 一起预填),多数人只填一个配对码;
- 源机开了一条龙时,「还差一步:去源机页面点接受」的叮嘱换成「传输自动进行中,无需在源机操作」;
- 迁移结束,卡片先给**汇总判定**再给明细:会话历史 / dsh 配置 / 插件 / 工作区 / 依赖 五项,
  全过就是那句「迁移完毕:插件正常,dsh 配置正常,可以使用(重启 dsh 后即与旧机一致)」;
  有 FAIL 就点名失败项。判定由 `verdictOf` 从 verify 检查(I 编号)与 apply 报告推出,
  工具输出与卡片读同一份;只有 FAIL 挡「可以使用」,WARN 如实写进备注但不挡。

### 旧机进度页:新增「bundle 内容」卡片

本机打开页面能看到打包了什么(会话数、插件名单、工作区清单与体积、凭据策略)——
远端快照里没有这个字段,可见性边界与配对码一致。

### 测试

261 → **261 全绿**(新增 9 条:autoAccept 配对即接受、`/info` 计数与名字不外泄、
`/summary` token 门禁、autoAccept 全程 pullBundle、toDevice 新字段与旧发送端兼容、
verdictOf 全绿/失败两态、migrateDefaults、jobSnapshot 带 verdict)。

## 0.17.0 (2026-10-24)

**给迁移加后悔药:apply 侧记账 + dshsync_undo 导入级撤销。** 借鉴 dsh-workspace-migrate 的
scoped undo(只回滚本次导入创建的项):apply 现在把每一笔变动记进备份目录里的落地账本
(`journal.json`),`dshsync_undo` 倒序回放整体撤销。252 个测试全绿。

### ① 落地账本(apply 侧记账)

apply 在备份目录里记下四类操作:文件**新建**(apply 前不存在,撤销=删)、文件**覆盖**(备份即
pre-state,撤销=还原)、**软链**(新建/替换,替换记旧指向)、会话分组**目录改名**。每个文件操作带
「apply 写完那一刻」的内容 sha256;同一文件被多次写(复制后 header 原地改写、projcache 重映射)
时以最后一次为准。账本在 ②b/⑥/⑦ 各大步骤后增量落盘,中途崩掉也有已发生部分的账。

### ② dshsync_undo(第九个工具)

倒序回放账本:新建的删掉(沿父目录链清掉空目录)、覆盖的从备份还原、软链摘除或还原旧指向、
分组名改回去(文件操作先把「改名前 rel」换算到改名后的实际位置)。安全规则:**当前内容 ≠
apply 写完时的指纹 → 跳过并逐条报告**——你已经开始用 dsh 的数据绝不拿旧快照盖。缺省撤
最近一次(回执带账本指针);更早的备份在存在更新 apply 时拒绝撤销(一层层退)。
`dryRun=true` 预演;撤销后建议 `dshsync_verify` 核对。

### ③ 顺手修的三个真问题

- **备份目录时间戳只到秒**:同一秒内两次 apply(自动化/重跑)会撞进同一个备份目录,后一次的
  账本与备份覆盖前一次的。`createBackupDir` 与 apply.ps1/apply.sh 的 Stamp 全部加毫秒。
- **工作区代码覆盖从不进备份**:②b 解包工作区时没挂 before 回调,`overwriteWorkspaces=true`
  覆盖已有目录时原文件直接丢。现在与其它写入同口径(备份 + 记账)。
- **README 工具表 `dshsync_remap` 行重复**。

## 0.16.0 (2026-10-24)

**把「迁移完成」推近用户想要的终点：传完自动补装依赖、卡片能带口令、必办直接出现在卡片结果里。**
0.15.0 把坑都点亮了（必办清单），这一版把其中两件能替用户做的直接做掉。239 → 247 个测试全绿。

### ① 卡片与局域网链路支持凭据口令（补掉 0.15.0 复盘的结构性缺口）

`dshsync_lan_pull` 新增 `credentialPassphrase` 参数，设置卡片的「开始迁移」表单新增**凭据口令（选填）**
密码框。口令沿 迁移路由 → pull-runner → 拉取器 → apply 一路**只在内存里传递**：不进任务状态、不进
日志、不落任何盘——卡片配置区仍然不保存任何密钥（secretNote 文案同步改写）。此前这条链路没有
口令输入位，加密导出的凭据在局域网流程里**必然**落不了地（复盘 P2 的真正根源）；现在导出时给的
口令在卡片上填同一个，凭据落地后必办项自动消失。

### ② 落地后自动重装缺失依赖（补掉复盘 P1 的手工痛点）

`dshsync_apply` 与局域网自动落地默认（`installDeps=true`）对缺依赖的 profile 执行自动重装：

- **pnpm 路径不再要用户自己翻安装目录**：从运行中的宿主进程推导（插件就跑在宿主的 node 子进程里，
  `resources/runtime/primary-runtime/dependencies/{node,pnpm}` 布局由 `lib/deps-install.js` 解析，
  找不到 pnpm 不编造，如实退回手工路径）；
- **失败不掩盖**：宿主活着时 Windows 可能锁住运行中的原生模块导致安装失败——失败原因（pnpm 退出码
  + stderr 尾部）原样进必办，绝不假装装好；
- **一键脚本兜底**：无论成败都生成 `$DSH_HOME/.dsh-sync-install-deps.ps1`（+.sh）——完全退出 dsh 后
  运行（无文件锁，必定干净），脚本里写死解析出的 node/pnpm 绝对路径与各 profile 目录，双击即可；
- 自动重装成功时必办措辞变为「已自动重装，重启 dsh 后生效」。

### ③ 卡片结果区补全（修掉一个 0.13.0 以来的暗坑）

局域网拉取的 `result.apply` 此前**没带** `nextSteps` 与 `actionRequired`——卡片结果区的「必办」行与
「接下来」清单在真实迁移里从来没显示过（测试里的合成数据带了这个字段，所以一直全绿）。现在随报告
走到卡片（`lib/lan/jobs.js` 的结果行生成器把必办逐条列成「必办」行）与 `dshsync_lan_status`。

### GUIDANCE / 文档

宿主依赖一节改写为「工具代做重活」的现状；Secrets 一节写明口令的内存传递通道。

### 测试

239 → 247。新增 `test/deps.test.js`（7 条：运行时路径推导与 pnpm 缺失不编造、缺失包点名、脚本生成
内容与无缺失不生成、注入 runner 的成败记账、apply 集成三态——成功必办改写+脚本兜底 / 失败原因与
脚本路径 / 没 pnpm 如实回退）；LAN e2e 新增加密凭据用例（带口令落地 / 不带口令进必办且 nextSteps
第一屏可见）。


## 0.15.0 (2026-10-24)

**一次真实换机迁移的全程复盘（12 个问题，P1–P12）直接落成了代码。** 复盘文档逐条给出宿主侧
证据（宿主日志原文、错误措辞、激活链级联），这一版把其中会伤数据、会白迁、会死局的项全部修进
插件，其余按 verify 检查项兜底。231 → 239 个测试全绿，其中 8 条是这次复盘的回归用例。

### 五个落点补齐（P3 / P4 / P10 / P11 —— 会话身份索引缺了两层）

迁移的落点清单从三处补到**五处**：会话首帧 cwd → 分组目录名 → workspace.json →
**session_projcache 两层（新增）** → skills 软链。此前 0.14.x 一层 projcache 都没碰：
单元 dump（`tables.sessions[*].identity.cwd`）漏了表现为「侧栏会话列表空白」（P3），
逐会话记录（`storages/session_projcache/sessions/<id>.json`，内嵌日志绝对路径）漏了表现为
`corrupt session log` 且 workspaceRegistry **整棵拒绝激活**（P10）。逐会话记录的日志路径
改写由 apply 的幂等复制顺带返回的分组改名清单驱动 —— 必须用 bundle 侧旧分组名，目标机扫
出来的 plan 是「已改名后」的口径，对不上旧名字。

路径形态同步修正（P4 / P11）：映射**输出**统一转平台原生形态（新增 `path-map.toNativeForm`）
—— 宿主 attach 校验把 `realpathNormalize(header.cwd)` 与 `record.path` **逐字比较**，重映射后
写成正斜杠的 record.path 必报 `workspace-attach-failed`。匹配侧本就归一化（盘符大小写不敏感、
正反斜杠等价），实测数据里的 `e:\...` 杂讯形态现在也能命中。

### 重复 session id：写盘前整体拦截（P5）

源机项目搬过家时旧目录会残留旧会话，导出把两个分组都带上，落地重映射后同一 session id 出现在
两个分组 —— 宿主报 `duplicate JSONL session id` 并拖垮整棵服务树（workspaceRegistry →
sessionController → schedule 全 pending），表现为「迁移显示成功但什么都打不开」。
`scanSessions` 现在跨分组查重（按 header.id，缺失时退回目录名），**apply 在动第一个字节之前**
扫 bundle 预检，发现重复整体拦下并给出处置建议；落地后的扫描同样把 error 级问题送进 errors
而不是 warnings。

### 依赖与凭据：「必办」取代「叮嘱」（P1 / P2）

实测推翻了 README 的旧说法：**宿主重启不会自动按新 package.json 重装 node_modules**——apply
覆写声明后重启，全部插件「异常 / 包不可用」，宿主不报任何错。apply 现在逐个落地过的 profile
比对「声明 vs node_modules 实有」，缺包进新的 `actionRequired`（必办）清单并排在 nextSteps
第一位；凭据未落地（bundle 含加密凭据但未给口令）同样进必办，不再是可以无视的 warning。
`plugins/node_modules → profiles/<p>/node_modules` 联接由 apply 自动创建（P6：vendored 插件
靠上级目录解析 schemastery 等共享包，落进 `.dsh/plugins/` 后解析链上没有任何一层有它）。

### 新工具 `dshsync_remap`（P8）

迁移完成后用户把工作区挪盘、把项目挪进子目录 —— dsh 全挂，而 apply 需要 bundle（那是迁移前的
旧路径）帮不上忙。`dshsync_remap(dshHome, mappings, dryRun)` 对**本机现状**就地改写上述五个
落点，映射必填、dryRun 先行、幂等可重跑；注册表 / 快捷方式 / 应用安装位置超出范围，明确提示
自行同步。

### verify 增项与强化（P12 / P4 / P10）

- **I14 projcache 身份残留**：session_projcache 两层里还有指向源机 home 的路径 → FAIL
  （这是 corrupt session log 的确定前兆，不是提示）。
- **I8 补强**：workspace.json 注册了但目录缺失的工作区单独点名（可能一个会话都没有，
  但宿主 attach 照样报错），给出「建空占位 / 移除注册」两条出路。
- **I5 补逐字形态**：record.path 不是平台原生形态时单独 WARN（normalize 相等不等于逐字相等，
  P4 的坑 verify 此前看不见）。

### GUIDANCE 修正

补写五条宿主不变量速查（attach 逐字比较、分组名编码、projcache 双层互校、重复 id 级联、
subagent 裸 UUID 目录形态），桌面版依赖重建的说法改为与实测一致。

### 测试

231 → 239。新增 8 条：原生形态输出（混形态源数据 `d:/...` 命中且输出 `E:\...`）、projcache
双层随 apply 重映射（含杂讯形态记录与 I14 正反两向）、重复 id 零写入拦截、裸 UUID subagent
会话不被漏掉、缺依赖与缺口令进必办、remap 五落点端到端与 dryRun/空映射守卫。


## 0.14.2 (2026-10-23)

**README 重排:中文主文从 543 行压到 267 行。** 原来的结构是「先讲 147 行设计原理,第 190 行才开始讲
怎么用」,读者要跳读 500 行才能找到第一条命令。现在装上就能跑,原理沉到文末。

- **顺序改为**:定位 → 安装 → 快速开始(导出 / 搬 / 落地)三步 → 再迁一次 → 工具 → 配置 → 密钥 →
  已知限制 → 开发。首屏即可看到安装命令与第一步。
- **原理与实测细节收进文末 10 个折叠块**(三层结构 / 为什么不能直接复制 `.dsh` / bundle 布局 /
  会话改写 / 工作区打包 / 方向判断 / 桌面版差异 / 核对项 / 安全设计 / 设置卡片为何手写)。
  信息一条未删,只是默认收起。
- **核对表补 `I6b`**:指向 `$DSH_HOME` 之外的外部软链在目标机缺路径时单独报 WARN。
  「13 项不变量」的说法随之改为「14 项检查(I1–I13,另含子项 I6b)」,与 `lib/verify-engine.js` 的
  14 个 `add()` 编号对齐 —— 市场评审会逐字核对数字。
- **补「目标机 `$DSH_HOME` 可放任意位置」**:与源机不同时,内部软链从源前缀重定位到目标前缀并报告数量。
  这段此前只写在英文版,中文版缺失。
- 英文版按同一结构重排(`README.en.md`,主文 223 行)。

代码零改动,`npm run verify` 仍是 231 全绿。

## 0.14.1 (2026-10-23)

**补齐安装说明。** 双语 README 从头到尾只有「怎么用」，没有「怎么装」—— 投稿插件市场时这正是会被
打回的第一条（同批提交的另一个插件被明确要求「README 没有安装命令」）。市场条目里的安装命令与
README 里的应当是同一条，不能让读者自己猜。

- 双语 README 新增 `## 安装` / `## Install`：`dsh plugin --profile web add github:huangfuren/dsh-sync`
  （桌面端把 `web` 换成 `desktop`），并写明**新旧两台机器都要装**、装完要重启（工具与同源路由都在
  启动时注册）、node ≥ 22.19 与同网段的要求。
- `package.json` 补 `repository` 字段，指向本仓库。

代码零改动，`npm run verify` 仍是 231 全绿。

## 0.14.0 (2026-10-23)

**多次交接：第二次（及以后）的迁移不再拿源机快照直接盖。** 用户的工作流是「先迁一次，旧机继续
用，过一阵再往同一台新机迁第二次」—— 这时候目标机已经不是空的了，而默认落地是**覆盖写**：
目标机在这期间自己装的插件、注册的工作区、改过的设置，一样都不在源机快照里，一盖就没了
（备份目录里有，但没人会去翻）。

### 新增 `merge=true`：先摊开分歧，再决定写不写

`dshsync_apply` 加了 `merge` 与 `resolutions` 两个参数。`merge=true` 时，落地前先把 bundle 与
**本机现状**比一遍，分四类列出来：

- `plugins` —— 本机声明里有、bundle 里没有（落地后会**从声明中消失**，源码还躺在 `plugins/` 里但
  没人加载它），或两边都有但版本不同；
- `workspaces` —— 本机注册过、bundle 里没有的工作区记录；
- `settings` —— 两边 settings.yaml 不一样。**不做三方合并**：YAML 的锚点、注释、键序在不知道
  schema 的情况下并对不了，合坏的结果比任一边都糟；
- `sessions` —— 只汇总一条（会话可以有几百个，逐条列等于没列）。

**只要还有一项没决定，就停在写盘之前，本机一个字节都不会动。** 检查插在工作区代码落地
（第一个会动目标机的动作）之前，不能往后挪。决议缺失一律按未决处理，**不设默认值** ——
merge 模式的全部意义就在这里：宁可让人多看一眼，也不替他猜。停下来时会给出「照着清单填
resolutions 再跑一次」的下一步，而不是只抛一个拒绝。

给了决议之后：`keep-target` 留本机的、`take-source` 跟源机走；settings 二选一；sessions 给一个
统一策略（`skip` / `append-missing` / `prefer-source` / `prefer-target`）。会话一律是**文件级**
操作 —— `append-missing` 只补本机缺的那几份日志，已有的（包括它自己追加的）一个字节都不碰；
**绝不拆帧再重组**，否则「历史不可能被破坏」这条保证本身就不成立了。

小细节但会咬人：工作区记录的合并放在路径改写**之后** —— 并回来的这些记录本来就是本机路径，
已是最终值，再对它们跑一遍源机→本机的映射只会把已经正确的路径改错。

### 局域网直传同样能带上 merge

第二次迁移大概率也是走卡片的，所以 `merge` / `resolutions` 一路透传到了 `dshsync_lan_pull` 与
卡片的「开始迁移」（`lib/migrate.js` → `pull-runner` → `client` → `applyBundle`）。

预演阶段就带 merge，于是「还有冲突没决定」是在**落地之前**说出来的。此时 bundle 已经完整收到了，
日志会直接把待定项列出来（含本机值与 bundle 值），并说明「给决议后重跑本命令即可，已收到的文件
全部跳过，不会重新传输」。`dshsync_lan_status` 也会把待定项列出来。

### 顺带修掉的一个误报

目标机**还没有** settings.yaml 时（第一次迁移就是这种），原本会被判成「两边不同」而列为冲突，
于是**第一次迁移开着 merge 也会被拦下来**。现在这种情形直接落地，不算冲突。

### 测试

新增 `test/merge.test.js`（12 条）：插件声明三类分歧、合并函数的 keep/take 两个方向、决议缺失算
未决（含非法取值）、**第二次迁移停在写盘前且本机一个字节没动**（这条最要紧，直接断言
package.json / workspace.json / settings.yaml 的字节与源机新会话都没落地）、keep-target 与
take-source 各自的落地结果、sessions 四种策略、`merge=false` 行为与旧版完全一致、第一次迁移开
merge 不被拦。

219 → **231 全绿**。

## 0.13.1 (2026-10-23)

**补掉两个真正会伤到数据的洞，并把「源机」这个词的二义性彻底消掉。** 前一版做完体感优化后，
把整个迁移流程按「哪里会在用户不知情的情况下丢数据」重新审了一遍，最实际的两条如下。

### ① 重跑 apply 不再翻倍

起因是一个**官方恢复路径自己踩的坑**：报告的「下一步」明确写着「按错误逐项处理后重跑
（已完成的步骤不会重复破坏数据）」，而重跑恰恰会破坏数据 —— 落地引擎无条件从 bundle 重新复制
`sessions`，可第一次运行已经把会话分组目录改名成新路径编码了。第二次运行时 bundle 里的旧目录名
副本又被复制进来、又要改写、又要改名，目标名已被占 → 改名失败，留下**新旧两套会话目录并存，
其中一套目录名与 cwd 编码不符**（verify 的 I3 判 FAIL，清理要手工删目录）。

现在复制前先按映射算好每个分组的落点，分三种情形：目标机已是迁移后状态 → **跳过**（顺带保住
迁移后用户在新机上继续聊出来的帧，照 bundle 覆盖等于丢历史）；已建好分组但缺个别会话（上次中断）
→ 补进新目录；其余照旧。报告里多一行「已是迁移后状态跳过 N」。

> 修的过程中发现这个保护**原本一次都没生效过**：`scanSessions` 收的是 `$DSH_HOME`（内部自己拼
> `sessions`），而幂等判定传的是 sessions 目录本身，扫出 0 个会话后静默退回整目录复制。更糟的是
> 判定里的 `sessionDirCwd` 引用了**从未 import 的 `isSessionLogName`**，抛出的 `ReferenceError`
> 被外层 `catch {}` 吞掉——「看起来在跑、实际恒为假」。已补 import，并新增 `isFsIoError()`：
> 这个文件里凡是要吞异常的地方，只吞「文件读不了」这类 I/O 错误，**代码 bug 一律炸出来**。
> 测试 `重跑 apply 不翻倍` 钉住这条链路，不是只钉住接口。

### ② 宿主回写从「叮嘱」变成「可检测」

`apply` 跑在**活着的宿主进程**里，宿主内存里持有 settings 与 workspace.json，随时可能把旧配置
写回、盖掉刚落地的文件 —— 用户看到的是「迁移成功，重启后设置全变 old」。原来唯一的防御是
nextSteps 里那句「落地后先别在界面里改设置」，纯纪律约束，做不到拦截，也说不清拦截时机。

现在分两段抓：
- **落地期间**：每次写入关键文件后立刻记下内容 sha256，落地结束逐条复核。抓到就报 error，
  整个 apply 判失败，并告诉用户「完全退出 dsh（桌面版从托盘退出）后重新 apply」。
- **落地之后、重启之前**（更长的窗口）：指纹写成落地回执
  `$DSH_HOME/.dsh-sync-apply-receipt.json`，`dshsync_verify` 新增 **I13** 随时复核。
  按内容比较，宿主原样重写（内容没变）不误报；没有回执（手工落地或旧版本落的）报 WARN 并说明
  原因，**不假判 PASS**。回执刻意不进 `STATE_PARTS`——它是本机的落地记录，不该随下一次导出走。

### ③ 术语：源机 = 旧机

「源机」这个词在两处被读反过。GUIDANCE 与双语 README 现在都写明：**源机 = 旧机**（有历史、
要搬出去的那台，跑 export / lan_host，全程只读），**目标机 = 新机**（刚装好、要变成跟旧机一样的
那台，跑 apply / lan_pull / verify）。并要求 AI 汇报时把「旧机/新机」与「源机/目标机」并列说出。

### 测试

209 → 219（新增 10 条，全部落在 `test/apply-safety.test.js`）：重跑不翻倍且不留孤儿分组、
重跑不抹掉目标机新增帧、中断后补齐缺失会话、回执指纹等于磁盘内容、I13 的 FAIL / 不误报 / 无回执
WARN 三种分支、落地期间并发回写当场判失败、正常落地不误报、GUIDANCE 术语段。

## 0.13.0 (2026-10-22)

**一次换机迁移里能省的动作，这一版省掉了四处。** 上一版把「在卡片里发起」做通之后，把完整流程
按用户视角数了一遍（11 步），找出的可省项按「不动安全边界、只去掉机械劳动」筛，留下这四条。

### ① 起发送端不再需要手抄 bundle 目录

`dshsync_lan_host` 的 `bundleDir` 缺省取配置里的「输出目录」。`outDir` **本身就是 bundle 目录**
（`exportBundle` 里 `bundleDir = path.resolve(outDir)`），导出的落点就是要发送的目录，让用户把同一个
路径再敲一遍纯属折磨。显式传参仍然压过配置。

### ② 只有一台时自动选中

「先选中设备」是安全边界（绝不替用户挑机器），但当列表里**只有一台且用户还没选过**时，不存在
选错的可能 —— 再点一次是白走一步。此时自动选中，并在界面上标一句「只找到这一台，已自动选中」，
让用户知道这台是谁选的。已经选过就绝不自动改选：对方关掉发送端后旧选择标 stale 并提示重扫，
跟之前一样。

### ③ 展开卡片时先广播一次

原来展开卡片只取内存快照，必须点「扫描」才发网络请求。现在**首次展开顺手做一次「仅广播」快扫**
（一次 UDP 广播 + 等 1.2 秒，不打 254 个地址）：用户打开这张卡片就是为了看有什么机器。
全量扫描（广播 + 逐 IP 兜底，最长 4 秒）仍然只在点「扫描」时走 —— 「看一眼设置页」不该顺带扫一整段网段。
对应地新增路由动作 `quick`；**未知 action 一律落到 `snapshot`**，一个拼写错误不许悄悄发起网络 I/O。

### ④ 完成态列出「接下来」

`apply` 报告里的 `nextSteps`（最要紧的一条是**重启 dsh**）此前只在对话里出现。卡片上不说，
用户就会把「迁移完成」当成「现在能用」，然后在旧配置下继续干活。现在引擎算、job 带、卡片渲染，
`dshsync_lan_status` 也打印同一份（`nextStepsOf` 从 jobs.js 导出后三处共用）——
**只有一份来源**（工具侧删掉了自己那份构造，两套迟早说不一样的话）。

### 测试

197 → 209（新增 12 条）：`bundleDir` 缺省值与显式传参的优先级、两个前置错误的措辞、
`stop` 恒成功；自动选中的三种情形（唯一 / 多台 / 已选过）与「剩一台也不改选」；
`quick` 不打地址（`scanned === 0`）、未知 action 落到 snapshot；`nextSteps` 的嵌套与平铺两种形状；
客户端两个区块的新状态不抛。新增 `test/lan-host.test.js`（**只测发起之前**那一段，不监听端口）。

## 0.12.0 (2026-10-22)

**迁移可以在卡片里一键发起了**，不必再回到对话里说一句话。

### 为什么

上一版把「先选中设备」做通了，但发起迁移仍要回对话：配对码、bundle 目录、项目根目录三个参数
得在对话里敲一遍。用户评估体感后的结论是——最别扭的三处里，两处（跨屏抄配对码、两个路径要想）
都属于「能在界面上省掉」的：**配对码保留**（它是「证明你看到了源机屏幕」的那道闸，动它是安全取舍），
但填码、填路径、点开始这三下，应该都在设置页里完成。

### 卡片新增「开始迁移」

- 三个输入：配对码 / 收到哪 / 项目代码落到。**「收到哪」由宿主给默认值**（系统临时目录下的
  `dsh-sync-incoming`，与导出侧的 `outDir` 刻意分开：两台机器可能配了同一个 outDir，混用会互相污染），
  展开卡片即预填。
- 「开始迁移」按钮：未选中设备 / 未填配对码时禁用，并说明缺哪个。
- 传输中：进度条 + 百分比 · 文件数（含续传跳过数）· 速率 · 剩余时间，外加一句「还差一步：去源机点接受」。
- 完成后：收到 / 耗时 / 落地 / 备份 / 核验 五行结果 + 最近日志。

### 执行逻辑只有一份

`lib/lan/pull-runner.js`（新）把「从哪台机器拉 + 怎么拉」抽出来，`dshsync_lan_pull` 工具与卡片上的
按钮**共用同一份实现**。两处各写一份的话，差别一定会出现在错误处理上（进度页起不来、中断续传、
失败记账），而这类差别只在真机上才暴露。工具侧只是把结果渲染成多行文本，卡片侧渲染成进度与结果行。

### 两条约束

- **发起请求立刻返回 jobId**，不等待传输完成：一次迁移可能十几分钟，挂着一个 HTTP 请求等它，
  宿主的请求超时与卡片加载态都会先崩。卡片每秒轮询 `status`，且只在任务运行中才轮询。
- 新增路由 `/api/dsh-sync/migrate`（`start` / `status`），约束同前两条：bind-at-extraction、
  `c.effect` 管 disposer、refuse-quietly、`no-store`。挂不上只影响「在界面上发起」，
  对话里的 `dshsync_lan_pull` 完全不受影响。

测试 187 → 197（新增 10 条：默认目录、参数校验在发起连接前拦下、任务视图形状、
路由常量一致、迁移区块三态、`progressText` 缺字段不渲染 undefined/NaN）。
**刻意不测 start 的成功路径** —— 那会真的建 socket 与起进度页服务，测试里连不上还会留下挂起句柄。

## 0.11.0 (2026-10-22)

**先选中设备，再迁移。** 之前 `dshsync_lan_discover` 只是在对话里打印一串地址，想迁移还得把 IP 手抄进
`dshsync_lan_pull` —— 「发现」和「迁移」之间缺一个选中步骤。现在这条链路通了，两个入口共用一份状态。

### 卡片里：扫描 → 点选

设置卡片下半新增「局域网设备」区块：点「扫描」→ 列出所有开着发送端的机器（别名 / 地址:端口 /
bundle 体积 / 状态）→ 点一台选中（高亮 + 「已选中」标记）→ 下面直接给出下一步该说什么。
检测范围维持原判据：**只列已开启发送端的机器**，列表里每一台都是真能传的，不会出现「选了它却传不了」。

三条刻意的边界：
- **展开卡片只取内存快照，不发起扫描**（0.13.0 起改为首次展开广播一次，全量扫描仍要手动点，
  见 0.13.0 第 ③ 条）。一次全量发现要打 254 个地址（广播 1.2s + 兜底约 3s），
  不该因为看一眼设置页就扫一轮局域网。同理，路由的缺省动作是 `snapshot` 而不是 `scan` ——
  一个写错 `action` 的调用不能悄悄触发网络 I/O。
- **迁移不在卡片里发起**。它需要源机页面上的 6 位配对码 + 人工点一次「接受」，放在对话里由工具承担更稳；
  卡片只负责把目标机器定下来。
- **选中项只在内存里**：插件重载 / DSH 重启后列表为空，重新扫描即可。过期（对方关了发送端）时明确标
  stale 并提示重扫，不静默改选另一台。

### 对话里：deviceId

`dshsync_lan_discover` 的输出现在带稳定 `id` 与 1 基序号，且结果被记住：
`dshsync_lan_pull(deviceId="1"｜id｜别名｜IP)` 直接引用其中一台；
`host` 与 `deviceId` 都不给时，回退到卡片里选中的那台。**没选过就明确报错并说清三条路，绝不替你挑**
—— 把 bundle 传给错的一方不可挽回。

新增 `lib/lan/devices.js`（登记表与解析），路由 `/api/dsh-sync/devices`（`snapshot` / `scan` /
`select` / `clear`），约束同 overview：bind-at-extraction、`c.effect` 管 disposer、refuse-quietly、
`no-store`、客户端自带一份路由常量（有测试钉住两处相等）。

测试 167 → 187（新增 20 条：规范化与去重 / 四种标识解析 / 多命中与越界报错 / stale 语义 /
路由三个动作与缺省动作 / 设备区块四态 / `resolvePullTarget` 的 host > deviceId > 选中项 优先级）。

## 0.10.0 (2026-10-22)

新增**设置卡片**：`设置 → 内置插件 → dsh-sync 迁移` 一张卡片，上半改导出默认值，下半只读本机状态。
这是本包第一次带客户端半边（`client.js`）。

### 为什么必须自己写

宿主「从 Config schema 自动生成设置页」这件事，0.2.1-rc.2 的 `dsh-settings` README 写得很直白：
`autoGenerate` 默认开，**「for clients that build pages from the schema; no shipped client does so yet」**
—— 没有任何客户端实现自动页。所以在 0.9.0 之前，本包导出的 `Config` 与
`configure({ auto: true })` 在界面上**什么都不会出现**：设置里既没有卡片，也没有左栏条目，
只有「插件列表」tab 里一行只读的模块路径与版本号。想让人看得见，只能自己注册
`settings.plugins.tab`（与 dsh-outline / dsh-alist 同一条路）。

### 卡片里有什么

- **导出默认值（可编辑）**：`outDir` / `profile` / `includeState` / `includePlugins`。
  改的是「不传参数时用什么」，每次导出仍可用工具参数覆盖。
- **本机状态（只读）**：机器名与用户名、dsh 版本及来源、状态层计数（会话 / 工作区 / skills / profile）、
  默认输出目录里那份 bundle（导出时间 / 文件数 / 来源机 / 是否加密 / 是否含明文凭据）、
  局域网发送端（端口 / 配对码）与最近任务。
- 徽章区分「已配置」（用户覆盖过至少一个字段）与「默认值」—— 用 `snap.value` 判非空没有信息量，
  它恒含 schema 默认值。

### 状态通道

状态走宿主**已认证的 `/api` 围栏**（`ctx.connection.fetch.register` → `/api/dsh-sync/overview`），
不自己起 HTTP 服务、不把状态塞进投影。三条铁律都落了：`bind`-at-extraction、注册包在 `effect` 里、
注册被拒时 refuse-quietly（卡片退化成「只有配置区」，配置照常可改）。

汇总逻辑在 `lib/status.js`：所有读取失败退化成哨兵（`-1` / `null`）而不是把卡片打空；
`probeRuntime` 显式关掉 CLI 探测 —— 为了显示一个版本号去起一次子进程不划算。
工作区计数读 `storages/workspace.json` 的 `tables.workspaces`（**对象** map，不是数组）。

### 两处安全收紧

- `credentialPassphrase` 与 `includeCredentials` **去掉了 `.volatile()`**。标了 volatile 的字段才进宿主
  的表单/可被 `settings.update` 写入；去掉之后它们在任何界面里都改不到，只能用工具参数按次传。
  前者若进表单会明文落在 `settings.yaml`，后者是一键把明文凭据打进 bundle。
- 卡片里那段提示把这件事写明了，避免有人以为「找不到就是漏做了」。

### 实机验证修掉的一处取默认值缺陷

宿主会把 Config 的 schema 默认值（空串）一并传进 `apply` 的 config，`...config` 展开后把算好的
`dshHome` / `outDir` 盖成空串 —— 卡片上「dsh / 状态层 / 输出目录」全部显示「—」，工具层则会直接抛
`cannot resolve $DSH_HOME`。现按字段描述兑现「Empty = auto」语义：空串回退到计算默认
（`withAutoFallbacks`，有测试钉住）。

### 数据

- 新增 `client.js`（手写单文件 IIFE，不用构建链）与 `lib/status.js`；`package.json` 补
  `exports["./client"]`、`dsh.client`（inject 提供 `slots`/`locale`/`configForms` 的宿主包，
  与 dsh-outline 同一条路）、`files` 与 `check` 项。
- 客户端与服务端各写一份路由常量（浏览器半不能 import 宿主模块），有测试钉住两处相等。
- 测试 152 → 166（新增 14 条：注册冒烟 / 常量一致 / 控制器写入与失败语义 / 计数与哨兵 /
  路由注册与 refuse-quietly / 响应 200 + `no-store`）。

## 0.9.0 (2026-10-22)

适配桌面版。查下来发现三处「在 web 上一切正常、到桌面版就静默失效」的地方，其中两处会让人
误判成「插件坏了」。

### 桌面版适配
- **宿主版本改从正在运行的应用里读**。原先只读 `$DSH_HOME/dsh-runtimes/*/runtime.json` 的
  `desktopVersion`，而那份清单是**安装时**写的，应用升级不刷新它：本机应用已是 `0.2.1-rc.2`
  （内置 node 24.21.0 / pnpm 11.28.5），快照还停在 `0.2.0-rc.2` / pnpm 11.7.0，时间停在十天前。
  后果不是「少一条提示」：换到刚装好的新机（快照新鲜）时两台版本明明相同却报不一致；两边都陈旧时
  又会把真跨代抹平，而那正是「插件装上了但不加载」的前兆。现在优先读桌面版安装包的
  `resources/app.asar/dsh/desktop-runtime.json`（`source: desktop-app`），读不到才回退快照。
- **`profile` 默认值从写死的 `'web'` 改为 `'*'`**。桌面版加载的是 `profiles/desktop`，不传 profile
  时原先会去导 `profiles/web` —— 搬出一台「看起来成功」的空机。
- **落地后的下一步提示改写**：桌面版机器上没有 PATH 上的 `pnpm` / `dsh`，照 web 的习惯让用户去命令行
  装依赖会直接卡住。现在明确说「宿主自带 pnpm，重启时自己重建」「列表空就去插件管理器修复一次」
  「落地后先别改设置，直接退出重开，免得内存里的旧配置写回」。
- GUIDANCE 与双语 README 新增「桌面版与 web 宿主」章节，把这三件事和检查命令
  `dsh plugin --profile desktop list` 写清楚。

### 实测
本机桌面版 0.2.1-rc.2 / Electron 44.7.0 / node 24.21.0：用宿主自带 node 加载插件，七个工具全部注册
（`dshsync_apply` / `dshsync_verify` 也在）；zstd 内建可用；修复后探测结果为
`dsh 0.2.1-rc.2 / win32-x64 / node 24.21.0`（此前误报 0.2.0-rc.2）。

- 测试 149 → 152（新增桌面版取值优先级 3 条：候选路径 / 清单解析 / 压过陈旧快照）

## 0.8.0 (2026-10-22)

新增**局域网直传**：两台机器在同一网络下，不用 U 盘、不过网盘，一条命令把 bundle 拉过去并落地。
顺带修掉两个实测暴露的缺陷，其中一个相当严重。

### 局域网直传（四个新工具）

- `dshsync_lan_host`（源机）：起 HTTP 服务，给 6 位配对码与进度页地址，立即返回 ——
  服务在后台跑，不会把对话卡十几分钟。`action="renew"` 换码，`action="stop"` 关停。
- `dshsync_lan_discover`（目标机）：UDP 广播（约 1 秒）优先，广播被防火墙拦了就自动改成
  逐地址扫描（约 3 秒），并把「是哪一层挡住的」讲清楚，而不是一句「没找到设备」。
- `dshsync_lan_pull`（目标机）：配对 → 等确认 → 逐文件接收并核对 sha256 → 自动 apply → 自动 verify。
  后台执行、立即返回 jobId 与本地进度页地址。
- `dshsync_lan_status`（两端）：进度、速率、剩余时间，以及落地与核验的最终结果。
- **进度为什么是浏览器页面**：宿主工具接口（`DefineToolOptions`）只有 `execute` 与
  `presentCall/presentResult`，**没有执行期流式通道**。想在对话里看实时进度只能等工具结束，
  而那正是最不需要它的时刻。所以进度走本机 HTTP + SSE：不依赖客户端 UI 包、不需要构建链、
  跨 DSH 版本不坏，关掉页面也不影响传输。

### 传输协议与安全边界

- 自定义帧协议（`MAGIC + TYPE + LEN + PAYLOAD`，DATA 帧裸字节、其余 JSON），一条连接连续推完所有文件。
  不用「每文件一个请求」是因为实测一个 bundle 有 2516 个文件，逐文件往返光 RTT 就是几百毫秒，
  而且进度粒度只能到文件级；不用 tar/zip 是因为 bundle 里已经是压缩过的 zstd 与会话文件，
  再压几乎无收益，却要多付两端各一遍全量读写，也让「边收边校验」没法做。
- **配对码不是授权**：`/decide` 校验请求源地址是否属于本机网卡，其他人从局域网打开页面只得到只读视图，
  远端快照里连 `pair.code` 字段都没有。码 6 位、5 分钟、5 次试错锁定（穷举概率 5e-6）。
- **只接受私有网段来源**（10/8、172.16/12、192.168/16、169.254/16、回环），其余 403。
  挡的是「桌面机直接挂在公网上」这种配置事故。
- **逐文件校验后才落地**：写 `*.dshsync-part`，sha256 与长度都对上才 rename；
  帧里的路径一律 resolve 后确认没越出目标目录（绝对路径、盘符、UNC、`..` 绕路全部拒绝）。
- 发送端边读边算 sha256，与清单不符立即中止 —— 那说明**源机磁盘上的 bundle 已被改动**，
  继续发只会让对方收到一批校验不过的文件。
- `server.requestTimeout = 0`：Node 18+ 默认 300 秒，一个 GB 级 bundle 会被服务器自己掐断，
  表现为「传到 8x% 突然断」且日志只有一句 socket hang up。

### 修：`dshsync_apply` 与 `dshsync_verify` 自 0.6.0 起**根本没注册上**

`workspaceMap` 的参数 schema 写成 `{ type: 'object' }`，宿主校验要求 `additionalProperties`
显式声明，于是 `defineTool` 抛错；而每个工具的注册都包在独立 try/catch 里（那是为了「一支失败不连累其它支」），
**失败只打一条日志，界面看起来一切正常，工具就是不在**。

这个缺陷藏了两轮，因为此前没有任何测试去真正注册一遍工具。现在补了注册冒烟测试：
`defineTool` 在定义时就校验 schema，所以「七个工具都能注册上」本身就是一条有效断言。
教训写在这里：**容错包装会把配置错误变成静默缺失**，凡是有独立 try/catch 的注册，都要有一条冒烟测试对应。

### 修：`checksums.json` 从来没被传出去

`buildChecksums` 把清单文件自身排除在 `entries` 之外（清单不能自指），而传输清单直接取自 `entries`，
于是落地后的 bundle **没有 checksums.json**。后果有两层：`apply` 的整包 sha256 校验形同关掉，
接收端的续传判断永远不生效（第二次拉取会因「目录非空且没有可续传的 bundle」被拒）。
现在 `loadBundleIndex` 单独为它算哈希并加入传输清单。

### 修：配对码「一次性」导致续传走不通

码在第一次 `/pair` 成功后就标记已用，而「传一半断了、重跑接着传」必须再配一次对 ——
实测第 5 步就是卡在这里。改为**同一来源可复用同一个码**（沿用同一个 token），
不同来源仍然拒绝：旁人拿到码一定来自另一个地址。中断后也刻意**不自动换码**，
因为用户手里那个码正要用来重试。

### 实测（真实 bundle，2516 文件 / 172 MB）

- 载入索引 90 ms，起服务 102 ms
- 首次传输 11 秒，15.6 MB/s，逐文件 sha256 独立复算 2516/2516 零差异
- 续传：跳过全部 2516 个，实传 0 字节，1 秒（耗时主要是哈希扫描）
- 测试 114 → 149（新增 `test/lan.test.js` 22 条、`test/lan-e2e.test.js` 13 条）

## 0.6.1 (2026-10-22)

补一个「搬反方向」的守卫。起因是一个真问题：**迁移前怎么确认哪台是新机？**

如实说：**判断不了，也不该假装判断得了。** 方向完全由「在哪台机器上跑哪个工具」决定 ——
跑 `dshsync_export` 的是源机，跑 `dshsync_apply` 的是目标机。既然判不了新机，就把能自动发现的
那部分兜住；剩下的靠文档给出可验证的信号，而不是靠用户记住。

- **bundle 记录源机身份**（`manifest.source.identity` = 主机名 + 用户名 + `DSH_HOME`），
  `dshsync_apply` 打印一行方向（`源机 A → 本机 B`）让用户一眼确认没搞反。
  **刻意不采集** MAC / 机器 GUID / 磁盘序列号 —— 硬件指纹对一个搬配置的工具没有正当理由。
- **同机同 `DSH_HOME` 直接拒绝**：这是「把快照落回它自己出生的地方」，几乎总是两台机器搞反了。
  会话首帧改写不可逆（有备份，但你得先知道要恢复、还要分得清哪些文件是本次改的）。
  重装后原地恢复这类真实需求，显式传 `allowSameMachine=true`。
  判据取「同主机名 **且** 同 `DSH_HOME`」，同机不同 home（就地预演、一台机器两套环境）照常放行。
- **空壳自检**：导出与预览都会检查「会话 0 **且** 工作区记录 0」，命中就报
  「这台机器没有任何会话、也没有工作区记录，看起来像刚装好的空壳，迁移应该在旧机上导出」。
  不拦截 —— 首次配置也可能从空机器导出。判据只用这两条**实测值**：
  要求确实扫过状态层（`includeState=false` 时「空」是没量过，不能拿它报警），
  也不看 profile 里的 bundle 数（刚装好的新机常带内置组合包，按它判反而漏报）。
  这条挡的是另一种搞反：在新机上导出，bundle 几乎为空，拿回旧机 apply 把设置与插件覆盖成默认值，
  而旧机会话因为新 bundle 里没有反而留着，故障表现成「历史都在、配置全没」。
- **老 bundle 不被误判**：0.6.0 之前导出的 bundle 没有 `identity` 字段，此时如实报「判不了方向」，
  不当作不匹配、也不假装通过。
- **预览多一行「本机」**：`本机: DESKTOP-XXX/user —— 导出后会写进 bundle，目标机 apply 时用它核对方向`。
- README 双语新增「先确认哪台是新机」一节：两种搞反的结局对照表 + 三个可验证信号
  （项目代码在不在 → 预览清单 → `$DSH_HOME` 体积）+ 方向日志样例。
- 测试 110 → 114（身份记录 / 同机拒落 / 老 bundle 兼容 / 空壳自检）。

## 0.6.0 (2026-10-22)

自用换机的缺口补齐：**把项目目录也搬走**，并把「新机器放哪」压缩成一个参数。

在这之前，bundle 只搬 `$DSH_HOME`，而会话 cwd 指向的是 `$DSH_HOME` 之外的项目目录。
实测 84 个会话、8 个工作区路径，换机后 I8 报「8/8 个工作区目录不存在」——会话能列出来，
点开是空的。自用场景下这不算迁移成功。

- **新增工作区代码搬运**（`lib/workspace-pack.js`）：从会话 cwd 与 `storages/workspace.json`
  两处取候选，按**根**打包（`D://deepseek` 5.4G 里真正被引用的只有 5 个根、净 1.18G），
  嵌套路径自动折进父根（8 条 cwd → 5 个根）。默认带 `.git`（完整仓库）、必排 `node_modules`。
  `gitMode` 能认出「容器目录里是多个子仓库」这种形态（`dsh-plugin/mine/` 下 9 个仓库）。
- **落位只要一个 `workspaceRoot`**：目录名保持源机形态，逐个覆盖用 `workspaceMap`。
- **派生映射优先于手写映射**：工作区代码落在哪，会话 cwd、`workspace.json`、外部软链就指向哪。
  反过来的话（手写 `D:/a → E:/b` 先命中）会话会指向 `E:/b/xxx` 而代码在 `workspaceRoot` 下，
  打开是空目录，且所有检查都显示成功。重叠时明确告警「这条规则对已搬工作区不生效」。
- **修掉外部软链不吃映射**（此前 `rebuildLinks` 根本不接收 `mappings`）：`skills/` 下指向项目
  目录的链接现在会跟着映射改指新位置。实测 7 个链接全部 remapped 且可达 —— 此前它们要么被
  跳过（新机上路径不存在），要么建成指向源机的 junction（同盘符同名时，指错内容且检查全绿）。
- **`dryRun` 不再吞掉结果**：此前预演时 `state` 不复制，而会话改写扫的是目标目录，于是恒报
  `sessions.total=0`、`workspaces=null` —— 用户唯一能确认映射是否正确的地方恰好看不到东西。
  现在预演改为扫描 bundle 内的 state 快照，实测能报出「84 个会话 / 2 个要改写」以及每个分组的
  `cwd → newCwd`。
- **`zstd` 缺失改为 fail-closed**：此前用 node < 22.15 导出会得到「文件在、索引空」的半成品
  （会话文件照拷 105 份，`sessions.total=0`），只提一句 warning 就算成功。现在直接中止并说明怎么办。
- **`verify` 新增 I12 工作区代码落地**：不传 `workspaceRoot` 时报 WARN（信息不足，不猜），
  传了就逐个核对是否落地、是否为空。
- **落位定不下来就整体中止**：bundle 带工作区代码，却既没给 `workspaceRoot` 也没给 `workspaceMap`
  时，`apply` 在改动任何文件**之前**返回失败。绝不退化成「状态搬了、代码没搬」——
  那种半成品表现是历史列表完整、点开全是空目录，且每条检查都能显示通过。
  确实不想搬工作区，就在源机用 `includeWorkspaces=false` 重导。
- **覆盖保护**：目标机上落位目录已存在且非空时**拒绝**解包（工作区太大、通常进不了备份），
  要覆盖必须显式 `overwriteWorkspaces=true`。
- **两个落地脚本改为出声**：`apply.ps1` / `apply.sh` 不解包工作区，此前静默跳过；
  现在启动就提示「本 bundle 含 N 个工作区代码，本脚本不搬它们」。`APPLY.md` 也加了对应章节。
- **文档对齐实现**：`dshsync_export` 的工具描述此前写着「EXCLUDES … sessions, storages, background」，
  而 `includeState` 默认 **true 会带**；同句还说「apply 脚本会重建会话」—— 会话是历史，不可能重建。
  已改正。
- 测试 86 → 110（新增 `test/workspace.test.js` 22 条 + 落地/中止回归 2 条）。

本机实测：导出 84 会话 + 2305 文件工作区（22.9 MB，含 9 个子仓库 `.git`）→ 真跑 → I12 PASS，
I8 从「8/8 缺」变成「1/8 缺」，7 个 skills 软链全部改指新位置。

## 0.5.0 (2026-10-22)

补上一条**一直存在、但从来没生效过**的兼容性检查：宿主运行时一致性。

问题的形状很典型 —— 代码里写了、报告里看着正常、实际一次都没跑成：

- `captureEnvironment()` 只问 `dsh --version`。桌面端的 dsh **没有命令别名**
  （本机 `which dsh` 为空，CLI 要经 Electron 主程序 `ELECTRON_RUN_AS_NODE` 才能调），
  于是 `manifest.source.dshVersion` **恒为 `null`**。
- 下游两处版本预警都以「`dshVersion` 非空」为前提：`apply.ps1` / `apply.sh` 里那段
  还额外要求 `dsh` 在 PATH —— 双重前提几乎必然不成立，等于从不出声。
- `dshsync_apply` / `dshsync_verify` **根本没有这条**：10 条不变量里没有运行时版本。

后果不是「有点差异」，而是**界面里插件全空**：宿主启动时做 peer 兼容性裁决，版本对不上时插件
`stays installed but startup denies it` —— 文件都在、sha256 全对、I1–I10 全绿，就是不加载。
这个失败模式从状态层完全看不出来，所以它必须有独立一条。

新增：

- **`lib/host-env.js`**：宿主运行时指纹（dsh 版本 / 平台 / 架构 / 宿主自带 node / pnpm）。
  取版本**不依赖 PATH 上有 `dsh` 命令**，顺序为
  `dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion`（桌面端宿主自己写的清单，本机实测可取到）
  → `profiles/*/node_modules/@deepseek-ai/dsh/package.json`
  → `dsh --version` 兜底。取不到一律写 `null`，**绝不猜**。
  多份运行时清单并存时优先 `dsh-primary-runtime`（装了插件运行时后目录会变多，
  按名排序取第一个会把插件运行时的 node 当成宿主的）。
- **`verify` 新增 I11「宿主运行时一致性」**，比对版本 / 平台 / 架构 / node 大版本。
  分级：跨 `major.minor` → 提示 peer 裁决拒装；同 `major.minor` 内（仅 patch 或预发布不同，
  运行时清单落后一个 patch 是常态）→ 弱提示，不制造噪音。
  node 比的是**宿主自带那份**（`runtime.json` 的 `node`），不是跑探测的进程 —— zstd 内建能力看的是前者。
- **`dshsync_apply` 在 dryRun 阶段就报这条**（`report.runtime` + warnings），此时还没动目标机，
  用户可以直接决定要不要先对齐版本。
- **`apply.ps1` / `apply.sh` 改为同一口径**：先从目标机 `dsh-runtimes/*/runtime.json` 取版本，
  读不到再退 `dsh --version`；两机版本都取不到时明确说「无法确定」，不再静默。

顺手修掉这两个脚本里同类的两处静默失效（都是「看着有代码、实际不生效」）：

- **`apply.sh` 把 `$BUNDLE` 拼进了 JS 字符串**（`node -p "...require('$BUNDLE/manifest.json')..."`）。
  Git Bash 下 `$BUNDLE` 是 `/d/xxx` 形式，而只有**原生参数**才会被 MSYS 转成 Windows 路径；
  内嵌进字符串后 node 认不出 → `src_ver` 恒为空 → 整段版本比对静默跳过。
  现在路径作为 `argv[1]` 传入。
- **`apply.sh` 的 `usage()` heredoc 未加引号**。脚本开头是 `set -u`，而 `DSH_HOME` 在多数机器上没设，
  于是 `--help` 和任何一个拼错的参数都会崩在 `DSH_HOME: unbound variable`，帮助信息根本打不出来。
  改为 `cat <<'EOF'`。

测试 69 → 86：新增 `test/host-env.test.js`（17 条）。其中三条是这次的真实回归钉：
`导出把 runtime.json 里的宿主版本写进 manifest.source`（原先恒 `null`）、
`verify 输出 I11 并在版本不同时报 WARN`、
`生成的 apply.ps1 / apply.sh 都从 dsh-runtimes 取版本`（同时钉住上面两处脚本修复）；
另有 `pickRuntimeManifest 优先取 dsh-primary-runtime`（防「取到插件运行时」）、
`任一端版本未知时不假判 PASS`（防「静默通过」）。

脚本侧三种场景已实测（目标机跨代 / 取不到 / 相同）：跨代与取不到各出一行黄色提示，相同则不出声。

实测：本机 `dsh-runtimes/dsh-primary-runtime/runtime.json` 读到 `0.2.0-rc.2`，
在此之前这条路径完全拿不到版本号。

## 0.4.2 (2026-10-18)

0.4.1 推送后 CI 六平台仍全红。CI 日志端点需要仓库权限（匿名 403），
改为让 workflow 在失败时把失败块写成 **annotation**（公开可读），才拿到真实报错。

修复：

- **内部链接改记「相对 `$DSH_HOME` 的位置」（`homeRel`）**。0.4.1 已把比较改成 realpath，
  但重建时仍要拿「目标绝对路径」和「源机 home」作比较 —— 在 Windows 8.3 短名、
  junction 存储拼写（`RUNNER~1` / 未展开的别名）这类场景里，两侧可能一侧已展开、一侧没有，
  于是被判成「目标不在源机 `$DSH_HOME` 内」而跳过重定位（CI 上表现为 `relocated = 0`）。
  现在导出时直接把 `path.relative(homeReal, target)` 写进 `links.json`，
  目标机只做一次 `join`，不再做任何绝对路径比较。
  旧 bundle（无该字段）仍走原来的比较逻辑，行为不变。
- **`validateMappings` 用例原先写死了 Windows 大小写语义**。断言 `D:/a` 与 `d:/A` 等价 ——
  这在 POSIX 上不成立，导致 ubuntu / macOS 上必红。改为按平台给期望值，
  并补一条「逐字相同在任何平台都算等价」。
- **CI 失败注解只抓日志尾部**。TAP 的尾部只有 summary，断言详情在 `not ok` / `✖` 之后若干行，
  于是注解里看不到 `actual` / `expected`。改为抓失败测试块（每个失败点后 30 行，单条注解内换行编码）。

测试 68 → 69：新增「旧 bundle 没有 `homeRel` 也能重定位」（兼容路径不是死代码）。
本地两种环境（常规临时目录 / 临时目录位于 junction 之下）均 69/69。

## 0.4.1 (2026-10-18)

一次针对「是否真的达到需求」的复审。查出主链路漏掉了**大部分会话**，以及「插件情况」缺一块。
全部由真实 `~/.dsh` 实测发现，不是读代码推断。

修复：

- **会话日志有三种文件名，此前只认一种（严重）**。宿主随版本演进留下
  `session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd` 三种形态
  （本机 33 / 45 / 25 份，其中 18 个会话同时存在多份）。此前只按第一个名字去找，
  于是 **49 个会话（60%）被当成「目录缺日志」**：文件确实搬过去了，但 `header.cwd`
  和目录名都还是源机路径 —— 目标机上等于全部孤立，而报告只写「会话目录缺 session.jsonl.zstd」。
  现在三种形态一并识别、一并改写；同一次会话的多份日志共用同一个新 cwd
  （实测多份日志的 cwd 完全一致，仅 `version` 不同）。
  单个会话内若有部分日志损坏（撕裂尾帧），只改写干净的那份，坏的那份逐字节不动，
  并在报告里点名。
- **`profiles/<n>/.dsh-market/state.json` 没有随行**。它是「插件情况」的另一半：
  哪些插件被**停用**（`disabled`）、用户自建的分组与顺序（`groups` / `groupOrder`）、
  市场区域（`region`）。281 字节，丢了目标机的插件列表会回到默认（被停用的插件重新生效）。
  已加入 `PORTABLE_PROFILE_FILES`，并让导出 / 落地两侧都支持带子目录的声明文件。
- **verify 的 I2 只比会话目录数**。某一版日志丢了照样 PASS。改为同时比**日志份数**。
- **verify 的 I4 把源机自带的损坏文件判 FAIL**。迁移对这些文件是逐字节复制，
  判 FAIL 等于把源机既有状况报成迁移失败（与 I5 同类错误）。改为 WARN 并注明「原样复制」。
- **内部链接的判定用了「字面拼写」比较（跨平台，会让链接断掉）**。导出侧拿链接的
  `realpath`（已展开）去比 `dshHome` 的原样字符串，`apply` 侧同样用未展开的源机 home 取相对路径。
  这在三种很常见的情形下必然对不上：macOS 的 `/var` 是 `/private/var` 的软链、
  Windows 进程拿到的是 8.3 短名（如 `RUNNER~1`）、以及用户把 `$DSH_HOME` 放在软链 / junction 下。
  对不上的后果是**内部链接被误判成 external** → 目标机上不重定位 → 迁移完成后是一条
  指向源机路径的死链，而报告里只写「目标机不存在该路径」。
  现在导出、`apply`、`link-scan` 三处统一按 `realpath` 比较，并共用 `path-map.isSameOrChild`
  （段边界 + 平台大小写 + 盘符规范化）；链接创建时按平台传 `junction` / `dir`。

实测（真实 `~/.dsh`，目标 `$DSH_HOME` 换到另一个目录 + 工作区路径整体重映射）：

| 环节 | 结果 |
|---|---|
| 会话 | 82 个 / **103 份日志，三种形态全覆盖** |
| 改写 | 35 个会话（43 份日志）命中映射，改名 3 组，失败 0 |
| 目标机残留源机路径 | **0 个会话** |
| 插件停用状态 | desktop / web 的 `.dsh-market/state.json` 均已落地 |
| verify | I1–I4、I6、I7、I10 PASS；I5/I8/I9 WARN（源机既有孤立 / 工作区代码不在 `$DSH_HOME` / 未装 `node_modules`）→ `ok = true`，failed = 0 |

测试 64 → 68：新增「三种文件名都要改写」「部分日志损坏只改干净的」
「`.dsh-market/state.json` 随行并落地」「`$DSH_HOME` 本身是符号链接时内部链接仍要重定位」四个用例。
最后一条是先失败后修复的：在「临时目录位于 junction / 软链之下」的环境里，旧实现会把
`skills/alias` 判成 `external`，新用例直接断言 `kind === 'internal'`。

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
