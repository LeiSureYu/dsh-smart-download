# P0 累计改动独立审查 · Round 2（t5 + t6 + t7，含 t14/t16 修复后复验）

> 审查者：verify-a（未参与 t5 / t6 / t7 / t14 / t16 中任何一项的实现；
> `docs/ROADMAP-1.3.md` 与 `docs/VERIFY-P0.md` 是我写的，因此本报告按**证伪**组织，
> 每条结论都附可复现命令或真实输出）
> 审查对象：t5（P0-1/2/3）、t6（P0-5/6 + 总带宽上限 + 后来的 timeoutMs）、t7（P0-4 + D7-② + D6-②），
> 以及 t14（repair round 2）与 t16（P0 收尾）对它们的修改
> 权威规格：`docs/ROADMAP-1.3.md` §1.3（验收标准）、§4（「不做」清单）、§5（已拍板决策 D1=A / D4=② / D6=② / D7-② / D5③）
> 结论：**pass** —— 四类重点问题全部有依据地通过；t8 发现的 P0V-01 与 P0V-02 均已修复并有实证；
> 另发现 **3 条 low**（不阻塞合并，逐条写明为什么判 low）。

---

## 1. 审查范围、方式与快照

### 1.1 读过的文件（逐行，不是 grep 命中即算）

| 类别 | 文件 |
| --- | --- |
| 规格 | `docs/ROADMAP-1.3.md` §1.3 / §4 / §5、`README.md`（契约表 524–551、批量章节 354–411、权限说明 557–567、面板章节） |
| t5 | `src/downloader.ts`（退出码段 + `runProcess` 全文）、`src/status.ts`（全文 321 行）、`src/verify.ts`、`src/hash.ts`、`src/index.ts`（`scanDiagnostic` / `download_status`） |
| t6 | `src/index.ts`（全文 1113 行，`downloadOne` / `runBatch` / `batchWindow` / `parseTimeoutMs` / `finishAborted`）、`src/types.ts`、`src/progress.ts`（写入段） |
| t7 | `src/client.js`（全文 459 行）、`src/rpc.ts`（全文 295 行）、`src/cleanup.ts`（全文 307 行） |
| 宿主 | `@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`（**全文 231 行**，`ClientConnectionRpc` / `HostConnectionHandle` / `ConnectionFetchRoute`） |
| 测试 | `test/execute.test.ts`（44 个 test 标题全过）、`test/tool-schema.test.ts`、`test/rpc.test.ts`、`test/runprocess.test.ts`、`test/client.test.ts`、`test/status.test.ts` |

### 1.2 跑过的命令（全部只读或仅产出本文档）

```powershell
cd C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download
pnpm check                    # exit 0
pnpm test                     # 433 tests / 431 pass / 0 fail / 2 skipped
pnpm build                    # exit 0
git diff -U0 -- test | Select-String '^-\s*assert\.'   # 逐文件统计被删断言
Get-FileHash src\client.js,dist\client.js              # 哈希比对
# 另有三份自建探针（写在仓库外 Temp 目录，未留残余）
```

**探针说明**：我另外写了三份独立探针（`r2.mts` / `r2b.mts` / `r2c.mts`，全部在
`C:\Users\Qing\AppData\Local\Temp\verify-p0-probe\`，**不在仓库内**），用真实本地 http server
驱动 `smart_download.execute()`，实测下列行为：timeoutMs 三态分类、批内窗口宽度、
取消与超时同时发生时的优先级、超时条目在两条轨道上的终态、单条目返回字段集合、
老进度文件解析、带宽均分墙钟。**没有**接受实现者的一面之词。

### 1.3 冻结快照（本文结论对这个快照成立）

审查期间工作区**仍在动**：t18 在 10:32:41/10:32:47 改过 `src/types.ts` 与 `src/index.ts`
（把 `timeoutMs` 类型并回 `SmartDownloadArgs`），t19 于 10:41 重建 `dist/`；
**另有并行的 P1-2 任务在 10:47–10:49 改了 `src/decision.ts`、`src/throughput-cache.ts`（新）、
`test/decision.test.ts` 与整个 `dist/`** —— `src/decision.ts` 正是 `batchWindow` 的档位来源，
所以我在写完初稿后**又重跑了一遍探针与全量测试**确认结论未漂移（见本节末）。

因此本文以 **10:51 之后的当前状态**为准，并另行核对了 dist 与 src 的同步性（§3.3）。

**对并行改动的复验（追加）**：P1-2 把 `decideConcurrency()` 里的字面量 `8` 提成
`export const MAX_CONCURRENCY = 8`，并新增了历史抬档入参。
`decideConcurrency(LARGE_FILE)` 仍返回 **8**，因此：

- `batchWindow(decideConcurrency(LARGE_FILE))` 仍为 **2**（`budget = 8 × 2 = 16`，`16 ÷ 8 = 2`）；
- 探针复测 12 条目慢响应：`peakConcurrent = 2`、`elapsedMs = 2135`、`succeeded = 12`；
- timeoutMs 三态分类、单条目返回字段集合、老进度文件解析**全部不变**（复测通过）；
- `pnpm check` exit 0；`pnpm test` **445 / 443 / 0 / 2**（P1-2 又加了用例，fail 仍 0、skip 仍 2）。

**本文所有 P0 结论在 P1-2 落地后依然成立。**

---

## 2. 四类重点问题逐项结论

### 2.1 ① 静默失败 —— **通过**（有依据，不是「未发现问题」）

我把 README 契约表（`README.md:524-551`）逐行读过，再把 P0 新增的每一条
「可能返回默认值」的路径列出来，逐条核对它**有没有正向断言**、**有没有回告**：

| 新增路径 | 默认值 / 退化形态 | 是否有正向断言 | 是否回告调用方 |
| --- | --- | --- | --- |
| `describeExitCode` 未知退出码 | 原样保留退出码 + stderr | ✅ `test/runprocess.test.ts:236-249`（未知码不丢信息、不编造下一步） | ✅ 退出码与 stderr 都在文案里 |
| `verifySize` 两种 skipped | `remote-length-unknown` / `content-encoded` | ✅ 既有 + `test/execute.test.ts:582`（gzip 场景） | ✅ `verifySkipped` 字段 + `describeSkip` 固定文案 |
| `readDownloadStatus` 目录读不到 | 空列表 | ✅ `test/status.test.ts:301-394` | ✅ `scanFailedDirs` + `scanDiagnostic` 渲染进模型可见回执，两个目录都失败时**否定**「空列表」结论 |
| 批量单条失败 | 只影响那一条 | ✅ `test/execute.test.ts:1274-1310` | ✅ `[failed] <url>: <原因>` 逐条进 `renderBatch` |
| 批量取消 vs 失败 | 混成一个状态 | ✅ `test/execute.test.ts:1312-1359` | ✅ `failed` 与 `cancelled` 分开计数，未开工条目各留一条取消记录 |
| `maxBandwidth` 非法值 | 被子进程静默忽略 | ✅ `test/execute.test.ts:1118`（断言服务器 hits===0） | ✅ 发起任何请求之前抛错 |
| `timeoutMs` 非法值 | 同上 | ✅ `test/execute.test.ts:1472` | ✅ 同上 |
| `resolveTargets` 二选一 / 空数组 / 超 50 | 静默取一边 / 静默截断 | ✅ `test/execute.test.ts:1087-1117` | ✅ 三条拒绝路径都在发请求之前，文案点明上限 |
| `cleanupHistory` 参数越界 | 静默夹到边界 | ✅ `test/rpc.test.ts`（t14 补，断言**一个文件都没删**） | ✅ `ok:false` + 文案点名字段与范围 |
| cleanup 扫不到轨道一 | 安静地只扫轨道二 | ✅ `test/rpc.test.ts`（t14 补，不设 `DSH_PROGRESS_DIR` 的用例） | ✅ `taskDir === ''` + `taskDirSkipped` 固定文案说明原因与解法 |
| 单条目超时 | 卡住整批不返回 | ✅ `test/execute.test.ts:1508`、`:1578` | ✅ 该条记 `failed` 并带超时文案；其余条目继续 |

**我用探针实证过的三条最易错的**：

1. **超时 ≠ 取消**：批量 3 条（1 慢 2 快）+ `timeoutMs:2000` →
   `{ succeeded: 2, failed: 1, cancelled: 0 }`，慢条 `error` 为
   `下载超时：2000ms 内没有完成（已终止这一条；半包与旁车指纹保留，重跑会先核对同源再续传）`，
   且**没有** `cancelled: true`。两条轨道终态分别是 `status:'failed'` / `state:'failed'`
   （实测，见探针 `r2c`）。
2. **用户取消优先于超时**：`timeoutMs:5000` 但用户在 300ms 时 abort →
   `cancelled: true`、`error: 下载已取消：curl 被 AbortSignal 终止`、`failed: 0`。
   `abortOutcome()` 的判定顺序（先 `ctx.exec.signal.aborted`）经实测成立。
3. **超时不塌窗**：1 慢 + 5 快 + `timeoutMs:2000` → `{ succeeded: 5, failed: 1, cancelled: 0 }`，
   5 条快的全部成功。超时只终止它自己那一条。

**一条必须点名的既有测试债（低，不阻塞）**：README 契约表至今**没有**为上述新增路径补行
（表里仍是 1.2.0 的那 20 行）。这张表在本仓库被当作硬约定
（`README.md:555`：「如果未来发现某条返回默认值的路径没有被正向信号断言覆盖，那是一个 bug」），
而 P0 新增了 11 条这样的路径却一行未加。**测试是全覆盖的**（上表左列全是 ✅），
所以这只是**文档滞后**而非防护缺失 —— 因此判 low 而非 blocker。详见 §4 F-01。

### 2.2 ② 测试是否被弱化 —— **没有**（通过）

逐文件统计（`git diff -U0 -- test`，只数 `assert.` 开头行）：

| 文件 | 删除 `assert.` | 新增 `assert.` | 删除 skip | 新增 skip |
| --- | --- | --- | --- | --- |
| `test/downloader.test.ts` | 0 | 33 | 0 | 1 |
| `test/runprocess.test.ts` | 2 | 43 | 0 | 0 |
| `test/status.test.ts` | 1 | 34 | 0 | 0 |
| `test/progress.test.ts` | 0 | 6 | 0 | 0 |
| `test/verify.test.ts` | 0 | 4 | 0 | 0 |
| `test/tool-schema.test.ts` | 1 | 56 | 0 | 0 |
| `test/execute.test.ts` | 0 | 128 | 0 | 0 |
| `test/rpc.test.ts` | 6 | 44 | 0 | 0 |
| `test/client.test.ts` | 0 | 0（t13 已把 11 条 skip 恢复成真跑） | 0 | 0 |

**10 条被删的断言，逐条核对都是「被更严格的断言替换」**，没有一条是「为了过测而删」：

- `status.test.ts` 的 `assert.equal(snap.ok, true)` → 换成 `ok === false` + `scanFailedDirs` 逐路径 deepEqual（语义收紧，不是放宽）。
- `tool-schema.test.ts` 的 `assert.deepEqual(params.required, ['url'])` → 换成 `required === undefined` **加一条结构性断言**（根节点键集严格 `['properties','type']`、无 `required`、无 `oneOf`）+ 一条专门用例证明 DSL 会把根级 `oneOf` 编译成名叫 `oneOf` 的入参属性。这条替换本身是 P0R-01 的修法，理由与证据都在代码注释里。
- `rpc.test.ts` 的 6 条「恰好注册 1 条路由」→ 「恰好注册 2 条，路径 / 方法 / requestBody 各自正确」。这是功能增加（cleanup 端点），不是放宽。
- `runprocess.test.ts` 的 2 条 `assert.match(err.message, /下载已取消/)` + `/AbortSignal/` →
  换成 `assert.equal(err.message, '下载已取消：node 被 AbortSignal 终止')` **加四条 `doesNotMatch`**
  （`/node_modules/i`、`/[A-Za-z]:[\\/]/`、`/[\\/]/`）。这是 t8 发现 P0V-01 之后补的**收紧**，
  把「不变量」从「包含某几个词」升级成「等于整句且不含任何路径分隔符」。

**唯一新增的 skip**（`test/downloader.test.ts`）是 `本机无 aria2 子包就跳过 aria2 取消文案用例`，
与 `execute.test.ts` 的既有做法一致，且本机装了子包所以不会触发。这不是弱化。

**正向性**：新增用例全是「检查有没有真的产出」，没有一条是「不抛错就行」。
带宽与超时的非法值用例断言服务器 `hits === 0`；并发用例断言 `maxActive === 2` **且**
`expectedWindow * perItemTier === perItemTier * 2`（既测实现也测推导规则）；
清理越界用例预先摆好过期文件再断言**一个都没删**。

**用例数**：初验时 433 / 431 / 0 / 2（规格基线 343 / 341 / 2 / 0 → **+90 条，fail 仍 0，skip 仍 2**）；
P1-2 并行落地后复测为 **445 / 443 / 0 / 2**（fail 仍 0、skip 仍 2）。

### 2.3 ③ 契约破坏 —— **除一条低风险项外全部向后兼容**（通过）

| 契约 | 结论 | 依据（实测或逐字段核对） |
| --- | --- | --- |
| 单条目返回结构 | ✅ | 我实测两次（带 / 不带 `timeoutMs`）：键集合**恰为** `['fellback','method','mirrored','path','reason','requestedUrl','size','success']`，无 `batch` / `results`；无 Content-Length 时 `size` 键不出现 |
| 单条目 render 文案 | ✅ | `src/index.ts:303-317` 分支一逐字保留；`test/tool-schema.test.ts:140-231` 逐条 `assert.equal`（含「无 reason 时不得拼出空括号」） |
| 现有 7 个参数 | ✅ | 全部保留；新增 `targets` / `maxBandwidth` / `timeoutMs` 三个；`headers` 仍是 `additionalProperties: true`；`test/tool-schema.test.ts:65-78` 逐名断言 |
| 老进度文件（无 `batch`） | ✅ | 我手写无 `batch` 的 `.jsonl` 与 `.json` 实测：`batch` 收敛成 `''`，`name`/`pct`/`msg`/`status`/`spd`/`eta` 全部正常解析；`download_status` 键集合仍恰为 5 个、`scanFailedDirs` 不出现 |
| output schema 两形态 | ✅ | `oneOf` 分支一 `additionalProperties: false`，`test/execute.test.ts` 用宿主自己的 `validateJsonSchemaValue` 跑真实返回值 |
| 缺省命令行 | ✅ | `maxBandwidth` / `timeoutMs` 缺省时 `buildAria2Args` / `buildCurlArgs` 不追加开关（`test/downloader.test.ts` 有 deepEqual 基准）；`decide()` 未改 |
| 取消 vs 失败的状态语义 | ✅ | 实测两态分离（§2.1） |
| `ProgressReporter.cleanup()` 仍是显式接口 | ✅ | `src/progress.ts` 在 P0 全程未被改（我核对了 mtime 与内容） |

**一条低风险项（F-02，见 §4）**：`timeoutMs` 在**单条目**路径上也生效。这是 t16 按用户新决策加的，
但它使「单条目路径与 1.2.0 逐字段相同」多了一层前提 —— **只在调用方显式传 `timeoutMs` 时**行为不同
（1.2.0 没有这个参数，所以不存在「回归」，只有「新参数改变了新路径」）。
我实测确认：不传时返回结构与 1.2.0 一致；传了但没超时时返回结构**也一致**（键集合不变），
只有真的超时才抛错。因此这是**新参数的预期行为**，不构成契约破坏，但值得在报告里写明。

### 2.4 ④ 功能蔓延 —— **没有越界**（通过）

**跨调用状态（captain 明确禁止的那条）**：

我把 `src/index.ts` 与 `src/progress.ts` 的模块级声明全过了一遍：

- `src/index.ts` 顶层只有 9 个 `const`（`BATCH_LABEL_*` × 3、`MAX_BATCH_TARGETS`、
  `BOTH_URL_AND_TARGETS`、`NEITHER_URL_NOR_TARGETS`、`BATCH_CANCELLED`、`MIN_TIMEOUT_MS`、
  `MAX_TIMEOUT_MS`）—— **全是字面量常量**。
- `src/index.ts` 与 `src/progress.ts` 里 **`^let` / `^var` / `setInterval` / `setTimeout(` /
  `new Map(` / `new Set(` / `globalThis` 全部零命中**（模块级）。
- 带宽均分是纯局部计算：`perItem = maxBandwidthBytes / workers`，`workers = min(limit, targets.length)`
  （`src/index.ts:358-366`），`maxBandwidthBytes` 来自本次 `args`。**没有任何模块级可变状态、
  没有缓存、没有定时器、没有注册表。**

**对照 `docs/ROADMAP-1.3.md` §4.1「不做」清单逐条核实**：

| 不做项 | 是否越界 | 依据 |
| --- | --- | --- |
| 后台常驻任务（路线 B） | ❌ 未做 | 无 `ctx.jobs` 调用；`grep 'ctx.jobs|jobs.start|fire-and-forget'` 零命中；`timeoutMs` 的 README 说明明写「那个形态明确不做」 |
| 跨进程 / 跨重启持久化 | ❌ 未做 | 无持久化队列代码 |
| 服务器端队列协议（aria2 RPC / `--input-file`） | ❌ 未做 | `src/downloader.ts` 仍是「一个文件一个子进程」 |
| 断点续传跨任务合并 | ❌ 未做 | `src/resume.ts` 未改 |
| 面板拖拽排序 / 队列重排 UI | ❌ 未做 | `src/client.js` 无任何交互元素 |
| 把 `download_status` 改成可写工具 | ❌ 未做 | `src/index.ts:383-455` 仍纯只读 |
| 面板按钮（取消 / 重试） | ❌ 未做 | 见 §2.5 |
| 面板交互式折叠 / 滚动 | ⚠️ 做了 `maxHeight:260 + overflowY:auto` | 这是 P0-4 验收标准 1（`STATUS_LIMIT` 5→50）的**必要配套**，不是新增交互 |
| 29 条错误文案全量重写 | ❌ 未做 | 只动 D1 / E 类 / G1 三处 |

**新增的 `timeoutMs` 是否越界**：它是 t16 按**用户新决策**加的（不是契约外自发添加），
README 已按「单条目超时 + 为什么路线 A 需要它」完整记载，且非法值在发请求前拒绝、
超时不回退 curl、已完成条目不被改判 —— 全部有实测与断言。**不判越界。**

---

## 3. 三项专项复验

### 3.1 t8 的 P0V-01（取消文案泄漏绝对路径）—— **已修复，实证**

我当时的发现：`src/downloader.ts` 两处取消分支插值原始 `command`，aria2 取消时用户可见文案
出现完整 node_modules 绝对路径。

**本轮复验（读代码 + 跑探针，双管）**：

- `src/downloader.ts:411`（`child.on('error')`）与 `:424`（`child.on('close')`）
  现在都是 `` reject(new Error(`下载已取消：${executableName(command)} 被 AbortSignal 终止`)) ``，
  并在 `:409-410` 留下注释说明这条不变量。
- **探针实测**：aria2 下载挂住后 abort → `error` 为
  `下载已取消：aria2c 被 AbortSignal 终止`（**无任何路径**）；curl 路径同样干净。
- **测试已补齐**：`test/runprocess.test.ts` 新增「运行中 abort 的文案只含可执行文件名」
  与「预先 abort 且命令不存在」两条，各带 4 条 `doesNotMatch`（`/node_modules/i`、
  `/[A-Za-z]:[\\/]/`、`/[\\/]/`、`/.exe/i`），其中一条**故意用形状与随包 aria2 完全一致的
  绝对路径**当命令，注释写明「将来若改成用解析出来的绝对路径启动 curl，这条用例就是拦住泄漏的那一道」。
- `test/downloader.test.ts` 另有一条「取消文案（aria2 路径）：随包 aria2 的绝对路径收敛成 aria2c」。

**判定：P0V-01 关闭。** 而且补的测试比我建议的更强（我原话说「修法两行」，
实现者连「将来换启动方式」的那道防线也一起埋了）。

### 3.2 t8 的 P0V-02（README 零记载批量功能）—— **已修复**

`README.md:354-411` 新增整节「一次下载多个文件：`targets` / `maxBandwidth` / `timeoutMs`」，
含 JSON 示例、二选一与上限、逐条结果与部分成功、批内并发的推导规则、`maxBandwidth` 均分语义、
`timeoutMs` 的四条定义（记 failed 不是 cancelled / 其余条目继续 / 已完成不改判 / 不回退 curl）。
`README.en.md`（t17）已同步同等深度。**判定：P0V-02 关闭。**

### 3.3 dist 与源码的同步性 —— **同步**

t18 改完 `src/` 后 dist 曾落后 9–14 秒（t19 已修）。我本轮独立核对：

- `pnpm build` exit 0；`dist/index.js` 含 `batchWindow`（3 处）、`timeoutMs`（9 处）、`targets`（34 处）。
- `dist/downloader.js:317` 与 `:329` 两处取消分支均用 `executableName(command)`。
- `dist/client.js` 与 `src/client.js` **SHA256 相同**（`8273210FA1BE…`）。
- `dist/types.d.ts:65` 含 `timeoutMs?: number`。
- 别名 `SmartDownloadArgsWithTimeout` 在 `dist/*.js`、`dist/*.d.ts`、`src/*.ts` 中**零命中**。
- dist 与 src 全部 **LF、无 BOM**（逐字节扫描）。
- `dist/client.js` 的 mtime（07:57:44）早于部分 src 文件，但那是**正常的**：
  `src/client.js` 自 t7 之后就没再被改过，内容哈希一致即同步。

---

## 4. Findings 清单（3 条 low，不阻塞合并）

| id | file | line | severity | problem | requiredFix |
| --- | --- | --- | --- | --- | --- |
| **P0R2-01** | `README.md` | 524–551（契约表） | **low** | P0 新增了 11 条「返回默认值」的路径（`describeExitCode` 未知码、批量逐条失败、取消 vs 失败、`maxBandwidth` / `timeoutMs` 非法值、`resolveTargets` 三条拒绝、cleanup 参数越界、cleanup 扫不到轨道一、单条目超时），**契约表一行未加**。这张表在本仓库是硬约定（`:555` 明写「没有被正向信号断言覆盖就是一个 bug」），而测试其实是全覆盖的（§2.1 左列全 ✅）—— 所以这是**文档滞后**，不是防护缺失 | 给这 11 条各补一行（环节 / 静默失败形态 / 必须断言的正向信号）。不阻塞合并，但表与实现的缺口拖得越久越容易被误读成「这些路径没有约定」 |
| **P0R2-02** | `src/index.ts` | 334–351（`shared` 含 `timeoutMs`） | **low** | `timeoutMs` 通过 `shared` 同时作用于单条目与批量。README 与参数说明都按「单条目超时」记载，行为也正确（实测：不传时与 1.2.0 逐字段相同；传了未超时键集合也不变），但「单条目路径与 1.2.0 逐字段相同」这条回归项从此多了一个前提：**调用方显式传了 `timeoutMs` 时，单条目路径的行为与 1.2.0 不同**（1.2.0 没有这个参数，所以不是回归，但是新参数改变新路径） | 无需改代码。建议在 README 的单条目示例旁注明「`timeoutMs` 对单条目调用同样有效」，避免读者以为它只服务于批量 |
| **P0R2-03** | `test/tool-schema.test.ts` | 84–110（设计决定记录） | **low** | P0R-01 的方案 (c) 把「schema 无法表达二选一」写成了带证据的设计决定，代码与测试都正确。但 `src/index.ts:164-175` 的注释里「⚠️ 这条二选一**无法**在 schema 层表达」是**绝对化表述**，而实际证据只覆盖了「DSH 当前的 `ParameterSchemaSpec`  DSL 放不下根级 `oneOf`」—— 宿主哪天扩展了 DSL，这句话会变成错的，且没有任何测试会发现 | 把注释里的「无法」改成「当前 DSL 无法（证据见 test/tool-schema.test.ts 的那条用例）」，让它随证据一起可被推翻 |

### 4.1 已关闭的项（不重开）

t9 的 8 条 findings（P0R-01…08）我逐条复验：**全部关闭**。逐条依据见 §2.1（P0R-02/03/06）、
§2.2（P0R-01 的测试替换）、§3.1（P0V-01，即 t8 对 P0-1 标准 4 的补充）、
§3.2（P0V-02）、以及 t14 交付说明中的 P0R-04/05/07/08（我核对了 README 的实际内容：
`README.md:349-350` 按官方定义对齐 33/36、`:565` 权限说明新增端点行含影响面与鉴权现状）。

---

## 5. D6-② 面板交互：可行性结论**诚实**（我独立核实，未接受一面之词）

任务要求我核实实现者「做不到」的卡点是否真实。我读了**宿主的类型定义原文**而不是推断：

`@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`（全文 231 行）：

- `ClientConnectionRpc`（`:209-230`）只暴露两个成员：`call(channel, endpoint, payload, signal?)`
  与可选的 `open(channel, endpoint, payload, signal, uplink?)`，注释明写
  「Browser transports omit this method; API Gateway owns their WebSocket mux」。
  **没有任何「触发宿主动作」的 API** —— 面板侧确实只能发 RPC 请求，不能让宿主取消某次 `execute()`。
- `HostConnectionRpc`（`:131-147`）只有 `handle` / `intercept` 两个注册方法，
  `ConnectionRpcHandler` 的签名是 `(endpoint, payload, signal, peer)` ——
  handler 拿得到 `payload` 与 `peer`，**拿不到 `exec` 的 `AbortController`**。

结合 `src/index.ts` 的实际情况：`AbortController` 只活在 `execute()` 栈帧里
（`ctx.exec.signal` → `downloader.runProcess`），进程内**没有** `taskId → AbortController` 映射；
进度文件（`ProgressRecord` / `DownloadTaskFile`）里**没有** `url` / `output` / `sha256` /
`headers` / `mirror` —— 连「重试什么」都无法表达。

**因此「本轮做不到」的结论成立**，卡点真实存在且比我预想的更硬（不只是「缺一张表」，
而是宿主客户端面本身就只提供请求通道）。

**没有死按钮**：`src/client.js` 全文无 `onClick` / `<button>`，只有
`connection.rpc.call(API_PATH, STATUS_ENDPOINT, …)` 一处只读调用。
`src/rpc.ts` 只注册两条路由：`/api/smartdl.status`（只读）与 `/api/smartdl.cleanup`（删历史），
**没有取消 / 重试端点**。实现者说的与代码一致。

---

## 6. 结论

### 6.1 Verdict：**pass**

四类重点问题全部有依据地通过：

1. **静默失败**：11 条新增「返回默认值」路径**全部**有正向断言且回告调用方，
   三条最易错的（超时≠取消、取消优先于超时、超时不塌窗）我用探针实证。
   遗留一条 low：README 契约表没给这 11 条补行（文档滞后，非防护缺失）。
2. **测试没有被弱化**：+90 条用例、0 fail；10 条被删断言逐条核对全是**被更严格的断言替换**，
   其中 2 条正是 t8 的 P0V-01 逼出来的收紧（`assert.equal` 整句 + 4 条 `doesNotMatch`）。
3. **契约向后兼容**：单条目返回结构 / render 文案 / 现有 7 个参数 / 老进度文件 / output schema /
   缺省命令行逐项实测或逐字段核对通过。一条 low：`timeoutMs` 让单条目路径多一个新参数前提
   （非回归，因 1.2.0 无此参数）。
4. **功能蔓延：没有**。模块级零可变状态、零缓存、零定时器、零注册表；
   §4.1「不做」清单 9 项逐条核实未越界（唯一沾边的 `maxHeight + overflowY` 是 P0-4 验收标准 1 的必要配套）。

另有两项专项复验通过：t8 的 P0V-01 / P0V-02 **均已关闭且证据比我建议的更强**；
dist 与源码同步（含别名零残留、LF、无 BOM）。

### 6.2 给 captain 的三句话

1. **P0 可以合并。** 三条 low 都不阻塞：两条是文档措辞（契约表补行、`timeoutMs` 单条目注明），
   一条是注释绝对化（改「无法」为「当前 DSL 无法」）。
2. **t14 与 t16 的修复质量比我预期高。** P0V-01 我原话说「修法两行」，
   实现者连「将来换成绝对路径启动 curl」的那道测试防线也一起埋了。
3. **唯一我想提醒的技术债**：README 契约表（`:524-551`）已经有 20 行 1.2.0 的约定，
   P0 又新增 11 条没进表。测试是全的，所以现在补只是成本问题；再拖下去，
   新来的人会以为这些路径没有约定 —— 而这张表在本仓库正是用来防止这种误读的。

---

*审查者：verify-a｜审查时间：2026-10-12 10:31–10:5x（Asia/Hong_Kong）｜
审查期间 t18 改过 src（10:32）、t19 重建 dist（10:41）、并行的 P1-2 改了 `src/decision.ts`
与 `dist/`（10:47–10:49），本文以 10:51 后状态为准，并对该并行改动做了复验（§1.3 末）。
未修改任何 `src/` / `test/` / `dist/` / 他人文档；三份探针脚本写在仓库外，跑完即清理。*
