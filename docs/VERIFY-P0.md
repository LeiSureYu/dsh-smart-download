# P0 累计改动独立验证（t5 + t6 + t7，含 t14 修复后复验）

> 验证者：verify-a（**不是** P0 三项实现中任何一项的作者；`docs/ROADMAP-1.3.md` 是我写的，
> 因此本报告刻意按「证伪」而不是「确认」来组织 —— 每条结论都附可复现命令或真实输出）
> 验证对象：`t5`（P0-1/2/3 表达层）、`t6`（P0-5/6 批次 + 批量 + 总带宽上限）、`t7`（P0-4 面板 + 清理入口）
> 权威规格：`docs/ROADMAP-1.3.md` §1.3（验收标准）、§5（已拍板决策 D1=A / D4=② / D6=② / D7=②）、§0.2（6 处纠正）
> 结论：**pass（可以进入下一轮审查）** —— 但有一条**新增的验收外缺陷**必须记入（P0V-01，退出码修复不完整），
> 以及一条**验收内未覆盖的缺口**（P0V-02，README 零记载批量功能）。

---

## 1. 环境与基线（真实命令 + 真实输出）

```powershell
cd C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download
node --version    # v24.18.0
pnpm --version    # 11.22.0
git log --oneline -1   # b36624d Merge pull request #15 ... (1.1.2)
```

**工作区版本**：`package.json:3` = `1.2.0`；**HEAD** = `1.1.2`。
即 1.2.0 的全部改动（含 P0 三项）**都是未提交的工作区改动** —— 这一点直接决定了 §4 的基线比对方式。

**基线复现**（规格要求先自己跑一遍）：

```
ℹ tests 410
ℹ suites 0
ℹ pass 408
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ duration_ms ~9300
```

> 注意：规格里写的基线是 **343 / 341 / 2 / 0**，而实测是 **410 / 408 / 2 / 0**。
> 差异不是失败：t5/t6/t7/t13 共新增 67 条用例（t5 +21、t6 +24、t7 +11、t13 +11），
> `fail = 0` 且 `skipped` 仍为 **2**（与基线一致的平台既有项，`test/runprocess.test.ts`
> 的 4 处 `t.skip` 里有 2 处在当前平台生效）。**用例数只增不减，0 失败。**

**三条契约 verify 命令实跑**（§5 有逐条输出）：

| # | 命令 | 结果 |
| --- | --- | --- |
| V1 | `pnpm check` | exit 0，`tsc --noEmit` 与 `tsc -p tsconfig.test.json` 均无错误 |
| V2 | `pnpm test` | exit 0，410 / 408 / 0 / 2（见上） |
| V3 | `pnpm build && git diff --stat -- dist` | exit 0；`dist/client.js` 与 `src/client.js` **SHA256 相同**（`8273210FA1BE…`），构建后 `dist/` 有 20 个文件改动 |

**t5 / t6 / t7 三份契约里的全部 verify 命令，逐条实跑**：

| 来源 | 命令 | 实测 |
| --- | --- | --- |
| t5 P0-1 | `node --test --import tsx test/downloader.test.ts test/runprocess.test.ts` | 48 / 46 / 0 / 2 |
| t5 P0-2 | `node --test --import tsx test/verify.test.ts test/hash.test.ts test/execute.test.ts` | 71 / 71 / 0 / 0 |
| t5 P0-3 | `node --test --import tsx test/status.test.ts test/tool-schema.test.ts` | 44 / 44 / 0 / 0 |
| t6 P0-5 | `node --test --import tsx test/progress.test.ts test/status.test.ts` | 60 / 60 / 0 / 0 |
| t6 P0-6 | `node --test --import tsx test/execute.test.ts test/tool-schema.test.ts` | 52 / 52 / 0 / 0 |
| t6 总带宽 | 同上（带宽用例在 execute.test.ts 内） | 52 / 52 / 0 / 0 |
| t7 P0-4 | `node --test --import tsx test/client.test.ts test/rpc.test.ts` | 38 / 38 / 0 / 0 |
| t7 D7-② | `node --test --import tsx test/rpc.test.ts` | 27 / 27 / 0 / 0 |
| t5/t6 共同 | `pnpm check` | 0 错误 |
| t7 共同 | `pnpm build` + 哈希比对 | `8273210FA1BE…` 两侧一致 |

**关于并行**：验证期间工作区**在动**。`t14`（repair round 2）在我验证过程中持续修改
`src/cleanup.ts`(09:10:00)、`src/rpc.ts`(09:10:19)、`src/index.ts`(09:10:49)、
`test/tool-schema.test.ts`(09:12:09)、`test/rpc.test.ts`(09:12:48)。
因此本报告分两段记录：**§2 前半**是对 t5/t6/t7 原始交付的验证，
**§2 后半 + §6**是对 t14 修复后当前状态的复验。凡结论依赖某个快照的，都写明该快照的 mtime 与哈希。

---

## 2. 逐条验收结果表

> 格式：工作项 → 验收标准（原文） → pass/fail → 证据。
> **不抽样**：规格里的每一条都列。难度高的（单条目逐字段、老进度文件、并发上限来源）单独加实测。

### P0-1 退出码翻译层（t5）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 退出码 0 逐字节不变，仍 `resolve()`，不产生任何文案 | **pass** | 实测 `describeExitCode('curl', 0, null, 'anything') === null`（第四轮探针 `zero.returnsNull`）；`src/downloader.ts:314` `if (code === 0) return null`，`:425-427` 仍 `resolve()` |
| 2 | 已知码给中文原因 + 下一步：curl 18/22/28/33/56，aria2 1/3/9/13/24 | **pass** | 实测 10 个码全部含「下一步」（`next.curl.*` / `next.aria2.*` 全 true）；表里恰为 curl [18,22,28,33,56] + aria2 [1,3,9,13,24]，**无多余码** |
| 3 | 未知退出码原样保留退出码与 stderr，不编造原因 | **pass** | 实测 `describeExitCode('/opt/aria2c.exe', 77, null, 'some stderr tail')` → `unknown.keepsCode=true`、`unknown.keepsStderr=true`、`unknown.hasNextStep=false`（**没有**编造的下一步）、`unknown.noAbsolutePath=true` |
| 4 | 文案里不再出现 `command` 绝对路径 | **部分通过（见 P0V-01）** | `describeExitCode` 内的路径已收敛（`/opt/` 不出现，走 `executableName()`）；**但取消路径的两处 `reject(new Error(\`下载已取消：${command} 被 AbortSignal 终止\`))`（`src/downloader.ts:409`、`:422`）仍插值原始 `command`**。实测 aria2 被取消时错误消息里出现完整绝对路径（见 §3 P0V-01） |

**「退出码里有凭记忆填的码」——专项核查（本仓库最看重的对抗性检查之一）**

规格 P0-1 备注明写「不得凭记忆填表」。我没有只读注释，而是**把每个码都用真实子进程实测了一遍**
（本地 127.0.0.1 受控 server + 本机 curl 8.13.0 / 随包 aria2 1.37.0）：

| 码 | 声称含义 | 实测退出码 | 实测 stderr / 结果 | 判定 |
| --- | --- | --- | --- | --- |
| curl 18 | 传输不完整 | **18** ✅ | `curl: (18) end of response with 600 bytes missing`（声明 1000 只发 400） | 实测一致 |
| curl 22 | HTTP 错误 | **22** ✅ | 500 与 404 两种场景均 22；stderr 含 `error: 500` | 实测一致 |
| curl 28 | 超时 | **28** ✅ | `--max-time 1` 对挂住不响应的 server；stderr 含 `timed out` | 实测一致 |
| curl 33 | HTTP Range 请求未被接受 | **33** ✅ | 服务器忽略 Range 且本地有半包 → `curl: (33) HTTP server does not seem to support byte ranges. Cannot resume.`；Range 却返回 200 同样得 33 | 实测一致，且措辞与官方定义（33 = HTTP range error）吻合 |
| curl 56 | 接收数据失败 | **未构造成功**（见下） | — | 见下 |
| aria2 1 | 未知错误 | **1** ✅ | `http://` → `Exception: [download_helper.cc:451] errorCode=1 Unrecognized URI or unsupported protocol` | 实测一致 |
| aria2 3 | 资源不存在 | **3** ✅ | 404 server → exit 3 | 实测一致 |
| aria2 9 | 磁盘空间不足 | **本地无法构造** | — | 来源只能是官方手册；已用官方文档核对（见下） |
| aria2 13 | 文件已存在且不允许覆盖 | **13** ✅ | 预置同名文件 + `--auto-file-renaming=false` → exit 13 | 实测一致 |
| aria2 24 | HTTP 鉴权失败 | **24** ✅ | 401 + `WWW-Authenticate` → exit 24 | 实测一致 |

**curl 56 与 aria2 9 为何标注为「未实测」而不是「通过」**：

- **curl 56**：我用「服务端中途销毁 socket」试了三次，在 Windows 上 curl 8.13.0 都退到
  18 或连接错误，**没能稳定构造出 56**。因此这一条我只能说「映射与官方文档一致，
  但我没有构造出复现」—— 记为**部分通过**，不是「通过」。
  官方口径已核对：`https://everything.curl.dev/cmdline/exitcode.html` 与
  `https://curl.se/libcurl/c/libcurl-errors.html`（`CURLE_RECV_ERROR = 56`）。
- **aria2 9**：磁盘满无法在本机安全构造。官方口径已核对：
  `https://aria2.github.io/manual/en/html/aria2c.html` 的 EXIT STATUS 一节明列
  「9 : If there was not enough disk space available.」；同源确认了
  「1 : If an unknown error occurred.」「2 : If time out …」「13 : If file already existed.」
  「24 : If HTTP authorization failed.」。

**结论**：10 个码里 **8 个我亲手复现**，2 个（curl 56 / aria2 9）只有官方文档来源而无本地复现。
没有发现「凭记忆填错」的码。规格要求「每个码都必须能追到官方文档或受控实测」——
按这个口径，56 与 9 靠官方文档，其余 8 个有实测，**都满足**；但我想把「哪 8 个是实测」
写清楚，免得读者以为 10 个都实测过。

### P0-2 校验失败文案（t5）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 四条失败路径都补「下一步」，至少含「半包与旁车已保留、可重试」 | **pass** | 实测：长度不符 → `下一步：产物、半包与旁车指纹均已保留（便于核对与续传），可直接重跑一次`；SHA-256 不匹配 → 同含该句 + 「若重跑后仍不匹配，请核对期望摘要是否抄错」；文件读不到（`HASH_UNREADABLE_MESSAGE`）→ 同含保留句。第四条（长度不符的两种子形态：文件缺失 / 字节数不等）共用 `describeMismatch`，实测都带下一步 |
| 2 | 保留原有可核对数据（落盘字节数、远端声明字节数、期望与实际摘要），只加不删 | **pass** | 实测长度不符文案含 `落盘 200 字节，远端声明 100 字节`（两个数都在）；SHA-256 文案含**完整 64 位**期望与实际摘要（`期望摘要：aaaa…`、`实际摘要：2f240b…`），实测 `hash-mismatch.containsExpected=true`、`hash-mismatch.fileKept=true`、`hash-mismatch.sidecarKept=true`（旁车 `.part.json` 仍在） |
| 3 | SHA-256 不匹配时两个 64 位 hex 不得并排一整行，且截断后仍可区分 | **pass** | 实测文案为三行呈现：`下载完整性校验失败：SHA-256 不匹配\n期望摘要：…\n实际摘要：…\n下一步：…`。**没有截断**（实现按「只加不删」选分行而非截断），两个摘要各自独占一行、可逐行比对 |
| 4 | 断言只依赖「文案包含下一步关键词」，不得逐字断言完整句子 | **pass** | `test/verify.test.ts` 用 `assert.match(..., /下一步/)`；`test/hash.test.ts` 对常量本身断言。我核对了没有被改成逐字断言 |

### P0-3 `download_status` 区分「读不到」与「没有任务」（t5）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 新增字段只在有目录读取失败时非空 | **pass** | `src/status.ts:319` `...(scanFailedDirs.length > 0 ? { scanFailedDirs } : {})`。实测正常路径 `status.hasScanFailedDirs === false`，键集合恰为 `['downloadDir','ok','taskDir','tasks','total']`（与 1.2.0 逐字段相同） |
| 2 | 两个目录都读不到时返回必须能区分「没有任务」与「读不到」 | **pass** | `ok = scanFailedDirs.length < scannedDirs`（`:307-308`）。实测空目录 `ok=true`；`test/status.test.ts` 断言两个都读不到时 `ok===false` + `scanFailedDirs` 逐路径 deepEqual |
| 3 | 目录读得到但为空时，行为与今天逐字段相同（回归项） | **pass** | 实测 `status.keys` 恰 5 个键、`hasScanFailedDirs=false`；`test/status.test.ts:335-342` 有 `Object.hasOwn(snap,'scanFailedDirs') === false` 断言 |
| 4 | 新字段向后兼容：老读取端忽略它不报错 | **pass** | 可选字段（`scanFailedDirs?: string[]`），`test/status.test.ts:394` 有「老读取端只取已知字段」用例 |

### P0-4 面板显示失败原因 + 容量对齐批量（t7）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `STATUS_LIMIT` 由 5 提到 50，与服务端 `MAX_STATUS_LIMIT` 对齐 | **pass** | `src/client.js:38` `STATUS_LIMIT = 50`；`src/status.ts:102` `MAX_STATUS_LIMIT = 50`。`test/client.test.ts:444` 断言请求带 `limit=50` |
| 2 | `failed` / `cancelled` 时失败原因在面板正文可见，不再只在悬停 `title` | **pass** | `src/client.js:145-155` `failureReason()` + `:260-274` 独立成行渲染（error 色、`pre-wrap`）。`test/client.test.ts:463` 断言失败原因出现在正文、title 只留名字 |
| 3 | 单行信息位数量不减少（文件名 / 百分比 / 进度条 / 速度·ETA 全保留） | **pass** | `test/client.test.ts:536` 逐项断言四条信息位 + 无障碍属性 |
| 4 | `role="progressbar"` 与 `aria-valuenow` 保持 | **pass**（且更强） | `src/client.js:220-227` 保留 `role` / `aria-valuenow` / `aria-valuemin` / `aria-valuemax` / `aria-label`，**并新增 `aria-valuetext`**（失败行把原因一起念出来）。`test/client.test.ts:517` 断言失败行带 `aria-valuetext`、进行中不带原因 |
| 5 | 改完必须 `pnpm build` 让 `dist/client.js` 同步 | **pass** | 实测 `Get-FileHash dist/client.js` == `Get-FileHash src/client.js` == `8273210FA1BE5591EBFE9924E2227092BD7BD2EF5234BC6A93FF417E6290969E` |

**关于「面板按钮点了没反应」**：我按任务要求主动找了。`src/client.js` 全文
**没有任何 `onClick` / `<button>`**（只有 `connection.rpc.call(API_PATH, STATUS_ENDPOINT, …)`
一处调用，且是只读端点）。**没有死按钮。** 与 t7 报告一致。

**GUI 面板实测 —— 按规格 R1 如实标注「未验证」**：本机 profile 装的是 **1.1.2**
（`C:\Users\Qing\.dsh-home\profiles\desktop\node_modules\@leisureyu\dsh-smart-dl\package.json` 的
`version` = `1.1.2`，且其 `dist/index.js` 里既无 `targets` 也无 `scanFailedDirs`），
工作区是 1.2.0 + P0 改动。因此**我无法在真实 profile 上确认面板跑的是哪一份代码**，
按 R1 的约束，面板部分**只做了代码级 + 单元测试级验证，未做真实浏览器实测**。
这不是缺陷，是环境限制，如实记录。

### P0-5 进度记录加「批次 id」并贯通四层（t6）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 新字段可选：老进度文件缺该字段时读取端不报错、不改原有 `status`/`pct`/`msg` 解析结果 | **pass（实测）** | 我手写了**没有 `batch` 字段**的老格式进度文件（轨道一 `.jsonl` 与轨道二 `.json` 各一条），实测读取结果：`{id:'legacy-2', name:'legacy2.bin', pct:42, msg:'下载中', status:'running', spd:'2MB/s', eta:'2s', batch:''}` 与 `{id:'legacy-1', …, pct:50, msg:'legacy.bin', …}`。**`batch` 收敛成 `''`，其余字段全部正常解析** |
| 2 | 一次批量调用的所有条目共享同一个批次 id，且该 id 在两条进度轨道里都写入 | **pass** | `test/execute.test.ts` 断言轨道一/轨道二各新增文件数与 `batch` 值相等；实测批量下载后两条轨道都出现带同一 `batch` 的记录 |
| 3 | 单条目调用（非批量）产生的批次 id 也必须存在且唯一 | **pass** | `src/index.ts:120-122` `makeBatchId()`，`:338` 单条目也调用；`test/execute.test.ts` 断言 `taskIds.has(batch) === false`（批次 id 与任务 id 不同前缀，不会混淆） |
| 4 | 批次 id 只做分组标签，不参与任何执行/并发决策 | **pass** | 我 grep 了 `batch` 在 `src/` 的全部读取点：只有 `progress.ts`（写入）、`status.ts`（读取展示）、`index.ts`（生成）。**没有任何一处 `decide` / `decideConcurrency` / 带宽分配读它** |

### P0-6 单次调用内批量下载（t6，D1=A / D4=②）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 新增可选数组参数，不破坏现有 7 个参数；`required: ['url']` 保持或明确改为二选一并更新断言 | **pass（t14 修复后）** | 9 个参数逐名断言（`test/tool-schema.test.ts:65-78`）。`url` 改为可选，`params.required === undefined`，且 `test/tool-schema.test.ts:84-110` 把「schema 无法表达二选一」写成**带证据的设计决定记录**（含一条专门用例证明 DSL 会把根级 `oneOf` 当成名叫 `oneOf` 的入参属性）。规格原文「必须二选一并写清」——实现选了第三种（schema 不表达、execute 强制 + 文案写明），**这一条 t9 曾判为 blocker，t14 已按方案 c 收口** |
| 2 | `url` 与 `targets` 同时提供时必须有确定行为，且该行为被断言 | **pass** | 实测 `both.message` = `拒绝下载：url 与 targets 只能二选一 —— url 下载单个文件，targets 一次下载一批；两个都给会让「到底下了什么」有两种答案`（**拒绝**，不是静默忽略一边）；`test/execute.test.ts:1094-1096` 断言 `{}` 与两者都给都被拒 |
| 3 | 批量执行有显式并发上限，且上限值来自 `decideConcurrency()` | **pass（实测）** | `src/index.ts:794-796` `batchConcurrency() { return decideConcurrency(LARGE_FILE) }`。**我实测了 12 条目 × 400ms 慢响应 server：`peakConcurrent = 8`**（恰为 `decideConcurrency(LARGE_FILE)` 的返回值 8），`elapsedMs = 1119`（12 条 / 8 并发 × 400ms ≈ 1000ms，符合），`succeeded = 12` |
| 4 | 部分失败时返回值必须逐条看出哪条成功/失败/失败原因，失败条目不得让成功条目结果丢失 | **pass（实测）** | 实测 2 条目批量（一条 200、一条 500）：`succeeded=1, failed=1, resultsCount=2`；成功条目 `{success:true, method:'curl', path:…, size:2048, reason:'文件过小…'}` **完整保留**，失败条目 `{success:false, error:'curl 退出码 22：HTTP 错误…下一步：…stderr:…'}` 带完整原因。`batch.okFileBytes = 2048`（成功条目的文件真的在） |
| 5 | 取消：整批取消时所有未完成条目走取消语义，已完成条目的结果不得被改成失败 | **pass（实测）** | 实测 3 条目（1 快 1 慢 1 未开工）中途 abort：`succeeded=2, failed=0, cancelled=1`。已完成条目 `success:true` **未被改判**；已开工未完成条目 `cancelled:true, error:'下载已取消：curl 被 AbortSignal 终止'`。另测 12 条目全未完成 abort：`succeeded=0, failed=0, cancelled=12`，8 个已开工条目报「下载已取消：curl 被…」、4 个未开工条目报 `BATCH_CANCELLED` 固定文案，**两种取消形态可区分** |
| 6 | 批量大小超过 `MAX_STATUS_LIMIT` 时必须显式拒绝或分批 | **pass（实测）** | 实测 51 条 → `拒绝下载：targets 有 51 条，超过单批上限 50 条（进度读取端一次最多读这么多，再多就会「下过了但查不到」）。请拆成多批调用`；`MAX_STATUS_LIMIT = 50`、`batchConcurrency = 8` |
| 7 | 单条目路径的返回结构与文案与今天逐字段相同（回归项） | **pass（实测，见 §4 专项）** | 实测 `single.keys` = `['fellback','method','mirrored','path','reason','requestedUrl','size','success']`，**无 `batch` / `results`**；render 文案 `Download succeeded via curl (fallback: 文件过小…)` 与 1.2.0 逐字一致 |

### 总带宽上限（§5 D5 ③「整批共享」）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 非法值在发起任何请求之前抛错 | **pass（实测）** | 实测 8 个非法值（`''`、`'abc'`、`'-1M'`、`'0'`、`'2MB'`、`'  '`、`'1.5M'`、`'2 M'`）**全部被拒**，且 `bw.serverHitsAfterAllInvalid = 0`（服务器一次都没被打到） |
| 2 | aria2 走 `--max-overall-download-limit`、curl 走 `--limit-rate` | **pass** | `src/downloader.ts` 的 `buildAria2Args` / `buildCurlArgs` 均已加对应开关；`test/downloader.test.ts` 有 deepEqual 基准断言缺省时命令行不变 |
| 3 | 批内按实际并发位均分，一批合计不超过给定上限 | **pass（实测墙钟）** | 实测 2 条目 × 8MB、`maxBandwidth:'2M'`：`elapsedMs = 8316`（≈8s），与「按 2 个并发位均分（每条约 1MB/s → 每条约 8s）」吻合；若未均分（每条各拿 2MB/s）应约 4s。**实测支持均分** |
| 4 | 不引入跨调用共享状态 | **pass** | `src/index.ts` 模块级声明我全过了一遍：新增的只有常量（`NO_TASKS_TEXT` / `BATCH_LABEL_*` / `MAX_BATCH_TARGETS` / `BOTH_URL_AND_TARGETS` / `NEITHER_URL_NOR_TARGETS` / `BATCH_CANCELLED`）与函数/接口。**零模块级可变状态、零缓存、零定时器、零注册表** |

### D7-② 清理入口（t7）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 只删过期的 `.json` / `.jsonl` 普通文件 | **pass（实测）** | 预置「老文件（10 天前）/ 新文件（60 秒前）/ 同名**目录**（10 天前）」后清理：`deleted = ['old.json']`、`kept = ['new.json', …]`、`dirSurvived = true`。**目录未被删**（`lstat` + `isFile()` 生效） |
| 2 | 保留窗口 60s..365d，单次默认 200、硬上限 500，按 mtime 升序 | **pass** | 常量实测 `DEFAULT_RETENTION_MS=86400000`(24h)、`MIN=60000`、`MAX=31536000000`、`DEFAULT_CLEANUP_LIMIT=200`、`MAX_CLEANUP_LIMIT=500` |
| 3 | 参数非法不得静默改写 | **pass（t14 修复后实测）** | 实测 `olderThanMs` 的 `0 / -1 / "abc" / 1e15 / 1.5` 与 `limit` 的 `0 / -1 / 99999 / "abc"` **全部抛错拒绝**，文案为 `拒绝清理：olderThanMs 必须是 60000..31536000000 之间的整数（收到 0）；缺省时为 86400000。这里不接受「夹取」…`。`readCleanupQuery` 同套校验同样拒绝。**这一条 t9 曾判为 blocker（静默回落），t14 已修** |
| 4 | 未开工条目被取消也要留记录 | **pass（实测）** | 见 P0-6 第 5 条：12 条目 abort 后 4 个未开工条目各有 `BATCH_CANCELLED` 文案 |
| 5 | 不自动调用 `ProgressReporter.cleanup()` | **pass** | `src/progress.ts` 未改（我核对了该文件在验证窗口内的 mtime 与内容），`cleanup()` 仍是显式接口 |

### D6-② 面板交互（取消 / 重试）

| # | 验收标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 不做死按钮 | **pass** | `src/client.js` 无任何 `onClick` / `<button>` |
| 2 | 「做不到」的结论诚实 | **pass（我独立读了宿主侧）** | 我读了 `@deepseek-ai/dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc`：只暴露 `call(channel, endpoint, payload, signal)` 与可选 `open`，**没有触发宿主动作的 API**；`AbortController` 确实只活在 `execute()` 栈帧里（`src/index.ts:552/692/729` 传 `ctx.exec.signal`）；进度文件里确实**没有** `url`/`output`/`sha256`（我核对了 `ProgressRecord` 与 `DownloadTaskFile` 的字段集合）。**结论成立** |

---

## 3. 对抗性检查发现

按任务要求，我主动构造了 6 类「看起来做了但没做到」的场景。前 5 类**没找到缺陷**，
第 6 类找到一条**新的**（t9 未列、t14 未修）。

### 3.1 退出码映射里有凭记忆填的码？ → **没有**（但 2 个码只有文档来源）

做法：用真实子进程 + 本地受控 server 逐个复现。**8 / 10 个码亲手复现**（见 §2 P0-1 表）。
curl 56 与 aria2 9 无法本地构造，仅核对官方文档。**未发现凭记忆填错的码。**

### 3.2 文案里丢了原有可核对数据？ → **没有**

做法：构造真实失败，逐字检查错误消息。长度不符含「落盘 200 字节，远端声明 100 字节」；
SHA-256 不匹配含两个完整 64 位摘要。**只加不删**成立。

### 3.3 批次 id 破坏了老进度文件的解析？ → **没有**

做法：手写**无 `batch` 字段**的老格式 `.jsonl` 与 `.json`，实测读取。`batch` 收敛为 `''`，
`name`/`pct`/`msg`/`status`/`spd`/`eta` 全部正常。轨道一缺 `batch` 时保留轨道二的值
（与既有 `name` 垫片同一手法）。

### 3.4 批量失败时成功条目的结果被吞？ → **没有**

做法：一条成功 + 一条失败的真实批量。成功条目 `success:true` 且字段完整、文件真的落盘
（2048 字节）。`renderBatch` 也把 `[ok]` / `[failed]` 逐条打进模型可见文案。

### 3.5 面板按钮点了没反应？ → **没有按钮可点**

做法：通读 `src/client.js`。无任何交互元素。

### 3.6 【新发现】取消路径的文案仍然泄漏绝对路径（P0V-01，medium）

**怎么构造的**：我让一条 aria2 下载挂住，然后 `AbortController.abort()`，捕获返回的错误消息。

**观察到了什么**：

```
"error": "下载已取消：C:\\Users\\Qing\\Documents\\Codex\\2026-09-28\\https-github-com-leisureyu-dsh-smart\\work\\dsh-smart-download\\node_modules\\.pnpm\\@leisureyu+dsh-aria2-win32-x64@1.37.0\\node_modules\\@leisureyu\\dsh-aria2-win32-x64\\bin\\aria2c.exe 被 AbortSignal 终止"
```

同一次实验里 **curl 路径的取消消息是干净的**：`下载已取消：curl 被 AbortSignal 终止`。

**为什么这算缺陷**：P0-1 的验收标准 4 明写「原文案里的 `command` 绝对路径**不再出现**在用户可见
文案里（改为 `aria2c` / `curl`）」。t5 只改了**退出码分支**（`describeExitCode` 内部的
`executableName()`），**漏了两处取消分支**：

- `src/downloader.ts:409`（`child.on('error')` 里的 `reject(new Error(\`下载已取消：${command} 被 AbortSignal 终止\`))`）
- `src/downloader.ts:422`（`child.on('close')` 里的同一句）

这两处直接把 `command` 插进文案。对 curl 无感（`downloadWithCurl` 传的字面量就是 `'curl'`），
对 aria2 就是**完整的 node_modules 绝对路径**。

**影响面**：这条消息会出现在 (a) 工具返回值/抛出的错误里，(b) `reporter.fail()` 写进的进度文件，
(c) 进度面板正文。用户与模型都会看到一长串本机路径。它不泄露敏感数据（路径里只有包名与版本），
但**违背了一条已写进验收标准的不变量**，而且同一份代码里 curl 与 aria2 行为不一致。

**与既有测试的关系**：`test/runprocess.test.ts:123-133` 只断言 `assert.match(err.message, /下载已取消/)`
与 `/AbortSignal/`，**没有任何用例断言取消文案里不出现绝对路径** —— 所以它一直是绿的。
这正说明「有测试」不等于「测到了那条不变量」。

**这是验收标准 4 的 fail**，因此 P0-1 记 **4/5 通过**（见 §2 表）。
它**局限在文案层**，不影响任何下载行为，修法是两行（把 `${command}` 换成 `${executableName(command)}`），
所以我没有把它升级成 blocker；但它是规格明文要求的一条，不能因为「只是文案」就记为通过。

---

## 4. 回归专项：单条目路径与 1.2.0 逐字段比对

规格要求「用 git stash 或对照 1.2.0 基线**实际比对**单条目调用的返回结构，而不是只读代码判断」。

### 4.1 基线不可得 —— 如实记录，并改用可替代的强证据

我先尝试取 1.2.0 基线，**三条路都断了**：

| 尝试 | 结果 |
| --- | --- |
| `git show HEAD:src/index.ts` | HEAD 是 `b36624d` = **1.1.2**；其 `src/index.ts` 里 **grep 不到 `targets`** |
| `git stash` + 对照 | 1.2.0 从未提交，`git stash` 只能回到 **1.1.2**，不是 1.2.0 |
| npm 包 `@leisureyu/dsh-smart-dl@1.2.0` | **E404** —— npm 上最新是 `1.1.2`，1.2.0 从未发布 |
| 已安装 profile | `C:\Users\Qing\.dsh-home\profiles\desktop\node_modules\@leisureyu\dsh-smart-dl` 版本 = **1.1.2** |
| dangling commit / blob | `git fsck` 的 10 个 dangling commit 里**没有** `package.json` 为 1.2.0 的；6 个 dangling blob 全是 `README.md` 的历史版本 |

**即：1.2.0 这一版在本机没有任何可还原的副本。** 我无法做「与 1.2.0 逐字段 diff」。

### 4.2 改用三条不依赖 1.2.0 副本的证据

**证据 A：1.2.0 的「逐字段相同」本身已被写成断言，且我复核了这些断言不是恒真**

`test/execute.test.ts:1246-1254` 断言单条目返回的键集合**恰为**
`['fellback','method','mirrored','path','reason','requestedUrl','size','success']`。
我核对了这条断言不是空转：如果实现不小心把 `batch` 或 `results` 加进单条目返回，
`additionalProperties: false` 的 oneOf 分支一会让宿主校验失败，而 `test/execute.test.ts`
用宿主自己的 `validateJsonSchemaValue` 跑过真实返回值（t6 报告述，我复跑了该用例文件 52/52 通过）。

**证据 B：我实测了单条目返回，逐字段列出**

```
single.keys = ['fellback','method','mirrored','path','reason','requestedUrl','size','success']
single.value = {
  requestedUrl: 'http://127.0.0.1:13065/single.bin',
  mirrored: false, success: true,
  path: '...\\single.bin', method: 'curl', size: 8192,
  fellback: true, reason: '文件过小（8192 字节 <= 阈值 1048576）'
}
single.fileBytes = 8192
```

**8 个键，无 `batch` / `results` / `targets` / `maxBandwidth`**；`size` 只在有 Content-Length 时出现
（另一条实测：无 Content-Length 时 `hasSize === false` 且 `verifySkipped` 有显式文案）。

**证据 C：单条目走的是与 1.2.0 同一条代码路径（结构上）**

`src/index.ts:335-341`：单条目直接 `return downloadOne(dispatch.item, …)`，
而 `downloadOne` 就是原 `execute` 主体逐字搬移（注释明写，且我核对了搬移内容：
校验顺序 `checkDownloadUrl` → `sha256` → `buildRequestHeaders` → 探测 → 镜像 → `planResume`
→ `decide` → 下载 → `assertIntegrity` → `successResult`，与 1.2.0 的顺序一致）。

**结论**：我**不能**声称「与 1.2.0 逐字节相同」（基线不可得），
但我用「实测键集合 + 宿主 schema 校验 + 同一条代码路径」三条证据支持「未增加字段、未改文案」。
规格这一条的**意图**（防止批量改动污染单条目路径）我认为达成了；
但**严格按字面**（与 1.2.0 实际 diff）我做不到，因此记为 **pass（附基线不可得的说明）**，
不记成「已与 1.2.0 逐字节比对」。

---

## 5. 「我实测过的」与「我推断的」

### 5.1 我实测过的（每条都有命令与输出，可复现）

1. `pnpm check` / `pnpm test` / `pnpm build && git diff --stat -- dist`（含 `dist/client.js` 与 `src/client.js` 的 SHA256 比对）
2. t5/t6/t7 三份契约里的**全部** verify 命令，逐文件跑并记录 tests/pass/fail/skipped
3. **单条目返回的逐字段内容**（本地 http server 驱动真实 `execute()`）
4. **无 Content-Length 时** `size` 键不出现、`verifySkipped` 有文案
5. **SHA-256 不匹配**的完整错误消息（含两个 64 位摘要、下一步、旁车保留）
6. **长度不匹配**的完整错误消息（含落盘/声明两个数字、下一步）
7. **批量部分失败**：成功条目字段完整 + 文件真的落盘 + 失败条目带完整原因
8. **批量并发上限**：12 条目实测峰值并发 = 8（= `decideConcurrency(LARGE_FILE)`）
9. **带宽均分**：2 条目 × 8MB + `2M` 上限，墙钟 8.3s（支持按并发位均分）
10. **8 个非法 `maxBandwidth` 值**全部被拒且服务器 hits = 0
11. **批量取消**：3 条目与 12 条目两种形态，`failed === 0`、已完成条目未被改判
12. **51 条批量**被显式拒绝
13. **老进度文件**（无 `batch`）解析结果逐字段
14. **退出码实测**：curl 18/22/28/33/6、aria2 1/3/13/24 共 9 个场景（另 aria2 9 无法构造）
15. **清理**：老/新文件 + 同名目录的删留；9 个越界参数全部被拒
16. **取消文案里的绝对路径泄漏**（P0V-01）
17. **1.2.0 基线不可得**的五条取证路径（git HEAD / stash / npm / profile / fsck）
18. `src/client.js` 全文无交互元素；宿主 `dsh-client-connection` 只有 `call`/`open`
19. 退出码官方来源核对（`everything.curl.dev/cmdline/exitcode.html`、`curl.se/libcurl/c/libcurl-errors.html`、`aria2.github.io/manual/en/html/aria2c.html` 的 EXIT STATUS）
20. `dist/` 与 `src/` 的同步性（构建后哈希一致）

### 5.2 我推断的（未实测，标注在此）

1. **GUI 面板的真实浏览器表现** —— **未实测**。本机 profile 是 1.1.2，工作区是 1.2.0+P0，
   按 R1 我不能把面板观察当证据。面板部分只有代码级 + 单元测试级结论。
2. **curl 56 与 aria2 9 的映射正确性** —— 只有官方文档来源，**本地未复现**（构造失败 / 无法安全构造）。
3. **「与 1.2.0 逐字段相同」** —— 基线不可得，我用「实测键集合 + 宿主 schema + 同代码路径」替代，
   **没有**做真正的 1.2.0 diff。
4. **`decide()` 在单条目内部未改** —— 我读了 `src/decision.ts` 并核对其 mtime 不在 P0 改动窗口内，
   **没有**为它写专门的端到端实测（`test/decision.test.ts` 31/31 通过是间接证据）。
5. **并发上限 8 的真实网络表现** —— 我的并发实测用的是 400ms 人为延迟的本地 server，
   真实网络下的峰值会受服务器与网络影响；我断言的是「上限不超过 8」而非「总能达到 8」。
6. **t14 修复的完整性** —— 我只复验了 P0R-01/02/03/04/08 五条，**没有**逐条复核 t9 的其余
   low 级 findings（P0R-05 措辞、P0R-06 测试盲区、P0R-07 措辞）是否已收口。

---

## 6. t14（repair round 2）修复复验

t9（review）判 **needs_revision**，列出 8 条 findings；t14 在我验证期间持续修改代码。
我对其中影响验收的 5 条做了复验：

| finding | t9 的判定 | 我复验的结果 | 证据 |
| --- | --- | --- | --- |
| **P0R-01** | blocker：`{}` / `{bogus:1}` 能穿过宿主入参校验 | **已收口（方案 c）** | `src/index.ts:164-175` 把「二选一 + 拒绝」写进 `url`/`targets` 的 description；`test/tool-schema.test.ts:84-207` 留下一份**带证据的设计决定记录**（含一条用例证明 DSL 会把根级 `oneOf` 编译成名叫 `oneOf` 的入参属性，因此方案 b 不可行） |
| **P0R-02** | blocker：非法清理参数静默回落 | **已修复** | 实测 9 个越界值全部抛错拒绝（§2 D7-② 第 3 条） |
| **P0R-03** | medium：cleanup 生产路径拿不到 session | **已修复** | `src/rpc.ts:286-293` 新增 `readCleanupPayload`，把 `payload.session` 解析出来传给 `cleanupHistory(query, session)`；`CleanupResult` 同时新增 `taskDir` 与 `taskDirSkipped`，定位不到轨道一时**明确报告**而不是静默 |
| **P0R-04** | low：README/SECURITY 对退出码 33 的解释与实现矛盾 | **已修复** | `README.md:349-350` 改为按官方定义对齐（33 = HTTP range error；36 = bad download resume），并保留本机实测说明「33 也可能意味着服务器忽略了你发的 Range」 |
| **P0R-08** | low：销毁性端点无授权说明 | **已修复** | `README.md:565` 权限说明新增一整行，写明 `/api/smartdl.cleanup` 会删文件、删除范围、保留窗口、单次上限、**影响面**（进度文件是回执唯一来源）、**鉴权现状**（沿用载体自身，无按任务/会话授权）、以及要清轨道一必须带 `session` |

**未复验**：P0R-05（报告措辞）、P0R-06（测试盲区）、P0R-07（报告措辞）—— 前两条属低风险，
第三条纯措辞。我在 §5.2 第 6 点已标注。

---

## 7. 结论

### 7.1 P0 是否可以进入审查门？

**可以，但附两条必须记入的记录。**

P0 的**功能与契约**部分是扎实的：批量真的并行且不超上限、部分失败真的不吞成功条目、
取消真的与失败分开、老进度文件真的还能读、带宽真的按并发位均分、入参非法真的在发请求前被拒、
测试只增不减且 0 失败、无跨调用状态、无功能蔓延、无死按钮。这些我全部用真实执行验证过，
不是读代码得出的。

### 7.2 必须记入的两条

| id | 严重度 | 内容 | 为什么记 |
| --- | --- | --- | --- |
| **P0V-01** | medium | 取消路径两处 `reject(new Error(\`下载已取消：${command} …\`))`（`src/downloader.ts:409`、`:422`）仍插值原始 `command`，aria2 取消时用户可见文案里出现完整 node_modules 绝对路径 | **这是 P0-1 验收标准 4 的 fail**（规格明写「绝对路径不再出现在用户可见文案里」）。t5 只改了退出码分支，漏了取消分支；`test/runprocess.test.ts` 只断言 `/下载已取消/` 与 `/AbortSignal/`，没有任何用例守住这条不变量。修法两行 |
| **P0V-02** | low | README **完全没有** `targets` / `maxBandwidth` / 批量语义的任何记载（我 grep 过 `batch|批量|带宽|targets|maxBandwidth`，只命中无关行） | P0 的核心交付（单次调用内批量）在对外契约文档里是零记载。t9 在 §3.1 已把它列为「建议随本轮收口的文档缺口（非缺陷，不阻塞）」，我复验确认**至今未补** |

### 7.3 我对 P0V-01 为什么给 medium 而不是 blocker

它**不影响任何下载行为**，只影响一条错误消息的文案；修法是两行；且它不构成数据丢失或安全问题。
但它是规格明文写的一条验收标准，且 curl 与 aria2 两条路径行为不一致 —— 所以不能记为通过，
也不该因为「只是文案」而忽略。**建议 captain 让 t14 或后续 repair 顺手修掉**，成本极低。

### 7.4 我明确没有做的事（按任务约束）

- **没有修改任何 `src/` / `test/` / `dist/` 文件，也没有修改任何其他文档。** 本报告是本次任务唯一新增的文件。
- 我的探针脚本全部写在 `C:\Users\Qing\AppData\Local\Temp\verify-p0-probe\`，**不在仓库内**，
  跑完的临时目录已清理（有一条 `rmSync` 因 Windows 文件占用报 EPERM，已另行手工删除）。
- **没有**「顺手修」P0V-01 —— 按任务要求，发现缺陷写进报告，修是 repair 任务的事。
- **没有**把面板观察当证据（R1 约束）。

---

*验证者：verify-a｜验证时间：2026-10-12 08:59–09:20（Asia/Hong_Kong）｜
验证期间工作区被 t14 持续修改，故 §2 前半记原始交付、§6 记修复后复验。*
