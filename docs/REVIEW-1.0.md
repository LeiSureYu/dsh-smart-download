# 1.0 代码审查记录

这份文档记录 `1.0.0` 定稿前对 `src/` 与 `test/` 做的整体审查：查了什么、发现什么、
改了什么、哪些是明知不改的折衷。

面向两类读者：想确认「1.0 到底比 0.9 强在哪」的用户，以及要接着改这份代码的人。

审查的原则只有一条，和本项目其他文档一致：**任何「返回默认值 / 跳过 / 回落」的路径
都必须有正向断言**（断言回落到哪个**具体值**），不接受「没崩」「没报错」当作通过。
下面每条「必修」都先写一条会失败的用例，再改代码，最后用例转绿。

## 验证基线

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 产物类型检查 | `pnpm typecheck` | 退出码 0 |
| 测试类型检查 | `pnpm typecheck:test` | 退出码 0 |
| 测试 | `node --test --import tsx "test/**/*.test.ts"` | **254 例：252 通过 / 2 跳过 / 0 失败** |
| 覆盖率 | `node --test --import tsx --experimental-test-coverage "test/**/*.test.ts"` | 行 **99.81%** / 分支 **92.50%** / 函数 **96.09%**（须在 LF 工作区测量，见下） |

2 个跳过用例在 `test/runprocess.test.ts`，是平台限制而非缺测：

- 「`close` 事件的 signal 参数」只在 Linux 复现 —— Windows 上 `child.kill` /
  `process.kill` / `taskkill /F` / 子进程自杀四种杀法拿到的 `closeSignal` 恒为 `null`；
- 「子进程忽略终止信号」在 Windows 上构造不出来（`child.kill` 直接终止进程）。

两条都会在 CI 的 Ubuntu job 上真跑。本地 Windows 跑这个文件是 6 通过 / 2 跳过（全局 250 通过 / 2 跳过）。

### 分模块覆盖率

**前提：覆盖率数字必须在 LF 工作区测量。**

V8 的行归属建立在对源码的偏移量上。同一份代码，只把行尾从 LF 换成 CRLF，
报告出来的未覆盖行号会整体漂移（实测见下）。因此本节所有数字都取自
`.gitattributes` 归一后的 LF 工作区，并把命令写死在 [CONTRIBUTING.md](../CONTRIBUTING.md)
里作为唯一来源。

| 文件 | 行 | 分支 | 函数 | 未覆盖行号 |
| --- | --- | --- | --- | --- |
| `src/decision.ts` | 100.00 | 100.00 | 100.00 | — |
| `src/mirror.ts` | 100.00 | 100.00 | 100.00 | — |
| `src/verify.ts` | 100.00 | 100.00 | 100.00 | — |
| `src/index.ts` | 100.00 | 89.23 | 100.00 | — |
| `src/probe.ts` | 100.00 | 92.00 | 83.33 | — |
| `src/progress.ts` | 100.00 | 95.56 | 89.66 | — |
| `src/resume.ts` | 100.00 | 87.04 | 100.00 | — |
| `src/status.ts` | 100.00 | 92.65 | 100.00 | — |
| `src/downloader.ts` | 99.71 | 87.32 | 100.00 | 107 |
| `src/url.ts` | 99.38 | 91.43 | 100.00 | 69 |
| `src/rpc.ts` | 98.94 | 97.78 | 100.00 | 85-86 |
| `src/progress-parse.ts` | 98.41 | 88.89 | 100.00 | 28 |

#### 未覆盖的 4 行逐条核对

| 行 | 源码内容 | 为什么 V8 报它未覆盖 |
| --- | --- | --- |
| `src/downloader.ts:107` | `url: string,`（函数参数续行） | 不是独立语句。`buildAria2Args` 由插桩计数到 **9** 次调用 |
| `src/progress-parse.ts:28` | `*/`（块注释收尾） | 注释行。`splitIntoLines` 全量命中 **70** 次 |
| `src/rpc.ts:85-86` | `*/` + `function readPayload(...) {`（签名行） | 反例：`readPayload` 函数体首行 `:87` 命中 **20** 次、`:88` 命中 **1** 次 |
| `src/url.ts:69` | `}`（catch 块收尾括号） | 花括号不是可执行语句。`checkDownloadUrl` 内 `:64/:66` 各命中 **12** 次 |

四条都落在「注释 / 参数续行 / 花括号 / 函数签名」上，同一函数的可执行语句全部命中 ——
这是 tsx 转译后 V8 行归属的产物，不是未测试的代码。

#### 同一份代码，行尾一换，未覆盖行号整体漂移

把工作区原样复制一份、只把 30 个 `.ts` 文件的行尾改成 CRLF（内容一字不改），
同一套 254 例、同一命令：

| 文件 | LF 工作区 | CRLF 工作区 |
| --- | --- | --- |
| `all files` | 行 99.81 / 分支 92.50 | 行 99.65 / 分支 92.68 |
| `src/index.ts` | 100.00，未覆盖 — | 99.46，未覆盖 `110 121` |
| `src/downloader.ts` | 99.71，未覆盖 `107` | 100.00，未覆盖 — |
| `src/url.ts` | 99.38，未覆盖 `69` | 100.00，未覆盖 — |
| `src/rpc.ts` | 98.94，未覆盖 `85-86` | 99.47，未覆盖 `83` |
| `src/probe.ts` | 100.00，未覆盖 — | 98.85，未覆盖 `109-111` |

`index.ts` 的未覆盖行从「有」变「无」、`downloader.ts` 从「无」变「有」`107` ——
代码没有任何改动。**这就是为什么数字必须绑定工作区行尾来读，而不能跨行尾比较。**

#### 全库函数覆盖

函数覆盖 **96.09%**（V8 记录 128 条，命中 123 条）。用 Node 的 lcov 报告可以看到
未命中的 5 条记录全在 `src/probe.ts` 与 `src/progress.ts`：

```bash
node --test --import tsx --experimental-test-coverage --test-reporter=lcov "test/**/*.test.ts" > cov.lcov
# 未命中记录（FNDA:0）：
#   probe.ts     anonymous_10   anonymous_11
#   progress.ts  anonymous_18   anonymous_19   anonymous_21
```

把 esbuild 对这两个文件的转译结果与 V8 记录的偏移对齐后，这 5 个 `anonymous_N` 的
起始位置分别是 `progress.ts` 的函数参数注释、方法体结束大括号、方法前注释，以及
`probe.ts` 的调用实参行 —— 都不是独立的函数体，是 tsx 转译 + 行归属产生的伪条目。

需要说明的是：**函数维度只做了这样的偏移归因，没有像行覆盖那样做逐条语句插桩证明**。
行覆盖的 4 行有插桩命中数作证（见上表），函数这 5 条是依据偏移位置判断的。
要精确复核请按上面的命令重跑 lcov。

结论：行覆盖剩的 4 行是注释 / 参数续行 / 花括号 / 函数签名（同一函数内的可执行
语句全部命中），函数覆盖剩的 5 条记录落在非可执行偏移上；覆盖率数字本身随工作区
行尾变化，必须绑定 LF 工作区来读。

---

## 必修（1.0.0 已修）

每条都是先有可复现的现象，再改代码。

### 1. `mirror` 参数能整个绕过协议白名单 ⚠️ 可利用

`src/mirror.ts`

**现象（真实 curl 复现）**：

```powershell
cd $env:TEMP\dsh-mirror-proof
curl --progress-bar -L -o stolen.txt --fail --show-error "file:///C:/Windows/win.ini?x=http://example.com/a.bin"
# curl exit=0；stolen.txt = 92 字节，首行 "; for 16-bit app support"
```

**根因**：`src/index.ts` 只对 `args.url` 做 `checkDownloadUrl`，随后 `mirror` 原样进
`applyMirror` 做**字符串拼接**。拼接后整串的 scheme 由**前缀**决定，后半个 http 地址
退化成 query：

```
applyMirror('http://example.com/a.bin', 'file:///C:/Windows/win.ini?x=')
  -> 'file:///C:/Windows/win.ini?x=/http://example.com/a.bin'
new URL(...).href === 上面同一串（合法的 file: URL）
```

这和 `0.4.2` 修掉的「缺少协议白名单」是同一个缺陷形态，只是入口从 `url` 换成了 `mirror`。
`javascript://alert(1)//`、`data://...` 同样能过。

**改法**：`applyMirror` 在拼接前先判前缀本身是不是 http(s)，不是就不生效、原样返回
原始 URL（正向断言到具体值 `SAMPLE_URL`）。

**回归用例**：`test/mirror.test.ts` 的
「`applyMirror: 镜像前缀不是 http(s) -> 不生效，原样返回（防白名单绕过）`」
与「`normalizeMirror: 非 http(s) scheme 原样保留，交由 applyMirror 拒绝`」。

> 这层边界同时写进了 [SECURITY.md](./SECURITY.md)（第一层：协议白名单的延伸）。

### 2. `awaitFlush` 超时计时器不 unref，CLI 每次下载多卡约 2 秒

`src/progress.ts`

**现象（实测）**：

```powershell
node --input-type=module -e "
import { setTimeout as delay } from 'node:timers/promises'
const t0 = Date.now()
const TIMEOUT = Symbol('t')
const winner = await Promise.race([Promise.resolve(), delay(2000).then(() => TIMEOUT)])
console.log('race resolved in', Date.now() - t0, 'ms, winner is timeout?', winner === TIMEOUT)
process.on('exit', () => console.log('process exit after', Date.now() - t0, 'ms'))"
# 修复前：race resolved in 0 ms, winner is timeout? false
#         process exit after 2003 ms
# 修复后（改用原生 setTimeout + unref）：process exit after 6 ms
```

**根因**：`node:timers/promises` 的 `setTimeout` **不会 unref**（实测
`process.getActiveResourcesInfo().filter(t => t === 'Timeout').length` 由 `0` 变 `1`，
原生 `setTimeout(...).unref()` 则为 `0`）。`awaitFlush` 用它做超时哨兵，`Promise.race`
是立刻返回了，但那个没到点的计时器还挂在事件循环上。

**改法**：删掉 `node:timers/promises` 依赖，新增 `timeoutAfter(ms)` 返回
`{ promise, cancel }`，用原生 `setTimeout` + `unref()`；`awaitFlush` 用哨兵对象识别
是否超时，`finally` 里无条件 `cancel()`。

**回归用例**：`test/progress.test.ts` 的
「`awaitFlush` 返回后不残留 Timeout 句柄（超时计时器已清理）`」——
断言调用前后 `getActiveResourcesInfo()` 里 `'Timeout'` 的数量相等。

### 3. `awaitFlush` 超时是静默的

`src/progress.ts`

**现象**：0.9.0 里 `awaitFlush` 超时后直接 return，没有日志也没有异常。用户侧只表现为
「面板卡在旧的进度」，排查不到原因 —— 又一个静默失败。

**改法**：超时（哨兵胜出）时 `process.emitWarning`，带上任务 ID 与
`code: 'DSH_SMARTDL_PROGRESS_FLUSH_TIMEOUT'`。仍然不阻断调用（磁盘满时让工具调用挂死更糟），
但留下可搜索的线索。

### 4. 「校验跳过」与「校验通过」在返回值上无法区分

`src/verify.ts`、`src/index.ts`、`src/types.ts`

**现象**：0.9.0 的 `verifySize` 在「远端未声明长度」和「服务器返回压缩编码」两种情形下
都返回 `{ kind: 'ok' }`，与「真的比过字节数且一致」完全同形。调用方无从区分，
用户看到的是一次「成功」，但这次下载其实没有做任何完整性校验。

**改法**：

- `VerifyOutcome` 拆出独立的 `{ kind: 'skipped'; reason; encoding? }`；
- 新增 `VerifySkipReason = 'remote-length-unknown' | 'content-encoded'`；
- 新增固定文案常量 `VERIFY_SKIP_LENGTH_UNKNOWN` / `VERIFY_SKIP_CONTENT_ENCODED`
  与 `describeSkip()`（定成常量而非就地拼串，使「跳过路径只能输出这两个值」成为可断言事实）；
- `SmartDownloadResult` 新增 `verifySkipped?: string`，与 `reason` 并存（合并字段必然有一方被顶掉）；
- 跳过时 `reporter.done('下载完成（' + note + '）')`，并写进工具返回与 render 文案。

**回归用例**：`test/verify.test.ts` 对两种跳过各断言 `reason` 字面量与 `describeSkip` 文案；
`test/tool-schema.test.ts` 断言 render 文案里带上 `verifySkipped`。

### 5. 取消（`cancelled`）状态在生产代码里不可达

`src/index.ts`

**现象**：`ProgressReporter.cancel()` 在 `src/` 里**零调用**，而测试、TROUBLESHOOTING、
`client.js` 都在处理 `cancelled` 状态。也就是说：用户按下取消，面板上看到的是
「失败」，而不是「已取消」——明明是他自己的操作。

**改法**：三处 catch（aria2 路径、curl 回退路径、curl 主路径）改成
「`exec.signal.aborted` → `reporter.cancel()`，否则 `reporter.fail(...)`」。
顺带修掉一个连带问题：aria2 失败后如果 signal 已 abort，不再徒劳地回退多跑一趟 curl。

`client.js` 侧的 `cancelled` 渲染此前已就位，现在终于有生产者。

### 6. aria2 失败回退 curl 时，进度文案写的是 aria2 的错误

`src/index.ts`

**现象**：curl 也失败时，`reporter.fail(aria2Message)` 用的是 aria2 的原因，抛出的却是
`curlErr`。进度里写着 aria2 的错，异常里是 curl 的错，排查时对不上。

**改法**：`reporter.fail(curlMessage)`。aria2 的原因已经作为 `reason`（`aria2 失败: ...`）
进了返回结果，两条信息各自归位。

### 7. `SIGKILL` 兜底只在 Windows 生效

`src/downloader.ts` (`runProcess`)

**现象**：取消路径的前置条件是 `if (process.platform === 'win32')`。但「忽略 `SIGTERM`」
不分平台 —— POSIX 进程同样可以装一个 `SIGTERM` handler 然后继续跑。一旦如此，
取消下载永远等不到 `close` 事件，`smart_download` 会**永久挂住**。

**改法**：去掉平台判断，所有平台都挂 1s 兜底（计时器已 `unref`，无泄漏）。

### 8. HEAD 探测的响应体未取消

`src/probe.ts`

**现象**：HEAD 分支不消费响应体也不取消。Node 的 undici 对没有 body 的 HEAD 会给出
`null`，但现实里有服务器/代理在 HEAD 上返回 body —— 不取消就一直占着这条连接。
下面的 Range GET 分支有取消，两条分支不一致。

**改法**：`head.body?.cancel().catch(() => {})`。

### 9. `MAX_STATUS_LIMIT` 硬编码在两个文件里

`src/status.ts`、`src/rpc.ts`

**现象**：默认值 `DEFAULT_STATUS_LIMIT` 在 `status.ts`，而「夹到 50」硬编码在
`rpc.ts` 的 `readPayload` 里；`readDownloadStatus` 自己又不夹。改一个忘一个就会出现
「RPC 认为上限 50、工具认为没有上限」的偏差。

**改法**：`status.ts` 新增 `MAX_STATUS_LIMIT = 50`，两个调用方共用；两边都改成
`Math.min(MAX_STATUS_LIMIT, Math.floor(limit))`。

---

## 建议（本轮不改，留作后续）

### [P2] 续传判定后进度百分比被重置为 0

`src/index.ts:165-167`

`planResume` 判定「无法证实同源、删掉本地半包全量重下」时，调用
`reporter.report(0, resumePlan.reason)`。行为是对的（确实要从 0 重下），但如果用户之前
已经下到 80%，面板会从 80% 突然跳回 0%。加一个「已重下 x%」的过渡文案会更好，
不改也不影响正确性。

### [P2] `DSH_PROGRESS_DIR` / `DSH_DOWNLOAD_PROGRESS_DIR` 未做路径校验

`src/progress.ts:100`、`src/progress.ts:119-121`

两个环境变量被直接当目录用，没有校验合法性。若被设成非法路径（如指向一个文件），
`ensureDir` 失败返回 `null`，于是**静默不写**该轨道 —— 与「不静默」的红线有张力。
考虑到这属于「环境配置错误」而非「运行时数据异常」，本轮按现状保留：读文档即可发现，
且强行改成抛错会让一个可用的下载因为无关的进度目录配置而失败。建议后续在
`download_status` 返回里带上「哪条轨道不可用」的说明。

### [P3] `readLastJsonlLine` 可能「状态旧、时间新」

`src/status.ts:84-105`

从后往前找第一条可解析的行。若最后一行是半截（正在追加），会退回到旧记录；而 `updatedAt`
取的是**文件 mtime**，于是出现「状态是旧的，时间是新的」。极端情况下 RPC 返回的任务
看起来比实际更新。影响有限（只影响显示的时间戳），本轮保留并记录。

### [P3] `reason` 文案不保证稳定

`decide()` 的 `reason` 直接进用户可见返回，含中文与平台串（如
`未找到 aria2 二进制（当前平台 darwin-arm64 不受支持或子包未安装）`）。程序化判断必须用
`success` / `method` / `fellback` / `verifySkipped`，不要匹配 `reason` 字符串。
已在 ARCHITECTURE.md 与源码注释里写明，作为设计而非缺陷保留。

### [P3] `src/client.js` 无单测

365 行的浏览器端面板（classic script，依赖 `window.__ModuleLoader__`）在 Node 侧无法直接
加载。`POLL_INTERVAL_MS = 2000`、`FINISHED_HOLD_MS = 30000`、`STALE_RUNNING_MS = 10min`、
`STATUS_LIMIT = 5` 这些常量只靠人工核对。要补测需要先给宿主 loader 做一个最小桩，
工作量大、收益有限，本轮不做。

### [P3] `getAria2Path()` 用 `createRequire(...).resolve()`

`src/downloader.ts`。依赖 `node_modules` 的解析结果（本机实测能解析到
`node_modules/.pnpm/@leisureyu+dsh-aria2-win32-x64@1.37.0/node_modules/@leisureyu/dsh-aria2-win32-x64/bin/aria2c.exe`）。
若宿主用非常规的安装布局（如 PnP），解析会失败并回退 curl。失败是**显式**的
（`reason` 写明原因），不是静默，因此可接受。

---

## 已知折衷

这些是**有意保留**的，不是待办。

| 折衷 | 原因 |
| --- | --- |
| macOS 不支持多线程 | 没有可核对哈希的 aria2 二进制来源，如实搁置而非硬做。详见 [COMPATIBILITY.md](./COMPATIBILITY.md) |
| `peerDependencies` 硬编码 DSH 预发布分支 | DSH 只发预发布版，npm 常规范围解析不到；DSH 每开一个新分支就要同步追加一段 `\|\|` |
| 不做内容哈希校验 | 远端不保证提供摘要。长度校验挡得住截断，挡不住「等长但内容不同」的恶意替换 —— 已在 SECURITY.md 的「已知边界」写明 |
| 进度目录不可写时静默跳过 | 进度是附属功能，不该因为进度写不进去就让下载失败 |
| 镜像内容不做忠实性验证 | 插件无法验证第三方镜像的返回。这正是落盘字节数校验存在的原因之一 |

---

## 附：复现命令

```powershell
cd work\dsh-smart-download

# 全量验证（三条都必须过）
npx tsc --noEmit
npx tsc -p tsconfig.test.json
node --test --import tsx "test/**/*.test.ts"

# 覆盖率
node --test --import tsx --experimental-test-coverage "test/**/*.test.ts"

# 单独验证 mirror 白名单修复
node --import tsx -e "import { applyMirror } from './src/mirror.ts'; console.log(applyMirror('http://example.com/a.bin','file:///C:/Windows/win.ini?x='))"
# 期望输出：http://example.com/a.bin（原样返回，不拼接）
```
