# 更新日志 / Changelog

本文件记录本插件的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 条目以中文撰写；`0.4.2` 起同时给出英文摘要。0.4.2 之前的条目依据 git 提交历史回溯整理，
> 只记录可核实的变更。
>
> Entries are written in Chinese, with English summaries from `0.4.2` on. Entries before `0.4.2`
> are reconstructed from the git history and only record verifiable changes.

## [Unreleased]

## [1.1.2] - 2026-10-02

### 修复 / Fixed

- 从 Git 仓库地址安装不再依赖构建脚本：`dist/` 提交进仓库，并去掉 `prepare`。DSH 0.2.0 自带 pnpm 11 会拦截 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），放行需要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds`，而它的 key 形如 `<包名>@git+<url>#<commit-sha>`、带 commit 哈希无法预先填写，批准这条路走不通；`1.1.1` 因此装上就失败。现在从仓库地址安装直接取仓库内容，不跑 `prepare`、不需要审批、也不需要本机 TypeScript 工具链。
  **Installing from a Git repository URL no longer depends on a build script**: `dist/` is committed and `prepare` is removed. DSH 0.2.0 ships pnpm 11, which blocks build scripts in git dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`); allowing it requires an `allowBuilds` entry whose key is `<name>@git+<url>#<commit-sha>` — it embeds a commit hash and cannot be written in advance, so approval is a dead end, which is why `1.1.1` failed to install. A repository-URL install now takes the repository contents directly: no `prepare`, no approval, no local TypeScript toolchain.

- `.gitignore` 不再忽略 `dist/`，改为在文件内说明为什么必须入库。发布仍由 `prepublishOnly` 构建，npm tarball 不受影响。
  `.gitignore` no longer ignores `dist/` and now carries an in-file note on why it must be committed. Publishing still builds via `prepublishOnly`, so the npm tarball is unaffected.

- 清单测试改为断言「`dist/` 在仓库里、`main` 指向的产物真实存在、且没有 `prepare`」，并把 `prepare` 缺失时的发布期构建（`prepublishOnly` 含 `build`）一并断言。用例数 262 → **262**。
  The manifest test now asserts "`dist/` is committed, the file `main` points at actually exists, and there is no `prepare`", plus the publish-time build (`prepublishOnly` contains `build`). Cases 262 → **262**.

- 文档更新「从 Git 仓库地址安装」：说明 `dist/` 已入库、无需构建与审批，并指出从 git 安装时 `files` 字段仍然生效。常见问题新增「安装报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`」一条。
  Docs update "installing from a Git repository URL": `dist/` is committed, no build or approval needed, and the `files` field still applies to git installs. Added an FAQ entry for `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`.

## [1.1.1] - 2026-10-02

### 修复 / Fixed

- 补上 `prepare` 脚本（`npm run build`）。`dist/` 不入库，从 Git 仓库地址或 tarball 安装是先抓取源码再本地构建；此前只有 `prepublishOnly`，只在发布时执行，所以从源码装完不会跑 `tsc`，`main` 指向的 `dist/index.js` 不存在，工具与 RPC 路由都注册不出来 —— 表现为「装上了但不启用」。
  **Added the `prepare` script** (`npm run build`). `dist/` is not committed, so git/tarball installs fetch source and build locally; only `prepublishOnly` existed, which runs on publish alone, so a source install never ran `tsc` and the plugin ended up installed but inactive.

- 文档补上「从 Git 仓库地址安装」这一形态：地址必须是 `https://<host>/<owner>/<repo>` 三段式（带路径前缀的代理镜像地址不被接受）；源码安装先抓取再构建，比装 npm 包慢；兼容性在抓取后才判定，不匹配会回滚。并说明 DSH 安装前会用 `git ls-remote` 探测 GitHub、超时 5 秒即失败。
  **Documented installing from a Git repository URL**: the URL must be the three-segment `https://<host>/<owner>/<repo>` form (proxy-mirror URLs with a path prefix are rejected); source installs fetch then build and are slower; compatibility is evaluated after the fetch and rolls back on mismatch. Also noted DSH's pre-install `git ls-remote` GitHub probe with a 5-second timeout.

- 常见问题新增一条：从仓库地址装上但工具没出现时的排查顺序（先确认主机可达，再看是否装到了 1.1.0 或更早）。
  **Added an FAQ entry** for "installed from a repository URL but no tool appears" (check host reachability first, then the installed version).

- 新增 1 例清单测试，断言 `scripts.prepare` 存在且指向会跑 `tsc` 的构建入口。用例数 261 → **262**。
  **Added 1 manifest test** asserting `scripts.prepare` exists and points at a build entry that runs `tsc`. Cases 261 → **262**.
## [1.1.0] - 2026-09-29

适配 DSH 0.2.0（含桌面版）。**生产代码零改动**：0.2.0 的 `dsh-tools` 与 0.1.7-rc.2 逐字节相同，
用 0.2.0-rc.2 自带的 `dsh-tools` 直接加载 `dist` 也验证过工具注册与 RPC 路由注册。

0.2.0 新增了一道 0.1.x 没有的**安装前置检查**（按 `peerDependencies` 判定）。实测已发布版本在
0.2.0-rc.2 上的判定结果：`0.4.1` ~ `1.0.1` **通过**，`0.4.0` 及更早**被拒**（0.4.0 给三个
`dsh-client-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0-0`）。所以这一版不是「修好被拒」，而是
**补齐清单声明、把兼容范围锁进测试、并把 0.2.0 的新行为写进文档**。

### 新增 / Added

- **`dsh.manifestVersion: 1`**：按 0.2.0 的清单规范显式声明。
  0.2.0 的安装器与加载器目前不强制这个字段，声明是为了先按规范对齐。
  **Declared `dsh.manifestVersion: 1`** as the 0.2.0 manifest spec prescribes.

- **`engines.dsh`**：`>=0.1.7-rc.1 <0.1.8-0 || >=0.1.8-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`。
  纯声明字段：0.2.0 的前置检查**不读**它（只读 `peerDependencies`），`dsh-package-manifest` 的
  README 也写明当前安装器与加载器都不强制它。
  **Added a declaration-only `engines.dsh`**; 0.2.0's pre-install check reads `peerDependencies`
  only, and the manifest spec states neither installers nor loaders enforce `engines.dsh`.

- **`test/compat-manifest.test.ts`**（7 例）：把清单与 `peerDependencies` 的兼容范围锁进测试，
  自带极简 semver 比较器，不引入新依赖。断言 `0.2.0-rc.2` 被每个 `@deepseek-ai/dsh*` peer 放行、
  `0.3.0-rc.1` 被明确排除、`client.platform` 仍为 `web` 且 `client.external` 不存在。
  用例数 254 → **261**。
  **Added `test/compat-manifest.test.ts`** (7 cases) locking down the manifest and the peer ranges,
  with a minimal built-in semver comparator and no new dependencies. Case count 254 → **261**.

### 文档 / Docs

- **README（中英双语）新增「DSH 0.2.0 的安装前置检查」一节**：0.2.0 在安装前核对 `peerDependencies`，
  不覆盖就拒绝安装；已装上的会在启动时**整个 bundle 被跳过**（`dsh: skipping profile bundle`），
  两个工具都不注册。**被拒的是 `0.4.0` 及更早**（0.4.0 给三个 `dsh-client-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0-0`），
  `0.4.1` 起已覆盖 0.2.0。文档同时写清 `0.4.1` ~ `1.0.1` 在 0.2.0 上的实际判定结果。
  同时给出按「包@版本 + 精确 dsh 版本」的豁免命令（`allow-version` / `version-exemptions` /
  `revoke-version`，记录在该 profile 的 `compatibility.json`）。版本要求同步改为 `1.1.0` 以上。
  **READMEs describe 0.2.0's pre-install peer check**, the all-or-nothing bundle skip, the fix
  (upgrade to 1.1.0), and the exact-version exemption commands.

- **README（中英双语）补 `desktop` profile**：桌面版自带 CLI 的完整安装命令（0.2.0 的 `desktop`
  profile 由 Electron 应用独占管理，外部 CLI 会被拒绝），以及「进度面板只在带 Web 界面的 profile
  生效」（客户端清单的 `platform: 'web'` 在桌面版同样适用，无需改）。
  **Added `desktop` profile notes** to both READMEs: the bundled-CLI install command and the fact
  that `platform: 'web'` covers the desktop app too.

- **README（中英双语）如实标注进度轨道一**：DSH 0.2.0 起官方不再内置 `dsh-task-progress` 格式的读取端，
  只有第三方 `dsh-task-progress` 会读；轨道二与内置面板不受影响。
  **Both READMEs now state plainly** that 0.2.0 ships no reader for the track-1 format.

- **COMPATIBILITY.md**：平台/版本表补 0.2.0 行与 `desktop` profile 行；新增「0.2.0 起范围写错不再只是
  ERESOLVE」小节，写明判定用的是
  `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`、所以范围必须显式写预发布段。
  另补安装命令与豁免机制的准确形状。
  **COMPATIBILITY.md** gains the 0.2.0 rows, the exemption mechanics, and the reason the range must
  spell out prerelease segments.

- **TROUBLESHOOTING.md**：新增「0.2.0 上插件被整层跳过」的排查条目（症状 → 原因 → 处理）。
  **TROUBLESHOOTING.md** gains the "bundle skipped on 0.2.0" entry.

- **`src/index.ts` 顶部注释**：把「基于 DSH 0.1.0-rc.5」的过时假设改为「0.1.7-rc.1 起验证、
  0.2.0-rc.2（含桌面版）兼容」。注释更正，无行为变化。
  **Fixed a stale header comment** in `src/index.ts` (no behaviour change).

## [1.0.1] - 2026-09-29

文档修正版。1.0.0 的代码与测试没有变化，改动只有英文 README 的一处。

### 修复 / Fixed

- **README.en.md 里残留了一整段 0.7.0 的旧正文**：改写「版本要求」段时替换只覆盖了前半句，
  `0.7.0` 那一整段（约 3.3 KB，含「to pin explicitly, use `@leisureyu/dsh-smart-dl@0.6.0`」
  这句已经过期的建议）被原样粘在新句子后面，成了英文 README 里最长的一行。中文 README 与
  CHANGELOG 不受影响。
  为什么单独发 1.0.1 而不是重打 tag：npm 上的 1.0.0 已经带着这段文本，而 registry 不允许
  复用已发布的版本号。GitHub 上的 v1.0.0 tag 与 Release 保持不动。
  **README.en.md carried a stale 0.7.0 paragraph** (≈3.3 KB, including an outdated
  `pin ...@0.6.0` suggestion). The Chinese README and the CHANGELOG were unaffected. Shipped as
  a patch instead of re-tagging because the registry never lets a published version be reused.

## [1.0.0] - 2026-09-29

首个正式版。0.9.0 到 1.0.0 之间做了一次完整的代码审查，结果整理在
[docs/REVIEW-1.0.md](./docs/REVIEW-1.0.md)：9 条必修、6 条留作后续的建议、5 条明确保留的折衷。
每条必修都是先写出会失败的用例，改完代码，用例才转绿。

### 修复 / Fixed

- **`mirror` 参数能整个绕过协议白名单**（可利用）：`src/index.ts` 只对 `args.url` 做
  `checkDownloadUrl`，`mirror` 原样进 `applyMirror` 做字符串拼接。`mirror` 是**前缀**，
  拼接后整串的 scheme 由前缀决定 —— `mirror = "file:///C:/Windows/win.ini?x="` 接上任何合法
  http 地址，后半个地址会退化成查询串，整串仍是一个合法的 `file:` URL。实测交给
  `curl -L --fail` 退出码 0，把本机 `win.ini`（92 字节）复制到了目标路径，和 0.4.2 修掉的
  那个缺陷是同一个形态，只是入口换成了 `mirror`。现在 `applyMirror` 在拼接前先判前缀本身
  是否 http(s)，不是就不生效、原样返回原始 URL；`test/mirror.test.ts` 新增两条正向用例。
  **`mirror` could bypass the protocol allowlist entirely**: only `url` was checked; a
  `file://` prefix made the concatenated string a valid `file:` URL (the http address degraded
  into a query string). Reproduced with `curl`: exit 0, local `win.ini` copied to the target.
  `applyMirror` now validates the prefix itself and returns the original URL unchanged.

- **`awaitFlush` 的超时计时器不 unref，CLI 每次下载多卡约 2 秒**：`node:timers/promises` 的
  `setTimeout` 建的计时器不会 unref，即使写盘早已完成、`Promise.race` 立刻返回，那个没到点的
  计时器仍把事件循环留住。实测进程退出时间 2003ms → 改用原生 `setTimeout` + `unref()` 后
  6ms。新增 `timeoutAfter(ms)`，`finally` 里无条件 `cancel()`，返回后不留句柄
  （`test/progress.test.ts` 断言 `getActiveResourcesInfo()` 的 `Timeout` 数回到基线）。
  **The flush timeout timer was not unref-ed**, holding the event loop for the full 2 s after
  every CLI download (measured 2003 ms → 6 ms). Now a native `setTimeout` + `unref()` with an
  unconditional `cancel()`.

- **`awaitFlush` 超时是静默的**：超时后直接 return，既没有日志也没有异常，用户侧只表现为
  「面板卡在旧进度」，无从排查。现在超时走 `process.emitWarning`，带任务 ID 与
  `code: 'DSH_SMARTDL_PROGRESS_FLUSH_TIMEOUT'`。仍然不阻断调用 —— 磁盘满时让工具调用挂死更糟。
  **Flush timeouts were silent.** They now emit a searchable warning instead of returning quietly.

- **「校验跳过」与「校验通过」在返回值上无法区分**：`verifySize` 在「远端未声明长度」和
  「服务器返回压缩编码」两种情形下都返回 `{ kind: 'ok' }`，与「真的比过字节数且一致」完全同形 ——
  「压根没测」和「测过且一致」长得一模一样。现在 `VerifyOutcome` 拆出独立的
  `{ kind: 'skipped'; reason; encoding? }`，新增 `VerifySkipReason` 与固定文案常量
  `VERIFY_SKIP_LENGTH_UNKNOWN` / `VERIFY_SKIP_CONTENT_ENCODED`（定成常量而非就地拼串，
  使「跳过路径只能输出这两个值」成为可断言事实），`SmartDownloadResult` 新增 `verifySkipped`，
  并写进工具返回与 render 文案。
  **"Verification skipped" and "verified OK" were indistinguishable** in the return value. There
  is now a distinct `skipped` outcome, fixed reason constants and a `verifySkipped` field.

- **取消（`cancelled`）状态在生产代码里不可达**：`ProgressReporter.cancel()` 在 `src/` 里零调用，
  而测试、TROUBLESHOOTING、`client.js` 都在处理 `cancelled`。用户按取消，面板上看到的却是
  「失败」—— 明明是他自己的操作。三处 catch 改成「`exec.signal.aborted` → `cancel()`，
  否则 `fail(...)`」，顺带修掉「signal 已 abort 还要徒劳回退 curl 多跑一趟」。
  **The `cancelled` state was unreachable in production code**; cancelling showed up as a
  failure. Three catch sites now branch on `exec.signal.aborted`.

- **aria2 失败回退 curl 时，进度文案写的是 aria2 的错误**：curl 也失败时
  `reporter.fail(aria2Message)` 用的是 aria2 的原因，抛出的却是 `curlErr`，进度里和异常里对不上。
  现在传 `curlMessage`；aria2 的原因已经作为返回结果的 `reason`（`aria2 失败: ...`）记录在案。
  **Wrong message on the curl fallback path**: the progress text named aria2's error while the
  thrown error was curl's.

- **`SIGKILL` 兜底只在 Windows 生效**：取消路径的前置条件是 `process.platform === 'win32'`，
  但「忽略 SIGTERM」不分平台 —— POSIX 进程同样可以装一个 handler 然后继续跑，此时取消下载
  永远等不到 `close` 事件，`smart_download` 永久挂住。现在所有平台都挂 1s 兜底
  （计时器已 unref，无泄漏）。
  **The `SIGKILL` fallback was Windows-only**; a POSIX process ignoring `SIGTERM` could hang the
  call forever. It now applies on every platform.

- **HEAD 探测的响应体未取消**：HEAD 分支不消费也不取消响应体。Node 的 undici 对没有 body 的
  HEAD 会给出 `null`，但现实里有服务器/代理在 HEAD 上返回 body —— 不取消就一直占着连接，
  与下面的 Range GET 分支不一致。现在 `head.body?.cancel().catch(() => {})`。
  **The HEAD probe never released its response body**, unlike the Range GET branch.

- **`MAX_STATUS_LIMIT` 硬编码在两个文件里**：默认值在 `status.ts`，「夹到 50」硬编码在
  `rpc.ts`，而 `readDownloadStatus` 自己又不夹，改一个忘一个就会出现「RPC 认为上限 50、
  工具认为没有上限」的偏差。现在 `status.ts` 导出 `MAX_STATUS_LIMIT = 50`，两个调用方共用。
  **`MAX_STATUS_LIMIT` was hard-coded in two places**; both callers now share one exported
  constant.

### 新增 / Added

- **测试 244 → 254 例**，新增用例全部是正向断言，覆盖上面每条修复的回归：
  `applyMirror` 的前缀白名单、`awaitFlush` 的句柄清理与超时告警、两种校验跳过各自的
  `reason` 与 `describeSkip` 文案、`cancelled` 与 `fail` 的分流、curl 失败时的文案归属、
  跨平台的 `SIGKILL` 兜底、`MAX_STATUS_LIMIT` 的夹取；并补上此前**完全没被走到**的
  aria2 成功路径与「aria2 失败 → 回退 curl 成功」两条主路径（用真实随包 aria2 + 本地
  http server，无 aria2 的平台跳过）。行覆盖 **99.81%** / 分支 **92.50%**。
  覆盖率的完整说明（必须在 LF 工作区测量、未覆盖行的逐条归因、LF/CRLF 对照数据）
  见 [REVIEW-1.0.md](./docs/REVIEW-1.0.md)。余下 2 个跳过用例是平台限制，CI 的
  Ubuntu job 会真跑。
  **Test count 244 → 254**, all new cases written as positive assertions; the aria2 success
  and aria2-to-curl fallback paths now have real coverage. Line **99.81%** / branch **92.50%**.

- **`pnpm check` 与 `tsconfig.test.json`**：此前测试文件从未被任何 tsc 检查过，
  写错一个类型也只有跑到那条用例才会炸。现在 `check = typecheck + typecheck:test`，
  本地与 CI 共用同一条命令。
  **`pnpm check` and a separate test tsconfig**: test files were never type-checked before.

- **CI 增加 `check` job**：PR 与 `main` push 上跑类型检查 / 构建 / 测试；二进制下载与发布
  只在 tag push 或手动触发时执行（PR 上下 4 份二进制既慢又与改动无关）。发布链路的
  `permissions` / OIDC 回退逻辑未动。
  **New CI `check` job** for PRs and `main`; binaries and publishing stay tag/dispatch-only.

### 文档 / Docs

- 新增 **[docs/REVIEW-1.0.md](./docs/REVIEW-1.0.md)**：1.0 定稿前的整体审查记录 —— 验证基线、
  分模块覆盖率与未覆盖行的逐条解释、9 条必修（现象 / 根因 / 改法 / 回归用例）、
  6 条后续建议、5 条已知折衷、复现命令。
- 新增 **docs/SECURITY.md 的 mirror 边界**：协议白名单必须覆盖 `mirror` 参数，
  附修复前的 curl 实测（`file://` 前缀 + 合法 http 地址 → 92 字节 `win.ini` 落盘）。
- 新增 **CONTRIBUTING.md / SECURITY.md（根）/ issue 与 PR 模板**：把「任何回退/跳过/默认值
  路径必须有正向断言」「覆盖率只认 Node 自带报告」「不要硬做平台」三条要求写成明文，
  新贡献者先看到规则再改代码。
- README（中英双语）同步：版本要求段改写为 1.0.0 正式版说明并链到 REVIEW-1.0.md、
  返回结构补 `verifySkipped`、镜像是「前缀也要过白名单」、静默失败防护章节补 1.0.0 三类、
  契约表与平台表更新、新增文档索引表。
  另修正一处事实错误：README 原文说「未启用 `--allow-overwrite`」，实际是一律带
  `--allow-overwrite=true`（**必须**，aria2 默认遇到同名文件另存为 `f.1.bin`，
  而返回的 `path` 仍指向旧文件）。

## [0.9.0] - 2026-09-29

### 修复 / Fixed

- **`src/progress-parse.ts` 认不出 aria2 1.38+ 的速度字段**：摘要行的正则原来只匹配
  `[KMGTPE]?i?Bs?` 这种形状，遇到 `DL:1.0MiB/s` 会整行匹配失败、被当成非摘要丢弃，于是面板在
  这类 aria2 上永远看不到速度。正则改为 `[KMGTPE]?i?B(?:\/s|s)?`，`/s` 与 `s` 两种写法都能吃到，
  且不会把已经带 `/s` 的字段重复补一个 `/s`。
  **`aria2` speed field was unparsable from 1.38 on**: the summary-line regex only matched
  `[KMGTPE]?i?Bs?`, so `DL:1.0MiB/s` failed to match, the whole line was dropped as a non-summary,
  and the panel never showed a speed on those builds. It now accepts both `s` and `/s` without
  double-appending.

### 新增 / Added

- **补齐剩余低覆盖模块的测试**（`test/runprocess.test.ts` 新增，`downloader` / `progress-parse` /
  `url` / `tool-schema` 四个测试文件扩充），用例数 220 → **244**。新增用例全部是正向断言：
  `checkDownloadUrl` 解析失败必须回落到把原始输入原样写进 reason、协议被拒时 reason 必须含
  `不支持的协议`；`deriveFilenameFromUrl` 遇到非法百分号编码必须回落成**原始片段**（断言具体
  值，而不是「没崩」）；`truncatePreservingExtension` 扩展名过长与无扩展名两条硬截断路径；两条
  render 文案用例（含「有 fellback 无 reason 时不得拼出空的 `(fallback: )`」）；aria2 / curl /
  reporter 接线用例。
  **Filled in the remaining low-coverage modules** (new `test/runprocess.test.ts`; expanded
  `downloader` / `progress-parse` / `url` / `tool-schema`), taking the case count from 220 to
  **244**, all with positive assertions.

- **`test/runprocess.test.ts` 里有一个 Linux 专属的信号用例**（断言子进程被 `SIGKILL` 终止后
  `closeSignal` 正确上报）——实测只在 Linux 复现：Windows 上 `child.kill` / `process.kill` /
  `taskkill /F` / 子进程自杀四种杀法拿到的 `closeSignal` 恒为 null，所以非 Linux 一律跳过。
  本地 Windows 跑是 6 通过 / 1 跳过，已在 WSL Ubuntu 上真跑验证（该用例通过），CI 的 Ubuntu job
  也会真跑。
  **One signal case in `test/runprocess.test.ts` is Linux-only** (it asserts `closeSignal` after a
  child is killed with `SIGKILL`) — it is only reproducible on Linux; on Windows all four kill
  methods (`child.kill` / `process.kill` / `taskkill /F` / self-kill) leave `closeSignal` as null, so
  it is skipped elsewhere. Locally on Windows it is 6 pass / 1 skip, and it was verified to pass for
  real under WSL Ubuntu (the Ubuntu CI job runs it too).

### 文档 / Docs

- README（中英双语）把 0.8.0 段落里 `6/16` / `16/26` 的旧数字改成实测的 **2/7**（剔除专属测试
  文件后的行覆盖 **62.37%**）→ **9/9**（行覆盖 **99.46%**），并在「开发」小节补上覆盖率的正确跑法。
  **覆盖率数字的来源统一为 Node 自带的 `--experimental-test-coverage`**：旧的 `6/16` / `16/26` 与
  CHANGELOG 里 `resume.ts 20/30`、`downloader.ts 53/80`、`progress.ts 57/109` 一样，都来自手搓的
  `NODE_V8_COVERAGE` 统计，该方式在 Windows + tsx 下源码映射错位、会虚增函数个数，已作废。
  Updated the bilingual README's 0.8.0 paragraph from the stale `6/16` / `16/26` to the measured
  **2/7** (62.37% lines, with the dedicated test file excluded) → **9/9** (99.46% lines), and added
  the correct coverage command to the Development section. **All coverage numbers now come from
  Node's built-in `--experimental-test-coverage`**; the older figures were produced by a hand-rolled
  `NODE_V8_COVERAGE` tally that misaligns source maps on Windows + tsx and is retired.

## [0.8.0] - 2026-09-29

### 新增 / Added

- **补齐 Host 侧 RPC 端点（`src/rpc.ts`）的测试覆盖**：`/api/smartdl.status` 是浏览器进度面板与
  `download_status` 工具共用的唯一 Host 端点，也是此前全项目覆盖率最低的模块（函数覆盖实测
  **2/7**、行覆盖 **62.37%**，`ok` / `fail` / `envelopeResponse` / `readPayload` 与整个 handler
  主体 `count=0`，一次都没被执行过）。新增 `test/rpc.test.ts`（21 例）后升至 **9/9**、行覆盖
  **99.46%**，上述函数全部 `count>0`。
  覆盖的正是这个模块「静默失败」的三类高发路径，且**每条跳过 / 回落路径都断言了它回落到的具体值**：

  | 路径 | 之前从未被验证的行为 | 新增的正向断言 |
  | --- | --- | --- |
  | 无 `connection` 服务（纯 CLI profile） | 静默跳过、不注册路由、不抛错 | 注入回调仍会执行但内部提前 return，且**恰好注册 0 条路由** |
  | `__connection.fetch.register` 形状不对 | 同样是静默跳过（不是崩溃） | `null` / 缺 `register` / 非对象三种形状都注册 0 条路由 |
  | 信封非法（`type` 不对 / `rpcId` 非字符串 / 空串 / `null`） | 一律 **200 + `ok:false`**（不是 HTTP 错误码，客户端易忽略） | `rpcId` 必须回退成固定哨兵 `'invalid-request'`，且 `error.code === 'internal'` |
  | `readPayload` 的非法 `limit` | 静默回落到默认值 | `'abc'` / `null` / `{}` / `-1` / `0` / `NaN` / `Infinity` 七种非法值都必须回落到 `DEFAULT_STATUS_LIMIT`（10），用「造 3 条任务恰好全部返回」证明它没落成 0 或 `Infinity` |
  | `limit > 50` / 小数 | 静默夹取 / 取整 | 造 60 条验证夹到 50；`limit=2.9` 必须返回 2 |
  | `payload.session` 形状非法 | 静默丢弃（不拿非法值当路径） | `null` / 字符串 / 数字 / `{}` / `{id:1,cwd:2}` 都必须回落为 `undefined` 且调用仍成功 |
  | handler 内的业务异常 | **不裸奔 500**，用 200 + `ok:false` 信封 | 把轨道目录指向一个「文件」逼业务层失败，断言仍是 200、带原样 `rpcId`、`result.ok` 是布尔值 |

  另有三条正向契约用例：`content-type: application/json; charset=utf-8` 必须被接受（按 `;` 截断后
  比较）、非 POST 必须 404、**非 JSON 的 `content-type` 必须 415**。最后一条端到端用例真的往轨道二
  写一个 `DownloadTaskFile`（`progress: 0.42`），断言能读回 `pct === 42` —— 防止只返回「空壳任务」。
  **Filled the test gap for the host-side RPC endpoint (`src/rpc.ts`)**: `/api/smartdl.status` is the
  single host endpoint shared by the web progress panel and the `download_status` tool, and it was the
  least-covered module in the project (measured function coverage **6/16**; `ok`, `fail`,
  `envelopeResponse`, `readPayload` and the whole handler body all had `count=0`). The new
  `test/rpc.test.ts` (21 cases) lifts it to **16/26**, with every one of those functions now `count>0`.
  It covers precisely the three classes of "silent failure" this module is prone to, and **every skip /
  fallback path asserts the concrete value it fell back to** (see the table above).

### 文档 / Docs

- README（中英双语）在「防护网」表格中补充 `rpc.ts` 一行，并在测试小节记录 0.8.0 的用例数
  （**220 通过 / 0 失败**，0.7.0 为 199）。同时把 rpc.ts 与其余低覆盖模块的现状如实记入，作为后续
  迭代的输入。
  Added an `rpc.ts` row to the bilingual README guard-rail table, and recorded 0.8.0's test count
  (**220 passing / 0 failing**, up from 199 on 0.7.0). The coverage status of `rpc.ts` and the other
  low-coverage modules is recorded as-is, as input for the next iteration.

> 本条里 rpc.ts 与其余模块的覆盖率数字当时取自手搓的 `NODE_V8_COVERAGE` 统计，数值有误；0.9.0 已
> 换成 Node 自带的 `--experimental-test-coverage` 并更正，详见下方 `[0.9.0]` 条目。
> The coverage numbers for `rpc.ts` and the other modules quoted here came from a hand-rolled
> `NODE_V8_COVERAGE` tally and were wrong; 0.9.0 replaced them with the built-in
> `--experimental-test-coverage` results — see the `[0.9.0]` entry below.

## [0.7.0] - 2026-09-29

### 新增 / Added

- **下载完成后校验落盘字节数**：`curl` / `aria2` 的退出码 0 只代表「它自己认为完成了」，不代表字节数对。
  用随包 aria2 1.37.0 与 curl 8.13.0 实测坐实的静默损坏：服务器用 chunked 只发 1MB 就干净断开时，
  aria2 退出码 **0**、摘要里写着 `OK`，落盘却只有 1MB（声明 4MB）；`curl` 同样 exit 0。
  现在三个成功出口（aria2 成功 / aria2→curl 回退成功 / curl 成功）都会比对
  「落盘字节数 vs 远端声明长度」，不一致就抛错，并且**不**清除 `.part.json` 旁车指纹。
  **Verifying the downloaded size after every download**: an exit code of 0 only means the tool thinks
  it finished, not that the byte count is right. Measured with the bundled aria2 1.37.0 and curl 8.13.0:
  when the server streams chunked and closes cleanly after 1MB, aria2 exits **0** and prints `OK` while
  only 1MB lands (4MB declared); curl exits 0 too. All three success paths now compare bytes on disk
  against the declared remote length, throw on mismatch, and keep the `.part.json` marker.

### 修复 / Fixed

- **探测必须强制 `accept-encoding: identity`**：Node 的 `fetch` 默认带 `gzip, deflate`，
  而 curl / aria2 默认不带 —— 5000 字节的 body 在默认探测下会报 41 字节。若不修，
  上面新增的大小校验会对**任何支持 gzip 的服务器 100% 误报**，把正确的下载判成损坏
  （这正是本项目最忌讳的「新增一个静默失败去修另一个静默失败」）。
  同时捕获 `content-encoding` 供校验层判定：服务器无视 `identity` 仍返回压缩编码时**跳过**校验。
  **The probe must force `accept-encoding: identity`**: Node's `fetch` sends `gzip, deflate` by default
  while curl / aria2 do not — a 5000-byte body is reported as 41 bytes under default probing. Without
  the fix, the new size verification would produce false positives on 100% of gzip-capable servers.
  `content-encoding` is now captured so the check is **skipped** when a server ignores `identity`.

### 性能 / Performance

- **大文件阈值从 50MB 下调到 8MB**：受控实测（每连接限速 2MB/s、3 轮取中位数、参数取自真实
  `buildAria2Args`）显示 8MB 文件 x=4 为 6.26 MB/s、x=8 为 11.99 MB/s（差近一倍），
  32MB 同理（6.22 → 12.21）。8~50MB 这一整段此前被压在 4 连接上，白白损失一半速度。
  维持 8 连接上限：32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），但保守起见不引入，
  避免触发服务器按 IP 限并发。
  **`LARGE_FILE` lowered from 50MB to 8MB**: controlled measurements (per-connection throttle at
  2MB/s, median of 3 rounds, real `buildAria2Args`) show an 8MB file at 6.26 MB/s with x=4 versus
  11.99 MB/s with x=8 — nearly double. The whole 8–50MB band had been stuck on 4 connections.
  The 8-connection cap stays: x=16 is another ~2× at 32/64MB but is deliberately not adopted to avoid
  tripping per-IP concurrency limits.

### 文档 / Docs

- 新增「并发阈值是实测的，不是猜的」章节（中英双语），记录受控实验数据与两个易踩的坑：
  aria2 的 `-x/-s` 会被默认 `min-split-size=20M` 悄悄废掉（本插件已传 `-k 1M` 避开，
  删掉会让所有档位静默退化成单连接）；以及探测的 Accept-Encoding 陷阱。
  Added a bilingual "concurrency thresholds are measured, not guessed" section with the experiment
  data and two traps: aria2's `-x/-s` being silently defeated by the default `min-split-size=20M`
  (this plugin passes `-k 1M`; removing it degrades every tier to a single connection silently), and
  the probe's Accept-Encoding trap.

## [0.6.0] - 2026-09-29

### 修复 / Fixed

- **续传可能产出「看起来成功、实际是错的」文件（最严重）**：此前只要探测到服务器支持 Range
  就无条件加 `curl -C -` / `aria2 -c`。但两者都**只看本地文件长度**，不校验远端资源有没有变。
  用真实 curl 8.13.0 与随包 aria2 1.37.0 在 127.0.0.1 上实测（`work/_fix/probe-resume.mjs`）：

  | 场景 | `curl -C -` | `aria2 -c` |
  | --- | --- | --- |
  | 远端变大 400B→1000B（同源） | exit 0，正确 1000B | exit 0，正确 1000B |
  | 远端变小 400B→200B | **exit 0，落盘仍是 400B** | **exit 0，落盘仍是 400B** |
  | 等长但内容变了 400B→400B(异) | **exit 0，保留旧内容** | **exit 0，保留旧内容** |
  | 服务器忽略 Range | exit 33（明确报错） | exit 0，正确 1000B |

  前三行是静默损坏：**退出码 0 且文件是错的**，用户拿到一个错误的产物却没有任何提示。现在续传前
  先比对「远端长度 + ETag / Last-Modified」，只有能证实本地半包确实是同一资源的前缀时才续传，
  否则删掉本地文件全量重下（详见 `src/resume.ts`）。
  **Resuming could silently produce a wrong file**: previously, any server that advertised Range
  support got `curl -C -` / `aria2 -c` unconditionally. Both tools only look at the local file
  length and never check whether the remote resource changed. Measured with real curl 8.13.0 and
  the bundled aria2 1.37.0 on 127.0.0.1 (`work/_fix/probe-resume.mjs`): remote shrinks 400B→200B →
  both exit 0 with the stale 400B still on disk; same length but different content → both exit 0
  with the old content intact. Both are silent corruptions: exit code 0 with a wrong file and no
  warning. Resume now compares "remote length + ETag / Last-Modified" first and only continues when
  the local partial file can be proven to be a prefix of the same resource; otherwise the local file
  is deleted and re-downloaded in full (see `src/resume.ts`).
- **aria2 覆盖下载时返回的路径与真实产物错位**：目标文件已存在时，aria2 既不截断也不覆盖，而是
  另存为 `f.1.bin` 并把新内容写进去，原 `f.bin` 保持旧内容。插件返回的 `path` 指向 `f.bin`，
  用户拿到的是旧文件。现在 aria2 调用统一带 `--allow-overwrite=true`（实测：仅留下 `f.bin`，
  1000B 正确覆盖）。
  **aria2 wrote to a different path than the one returned**: when the target already existed,
  aria2 did not truncate or overwrite it; it saved the new content as `f.1.bin` and left the old
  `f.bin` untouched, while the plugin returned `path` pointing at `f.bin`. aria2 is now always
  invoked with `--allow-overwrite=true` (measured: only `f.bin` remains, correctly overwritten).

### 新增 / Added

- **`src/resume.ts`：续传安全策略**。导出 `planResume()` / `writeMarker()` / `clearMarker()` /
  `localFileSize()` / `normalizeEtag()`。判定顺序：无本地文件 → 从头下；远端长度未知 → 删掉重下；
  本地比远端还长 → 删掉重下；ETag / Last-Modified 变化 → 删掉重下；旁车长度与本次远端长度不一致 →
  删掉重下；其余 → 按长度续传。删除时会连带清掉 aria2 的 `.aria2` 控制文件（留着它会让 aria2 按旧
  进度继续）。
  **`src/resume.ts`: resume safety policy** exporting `planResume()` / `writeMarker()` /
  `clearMarker()` / `localFileSize()` / `normalizeEtag()`.
- **`.part.json` 旁车指纹**：下载开始前把本次远端资源的长度与 ETag / Last-Modified 写到
  `<output>.part.json`。指纹是唯一能挡住「等长但内容变了」的手段（只比长度挡不住）。下载成功时
  清除；**失败或中断时刻意保留**，供下次续传比对。
  **`.part.json` sidecar fingerprint**: the remote length plus ETag / Last-Modified are recorded
  before the download starts. Cleared on success and deliberately kept on failure or interruption.
- **`decide()` 的平台入参**：新增可选 `DecideEnv { platform?, arch? }`，缺省时才回落
  `process.platform` / `process.arch`。此前「aria2 不可用」的提示文案直接读环境，导致该分支在别的
  平台上无法被单测覆盖；现在行为不变但可注入。
  **`decide()` environment parameter**: optional `DecideEnv { platform?, arch? }`, falling back to
  `process.platform` / `process.arch` when omitted.
- **进度写盘异步化**：`ProgressReporter.report()` 不再同步 `appendFileSync` / `writeFileSync`，
  改为把记录 push 进队列后在 microtask 里批量写出（保序，不合并中间记录），并新增
  `awaitFlush()` 供调用方在返回前等待落盘。
  **Progress writes are now asynchronous** with a new `awaitFlush()` for callers to await.

### 变更 / Changed

- **`buildCurlArgs` 去掉位置魔法**：原来用 `args.splice(2, 0, '-C', '-')` 按索引插参，参数顺序一变
  就会插错位置；现在 `-C -` 直接写在数组字面量里由 `resume` 条件展开。
  **`buildCurlArgs` no longer splices by index**: `-C -` is now spread conditionally in the array
  literal.
- **`buildAria2Args` / `downloadWithAria2` 新增 `resume` 参数**：不续传时不再传 `-c`，配合
  `--allow-overwrite=true` 走覆盖写。
  **`buildAria2Args` / `downloadWithAria2` take a `resume` argument**: `-c` is omitted when not
  resuming.

### 验证 / Verification

- `npm test`：**177 通过 / 0 失败**（0.5.0 为 148）。新增覆盖：`test/resume.test.ts`（24 例，
  含 ETag 归一化、旁车往返与损坏回退、`planResume` 全分支）、`decide()` 的平台注入、
  `execute()` 层的两条续传安全集成用例（等长但内容变了 → 必须重下且落盘为新内容；中断后必须保留
  旁车指纹）。
  `npm test`: **177 passing / 0 failing** (148 on 0.5.0). New coverage: `test/resume.test.ts`
  (24 cases), platform injection for `decide()`, and two resume-safety integration cases at the
  `execute()` level.
- `npx tsc --noEmit` 干净，`npm run build` 成功。
  `npx tsc --noEmit` clean, `npm run build` succeeds.

## [0.5.0] - 2026-09-29

### 修复 / Fixed

- **进度面板永远显示「下载中」（最严重）**：写入 dsh-task-progress 轨道（轨道一）的每条记录都缺少
  `state` 字段，而该协议的读取端 `parseEvent()` **只认 `state`**，缺失时一律按 `running` 处理。
  结果：即使 `pct=100`、`msg=下载完成`，界面面板也永远显示「下载中」，`download_status` 只能靠
  文案猜状态。现在 `report()` 会写入显式 `state`，终态（`done` / `failed` / `cancelled`）一定带对。
  **Panel stuck on "downloading" forever**: every record written to the dsh-task-progress track
  (track 1) lacked a `state` field, and that protocol's reader (`parseEvent()`) **only looks at
  `state`**, defaulting to `running` when it is missing. So even with `pct=100` and
  `msg=下载完成`, the UI panel showed "downloading" forever and `download_status` could only guess
  from the message. `report()` now writes an explicit `state`, and terminal states (`done` /
  `failed` / `cancelled`) always carry the right one.
- **没有会话上下文时把进度写进没人读的目录**：轨道一此前固定写入 `<cwd>/.dsh-progress/default/`，
  但 dsh-task-progress 的读取端按 `sessionId` 过滤目录（`snapshot(now, sessionId)`），写错目录等于
  没写。现在轨道一写入 `<session.cwd>/.dsh-progress/<session.id>/`（来自
  `exec.agent.session.header`），**拿不到会话时不写轨道一**，而不是写进一个永远不会被读到的目录。
  **Progress written to a directory nobody reads**: track 1 always went to
  `<cwd>/.dsh-progress/default/`, but the dsh-task-progress reader filters directories by
  `sessionId` (`snapshot(now, sessionId)`), so writing to the wrong directory is the same as not
  writing. Track 1 now goes to `<session.cwd>/.dsh-progress/<session.id>/` (from
  `exec.agent.session.header`), and is **skipped entirely when there is no session** instead of
  being written somewhere that is never read.
- **未读取 `DSH_HOME`，进度写进陈旧 home**：轨道二的缺省目录此前用 `USERPROFILE` / `HOME` 推导，
  完全忽略 DSH 自己的 `DSH_HOME`。实测本机 `DSH_HOME=C:/Users/Qing/.dsh-home`，而进度仍被写进
  陈旧的 `~/.dsh/downloads/tasks/`。现在复刻 `@deepseek-ai/dsh-home-paths` 的优先级：显式配置 →
  `$DSH_HOME`（空 / 纯空白视为未设置）→ `~/.dsh`。
  **`DSH_HOME` ignored, progress landed in a stale home**: the default directory for track 2 was
  derived from `USERPROFILE` / `HOME`, ignoring DSH's own `DSH_HOME`. On a machine with
  `DSH_HOME=C:/Users/Qing/.dsh-home` the progress still went to the stale
  `~/.dsh/downloads/tasks/`. The precedence of `@deepseek-ai/dsh-home-paths` is now mirrored:
  explicit config → `$DSH_HOME` (empty / whitespace-only counts as unset) → `~/.dsh`.

### 新增 / Added

- **`cancelled` 状态**：`ProgressReporter.cancel()` 写入 `state: 'cancelled'`，轨道二与
  `download_status`、界面面板都能区分「取消」与「失败」。`AbortSignal` 触发的中止也走这条路径。
  **`cancelled` state**: `ProgressReporter.cancel()` writes `state: 'cancelled'`; track 2,
  `download_status` and the UI panel can now tell "cancelled" apart from "failed". Aborts caused by
  the `AbortSignal` take this path too.
- **`download_status` 支持会话定位**：RPC 请求体新增可选 `session: { id, cwd }`，Host 据此扫描
  该会话的进度目录；界面面板会自动带上当前主会话。不传时行为与之前一致（只扫轨道二）。
  **Session-aware `download_status`**: the RPC payload accepts an optional `session: { id, cwd }`
  so the Host can scan that session's progress directory; the UI panel supplies the current main
  session automatically. Without it the behaviour is unchanged (track 2 only).

### 变更 / Changed

- **去重语义：从「百分比去重」改为「整条记录去重」**。此前进度只在整数百分比变化时才落盘，速度与
  ETA 变化被丢弃；现在 `pct + state + msg + spd + eta` 完全一致才跳过，因此面板能看到实时的速度与
  剩余时间，而终态因为 `state` 变化必然穿透去重。
  **De-duplication changed from "by percentage" to "by the whole record"**: previously progress was
  only written when the integer percentage changed, dropping speed and ETA updates. Now a record is
  skipped only when `pct + state + msg + spd + eta` all match, so the panel sees live speed and ETA,
  while terminal states always break through because `state` changed.
- **`download_status` 的状态判定以 `state` 为准**：记录带 `state` 时完全按 `state` 映射
  （`done` → `completed` 等）；老版本进度文件没有 `state` 时，仍回退到按文案与百分比推断，保持
  向后兼容。
  **`download_status` now trusts `state`**: when a record carries `state` it maps directly
  (`done` → `completed`, etc.); older progress files without `state` still fall back to
  message/percentage inference for backward compatibility.

### 验证 / Verification

- `npm test`：**148 通过 / 0 失败**（0.4.2 为 124）。新增覆盖：`state` 写入与终态穿透、`cancelled`
  状态、整条记录去重、`resolveTaskProgressDir` / `resolveDshHome` /
  `resolveDownloadProgressDir` 的优先级与非法输入、无会话时不写轨道一、`download_status` 的
  `state` 优先级与按会话定位、`execute()` 在带 / 不带会话上下文时轨道一的落点。
  `npm test`: **148 passing / 0 failing** (124 on 0.4.2). New coverage: `state` writing and
  terminal-state de-dup bypass, the `cancelled` state, whole-record de-duplication, the precedence
  and invalid-input handling of `resolveTaskProgressDir` / `resolveDshHome` /
  `resolveDownloadProgressDir`, "no session → no track 1", `download_status`'s `state` precedence
  and session targeting, and where `execute()` puts track 1 with and without a session context.
- `npx tsc --noEmit` 干净，`npm run build` 成功。
  `npx tsc --noEmit` clean, `npm run build` succeeds.

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

[Unreleased]: https://github.com/LeiSureYu/dsh-smart-download/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/LeiSureYu/dsh-smart-download/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LeiSureYu/dsh-smart-download/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/LeiSureYu/dsh-smart-download/releases/tag/v0.1.5
