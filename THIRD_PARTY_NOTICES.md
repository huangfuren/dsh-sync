# 第三方来源与许可声明 / Third-Party Notices

dsh-sync 的实现是**独立编写的 JavaScript**。本文说明在设计过程中参考过哪些公开项目、
它们各自的许可证、以及具体参考了哪些「设计结论」而**没有**复制其源码。

---

## 结论先说

| 问题 | 答案 |
|---|---|
| 有没有直接复制别人的源文件？ | **没有。** 本仓库所有 `.js` / `.mjs` 均为自行编写。 |
| 参考过的项目是什么许可证？ | 均为 **MIT**（`dsh-config-manager`、`dsh-backup`），MIT 明确允许复制、修改、再分发。 |
| 那还需要这份文件吗？ | **需要。** MIT 的唯一实质义务是「保留版权声明与许可声明」；此外诚实署名能避免「反向混淆」争议。 |
| 参考的是「思想」还是「表达」？ | 全部是**思想与事实性知识**（数据结构、文件格式规范、失败模式、取舍理由），不是受版权保护的表达。 |

版权法保护的是**表达**（具体代码文本），不保护**思想、方法、事实**。
「会话文件是 zstd 多帧、首帧是 JSON header、header 里有 cwd」是事实；
「路径映射应有序应用且命中必须在段边界」是方法结论。
这些可以自由使用，但既然是从别人的工程经验中学到的，署名是应当的。

---

## 一、xiajiajun516/dsh-config-manager

- 仓库：https://github.com/xiajiajun516/dsh-config-manager
- 版权人：Copyright (c) 2026 xiajiajun516
- 许可证：MIT
- 参考版本：`dsh-config-manager@0.1.76`（npm 发布包）

### 参考的具体设计点

1. **有序路径映射的口径**
   其 `src/core/path-mapping.ts` 的注释指出：映射规则是**有序**的，
   自创「最长前缀优先」会在多规则重叠时算出与用户书写顺序不同的结果；
   且同一套映射必须同时作用于工作区记录与会话首帧 `cwd`，否则宿主校验
   `realpath(cwd) === workspace.path` 会失败。
   → dsh-sync 的 `lib/path-map.js` 按此结论实现（首条命中即返回 + 路径段边界判定），代码自行编写。

2. **会话容器的结构认知**
   其 `src/utils/session-log-repair.ts` 说明会话日志是 **zstd 多帧容器**，
   首帧为单行 JSON header，改写必须「帧级最小写」以逐字节复用未触及的帧，
   并在写前校验、写后复验。
   → dsh-sync 的 `lib/zstd-frame.js` 自行实现 RFC 8878 帧边界解析与最小写；
   该结论帮助避免了「整体解压再重压」这个会改掉全部事件帧字节的错误做法。

3. **软链缺失必须可见**
   其 `src/utils/recursive-walk.ts` + `src/adapters/link-report.ts` 提出：
   目录 junction / 符号链接被静默跳过会造成「报成功但内容缺失」，
   应把「跟随了什么、跳过了什么、为什么跳过」变成报告里可见的一行，
   并给出 `loop` / `outside-home` / `broken` / `unreadable` / `too-deep` 五类原因。
   → dsh-sync 的 `lib/link-scan.js` 采用同类的**可见性原则**与原因分类，
   但**语义相反**：其目标是备份（跟随链接、内容进包），
   dsh-sync 的目标是迁移（只记清单、在目标机重建链接），实现完全不同。

4. **「哪些内容没进来」必须记账**
   → dsh-sync `lib/bundle.js` 的 `inspectNotMigrated()` 沿用这一产品原则（原版已有，本次扩展）。

### 没有沿用的部分

该项目的插件自托管、市场、33 种外部工具格式读取、S3/WebDAV/Gist/Git 四通道同步、
回滚账本（`rollback-point.ts` 5000+ 行）等能力与本插件定位无关，**未参考也未移植**。
其把 `link:` 依赖降级为 `npm pack` 快照的做法，dsh-sync **刻意不采用** ——
那会切断本地开发循环，dsh-sync 改为 vendoring 源码后在目标机重建。

---

## 二、xiaoyuyu6420/dsh-backup

- 仓库：https://github.com/xiaoyuyu6420/dsh-backup
- 版权人：Copyright (c) 2026 xiaoyuyu6420
- 许可证：MIT
- 参考版本：`@xiaoyuyu6420/dsh-backup@0.13.4`（npm 发布包）

### 参考的具体设计点

1. **「整机搬」的边界口径**：全量归档 `~/.dsh` 但排除 `node_modules`，
   因为依赖树应由 `package.json` 重建而不是复制。
   → dsh-sync 的 `inspectNotMigrated()` 采用同一取舍，并补充排除
   `dsh-runtimes`（随宿主安装包重建）与 `cache` / `logs`。

2. **sha256 清单 + 独立校验**：导出时记账、应用前整包校验、损坏即停手。
   → 原版本已有 `checksums.json`，本次把校验提为独立工具（`dshsync_verify`）。

### 没有沿用的部分

其「会话体检 / 定点修复 / 进程外救援台」是针对**已损坏**会话的修复能力；
dsh-sync 只做迁移期的**改写**，不做损坏修复（改坏的历史应交给专门的修复工具，混杂会让两者都不可靠）。

---

## 三、PerryLink/dsh-session-sync

- 仓库：https://github.com/PerryLink/dsh-session-sync
- 许可证：Apache-2.0（GitHub 仓库元数据）
- 仅在**生态调研**阶段阅读过其 README 对「会话跨设备同步」的定位描述，
  **未参考其实现，未使用其任何代码或设计细节**。
  列出是为了完整：说明本次调研确实覆盖过它，结论是「只搬会话，不覆盖工作区记录与链接」，
  不满足本项目需要。

---

## 四、许可证全文

以下为上述 MIT 项目的许可证原文（两个项目使用同一份 MIT 文本，仅版权人不同）。

```
MIT License

Copyright (c) 2026 xiajiajun516
Copyright (c) 2026 xiaoyuyu6420

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 五、dsh-sync 自身的许可

本插件以 **MIT** 许可证发布（见 `LICENSE`）。
其设计与上述 MIT 项目**许可证兼容**：MIT → MIT 无任何冲突，
即使将来需要引入其代码片段，也只需在文件头保留原版权行并在此处登记。

---

## 六、规范性引用（非软件，无版权问题）

- **RFC 8878 — Zstandard Compression and the `application/zstd` Media Type**：
  `lib/zstd-frame.js` 的帧边界解析（Frame_Header_Descriptor、block 头布局、
  Content_Checksum 位置）依据该 RFC 的规范描述实现。
- **Node.js `node:zlib` 文档**：zstd 编解码 API 的行为依据其官方文档。

---

如果你认为本仓库有任何内容侵犯了你的权利，请开 issue 说明，会立即处理。
