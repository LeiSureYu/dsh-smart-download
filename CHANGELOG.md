# 更新日志 / Changelog

本文件记录本插件的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 条目以中文撰写；`0.4.2` 起同时给出英文摘要。0.4.2 之前的条目依据 git 提交历史回溯整理，
> 只记录可核实的变更。
>
> Entries are written in Chinese, with English summaries from `0.4.2` on. Entries before `0.4.2`
> are reconstructed from the git history and only record verifiable changes.

## [Unreleased]

## [1.6.0] - 2026-10-23

**下载管理器从「看得见」补到「管得动」。** 这一版给进行中的任务加上取消、给失败 / 已取消的
任务加上原地重试；两者都走宿主进程，客户端只发 `taskId`。重试所需的元数据最小化落盘，
**请求头与凭证一律不保存、不重放**。

**The download manager can now act, not just observe.** This release adds cancel for running
tasks and in-place retry for failed / cancelled ones. Both go through the host process and the
client only sends a `taskId`. Retry metadata is kept minimal, and **request headers and
credentials are never stored or replayed**.

### 新增 / Added

- **取消**：`POST /api/smartdl.manage` 的 `op:"cancel"` 会 abort 当前 Host 进程内该任务的
  `AbortController`，子进程按既有 `SIGTERM` → 1s 后 `SIGKILL` 结束，终态记为 `cancelled`。
  管理器只在 `running` 行显示该按钮；不需要 `confirm`。只对**当前进程**有效，已结束或来自
  别的进程时如实回 `not-running`，未知 id 回 `unknown`。
- **重试**：`op:"retry"` 只接受 `failed` / `cancelled`，复用原 `taskId` 在后台重新下载，
  复用 URL、输出路径、摘要、`ifExists`、镜像、限速与超时；面板原地刷新，不新增重复行。
  重试前重新校验 URL 与摘要格式，非法值回 `not-retryable`。
- **最小重试元数据**：进度记录新增可选 `request` 字段，只含可安全落盘的请求信息。
  **`Authorization` / Cookie / `Referer` / UA / 自定义请求头不落盘、不重放**；受保护地址
  需重新调用 `smart_download` 并传 `headers`。旧记录没有 `request` 时回 `no-request`。
- 管理器行内新增「取消下载」/「重试」按钮（中英文案齐全），行级动作在途时其余行按钮禁用，
  当前行显示进行中文案。

### 变更 / Changed

- `smartdl.manage` 的 `op` 白名单扩展为 `inspect` / `forget` / `delete` / `reveal` /
  `cancel` / `retry`；`cancel` / `retry` 在 `delete` 的 `confirm:true` 分支之前分派，
  即使多带 `confirm` 也绝不会落到删除产物的路径。
- 条目级取消信号与批量信号、`timeoutMs` 信号合并；同时修正 aria2 → curl 回退路径此前只传
  批量信号、导致条目级取消与超时失效的问题。

### 测试 / Tests

- 新增 `test/tasks.test.ts`、`test/retry.test.ts`，并补充 `test/client.test.ts` /
  `test/rpc.test.ts` 的取消、重试、拒绝原因与「不误删」用例。
- 基线：**626 例（623 通过 / 3 跳过 / 0 失败）**。

## [1.5.0] - 2026-10-22

**从「能下」补到「下得对、下得稳、下完找得到」。** 这一版加入通用摘要校验、同名文件
策略、服务器文件名解析、下载前磁盘预检，并让 macOS 上已有的 `aria2c` 真正参与多线程
下载；同时补上 aria2 / curl 的瞬时故障重试与 curl 的重定向协议限制。

**From "it downloads" to "it downloads the right bytes, reliably, under the right
name".** This release adds generic checksum verification, an if-exists policy,
`Content-Disposition` filename handling, a disk-space preflight, and uses an
`aria2c` found on `PATH` (including macOS). It also adds transient-failure retries
for aria2 / curl and restricts curl redirects to HTTP(S).

### 新增 / Added

- **通用 `checksum`**：支持 MD5 / SHA-1 / SHA-256 / SHA-512。裸十六进制按长度识别
  （32 / 40 / 64 / 128），也接受 `md5:` / `sha1=` / `SHA512(...)` 等前缀写法与
  `sha256-` / `sha512-` 的 SRI 写法；成功后返回 `checksum` 与 `checksumAlgorithm`。
  旧的 `sha256` 参数与返回字段保持兼容，二者同时给出会在下载前拒绝。
- **`ifExists` 同名文件策略**：`overwrite`（默认）/ `skip` / `rename`。`skip` 不发
  下载请求，但传了摘要时仍校验已有文件；`rename` 另存为 `name (1).ext`，绝不覆盖，
  并禁用续传。批量条目可逐条设置。
- **`Content-Disposition` 文件名**：URL 末段没有可用文件名时，读取服务器给出的
  `filename*=` / `filename=`；查询串 `?filename=` / `?file=` 也会被识别。服务器
  文件名属于不可信输入，统一经过 `sanitizeFilename()`，不会造成路径穿越。
- **磁盘空间预检**：远端大小已知且响应未压缩时，要求可用空间不少于
  `大小 + max(64MB, 5% × 大小)`，不足则在发请求前拒绝。`statfs` 不可用时继续下载，
  并在结果里返回 `diskCheckSkipped`，不假装检查过。
- **`PATH` 上的 aria2**：随包子包不可用时，查找 `PATH` 上的 `aria2c` 并执行
  `--version` 验证；macOS 用户安装 Homebrew aria2 后也能多线程下载。

### 变更 / Changed

- aria2 使用 `-m 3 --retry-wait=2`，curl 使用
  `--retry 3 --retry-all-errors --retry-delay 2`，避免瞬时 5xx / 连接重置直接失败。
- curl 增加 `--proto-redir =http,https`，重定向目标同样只允许 HTTP(S)。
- 单条与批量 output schema 同步新增 `checksum` / `checksumAlgorithm` /
  `skipped` / `diskCheckSkipped`；`additionalProperties: false` 的两支都保持一致。
- 进度上报新增 `setTarget()`，在探测拿到真实文件名后修正面板中的文件名与
  `outPath`，避免进度记录指向一个从未落盘的临时名。

### 修复 / Fixed

- 进度文件的覆盖写改为真正串行：此前只串行化了「等待」而没有串行化「发起」，
  两批刷新可能同时以截断模式打开同一个 `<taskId>.json`，在 Linux 上留下
  「新 JSON + 旧 JSON 尾巴」的半截文件，读取端会报
  `Unexpected non-whitespace character after JSON`。现在一次只允许一批写入启动。

### 测试 / Tests

- 新增 `test/disk.test.ts`，并补充 checksum、`ifExists`、`Content-Disposition`、
  `PATH` aria2、重试参数与 output schema 的用例。
- 新增进度覆盖写串行化的回归用例（注入可计数的写盘实现，断言同时活跃写入数为 1）。
- 基线：**600 例（597 通过 / 3 跳过 / 0 失败）**；行覆盖 **99.23%** / 分支
  **91.87%** / 函数 **97.70%**。

## [1.4.6] - 2026-10-13

**安装段改成与生态一致：图形界面优先。** 此前 README 把命令行
`dsh plugin --profile web add @leisureyu/dsh-smart-dl` 放在最前面当主路径，
而 DSH 现在的标准装法是**在界面里装**：侧边栏 →「插件」→「添加插件」→ 粘贴包名 → 安装 → 重启。
命令行降为「命令行」小节，并补上 pnpm 的 `github:` 简写形式。

**The install section now follows the ecosystem convention: the UI flow comes first.** The README
used to lead with `dsh plugin --profile web add @leisureyu/dsh-smart-dl`; the standard way today is
to install **from the UI** — sidebar → **Plugins** → **Add plugin** → paste the package name →
Install → restart. The command line moved to its own section, and pnpm's `github:` shorthand is now
documented alongside the full URL.

### 变更 / Changed

- 安装段拆成三节：**在 DSH 界面里装（推荐）** / **命令行** / **从 Git 仓库地址安装**。
- GUI 路径按本机实测写：**侧边栏 →「插件」→「添加插件」**。
  依据是 `dsh-plugin-manager` 自己的 README ——「使用 Web 侧栏的**插件**入口管理 profile 已安装的
  组合包……**设置 → 内置插件**则展示内置插件列表及运行状态」，以及客户端包里的
  `addPlugin: "添加插件"` 文案。**设置页那份是只读的**，不是安装入口。
- 「从 Git 仓库地址安装」补上 pnpm 的 `github:LeiSureYu/dsh-smart-download` 简写（与完整地址等价）。
- 目录按新标题重新生成（43 条；锚点逐条校验：0 死链、0 重复）。

> 起因：用户拿 `dsh-plugin-notify-sounds` 的 README 对照，指出我们把命令行当主路径、
> 与生态里「界面优先」的写法不一致。核对后确认属实。

## [1.4.5] - 2026-10-13

**开发段的数字全部过期，已按实测更新。** README 声称「343 例用例（341 通过）/ 行覆盖 99.74% /
分支 94.18% / 函数 96.99%」—— 那是 1.0 时代的数字，**用例数早已涨到 541**。

**The Development section carried stale numbers; they are now measured.** The README claimed
"343 cases (341 pass) / 99.74% line / 94.18% branch / 96.99% function" — numbers from the 1.0 era.
The suite has since grown to **541 cases**.

### 变更 / Changed

- 开发段基线改为**实测值**：**541 例用例（539 通过 / 2 跳过 / 0 失败）**，行覆盖 **99.40%** /
  分支 **92.71%** / 函数 **97.11%**（`node --test --import tsx --experimental-test-coverage`，
  LF 工作区实测）。
- 「覆盖率必须在 LF 工作区测量」这条警告补上**实测对照**：同一棵树 CRLF 时行覆盖 **99.36%**，
  转成 LF 后 **99.40%** —— 此前这条只是断言，现在有数字。
- 「未覆盖行」注释里的行号已过期（原文写 `downloader.ts:134`），改为**当前真实的 4 处**
  （`downloader.ts:246-249`、`headers.ts:119`、`index.ts:323-326`、`index.ts:409-413`），
  并**重新逐条核对**：全部是块结束的 `}`、对象字面量续行、类型声明与注释行，
  **没有「有逻辑但缺用例」的语句**。

> 测量纪律：本机工作区曾因编辑工具写成 CRLF（`.gitattributes` 规定 `eol=lf`）。
> 在 CRLF 树上测出的行覆盖是 99.36%，规范化成 LF 后是 99.40% —— **同一份代码、同一批用例**。

## [1.4.4] - 2026-10-13

**README 结构重构，并修掉 npm 页面上的死链。** README 之前 857 行 / 38 个标题却**没有目录**，
参数散落在十几节散文里，支持平台 / 权限 / 兼容性被压到内部原理**之后**；更严重的是
**所有相对链接**（`./docs/*.md`、`./CHANGELOG.md`、进度面板截图）**在 npmjs.com 上都是死的**
—— npm 渲染 README 时不解析相对路径。

**README restructured, and the dead links on the npm page are fixed.** The README had 857 lines
and 38 headings but **no table of contents**; parameters were scattered across a dozen prose
sections, and platforms / permissions / compatibility sat *after* the internals. Worse, **every
relative link** (`./docs/*.md`, `./CHANGELOG.md`, the progress-panel screenshot) **was dead on
npmjs.com** — npm does not resolve relative paths when it renders a README.

### 变更 / Changed

- 新增**目录**（41 条，含二级标题）。锚点逐条校验：**0 死链、0 重复锚点**。
- 新增**「参数与选项速查」**：`smart_download` 的全部 10 个参数、`download_status` 的 2 个参数，
  以及面向用户的环境变量，收成三张表。数据取自**工具 schema**（`src/index.ts`），不是转述散文 ——
  例如 `timeoutMs` 的 `1000`–`1800000`、`targets` 的 50 条上限、`limit` 默认 `10`。
  表里只列用户可调的变量；`DSH_SMARTDL_REVEAL_CMD` 之类是**测试接缝**（源码注释明写），
  单独用一句话说明，不混进用户选项。
- 按常规骨架重排：**支持平台 / 权限说明 / 兼容性**提到「工作原理」「设计上的静默失败防护」
  「并发阈值是实测的」等内部原理**之前**。
- README 里 48 处文件链接 + 2 处图片改为**绝对地址**（`github.com/.../blob/main/...` 与
  `raw.githubusercontent.com/...`），现在在 npm 页面与 GitHub 上都能打开。
- 中英两份同步做，章节顺序一一对应。

> **内容一字未删**：把新增章节与链接目标排除后逐行比对，旧 644 行 / 新 644 行，**双向差异 0**。

## [1.4.3] - 2026-10-13

**文档（安全）**：把 `COMPATIBILITY.md` 里「桌面版必须用桌面版自带 CLI 安装」的警告**写实** ——
原来只说「外部 CLI 会被拒绝」，听起来像「顶多装不上」，实际后果是**把 DSH 弄崩**：profile 的
`package.json` 不声明 9 个 `@deepseek-ai/dsh-*` 核心包，它们在 pnpm 眼里是「多余的包」，
一次手跑 `pnpm install` 就会把它们 prune 掉，导致 `sessions` / `tools` 服务无人提供、
几十个插件无法激活、DSH 启动即崩溃（且所有工具调用都不会返回结果）。
`TROUBLESHOOTING.md` 新增完整条目：症状、根因、官方逃生口与手工恢复步骤。

**Docs (safety)**: made the "install on desktop only through the bundled CLI" warning in
`COMPATIBILITY.md` state the **real** consequence — it used to say "external CLI is rejected",
which reads like "it just won't install". In fact it **bricks DSH**: the profile's `package.json`
does not declare nine `@deepseek-ai/dsh-*` core packages, so pnpm treats them as extraneous and a
single hand-run `pnpm install` prunes them; the `sessions` / `tools` services then have no provider,
dozens of plugins cannot activate, and DSH fails at startup (with every tool call returning nothing).
`TROUBLESHOOTING.md` gained the full entry: symptoms, root cause, the official escape hatch, and
manual recovery.

### 变更 / Changed

- `COMPATIBILITY.md`：桌面版安装警告补上真实后果（DSH 崩溃 + 工具全部无响应）与指向排查手册的链接。
- `TROUBLESHOOTING.md`：新增「在 desktop profile 里手跑 pnpm / npm install 后，DSH 启动即崩溃」，
  含崩溃日志原文、四重保护为何被绕过、以及恢复用的 9 条 `link:` 声明。

> 本条是**实测事故的复盘**（DSH `0.2.0-rc.2`，崩溃日志
> `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-12T23-54-30-829Z-host.log`），不是推测。

## [1.4.2] - 2026-10-13

**文档**：把三份面向用户的文档补齐到 1.4.x 的实际状态。`ARCHITECTURE.md` 的模块表此前**严重失真** ——
`rpc.ts` 写的「~188 行 / 1 个端点」，实际是 770 行 / 3 个端点；`client.js` 写的 365 行，实际 2333 行；
`cleanup.ts` / `throughput-cache.ts` / `verify.ts` 三个模块**根本没列进表**。

**Docs**: brought the three user-facing documents up to date with 1.4.x. The module table in
`ARCHITECTURE.md` had drifted badly — `rpc.ts` was listed as "~188 lines / one endpoint" (it is 770 lines
and three endpoints), `client.js` as 365 lines (it is 2333), and three modules
(`cleanup.ts` / `throughput-cache.ts` / `verify.ts`) were missing entirely.

### 变更 / Changed

- `ARCHITECTURE.md`：模块表按真实数据重写（19 个模块，行数与职责全部核对过）；新增
  「下载管理器：删除与「在文件夹中显示」」一节 —— 数据流、三条硬约束（路径只能来自本插件自己的记录 /
  只有文件确实在原位才动手 / 绝不假装成功）、`spawn` 的异步 `error` 会打崩宿主的坑、
  以及会话为什么必须随请求带上。
- `COMPATIBILITY.md`：新增「客户端插件的服务依赖」—— 五个 manifest 声明的用途与缺失后果，点明
  「光在代码里写 `inject` 不够，manifest 才决定拿不拿得到」（`remote.session` 恒为 `undefined` 的真因），
  并说明 `remote.session` **不是必需的**（有服务端降级路径）。「包管理器要求」补上 **pnpm 11 的构建审批**
  说明：仓库把 `onlyBuiltDependencies` 写在 `package.json` 的 `pnpm` 字段（pnpm 9 的位置，CI 用 9），
  而 pnpm 11 改从 `pnpm-workspace.yaml` 读 —— 未批准时 `pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS`
  直接失败。
- `TROUBLESHOOTING.md`：新增五条 —— 侧边栏没有「下载管理」入口 / 「在文件夹中显示」提示
  「打不开文件夹位置」/ 删除后「文件没了、记录还在」/ 面板上没有「同时删除本地文件」/
  批量删除为什么不能连文件一起删。

> 内部工作记录（`PLAN-*` / `REVIEW-*` / `VERIFY-*` / `SPIKE-*` / `ROADMAP-*`）**刻意不改**：
> 它们是开发过程记录，改了就是篡改历史，而且自 1.4.1 起已不随包发布。

## [1.4.1] - 2026-10-13

**文档与打包**：补齐 1.4.0 的更新日志与 README（此前**缺了 12 个提交**的内容：筛选/搜索/批量、速度与 ETA、
`Delete` 键、服务端 `reveal`，以及 4 个 bug 修复），并把**内部工作记录**（`PLAN-*` / `REVIEW-*` / `SPIKE-*` /
`VERIFY-*` / `ROADMAP-*`）从发布包里移除 —— 它们是开发过程记录，用户不需要。包从 62 个文件 / 465 KB
降到 49 个文件 / 305 KB。

**Docs and packaging**: completed the 1.4.0 changelog and README (**12 commits' worth of entries were missing**:
filtering/search/bulk delete, speed and ETA, the `Delete` key, the server-side `reveal`, and four bug fixes), and
dropped the **internal working notes** (`PLAN-*` / `REVIEW-*` / `SPIKE-*` / `VERIFY-*` / `ROADMAP-*`) from the
published package — they are development records users do not need. The package went from 62 files / 465 KB to
49 files / 305 KB.

### 变更 / Changed

- `files` 改为**显式白名单**：只带 `dist/`、四份面向用户的文档（ARCHITECTURE / COMPATIBILITY / SECURITY /
  TROUBLESHOOTING）、`docs/progress-pill.png`、`cordis.patch.yml`、README、CHANGELOG、LICENSE。
  显式列举而不是「整个 `docs/` 再排除」：新加的内部文档不会因为忘了排除而误发。
- 新增端到端断言：真跑 `npm pack --dry-run` 核对**实际会发出的文件清单**（而不是只读 `files` 字段 ——
  匹配规则由 npm 决定），内部文档出现即失败。

### 修复 / Fixed

- 1.4.0 的 CHANGELOG 与 README 与实际发布内容不符（缺少上述 12 个提交的条目）。

## [1.4.0] - 2026-10-12

**下载管理器**：侧边栏新增「下载管理」入口，点开是占满主区的列表页 —— 能看到全部任务（进行中 + 已完成，
不再受浮层 30 秒回执期的限制）。列表支持按状态筛选（带计数）、按文件名搜索、多选后批量删除记录；
每行显示状态色点、进度条、大小与最近更新时间，下载中另有实时速度与剩余时间；行内提供
「在文件夹中显示」与「删除」，并支持键盘操作（`Delete` 开确认框、`Enter` 确认）。
删除记录时会显示**完整绝对路径、文件大小与不可恢复声明**；「同时删除本地文件」只在文件仍在原位时提供 ——
**文件已被移走或改动时，只能删除记录**（这是「删除的是当初下载的那个文件」的安全边界，不是偷懒）。

A **download manager**: a new sidebar entry opens a full-page list of every task (in-progress and
finished, no longer bounded by the overlay's 30-second receipt window). The list filters by status
(with counts), searches by file name, and deletes records in bulk after multi-select; each row shows
a status dot, a progress bar, size and last-update time, plus live speed and ETA while downloading,
with per-row "Show in folder" and "Delete" and keyboard support (`Delete` opens the confirm dialog,
`Enter` confirms). Deleting shows the **absolute path, size, and a non-recoverable notice**;
"also delete the local file" is offered only while the file is still in place — **moved or changed
files allow deleting the record only**.

### 新增 / Added

- 侧边栏「下载管理」入口（`sidebar.panellist`）与主区面板（`main` keyed slot，`ctx.layout.selectPanel` 开合）；
  原 1.3.0 的会话头部入口移除，浮层只保留播报职责（进度 + 回执 + 提示音）。
- **列表能力**：按状态筛选（全部 / 下载中 / 已完成 / 失败·取消，各带计数）、按文件名搜索（大小写不敏感）、
  多选 + 全选后批量删除记录。批量**只删记录、绝不删本地文件** —— 一次误选就是多个文件永久消失
  （不进回收站），代价不对称；要删文件就逐行进确认框。
- **行内信息**：状态色点 + 彩色状态文字、进度条（按状态着色）、`presence` 胶囊徽标（原位 / 已移走 /
  已改变 / 路径不可删）、大小与最近更新时间；下载中另有**实时速度与剩余时间**（ETA 只在 `running` 时显示，
  给已完成的任务报「剩余 0s」是噪声）。
- **键盘操作**：行获得焦点后按 `Delete` 打开该行确认框（不是直接删 —— 不可逆操作的刹车仍在）；
  确认框把 `autoFocus` 放在**上次用的那个选项**上，`Enter` 即确认（选择记在
  `localStorage: dsh-smart-dl.last-delete`）。文件已移走时焦点自动落回「只删记录」。
- `POST /api/smartdl.manage`：`inspect` / `forget` / `delete` / `reveal` 四个操作。删除本地文件按 14 条安全规则执行：
  路径只能来自本插件自己的记录（客户端只发 `taskId`）、只接受绝对路径、`normalize` 一致且无 `..`/NUL、
  只用 `lstat`（拒目录与符号链接）、尺寸不符即拒、任务未终态拒、拒删记录目录内的路径、
  **先删文件再删记录**、失败按 `gone`/`busy`/`denied`/`is-dir`/`is-link`/`changed`/`no-path`/`running` 分类回告、
  **绝不假装成功**。
- `op:'reveal'`：由**宿主进程**打开系统文件管理器并定位产物（Windows `explorer.exe /select,`、
  macOS `open -R`、Linux `xdg-open`）。路径同样只能来自本插件自己的记录并走同一套校验；
  产物不在原位时**什么都不打开**（打开一个「看起来对」的邻居路径比不做更糟）。
- 两条进度轨道新增可选 `outPath` / `size` / `fileMtimeMs`（与 `batch` 同构：有值才写，老记录照常可读）。
- 下载管理器行内显示最近更新时间（手写 `MM-DD HH:mm`，不用 `toLocaleString` —— locale 相关格式随浏览器变，
  撑不住行宽也没法断言）。
- 下载失败/删除失败的提示按具体原因区分（8 种 reason 各自的文案 + errno 次要信息），不再一律「操作失败」。
- 空状态区分「一条记录都没有」与「被筛掉了」，后者给「清除筛选」入口。
- `docs/SECURITY.md` 新增「本地持久化：输出路径与产物指纹」与「删除本地文件（不可逆，不进回收站）」的隐私与边界说明。

### 变更 / Changed

- **返回值里的输出路径改为绝对路径**：`smart_download` 成功结果的 `path` 与批量条目的 `output` 现在由
  `path.resolve` 得到。此前它们是「调用方传入的 `output` 原样回显」，未传 `output` 时则是**单段文件名**
  （含义为相对进程 cwd）。**落盘位置不变** —— 相对路径此前就是按 Host 进程 cwd 解析的，这次只是把这个含义
  写进返回值，不再留给调用方去猜。传绝对 `output` 的调用方拿到逐字节相同的结果（含 `..` 或多重分隔符的
  输入会被规范化，指向同一个文件）。
- 行内删除按钮文案由「删除记录」改为「**删除**」—— 具体删什么由确认框里的「只删除记录」/「同时删除本地文件」
  说清楚，按钮上写太长反而看不清。
- 删除失败时面板**保留该行**并显示具体原因（此前 `ok:true` 被当成「已删除」，行会闪一下又回来且无解释）。
- 无创建符号链接权限的环境（Windows 普通终端）下，`is-link` 那条用例**如实跳过**，而不是让整片测试变红 ——
  硬跑会让 EPERM 掩盖真正的回归。

### 修复 / Fixed

- **「文件删得掉、记录删不掉」**：`manage` 请求此前不带会话，而轨道一的路径是
  `<cwd>/.dsh-progress/<session.id>/` —— 没有会话就解析不出来，于是文件被删了、记录还留在磁盘上。
  现在会话由浮层写进共享 store，`manage` 一并带上。
- **「在文件夹中显示」失败时静默**：`reveal` 在「宿主没有该服务」「调用抛错」「宿主拒绝」三种情况下都是
  **返回 `ok:false` 而不抛异常**，只靠 `try/catch` 抓不住，点了没反应。现在检查返回值并给出具体原因。
- **打开文件管理器会崩掉宿主**：`spawn` 在命令不存在时**异步 emit `'error'`**，`try/catch` 抓不到；
  没有监听器时它就是未捕获异常（CI 的 Linux 容器里没有 `xdg-open`，测试进程就是这样被打挂的）。
  现在同步抛与异步 error 都如实返回失败，只有真的起来了才报成功。
- **Linux 上绝对路径泄漏进用户文案**：`executableName` 用了 `path.basename`，而它是**平台相关**的 ——
  Linux 上不认反斜杠，`C:\...\aria2c.exe` 会整串留下来。现在两种分隔符都切，行为与平台无关。
- 完成态显示为灰色而非绿色：宿主没有 `success` 这类语义变量，此前用 `label-secondary` 顶替，
  结果完成态与取消态同色。现在语义色自己取（完成 = 绿、失败 = 红、进行中 = 主色、取消 = 中性灰）。
- 客户端清单补齐 `remote.session` / `dsh-api-gateway` / `layout` 的声明 —— 光在代码里写
  `inject: ['remote.session']` 不够，manifest 才决定插件拿不拿得到这些命名空间。实测这份 profile 下
  `ctx.remote.session` 仍不可用，因此「在文件夹中显示」改为**不依赖任何客户端注入**的服务端实现（见上）。

## [1.3.0] - 2026-10-12

三件事：**一次调用下一批文件**（下载队列）、**把「静默失败」的出口补上人话**（错误提示与进度面板）、
**把观测到的数据用起来**（实际连接数解析 + 吞吐缓存）。另外把 P2 的核对结论写进文档 ——
结论是「macOS 仍然不做」，但理由从「没找到」升级为「逐个来源核对后仍不成立」。

Three things: **downloading a batch inside one call** (the download queue), **giving the
"silent failure" exits human-readable text** (error messages and the progress panel), and
**putting the observed data to use** (real connection-count parsing plus a throughput cache).
P2's findings are also written down — macOS is still not done, but the reason is upgraded from
"not found" to "checked every source and it still does not hold up".

### 新增 / Added

- **`targets` 参数：单次调用内批量下载（P0 的核心交付）。** 传一个数组，每个条目带自己的
  `url` 与可选的 `output` / `sha256`，`mirror` / `userAgent` / `referer` / `headers` /
  `maxBandwidth` / `timeoutMs` 整批共享。批内用**滑动窗口**并发，窗口宽度按「批内总连接数
  有界」反推（预算 = 单条目最高档 × 2 = 16，窗口 = 预算 ÷ 单条目可能占用的连接数，当前恒为 2）——
  刻意**不取**单条目最高档 8，否则 8 条 × 8 连接 = 峰值 64，会把「单文件压在 8 连接以避免触发
  服务器按 IP 限并发」这条既定取舍整个抵消。单条目内部开 4 还是 8 仍由 `decide()` 按实际
  文件大小决定，两者互不影响。
  **失败语义（用户拍板 D4=②）：部分成功照常返回**，返回值带 `batch`（批次 ID）、
  `succeeded` / `failed` / `cancelled` 三个计数与逐条的 `results[]`，一行一条 `success` /
  `path` / `error` —— 只给「N 条成功 M 条失败」的话，调用方仍然不知道要不要重试、重试哪一条。
  失败与取消分开计数：`failed` 是「下载坏了」，`cancelled` 是「整批被取消」；整批取消时还没
  开工的条目也各留一条取消记录，不会凭空消失。
  **`targets` parameter for downloading several files inside one call** (route A: synchronous
  return, no background jobs), with a sliding-window concurrency derived from a bounded
  in-batch connection budget, per-entry results so a failing entry never discards the ones
  that succeeded, and failures counted separately from cancellations.

- **`maxBandwidth` 参数：一批内所有任务共享的总带宽上限。** 接受裸字节数或 K/M/G 后缀
  （1024 进制），如 `"4M"` / `"500K"` / `"1500000"`。它是**一次调用**的上限而不是每条的上限：
  批量时按实际并发位均分（`"4M"` + 窗口 2 → 每条 2M），因此一次调用的合计吞吐不会超过它。
  落到子进程上是 aria2 的 `--max-overall-download-limit` 与 curl 的 `--limit-rate`。
  **为什么不需要跨调用状态**：`smart_download` 未声明 `isConcurrencySafe`，DSH 的
  executionMode 规则是「未声明即 exclusive」，同一时刻只可能有一个调用在跑，所以上限天然
  只需在批内共享。**非法值在发起任何请求之前抛错** —— 交给子进程等于「用户以为限了速，
  其实没限」（它们对非法参数是静默忽略的）。缺省时两条命令行逐字节不变。
  **`maxBandwidth`** a bandwidth cap shared by every task in one call (divided across the
  entries running concurrently in a batch); no cross-call state is needed because the tool
  is exclusive, and an invalid value is refused before any request is made.

- **`timeoutMs` 参数：单条目超时。** 毫秒，`1000`..`1800000`（1 秒到 30 分钟）。为什么需要它：
  路线 A 是同步调用，一个卡死的条目会让整批一直不返回。30 分钟是保守上限
  （1GB @ 1MB/s ≈ 17 分钟）；更长的等待说明应当改用「先返回、后台继续」的形态 ——
  那个形态明确不做（见下方「不做」），所以宁可让它在这里失败，也不挂住整个会话。
  超时之后：**那一条记 `failed` 而不是 `cancelled`**（用户并没有按取消，两者在面板上是两个
  状态），同批其余条目继续跑，已完成条目的结果不会被改判，超时**不**回退到 curl
  （回退等于把同一份等待再花一遍）。它对**单条目调用同样有效**；不传时单条目路径与 1.2.0
  逐字段相同，传了但未超时时返回结构的键集合也不变。
  **`timeoutMs`** a per-entry timeout (1000..1800000 ms) that exists because route A is a
  synchronous call; a timed-out entry is reported as `failed` (not `cancelled`), the batch's
  other entries keep running, and there is no fallback to curl.

- **进度记录加 `batch` 字段（批次 ID，P0-5）。** 一次调用的所有条目共享同一个 ID，两条进度
  轨道都写入，`download_status` 与面板因此能把它们归到一起。字段**可选**：老进度文件缺它时
  读取端不报错、不改变原有 `status` / `pct` / `msg` 解析结果。它只做**分组标签**，
  不参与任何执行 / 并发决策。单条目调用也生成一个（不进返回值，返回结构必须与 1.2.0 相同），
  便于统一显示。
  **A `batch` field on progress records** shared by every entry of one call on both progress
  tracks; optional for backward compatibility, a grouping label only, never an input to any
  execution or concurrency decision.

- **`/api/smartdl.cleanup` Host 端点：历史进度文件清理入口（D7-②）。** 此前 `cleanup()` 是
  给调用方准备的显式接口但没有任何触发入口，进度文件只增不减。删除范围被严格限制在两条进度
  轨道目录内，且只删「文件名符合本插件规则（`*.json` / `*.jsonl`）且 mtime 早于保留窗口」的
  **普通文件**（用 `lstat`，目录与符号链接一律不碰）：默认窗口 24 小时（下限 60 秒、上限 365 天），
  单次默认删 200 个（硬上限 500），最旧优先。它**不**删下载产物、**不**递归、**不**碰其它目录；
  参数非法直接 `ok:false` + 可操作文案拒绝，而不是把参数夹到边界后照删。
  要清轨道一必须在 payload 里带 `session: { id, cwd }`，不带时返回里用 `taskDirSkipped`
  明确说明「轨道一未参与」，而不是假装清完了。
  **A `/api/smartdl.cleanup` endpoint** for pruning historical progress files, strictly
  scoped to the two progress directories, regular files only (`lstat`), with an explicit
  `taskDirSkipped` when track 1 is not reachable.

- **吞吐缓存（P1-2 读侧 + 写入侧）。** 新增 `src/throughput-cache.ts`：按**主机 + 端口**分桶，
  **只存主机名的 sha256 前缀**（缓存文件里 grep 不到任何明文域名），每条记录保留最近 5 次样本的
  吞吐中位数、当时的并发数与**实际有效连接数**、更新时间；TTL 24 小时，过期顺手淘汰。
  读侧：`decide()` 新增可选 `history` 入参，命中且历史并发达到上限时**只做抬档**，且抬档理由
  必须显式写明「依据历史吞吐抬档」并带上主机标识与数值；不给 `history` 时与今天逐字段相同
  （不读盘、不抬档）。写入侧：下载成功且完整性校验通过之后记录一次观测值
  （放在校验之后是刻意的 —— 校验失败说明这次字节不可信，那种速度不代表这台主机的能力），
  写失败静默忽略（与 `writeMarker()` 同构：缓存是优化而不是功能）。
  目录可用 `DSH_SMARTDL_THROUGHPUT_DIR` 覆盖。隐私口径见 `docs/SECURITY.md`。
  **A throughput cache** keyed by host + port, storing only a sha256 prefix of the hostname,
  read by `decide()` to raise (never lower) the concurrency tier with an explicit reason, and
  written after a verified successful download.

- **解析出 aria2 的「实际有效连接数」`CN`（P1-1，纯观测）。** `parseAria2Summary()` 此前已经
  匹配 `CN:\d+` 却只取了 `pct` / `spd` / `eta`，把这个白拿的观测值丢掉了。现在返回 `cn`，
  语义与 `-x/-s` 不同：后者是**请求**的并发数，前者是**实际用起来**的连接数，两者不等说明
  瓶颈不在并发档位。本项**不消费**这个字段（零行为变更），它是上面那条缓存的数据来源之一。
  **Parsing aria2's real connection count `CN`** (observation only, zero behaviour change):
  `-x/-s` is what was requested, `CN` is what actually got used.

- **`download_status` 区分「读不到」与「没有任务」（P0-3）。** 新增可选 `scanFailedDirs` 字段，
  只在真有目录读不到时出现；两个目录都读不到时 `ok` 为 `false`（此前恒为 `true`），
  于是「权限不足」与「确实没有任务」不再同形。可读的空目录返回结构与之前逐字段相同。
  模型可见回执也会追加诊断段，并且**否定**那句空列表结论。
  **`download_status` now distinguishes "unreadable" from "no tasks"** via an optional
  `scanFailedDirs` field and a tightened `ok`.

### 变更 / Changed

- **子进程退出码翻译层（P0-1）。** 此前非零退出时用户看到的是原始 stderr 直出，没有任何
  「下一步」。现在 curl 18 / 22 / 28 / 33 / 56 与 aria2 1 / 3 / 9 / 13 / 24 都会给出中文原因
  与下一步；**未知码原样保留退出码与 stderr 尾部**，不编造原因。退出码 0 仍 `resolve()` 且
  不产生任何文案。文案里的命令收敛为 `curl` / `aria2c`，绝对路径不再出现。
  **每个码都追到官方来源**：curl 取 man page 的 "Exit codes"，aria2 取官方手册的
  "EXIT STATUS"（随包二进制查不到退出码表，`--help=#exit-status` 只回一句
  「Refer to man page for more information.」）—— 宁可不翻译，不可翻译错。
  **An exit-code translation layer** mapping curl 18/22/28/33/56 and aria2 1/3/9/13/24 to a
  cause plus a next step, each traced to its official documentation; unknown codes keep the
  exit code and stderr verbatim.

- **校验失败文案补「下一步」（P0-2）。** 四条失败路径（长度不符 / 文件不存在 / SHA-256 不匹配 /
  无法读取）都补上下一步，并保留原有的可核对数据（落盘字节数、远端声明字节数、期望与实际摘要）。
  SHA-256 不匹配改为**分行**呈现（原因 / 期望摘要 / 实际摘要），两个 64 位 hex 不再并排。
  **Integrity-failure messages gained a "what to do next"** while keeping every previously
  reported number, and a SHA-256 mismatch now prints expected and actual on separate lines.

- **进度面板：失败原因进正文 + 容量对齐批量（P0-4）。** `STATUS_LIMIT` 由 5 提到 **50**，
  与服务端 `MAX_STATUS_LIMIT` 对齐 —— 一次批量可能同时有多行，5 条装不下。`failed` /
  `cancelled` 的失败原因从此在**面板正文可见**，不再只存在于悬停 `title`。单行信息位数量
  不减少（文件名 / 百分比 / 进度条 / 速度·ETA 全部保留），`role="progressbar"` 与
  `aria-valuenow` 保持。批量超过面板高度时可滚动（`maxHeight: 260` + `overflowY: auto`）——
  这是 `STATUS_LIMIT` 提升的必要配套，不是新增交互。
  **The progress panel shows failure reasons in the row itself**, raises `STATUS_LIMIT` to 50
  to match the server cap, and scrolls when a batch is longer than the panel.

- **`curl -C -` 退出码 33 的表述按官方定义对齐。** 此前把它解释成「服务器不支持 Range」，
  而 curl 官方定义里 **33 = HTTP range error**（我们发出的 Range 请求未被服务器接受），
  「服务器不支持续传」对应的是 **36 = bad download resume** —— 两者不是一回事。本机实测
  （curl 8.13.0）：服务器**忽略**我们发的 `Range` 且本地已有半截文件时以 33 失败；
  同一场景不带 `-C -` 能正常全量重下。据此推断「服务器永久不支持续传」是不成立的（那要按 36 判）。
  **curl exit code 33 is now described per its official definition** (HTTP range error),
  distinguished from 36 (bad download resume).

### 修复 / Fixed

- **取消文案泄漏可执行文件绝对路径（P0V-01）。** `runProcess` 的两处取消分支此前插值原始
  `command`，aria2 取消时用户可见文案里出现完整的 `node_modules` 绝对路径。现在改用
  `executableName(command)`，并在原地留下注释说明这条不变量。测试连带加强：除了「等于整句」，
  还加了四条 `doesNotMatch`（`/node_modules/i`、`/[A-Za-z]:[\\/]/`、`/[\\/]/`、`/.exe/i`），
  其中一条**故意用形状与随包 aria2 完全一致的绝对路径**当命令 —— 将来若改成用解析出来的
  绝对路径启动 curl，这条用例就是拦住泄漏的那一道。
  **Cancellation messages no longer leak the executable's absolute path**; the new assertions
  also refuse any path separator at all, so a future change in how the binary is located
  cannot silently reintroduce the leak.

- **`targets` 与 `url` 的二选一约束（P0R-01 修法）。** 目标是「两个都给、或两个都不给都要被
  拒绝」。曾尝试在 schema 根节点写 `oneOf: [{required:['url']}, {required:['targets']}]`，
  **无法经 parameters 的 DSL 表达**：`ParameterSchemaSpec` 就是一个属性映射，没有根级 `oneOf`
  的位置；把 `oneOf` 写成 parameters 的一个键，DSL 会把它当成**一个名叫 `oneOf` 的入参属性**。
  给两者都标 `required: true` 则会挡下 targets-only 的合法调用。因此采用：schema 只表达
  「各自是什么」，强制放在执行层，并把后果写进两个参数的 description；根节点必须保持没有
  `required` 列表 —— 一旦有人把 `required` 加回来（退回被否掉的方案），测试立刻红。
  **The `url` / `targets` mutual exclusion is enforced in the execution layer**, because the
  parameter DSL cannot express a root-level `oneOf`; the design decision and its evidence are
  recorded in `test/tool-schema.test.ts`.

- **清理端点的两处静默回落（P0R-02 / P0R-03）。** 参数越界此前会被静默夹到边界后照删，
  现在直接 `ok:false` + 文案点名字段与范围，且**一个文件都不删**；扫不到轨道一时返回
  `taskDir === ''` + `taskDirSkipped` 固定文案说明「轨道一未参与」及原因与解法，
  而不是安静地只扫轨道二、假装清完了。
  **The cleanup endpoint no longer silently clamps out-of-range parameters**, and reports
  `taskDirSkipped` instead of pretending it cleaned track 1 when that directory is unreachable.

- **面板轮询计时器泄漏（t13 修复）。** `test/client.test.ts` 的 11 条断言此前被 skip 屏蔽
  （等于零覆盖）。恢复成真跑后发现 18 个面板轮询计时器只清了 10 个；修复后 11/11 通过、
  0 skip。**Panel polling timers were leaking** (18 created, 10 cleared); found by un-skipping
  11 previously disabled assertions.

### 文档 / Docs

- **README 新增「一次下载多个文件」整节**，并把批量语义（二选一、50 条上限、逐条结果、
  批内并发推导、带宽均分、超时四条定义）与 P0 新增的 11 条「返回默认值」路径补进
  「静默失败防护」契约表。`README.en.md` 同步同等深度。
  **A whole README section for batch downloads**, plus 11 new rows in the silent-failure
  contract table for the paths P0 added; `README.en.md` mirrors it.

- **P2 的核对结论写进既有文档（P2-1）。** `docs/COMPATIBILITY.md` 的 macOS 搁置理由从
  「没找到满足条件的来源」升级为「逐个来源核对后仍不成立」，并**明确写出卡点是「来源不可信」
  而不是「没有二进制」**（macOS 二进制确实存在，`FerroDownload/aria2-static-builds` 也确实
  提供 x64 + arm64 且公布 SHA256，但仓库 0★、无许可证、创建于 2026-06-20、构建证明实测 404、
  构建不可复现）；README 与 `docs/SECURITY.md` 明确写出**不支持 FTP / SFTP / BitTorrent**
  及其一句话理由。所有外部结论都带来源 URL 与核对日期（2026-10-12）。
  **P2's findings are written into the existing docs**: the macOS blocker is restated as
  "no trustworthy source" rather than "no binary", and FTP / SFTP / BitTorrent support is
  explicitly ruled out with reasons and dated sources.

### 已知折衷与明确不做 / Known trade-offs and explicit non-goals

- **面板交互（取消 / 重试）明确不做（D6-②）。** 卡点经查证真实存在：宿主客户端面
  （`@deepseek-ai/dsh-client-connection` 的 `ClientConnectionRpc`）只暴露 `call` 与 `open`，
  **没有任何「触发宿主动作」的 API**；handler 拿得到 `payload` 与 `peer`，拿不到 `execute()`
  栈帧里的 `AbortController`（进程内没有 `taskId → AbortController` 映射）；进度文件里也
  **没有** `url` / `output` / `sha256` —— 连「重试什么」都无法表达。因此本轮只做展示，
  **没有死按钮**：`src/client.js` 全文无 `onClick` / `<button>`。要做需先扩建 RPC 写端点
  与任务元数据持久化。
  **No panel buttons this round.** The blocker is real and verified against the host's own
  type definitions: there is no client-side API to trigger a host action, the handler cannot
  reach the `AbortController`, and the progress files do not record enough to retry anything.

- **后台常驻任务（路线 B）不做（D1=A）。** 队列只做「单次调用内批量、同步返回」，不动 DSH 的
  工具调用模型。跨进程 / 跨重启持久化、服务器端队列协议（aria2 RPC / `--input-file`）、
  断点续传的跨任务合并、把 `download_status` 改成可写工具，同样不做。
  **No background jobs (route B)**: the queue is in-call batching with a synchronous return.

- **下载中动态调并发不做（P1-3）。** 有实测证据：命令行方式不可能改（argv 启动即固定）；
  RPC 方式方向不对称 —— 上调 3/3 成功，**下调 2/2 失败**（`errorCode=1` "No URI available."、
  落盘缺字节）；而 32MB 上「先慢后快」反而比固定 x8 慢 2.2s，收益 ≤2.2s 却要付 5 类新增失败面。
  本轮改为做「记录实际吞吐与实际有效连接数」这件不需要 RPC 的事。
  **No mid-download concurrency adjustment**: measured evidence shows down-scaling fails and
  the upside does not justify the new failure surface.

- **macOS 随包 aria2 仍不做（D9=①）。** 唯一带哈希的候选过不了可信门槛（见上方 P2-1）。
  macOS 上插件照常安装并工作，只是永远走单线程 `curl`。
  **Still no bundled aria2 for macOS**; the plugin installs and works there over single-threaded curl.

### 验证 / Verification

- `pnpm test`：**445 例（443 通过 / 2 跳过 / 0 失败）**；规格基线为 343 / 341 / 2 / 0，
  即 **+102 条用例、fail 仍 0、skip 仍 2**（2 条 skip 是平台相关，只在 Linux 复现，由 CI 的
  Ubuntu job 真跑）。
- `pnpm check`（两个 tsconfig）exit 0。
- `pnpm build` exit 0；`dist/client.js` 与 `src/client.js` SHA256 相同。
- 测试弱化核查：`git diff -U0 -- test` 逐文件统计，10 条被删断言**全部**是「被更严格的断言
  替换」，无一条是为过测而删（其中 `runprocess.test.ts` 的 2 条从 `assert.match` 升级为
  `assert.equal` + 四条 `doesNotMatch`，是收紧）。
- **`pnpm test`: 445 tests (443 pass / 2 skip / 0 fail)**, `pnpm check` and `pnpm build`
  both exit 0, and every deleted assertion was replaced by a stricter one.

## [1.2.0] - 2026-10-12

围绕「照着官方文档把文件下对」这一件事：官方文档给了摘要就核对摘要，给了需要
Referer / UA 的地址就带上头，给的是原始 GitHub 地址就让插件自己找可用镜像。
同时修掉审查中发现的三处探测与回退缺陷。

This release is about downloading the right bytes from an official documentation page:
verify against the checksum the docs print, send the UA/Referer the docs' link needs,
and let the plugin pick a working mirror when the docs only give a raw GitHub URL.
Three probe/fallback defects found during review are fixed alongside.

### 新增 / Added

- **`sha256` 参数：按官方文档给出的摘要核对下载内容。** 接受裸十六进制、
  `sha256:<hex>` / `sha256=<hex>` / `SHA256(<hex>)` 前缀写法，以及 SRI 的
  `sha256-<base64>`；不合法会在**下载开始前**直接拒绝。校验通过时返回值带
  `sha256` 字段，失败则抛错并保留旁车指纹。它补上了长度校验挡不住的那一类
  ——「等长但内容不同」；而且**不依赖任何远端信息**，因此在「远端未声明长度」
  或「远端声明了压缩编码」导致长度校验跳过时，它依然能给出确定结论（此时
  不再报 `verifySkipped`，因为内容已经逐字节核对过了）。流式计算，不把大文件
  读进内存。逐条依据见下方「不做内容哈希校验」这条已知折衷的更新。
  **`sha256` parameter** verifying the downloaded bytes against the checksum printed
  in a project's official documentation; rejects a malformed digest before downloading,
  streams the file instead of buffering it, and works even where the byte-length check
  has to be skipped.

- **`userAgent` / `referer` / `headers` 参数：给官方文档里那些「直接 GET 拿不到」的地址
  带上请求头。** 三者合成**一份**头表，探测与下载共用 —— 两边不一致会让探测结论
  与真实下载错位（站点按 UA 分流时尤其明显）。`headers` 接受 `{"Name": "value"}` 映射，
  命名参数优先。插件自身管理的头（`Range` / `Accept-Encoding` / `Host` / 连接级头）
  一律拒绝覆盖；头值含 CR / LF / NUL 直接判为**请求头注入**并拒绝。
  **`userAgent` / `referer` / `headers`** feeding one shared header set to both the probe
  and the download; reserved transport headers are refused, and header values carrying
  CR/LF/NUL are rejected as header injection.

- **`mirror: "auto"`：内置镜像自动挑选。** 此前 `mirror` 只能由调用方手填，也就是
  说模型得先「知道」gh-proxy 这类域名。现在候选表内置（`RECOMMENDED_MIRRORS`，
  此前是死代码，只有测试引用），插件按顺序探测并采用第一个**被证实与原地址
  同源**的镜像。自动模式**必须显式传入**才会生效 —— 它会让下载内容经过第三方
  服务器，这是调用方该做的决定，不能默认开启；且只对 GitHub 域名生效。
  **`mirror: "auto"`** picking a built-in GitHub mirror that provably serves the same
  file; opt-in only, GitHub hosts only.

- **`DSH_SMARTDL_MIRRORS` 环境变量：覆盖内置候选镜像表。** 逗号分隔的前缀表，
  顺序即优先级。内置候选是三个公开第三方服务，企业内网 / 自建代理的场景下一个
  都用不了，此前除了手填 `mirror` 没有别的办法。
  **`DSH_SMARTDL_MIRRORS`** overriding the built-in mirror list (comma-separated,
  order = priority).

- 返回值新增三个字段：`sha256`（实际算出的摘要，仅在核对通过时出现）、
  `mirror`（实际使用的镜像前缀）、`mirrorSkipped`（请求了自动镜像但未启用时的
  说明）。`mirrorSkipped` 与 `verifySkipped` 同理：**静默失效是不允许的**。

### 修复 / Fixed

- **HEAD 抛异常时不再直接放弃探测。** 此前 HEAD 一旦超时 / 被墙 / 连接被重置就
  立刻返回「不支持多线程」，连带三件事一起发生：每次下载白等一整个探测超时、
  拿不到 `contentLength`（完整性校验永久退化成「跳过」）、再大的文件也永远走
  curl 单线程。而「HEAD 不通、GET 正常」在 CDN / 代理上很常见 —— 本机实测
  `raw.githubusercontent.com` 就是：`smart_download` 返回
  `via curl (fallback: HEAD 请求失败: The operation was aborted due to timeout)`
  且附带「未做字节数校验」。现在 HEAD 失败与「405 / 无 Content-Length」走同一条
  Range GET 兜底；两条路都失败才判不支持，且文案同时带上两者。
  **HEAD failures now fall through to the Range GET probe** instead of giving up.

- **HEAD 分支必须照读 `Content-Range`。** 此前该分支把 `contentRange` 写死成
  `null`，于是对「HEAD 回 206 + `Content-Range`」的服务器（合法，部分 CDN / 代理
  如此）会把 `Content-Length` 的**分片长度**当成总长度。后果有两层：决策层把大
  文件判成「太小」压成单线程；更要命的是完整性校验拿分片长度当期望值，一个
  **完全正确**的下载会在落盘后被判成损坏。现在与 Range GET 分支取值规则一致：
  `Content-Range` 优先。
  **The HEAD branch now reads `Content-Range`**, so a server answering HEAD with 206
  no longer makes a correct download fail its size check.

- **完整性校验失败不再回退 curl 重下。** aria2 分支的 `catch` 此前把校验失败也
  当成「aria2 失败」，于是会换 curl 把同一个地址重下一遍。产物已经落盘且内容
  不对，换下载器不会改变结果，只会让调用方白等一遍 —— 传了 `sha256` 时尤其
  明显（摘要不符是内容问题，不是传输问题）。现在校验失败以独立的
  `IntegrityError` 抛出，直接透出。
  **Integrity failures no longer trigger a pointless curl re-download.**

- **aria2 路径显式传入 `resume`。** 此前该调用漏传参数、走的是默认值 `true`，
  等于 `planResume()` 的结论对 aria2 完全不起作用。它至今没暴露成缺陷，只是因为
  「判定不能续传时必然先删掉本地半包」，于是 `-c` 恰好落在一个不存在的文件上
  —— 这是巧合，不是设计。
  **The aria2 call now receives `resume` explicitly.**

### 文档 / Docs

- README 新增「照着官方文档下载」一节：从官方文档取 URL / 摘要 / 需要哪些头，
  到 `smart_download` 参数怎么填，并给出可直接照抄的调用示例。
- README 的「权限说明」补上 `DSH_SMARTDL_MIRRORS` 与自定义请求头这两项；
  「已知折衷」里「不做内容哈希校验」一条更新为「调用方传 `sha256` 时做」。
- 基线更新：用例数 262 → **343**（341 通过 / 2 跳过 / 0 失败），行覆盖
  **99.74%** / 分支 **94.18%** / 函数 **96.99%**（同环境实测基线为
  99.81% / 92.53% / 96.09%）。

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
