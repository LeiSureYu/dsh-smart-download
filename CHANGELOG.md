# 更新日志 / Changelog

本文件记录本插件的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 条目以中文撰写；`0.4.2` 起同时给出英文摘要。0.4.2 之前的条目依据 git 提交历史回溯整理，
> 只记录可核实的变更。
>
> Entries are written in Chinese, with English summaries from `0.4.2` on. Entries before `0.4.2`
> are reconstructed from the git history and only record verifiable changes.

## [Unreleased]

## [0.4.2] - 2026-09-29

### 修复 / Fixed

- **探测不到文件大小时不再返回非法结果（最严重）**：`smart_download` 在 HEAD 失败 / 超时 /
  chunked 响应缺少 `Content-Length` 时，会把 `size: undefined` 写进返回对象。宿主
  `@deepseek-ai/dsh-tools` 用 `snapshotJsonValue` 判定结果是否为 lossless JSON，含 `undefined`
  的对象会被判为非法并抛出 `ToolOutputError: tool "smart_download" returned invalid output:
  value is not lossless JSON`——即**下载已经成功落盘，工具却报错**。现在 `size` 只在真正探测到
  大小时才出现（条件展开，而非赋 `undefined`）。
  **No more invalid output when the size is unknown**: when the HEAD probe failed, timed out, or the
  response was chunked without `Content-Length`, `smart_download` wrote `size: undefined` into the
  result object. The host's `@deepseek-ai/dsh-tools` treats any object containing `undefined` as
  non-lossless JSON and throws `ToolOutputError: ... value is not lossless JSON` — the download had
  actually succeeded, yet the tool reported an error. `size` is now emitted only when a size was
  actually probed (conditional spread instead of an `undefined` value).
- **修复路径穿越**：`deriveFilenameFromUrl` 直接对 pathname 末段做 URI 解码后当文件名使用。
  实测 `http://host/..%2F..%2F..%2Fescaped.txt` 会解码出 `../../../escaped.txt`，未指定 `output`
  时文件被写到**当前工作目录之外**（0.4.1 实测确认写入成功）。现在解码后会再按分隔符切分、
  只取最后一段，并统一经过 `sanitizeFilename` 净化。
  **Path traversal fixed**: `deriveFilenameFromUrl` used the URI-decoded last pathname segment as
  the filename verbatim. `http://host/..%2F..%2F..%2Fescaped.txt` decoded to
  `../../../escaped.txt`, so with no `output` argument the file was written **outside the current
  working directory** (reproduced on 0.4.1). The decoded value is now split on separators again and
  only the last segment is kept, then passed through `sanitizeFilename`.
- **新增协议白名单**：此前 URL 不做协议校验。实测 `file:///C:/Windows/win.ini` 会被 `curl`
  接受并**成功复制本地文件**到目标路径。现在只允许 `http:` / `https:`，其余协议在下载前直接
  拒绝，错误信息为 `拒绝下载：不支持的协议 <proto>（仅允许 http / https）`。
  **Protocol allow-list added**: URLs were not validated before. `file:///C:/Windows/win.ini` was
  accepted by `curl` and **successfully copied a local file** to the output path. Only `http:` /
  `https:` are allowed now; anything else is rejected before any download starts.

### 新增 / Added

- **`src/url.ts`**：把 URL 校验与文件名净化抽成纯函数模块（`checkDownloadUrl`、
  `sanitizeFilename`、`deriveFilenameFromUrl`），并覆盖 Windows 保留设备名（`CON` / `NUL` /
  `COM1`…）、控制字符、首尾空白与点、超长截断（保留扩展名，上限 200 字符）。
  **`src/url.ts`**: URL validation and filename sanitisation extracted into pure functions
  (`checkDownloadUrl`, `sanitizeFilename`, `deriveFilenameFromUrl`), covering Windows reserved
  device names (`CON` / `NUL` / `COM1`…), control characters, leading/trailing spaces and dots, and
  truncation that preserves the extension (200-character cap).
- **本文件（`CHANGELOG.md`）**：补齐此前缺失的变更记录。
  **This file (`CHANGELOG.md`)**: fills in the previously missing change history.

### 验证 / Verification

- `npm test`：**124 通过 / 0 失败**（0.4.1 为 103）；新增 `test/url.test.ts`（15 例）与
  `test/execute.test.ts`（6 例，真实调用 `execute()` 并用宿主的 `snapshotJsonValue` 复校验返回值）。
  `npm test`: **124 passing / 0 failing** (103 on 0.4.1). Added `test/url.test.ts` (15 cases) and
  `test/execute.test.ts` (6 cases that call `execute()` for real and re-validate its return value
  with the host's own `snapshotJsonValue`).
- `npx tsc --noEmit` 干净，`npm run build` 成功。
  `npx tsc --noEmit` clean, `npm run build` succeeds.

## [0.4.1] - 2026-09-28

### 修复

- **修正 `peerDependencies` 预发布版本范围**：`@deepseek-ai/cordis` 原写 `^4.0.0`，三个
  `@deepseek-ai/dsh-client-*` 原写 `>=0.1.7-rc.1 <0.2.0-0`。node-semver 只在范围中存在
  `major.minor.patch` 元组完全一致、且自身带预发布标签的比较符时才放行预发布版本，因此 harness
  走到 `0.2.0-rc.1`（`next` 标签）或 cordis 用到 `4.0.1-rc.x` 时会被**静默排除**，安装报
  `npm error ERESOLVE could not resolve`。现改为带显式预发布分支的 `||` 范围。
- **`screenshots.json`**：按插件市场约定声明截图，并加入 `package.json` 的 `files`。

## [0.4.0] - 2026-09-28

### 新增

- **`web` profile 实时进度面板**：右下角浮层显示输出文件名、百分比、速度与剩余时间，下载完成
  后自动消失；客户端经 `connection.fetch.register` 注册的 `/api/smartdl.status` 拉取快照。

### 修复

- 面板显示任务 ID 而非文件名。
- 陈旧任务永久卡住面板（超过 10 分钟未更新的 `running` 任务不再计入）。

## [0.3.0] - 2026-09-28

### 新增

- **镜像加速**：`smart_download` 新增可选 `mirror` 参数，做「前缀 + 完整原始 URL」拼接。
- **断点续传**：aria2 无条件 `-c`；curl 仅在探测确认支持 Range 时才加 `-C -`。
- **`download_status` 工具**：只读查询最近任务的百分比 / 速度 / ETA。

## [0.2.1] - 2026-09-28

### 修复

- `peerDependencies` 中 `@deepseek-ai/dsh-tools` 原写 `^0.1.0`，而该包从未发布 0.1.x 正式版
  （可用版本均为预发布版），导致解析不到任何版本、安装报
  `npm error notarget No matching version found for @deepseek-ai/dsh-tools@^0.1.0`。

## [0.2.0] - 2026-09-28

### 新增

- 支持 **Windows arm64** 与 **Linux x64 / arm64**（此前仅 Windows x64）。
- CI 分平台下载并校验 aria2 二进制，统一在 Linux runner 上打包发布（Windows 打包会把
  `bin/aria2c` 记成 `0644`）。

## [0.1.5] - 2026-09-28

### 修复

- 修正工具 schema 以通过 `@deepseek-ai/dsh-tools` 的严格校验（去掉 `required: false`，
  为 object 节点补 `additionalProperties`）。

## [0.1.4] - 2026-09-28

### 变更

- CI 子包发布改为幂等（版本已存在则跳过）。**该版本已从 npm 撤回。**

## [0.1.3] - 2026-09-28

### 变更

- aria2 子包重命名并升版到 0.1.3。**该版本已从 npm 撤回。**

## [0.1.1] - 2026-09-28

### 新增

- 首次发布（`@leisureyu/dsh-smart-dl`）。**该版本已从 npm 撤回**：插件清单与工具 schema 存在
  缺陷，会导致安装被拒（`Cannot validate installed package ... dsh.bundle.patch`）或激活失败
  （启动日志出现 `did not activate`）。

[Unreleased]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/LeiSureYu/dsh-smart-download/releases/tag/v0.1.5
