# P0 需求与差距分析：下载队列 / 可视化进度 / 错误提示

> 状态：**需求摊平稿**，待用户对第 3 节决策点拍板后，才进入实现。
> 本轮**不改任何源码**，只产出本文件。
> 基线：工作区版本 `1.2.0`（`package.json:3`，未提交）。
> 实测复核：`node --test --import tsx "test/**/*.test.ts"` → **343 tests / 341 pass / 2 skipped / 0 fail**（2026-10-12 本机）。
> 凡本文写出行号的地方都已核对过源码；无法证实的写「待确证」。

---

## 0. 一句话结论

P0 三项的难度**不对称**，而且不对称的方向与直觉相反：

| P0 项 | 判断 | 依据 |
| --- | --- | --- |
| 可视化进度反馈 | **主要是表达不足**，不是能力缺失 | 进度双轨、面板、`download_status` 都已存在（§1.2），缺的是「批次/队列层级」与「失败后怎么办」的落点 |
| 优化错误提示 | **绝大部分已经是可操作的**，属于局部收口 | 逐条盘点 **29 条用户可见错误路径**：✅ 可操作 12 条、⚠️ 部分可操作 16 条、❌ 不可操作 1 条；另有 6 条正向声明全部可操作。缺口集中在 3 处（§1.3.1） |
| 下载队列管理 | **是能力缺失，而且是本次唯一真正动架构的一项** | 全仓无任何并发上限、批次、队列概念（§1.1、§2.3 的证据）；且「队列」在 DSH 里至少有两种互不兼容的语义（§3.1） |

---

## 1. 现状清单（每条带 file:line）

### 1.1 两个工具的参数与返回结构

#### `smart_download`（`src/index.ts:67-430`）

参数 7 项，**仅 `url` 必填**（`src/index.ts:72-108`；`test/tool-schema.test.ts:55-59` 断言了这 7 项与 `required: ['url']`）：

| 参数 | 类型 | 行号 | 说明（源码描述摘要） |
| --- | --- | --- | --- |
| `url` | string | `src/index.ts:73-77` | 必填，待下载地址 |
| `output` | string | `src/index.ts:78-81` | 可选，缺省由 URL 推导（`src/index.ts:187`） |
| `mirror` | string | `src/index.ts:82-86` | 前缀，或字面量 `auto` |
| `sha256` | string | `src/index.ts:87-91` | 期望摘要，下载后逐字节核对 |
| `userAgent` | string | `src/index.ts:92-96` | 探测与下载共用 |
| `referer` | string | `src/index.ts:97-101` | 同上 |
| `headers` | object | `src/index.ts:102-107` | 任意附加头，`additionalProperties: true` |

返回结构 12 个字段（schema：`src/index.ts:110-127`；类型定义：`src/types.ts:46-86`）：
`success` / `path` / `method` / `size?` / `fellback` / `reason?` / `verifySkipped?` / `sha256?` / `requestedUrl` / `mirrored` / `mirror?` / `mirrorSkipped?`。

两条结构性事实（对 P0 有直接影响）：

- **一次调用只处理一个 URL**：`args.url` 是单数（`src/index.ts:147`），返回值也是单个对象，**没有数组形态**。
- **返回给模型的文本只有一行**：`render` 在 `src/index.ts:128-139`，形如
  `Download succeeded via aria2 (fallback: …) (未做字节数校验: …) (SHA-256 verified) (未使用自动镜像: …)`。
  这条文案的每个修饰分支都被 `test/tool-schema.test.ts:88-179` 逐字断言。

#### `download_status`（`src/index.ts:432-505`）

参数 2 项（`src/index.ts:437-447`）：`taskId?`（`src/index.ts:438-442`）、`limit?`（integer，`src/index.ts:443-446`）。

返回（schema `src/index.ts:449-475`，类型 `src/status.ts:50-61`）：
`ok` / `taskDir` / `downloadDir` / `total` / `tasks[]`，每个 task 有
`id` / `name` / `pct` / `msg` / `status` / `spd` / `eta` / `updatedAt`（`src/index.ts:462-471`）。

render 文案：无任务时固定 `'No download tasks found.'`，否则每个任务一行
`` `${name || id}: ${pct}% (${status})${spd}${eta}` ``（`src/index.ts:476-491`，`test/tool-schema.test.ts:181-202`）。

**它是纯只读扫描，不是运行时任务表**：`readDownloadStatus` 扫的是两个**磁盘目录**（`src/status.ts:209-243`），
`ok` 恒为 `true`（`src/status.ts:243`），任何读取失败都退化成「该任务不出现在列表里」（`src/status.ts:11-15` 文件头声明）。
因此它**回答不了**「现在有没有在跑」「排在谁后面」——它只知道「磁盘上有哪些任务的进度文件」。

### 1.2 进度双轨与界面面板：现在到底能显示什么

#### 写入端（`src/progress.ts`）

两条轨道（文件头 `src/progress.ts:1-20`）：

| 轨道 | 路径 | 格式 | 代码 |
| --- | --- | --- | --- |
| 一 | `$DSH_PROGRESS_DIR/<taskId>.jsonl`，缺省 `<session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl` | append-only JSONL | `resolveTaskProgressDir` `src/progress.ts:99-112` |
| 二 | `$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`，缺省 `<DSH_HOME>/downloads/tasks/<taskId>.json` | 整体覆盖写 JSON | `resolveDownloadProgressDir` `src/progress.ts:118-123` |

关键行为：

- **拿不到会话上下文时不写轨道一**（`src/progress.ts:103-111` 返回 `null`；`src/progress.ts:197-201` 据此跳过），理由是读取端按 session 过滤。
- `taskId` 在每次调用里现生成：`` `dl-${Date.now().toString(36)}-${随机4位}` ``（`src/index.ts:188-190`）。
- 写入按「整条记录」去重，`pct+state+msg+spd+eta` 全等才跳过（`src/progress.ts:229-233`），所以速度和 ETA 变化都能落盘。
- 落盘是异步微任务批量写（`src/progress.ts:251-308`），终态由 `awaitFlush()` 等落盘，超时 2s 并 `process.emitWarning`（`src/progress.ts:328-353`）。
- 状态取值只有 4 个：`running` / `done` / `failed` / `cancelled`（`src/types.ts:214`）。
- **`cleanup()` 在生产代码里从未被调用**（定义 `src/progress.ts:379-394`；全仓 grep 无调用点）——即进度文件只增不减。

#### 界面面板（`src/client.js` + `src/rpc.ts`）

- Host 端点：`POST /api/smartdl.status`（`src/rpc.ts:20-22`、`src/rpc.ts:122-186`），由 `ctx.inject(['connection'], …)` 挂载，纯 CLI profile 下静默跳过（`src/rpc.ts:115-119`）。
- 客户端注册到 `shell.overlay` 插槽，`order: 100`（`src/client.js:344-358`）。
- 轮询节奏与容量：`STATUS_LIMIT = 5`、`POLL_INTERVAL_MS = 2000`、`FINISHED_HOLD_MS = 30000`、`STALE_RUNNING_MS = 600000`（`src/client.js:28-42`）。
- **面板每行能显示的东西**（`TaskRow`，`src/client.js:99-186`）：
  1. 任务名（`name` → `msg` → `id` 依次回退，取 basename，超 48 字符截断加省略号，`src/client.js:84-89`）
  2. 百分比（`src/client.js:133-145`）
  3. 进度条（带 `role="progressbar"` 与 `aria-valuenow`，`src/client.js:147-171`）
  4. 速度 / ETA / 终态文字，用 `·` 拼接（`src/client.js:103-108`、`src/client.js:172-184`）
- 面板**不显示**：批次/队列层级、队列位置、等待状态（数据模型里根本没有）、任何按钮（取消/重试/清理都无）。失败/中间态的原因文案 `msg`（如「失败: …」「下载中（aria2）」）**只在鼠标悬停的 `title` 提示里**（`src/client.js:119`），或当 `name` 缺失时被当成标题回退使用（`src/client.js:84-89`）——正常情况下面板正文看不到它。
- 可见性规则：`running` 且 10 分钟内更新过 → 实时条；非 `running` 且 30 秒内更新过 → 回执；其余不显示（`src/client.js:70-77`、`src/client.js:276-280`）。

**可显示的上限结论**：面板是一个「最多 5 行、每行 4 个信息位、无交互」的浮层。

### 1.3 逐条列出所有用户可见的错误路径

标注口径：
- **✅ 可操作** = 用户看完知道下一步做什么；
- **⚠️ 部分可操作** = 说了是什么，但没说怎么办，或文本对用户不友好；
- **❌ 不可操作** = 用户看完不知道下一步。

#### A. 下载前拒绝（抛错，工具调用直接失败）

| # | 文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| A1 | `拒绝下载：无法解析为 URL：<原始串>` | `src/url.ts:68` → 抛出 `src/index.ts:149` | ⚠️ 没提示「需要完整 http(s) 地址」 |
| A2 | `拒绝下载：不支持的协议 <proto>（仅允许 http / https）` | `src/url.ts:70-76` → `src/index.ts:149` | ✅ 明确给出允许的协议 |
| A3 | `拒绝下载：sha256 不是合法的 SHA-256 摘要（<原值>）；接受 64 位十六进制、sha256:<hex>、SHA256(<hex>) 或 SRI 的 sha256-<base64>` | `src/index.ts:158-161` | ✅ 四种写法都列出来了 |
| A4 | `拒绝下载：请求头名不能为空` | `src/headers.ts:106` → `src/index.ts:174` | ✅ |
| A5 | `拒绝下载：请求头名过长（上限 128 字符）：<前 40 字符>…` | `src/headers.ts:107-109` | ✅ |
| A6 | `拒绝下载：请求头名含非法字符：<名字>` | `src/headers.ts:110-112` | ⚠️ 没说合法字符集是 RFC 7230 token |
| A7 | `拒绝下载：请求头 <Name> 由插件自身管理，不允许覆盖（会破坏探测 / 续传 / 完整性校验）` | `src/headers.ts:114-119` | ✅ 给出了「为什么」 |
| A8 | `拒绝下载：请求头值过长（上限 8192 字符）` | `src/headers.ts:128-130` | ✅ |
| A9 | `拒绝下载：请求头值含换行或控制字符（属于请求头注入，已拒绝）` | `src/headers.ts:131-136` | ✅ 点明性质 |
| A10 | `拒绝下载：headers 必须是一个「头名 -> 头值」的对象` | `src/headers.ts:164-166` | ⚠️ 没给正确形状的例子（虽然工具描述里有） |
| A11 | `拒绝下载：自定义请求头过多（上限 32 条）` | `src/headers.ts:168-170` | ✅ |
| A12 | `拒绝下载：请求头 <rawName> 的值必须是字符串` | `src/headers.ts:172-174` | ⚠️ 建议补「数字也要写成字符串」 |

#### B. 探测失败（不抛错，降级为 curl + `fellback: true`）

| # | 文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| B1 | `HEAD 请求失败: <err>；Range GET 请求失败: <err>` | `src/probe.ts:232-236`（`notSupported`） | ⚠️ 两个底层错误原文直出，可能是 `fetch failed` / `The operation was aborted due to timeout`，用户不知道是站点不通还是被墙；**且 `fallback:` 前缀把它标成「回退原因」，容易被读成错误** |
| B2 | `无法获取 Content-Length / Content-Range` | `src/probe.ts:103` | ⚠️ 同上 |
| B3 | `服务器不支持 Range（无 bytes Accept-Ranges 且无 206）` | `src/probe.ts:106` | ✅ |
| B4 | `文件过小（<size> 字节 <= 阈值 <threshold>）` | `src/probe.ts:109` | ✅（但这是探测层的「不支持多线程」判定，与决策层 `文件仅 xxKB，多线程无收益` 会二选一，见 B5） |

#### C. 决策层降级原因（进 `reason`，`fellback: true`）

| # | 文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| C1 | `探测判定不支持多线程`（`probe.reason` 缺失时的兜底） | `src/decision.ts:82` | ❌ 没有信息量 |
| C2 | `无法获取文件大小，保守使用 curl` | `src/decision.ts:92` | ✅ 说清了「保守」 |
| C3 | `文件仅 <kb>KB，多线程无收益` | `src/decision.ts:99-104` | ✅ |
| C4 | `未找到 aria2 二进制（当前平台 <platform>-<arch> 不受支持或子包未安装）` | `src/decision.ts:108-116` | ✅ 已带平台与原因 |

#### D. 传输失败（抛错）

| # | 文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| D1 | `<command> 退出码 <code>（信号 <sig>）\nstderr:\n<stderr 尾部>` | `src/downloader.ts:302-307` | ⚠️ **唯一一条把原始 stderr 直出给用户的路径**，没有把常见退出码翻译成人话（curl 18=传输不完整、22=HTTP 错误、33=不支持续传、28=超时、56=接收失败；aria2 的退出码体系又是另一套）。`command` 是 `aria2c` 的**绝对路径** |
| D2 | `下载已取消：<command> 被 AbortSignal 终止` | `src/downloader.ts:281`、`src/downloader.ts:294` | ⚠️ 面向调用方的措辞（`AbortSignal` 是实现细节），且**取消路径最终抛给模型的就是这句**（`src/index.ts:365` 原样 rethrow），不是「用户取消了」 |
| D3 | `aria2 失败: <aria2Message>`（回退成功时进 `reason`） | `src/index.ts:385` | ✅ 明确写了是谁失败、为什么回退 |

#### E. 完整性校验失败（抛 `IntegrityError`，**不回退 curl**）

| # | 文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| E1 | `下载完整性校验失败：落盘 <N> 字节，远端声明 <M> 字节` | `src/verify.ts:129-132` → 抛出 `src/index.ts:260` | ⚠️ 说了事实，没说「可重试 / 半包与旁车已保留」 |
| E2 | `下载完整性校验失败：落盘 文件不存在，远端声明 <M> 字节` | `src/verify.ts:130` 的 `null` 分支 | ⚠️ 同上 |
| E3 | `下载完整性校验失败：SHA-256 不匹配（期望 <hex>，实际 <hex>）` | `src/hash.ts:122-126` → `src/index.ts:274` | ⚠️ 同上；两个 64 位 hex 并排对用户几乎不可读 |
| E4 | `下载完整性校验失败：无法读取落盘文件以计算 SHA-256` | `src/hash.ts:118-119` | ⚠️ 同上 |

#### F. 进度/镜像相关的说明性文案（不抛错，出现在返回结构里）

> 本节 6 条里**只有 F5 是失败原因**（「没启用镜像」），F1–F4 是「这次没做 X」的正向声明，F6 是「这次做了什么」的说明。计数见 §1.3.1。

| # | 字段与文案 | 位置 | 可操作 |
| --- | --- | --- | --- |
| F1 | `verifySkipped = 未做字节数校验：远端未声明文件长度` | `src/verify.ts:75`，落点 `src/index.ts:264`、`src/index.ts:287`、`src/index.ts:308` | ✅ 这是本插件最反直觉也最正确的一条设计（「跳过」与「通过」不同形，`src/verify.ts:23-28`） |
| F2 | `verifySkipped = 未做字节数校验：远端声明了压缩编码` | `src/verify.ts:76` | ✅ |
| F3 | `mirrorSkipped = 未使用自动镜像：只有 GitHub 地址支持` | `src/auto-mirror.ts:154` | ✅ |
| F4 | `mirrorSkipped = 未使用自动镜像：无法从原始地址取得文件长度，无从证实镜像返回的是同一个文件` | `src/auto-mirror.ts:156-157` | ✅ |
| F5 | `mirrorSkipped = 未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致` | `src/auto-mirror.ts:159-160` | ⚠️ 三种失败（不可达 / 长度不符 / ETag 不符）合成一句，用户无从知道是哪一种 |
| F6 | 镜像采用时的 `reason`：`镜像 <prefix> 返回同一文件（<N> 字节，ETag 一致）` | `src/auto-mirror.ts:141-145` | ✅ |

#### G. 只读查询与面板路径

| # | 情形 | 位置 | 可操作 |
| --- | --- | --- | --- |
| G1 | `download_status` 读不到任何任务 → `tasks: []`，`ok: true` | `src/status.ts:126-133`（目录读不到就返回空 Map）、`src/status.ts:243` | ❌ **失败被完全吞掉**：目录权限不足 / 路径写错 / 进度根本没写成功，三者与「确实没有任务」在返回结构里**完全同形** |
| G2 | RPC `content type must be application/json` → HTTP 415 | `src/rpc.ts:130-137` | 不面向用户（浏览器 Network 面板可见） |
| G3 | RPC `body is not JSON` → HTTP 400 | `src/rpc.ts:139-144` | 同上 |
| G4 | RPC `ok:false, 'invalid client-request message'` | `src/rpc.ts:152-161` | 同上 |
| G5 | RPC `method "<x>" does not match endpoint "smartdl.status"` | `src/rpc.ts:162-169` | 同上 |
| G6 | 面板拉取失败 → 静默保留上一帧 | `src/client.js:263-265` | ⚠️ 有意为之（避免闪烁），但用户无法区分「没在下载」与「面板坏了」 |

#### 1.3.1 错误提示的统计结论

**计数口径**（先说清楚，避免数字口径漂移）：
- 「用户可见的错误路径」= 用户/模型在工具调用回执里真的会看到的那条失败文案。按此口径，§1.3 的 F 表只有 **F5** 算错误（它是「没启用镜像」的失败原因），F1–F4、F6 是**正向声明**（说明「这次没做 X」，不是失败）；G 表只有 **G1** 算错误，G2–G6 只出现在浏览器 Network 面板或根本不面向用户。

| 类别 | 条目 | 条数 |
| --- | --- | --- |
| A 下载前拒绝 | A1–A12 | 12 |
| B 探测失败降级 | B1–B4 | 4 |
| C 决策层降级原因 | C1–C4 | 4 |
| D 传输失败 | D1–D3 | 3 |
| E 完整性校验失败 | E1–E4 | 4 |
| F 未启用镜像 | F5 | 1 |
| G 查询失败被吞 | G1 | 1 |
| **合计** | | **29** |

逐条标注后：**✅ 可操作 12 条**、**⚠️ 部分可操作 16 条**、**❌ 不可操作 1 条**（C1），合计 29 条。
> 明细：A 类 ✅6（A2/A3/A4/A5/A7/A8/A9/A11）⚠️6；B 类 ✅2（B3/B4）⚠️2；
> C 类 ✅3（C2/C3/C4）❌1（C1）；D 类 ✅1（D3）⚠️2；E 类 ⚠️4；F 类 ⚠️1（F5）；G 类 ❌1（G1）。

另外有 **6 条正向声明**（F1–F4、F6 共 5 条 + `HASH_VERIFIED_MESSAGE` = `SHA-256 已校验`，`src/hash.ts:143`）：
它们全部 ✅ 可操作，且是本插件最反直觉也最正确的一处设计（「跳过」与「通过」不同形，`src/verify.ts:23-28`）。

- 唯一**成体系**的缺口不是「文案写得差」，而是：
  1. **D1 把子进程原始 stderr 直出**（`src/downloader.ts:302-307`）——退出码没有翻译层；
  2. **E 类四条的措辞把「已保留半包与旁车、可重试」这个最有用的信息丢了**（`src/verify.ts:129-132`、`src/hash.ts:118-126`）；
  3. **G1 让「读取失败」与「没有任务」同形**（`src/status.ts:126-133` + `src/status.ts:243`）——这一条与 README 自己反复强调的「静默失败防护」原则（`README.md:461-492` 的契约表）是冲突的，是既有设计里少见的自相矛盾处。

---

## 2. 差距分析

### 2.1 可视化进度反馈

| | 内容 | 证据 |
| --- | --- | --- |
| **已有什么** | 双轨进度写盘；面板浮层（文件名/百分比/进度条/速度/ETA）；`download_status` 只读查询；陈旧任务自动忽略；终态回执 30 秒 | §1.2 全部 |
| **缺什么** | ① 批次/队列层级（多文件同属一次请求）② 「等待中 / 排队位置」这个状态 ③ 失败原因在面板上可见 ④ 任何交互（取消/重试/清理）⑤ 面板只取 5 条、30 秒后消失，长任务之外的「历史」无处可看 | `src/client.js:28-42`、`src/client.js:99-186`、`src/types.ts:214`（状态只有 4 个） |
| **缺的属于哪一类** | **主要是表达不足**：③⑤ 是纯展示问题；① 需要一个新的数据字段（批次 id），但不需要新的执行模型；②④ 才是能力缺失（要新的状态与新的端点） | — |

### 2.2 优化错误提示

| | 内容 | 证据 |
| --- | --- | --- |
| **已有什么** | 29 条错误路径中 12 条已完全可操作、另有 6 条正向声明；最难的「静默失败」问题历史上已被系统性治理（`verifySkipped` / `mirrorSkipped` / `cancelled` 三个字段就是那轮治理的产物） | §1.3、`README.md:446-459` |
| **缺什么** | ① 子进程退出码翻译层（D1）② 校验失败文案补「怎么办」（E 类）③ `download_status` 区分「读不到」与「没有」（G1）④ 少数文案的措辞（A1/A6/A10/A12） | §1.3.1 |
| **缺的属于哪一类** | **纯表达不足**，且是局部收口：三个缺口里 ①③ 各自是一个小函数/一个字段，② 是改四个字符串 | — |

### 2.3 下载队列管理

| | 内容 | 证据 |
| --- | --- | --- |
| **已有什么** | 单个 URL 的完整下载能力（探测→决策→aria2/curl→校验→续传）；每个任务有独立 taskId 与进度文件 | §1.1、§1.2 |
| **缺什么** | ① 一次调用处理多个 URL 的入口 ② 并发上限 ③ 排队/优先级 ④ 取消单个任务 ⑤ 「现在在跑什么」的运行时视图 | 见下 |
| **缺的属于哪一类** | **能力缺失**，而且分两档（见 §3.1）：批量可以只改本插件；后台常驻必须接入 DSH 的 job 模型 | — |

#### 2.3.1 关于并发的三个可核实事实（这决定了「队列」到底要解决什么）

1. **插件内没有任何并发上限**。全仓 grep `semaphore|mutex|queue|maxConcurrent|concurrencyLimit|activeDownloads` 只命中一处 `queueMicrotask`（`src/progress.ts:255`），与下载并发无关。
2. **同一 agent step 内的 `smart_download` 调用天然串行**。`smart_download` 没有声明 `isConcurrencySafe`，而 DSH 的判定是「只有恰好返回 `true` 才算 parallel，未声明一律 exclusive」
   （`@deepseek-ai/dsh-tools/lib/index.js:3052-3064` 的 `executionMode`；agent loop 的并行池逻辑在 `@deepseek-ai/dsh-agent-loop/lib/index.js:619-621`）。
   → **同一轮里模型发起 5 个下载，实际是排队跑，一个跑完才起下一个。**
3. **跨轮/多 agent 时没有任何约束**。每个调用各起一个 aria2（决策档位 4 或 8 连接，`src/decision.ts:44-47`），彼此不知道对方存在。
   → 若两个会话/两个子 agent 同时下载，进程内会同时出现 2 个 aria2 × 8 连接。
   > ⚠️ 待确证：多 agent 场景下 DSH 是否共用同一个 agent loop 的并行池。本次未追到跨会话的调度路径，不做断言。

**这三条合起来说明**：单会话里「队列」其实已经由 DSH 的 exclusive 调度**免费提供**了（只是它不可见、不可控、不可取消）；真正缺的是
(a) 批量的**入口与可见性**，(b) 跨调用的**上限**，(c) **取消单个任务**的手段。

---

## 3. 必须由用户拍板的决策点

> 以下每条都给出选项与取舍，**不替用户选**。

### 3.1 决策点 1：「队列」的语义 —— 单次调用内批量 vs 后台常驻任务

#### 路线 A：单次工具调用内批量（同步返回）

形态：`smart_download` 增加一个数组参数（例如 `targets: [{url, output?, sha256?}, …]`），一次调用顺序或按并发上限下载完所有条目，最后**一次性返回**每个条目的结果。

| 维度 | 代价 |
| --- | --- |
| DSH 模型改动 | **无**。工具仍是 `exclusive`（`@deepseek-ai/dsh-tools/lib/index.js:3052-3064`），行为与现在一致 |
| 参数 DSL 可行性 | **已确证可行**：DSH 的参数 schema 子集支持 `array` + `items`（`@deepseek-ai/dsh-tools/lib/index.js:274-281` 的 `SCHEMA_TYPES` 含 `"array"`；`:286-295` 的键→类型约束表允许 `items` 仅出现在 `array` 节点上），现有测试里 `headers` 已用过嵌套对象节点（`test/tool-schema.test.ts:69-71`） |
| 改动面 | `src/index.ts`（参数 + 批量编排 + 批量 render）、`src/types.ts`（批量结果类型）、`src/progress.ts`（每个条目一个 taskId 已天然支持，可能需要加「批次 id」字段）、`src/client.js`（可选：按批次分组显示） |
| 用户体验 | 模型**阻塞等待全部下完**才拿到结果；一次 5 个大文件可能让一个 tool call 跑很久。无超时保护（`smart_download` 未声明 `timeoutMs`，而超时策略插件只对声明了 `timeoutMs` 的工具生效：`@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js:123-124`） |
| 取消 | 只能整批取消（一个 `exec.signal`，`src/index.ts:362`、`src/index.ts:392`、`src/index.ts:420` 三处判 aborted），**做不到取消第 3 个** |
| 面板 | 每个条目一个进度文件，面板已经能逐条显示（`src/client.js:320-322`），只要把 `STATUS_LIMIT=5` 调大或按批次过滤 |
| 失败语义 | 需要拍板：任一条失败是否整批失败？部分成功怎么表达？（这是**新增的语义决定**，不是技术问题） |
| 估量 | **中**（见 §4） |

#### 路线 B：后台常驻任务（fire-and-forget + 状态轮询）

形态：`smart_download` 立即返回一个任务/job id，真正下载在后台跑；模型通过 `download_status`（或 DSH 现成的 `job_output`）轮询。

**关键发现：DSH 已经内置了这套东西，不需要发明。** 本机 profile 里已经加载了：
`@deepseek-ai/dsh-jobs-local`（`C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml:53-54`）与 `@deepseek-ai/dsh-tool-jobs`（同文件 `:296-297`，另外 `:772`、`:954`、`:1228`、`:1473` 各有加载），对应模型侧的 `job_output` / `job_list` / `job_kill` 三个工具（`@deepseek-ai/dsh-tool-jobs/lib/index.js:74`、`:89-90`）。

| 维度 | 代价 |
| --- | --- |
| 接入方式 | 插件 `inject` 增加 `jobs`，调 `ctx.jobs.start(spec)`；spec 支持 `updateProgress(line)` 发布进度行（`@deepseek-ai/dsh-jobs-local/lib/index.js:412-434`、`:713-725`） |
| 可用性风险 | `jobs` 是**可选**服务：`start()` 在没有 job controller 的 profile 下**直接失败**（`@deepseek-ai/dsh-jobs/README.md`「Starting background work needs a controller」一节），纯 CLI profile 或未加载 `dsh-tool-jobs` 的组合下必须降级回同步模式 —— 等于**两条路径都要写、都要测** |
| 持久性 | 进程内 registry，**进程退出即丢**（`@deepseek-ai/dsh-jobs/README.md`「What can go wrong」：*Jobs managed by the shipped in-process registry die with the harness process*）。跨重启恢复**不在**这个契约内 |
| 与现有进度双轨的关系 | 需要拍板：`ctx.jobs` 的 output ring 与现有两条进度轨道**并行存在**（等于三条），还是用 jobs 取代轨道二？两者同时写会有两套真相 |
| 面板 | `@deepseek-ai/dsh-client-ui-jobs` 已在 profile 中加载（`cordis.yml:710-711`），但那是宿主自己的 job 面板；本插件现有的右下角 pill（`src/client.js:344-358`）与它是**两套 UI**，需要拍板谁负责显示 |
| 模型侧体验 | 已经内置了「不轮询、结算时收到 in-session 通知」的机制（`@deepseek-ai/dsh-tool-jobs/lib/index.js:260` 的系统提示片段），比自建轮询更好；但**要接受模型的下载调用不再是「一次调用一次结果」** |
| 取消 | `job_kill` 现成可用，**单任务取消免费拿到** |
| 改动面 | `src/index.ts`（拆分 execute 为「启动 + 后台执行」）、`src/types.ts`、新增一个 job 适配模块、`src/client.js`（是否继续显示）、以及**同步/异步双模式的降级逻辑** |
| 估量 | **大**（见 §4） |

#### 两条路的代价对比（一句话）

- **路线 A 的代价是「一次调用更慢、失败语义要新定义」**，但不动 DSH 模型，改动集中在本插件，风险可控。
- **路线 B 的代价是「多一个可选依赖 + 双模式降级 + 三套进度的取舍 + 跨重启不保证」**，换来的是真正的后台并行与免费的单任务取消。

> 注意：**这两条路不是互斥的**。也可以先做 A（入口 + 可见性），把 B 留到 P1。但这需要用户明确表态，因为 B 会改变 `smart_download` 的返回语义（从「结果」变成「回执 + 轮询」），是**破坏性变更**。

### 3.2 决策点 2：面板形态 —— 现有右下角 pill 之外还需要什么

现有 pill 的能力边界已列在 §1.2（5 行、每行 4 个信息位、无交互）。可选增量：

| 选项 | 取舍 |
| --- | --- |
| **① 批次列表（把同一次调用的多个条目分组显示）** | 需要新增「批次 id」字段并贯通写入/读取/显示三层。收益：用户能看出「这 5 个文件是同一件事」。代价：进度文件格式要加字段（向后兼容，读取端需容忍缺失） |
| **② 每文件进度（逐条明细）** | **基本已经有了**（`src/client.js:320-322` 就是逐条渲染）。真正要改的是 `STATUS_LIMIT=5`（`src/client.js:29`）—— 超过 5 个条目时面板会静默少显示。若采纳路线 A 且批量大小可能 >5，这一项从「可选」变成「必须」 |
| **③ 失败重试入口** | **代价最高的一项**。要新增一个写端点（现有 RPC 只有 `POST /api/smartdl.status` 且是只读的，`src/rpc.ts:22`、`src/rpc.ts:175`），要新增任务元数据（原 URL / output / sha256 都要存下来才能重试，而现在进度文件里**没有** URL，见 `src/progress.ts:136-144` 的 `DownloadTaskFile` 结构），还要定义重试的幂等与并发语义。≈ 一次小型 RPC 体系扩建 |
| **④ 取消单个任务** | 需要 Host 侧持有「taskId → AbortController」的运行时可取消表（现在没有；`exec.signal` 由宿主注入，插件无法为单个任务造信号），同样是**新能力**而非新表达。若采纳路线 B，这一项由 `job_kill` 免费提供 |
| **⑤ 清理/隐藏历史** | 最小的一项：`ProgressReporter.cleanup()` 已存在但无人调用（`src/progress.ts:379-394`），缺的只是一个触发入口与「哪些算历史」的判定 |

**需要用户拍板的具体问题**：
1. 面板要不要交互（按钮）？—— 要，就得扩建 RPC 到「写」的方向；不要，则 P0 面板只做展示。
2. 面板是否继续作为唯一入口，还是把队列视图交给宿主已有的 job 面板（`@deepseek-ai/dsh-client-ui-jobs`）？
3. 进度文件只增不减（`cleanup()` 从未被调用）是否要处理？超过 N 个历史任务后面板/`download_status` 的信噪比会持续下降。

### 3.3 决策点 3：是否需要限速 / 优先级 / 取消单个任务

| 能力 | 现状证据 | 若要做的代价 |
| --- | --- | --- |
| **限速** | 现在**完全没有**。aria2 参数里没有 `--max-overall-download-limit` / `--max-download-limit`（`src/downloader.ts:117-136` 全部参数），curl 参数里也没有 `--limit-rate`（`src/downloader.ts:161-172`） | 小：两个参数各加一个 flag + 两个新入参 + 文案。但「限速」的定义要拍板：总带宽上限（跨任务共享）还是每任务上限？前者需要跨调用状态 |
| **优先级** | 现在**完全没有**（`decide` 只看文件大小与 aria2 可用性，`src/decision.ts:71-128`） | 中：优先级只有在「多个任务同时在等」时才有意义。路线 A 下是数组内排序（小）；路线 B 下要动 job 调度（大） |
| **取消单个任务** | 现在**只能整批/整调用取消**：`exec.signal` 是唯一的取消源，三处判 `aborted`（`src/index.ts:362`、`:392`、`:420`），取消后统一走 `reporter.cancel()`（`src/progress.ts:367-370`） | 中：需要 Host 侧持有可取消表 + 写端点。**但若采纳路线 B，这一项由 `job_kill` 免费提供** —— 这也是路线 B 唯一明确「省掉一整块工作量」的地方 |

---

## 4. 工作量初估

分档依据：**改动文件数 × 是否需要新数据字段 × 是否需要新端点/新服务 × 是否需要新增测试面**。
（本仓库测试基线 343 例、`execute.test.ts` 单文件 1018 行，任何触及 `execute()` 主流程的改动都必须补端到端用例 —— 这是既有的项目规范，`README.md:461-492` 的契约表把它写成了硬约束。）

| 子项 | 档位 | 依据 |
| --- | --- | --- |
| 错误提示：退出码翻译层（D1） | **小** | 新增一个纯函数（退出码 → 人话）替换 `src/downloader.ts:302-307` 的拼接；纯函数可单测，不碰执行流程 |
| 错误提示：校验失败文案补「怎么办」（E 类） | **小** | 改 4 个字符串（`src/verify.ts:129-132`、`src/hash.ts:118-126`）；但会动 `test/` 里的断言，需同步更新 |
| 错误提示：`download_status` 区分「读不到」与「没有」（G1） | **小** | `src/status.ts` 加一个「扫描失败目录数」字段 + schema/render 各加一处；不改执行流程 |
| 错误提示：其余措辞（A1/A6/A10/A12、F5） | **小** | 纯字符串 + 断言更新 |
| 可视化：面板 `STATUS_LIMIT` 与失败原因可见 | **小** | `src/client.js` 单文件，改常量 + 加一行 meta；无 Host 侧改动 |
| 可视化：批次分组（新增批次 id） | **中** | 要动 `src/types.ts`（ProgressRecord 加字段）、`src/progress.ts`（写入）、`src/status.ts`（读取）、`src/client.js`（显示）**四层**，且要保证老进度文件向后兼容（`src/status.ts:119-122` 已有兼容垫片的先例） |
| 队列：路线 A（单次调用内批量） | **中** | `src/index.ts` 的 `execute` 需要重构成「单条目执行 + 批量编排」两层（现在 `execute` 是一个 288 行的单体，`src/index.ts:141-428`）；新增参数与批量结果类型；新增并发上限；**新增失败语义**；测试面：`execute.test.ts` 需要新增批量用例（含部分失败） |
| 队列：路线 B（后台常驻） | **大** | 接入可选服务 `ctx.jobs` + 同步/异步双模式降级 + 三套进度的取舍 + 面板归属决策 + 跨重启不保证的文档化 + 两条路径各自端到端测试。**且 `src/index.ts` 的 execute 必须拆成「启动」与「后台执行」两个可独立测试的部分** |
| 限速 | **小** | 两个下载器的参数拼接各加一项 + 两个入参（若只做「每任务上限」） |
| 优先级 | **中**（路线 A）/ **大**（路线 B） | 见 §3.3 |
| 取消单个任务 | **中**（自建）/ **小**（复用 `job_kill`） | 见 §3.3 |

**合计（不含「不做」项）**：
- 只做错误提示 + 可视化收口：**小**，且可以在一次迭代内完成；
- 加路线 A 队列 + 限速：**中**；
- 路线 B：单独一项就是 **大**。

---

## 5. 明确「不做」的清单（P0 范围内的边界）

以下不是「遗漏」，是本轮建议**明确排除**、并写进方案以免范围蔓延的项（如用户要求，可移出）：

1. **跨进程 / 跨重启的任务持久化与恢复**。DSH 的 `ctx.jobs` 契约本身就声明进程内 registry 不跨重启（`@deepseek-ai/dsh-jobs/README.md`），自建一套持久化队列属于 P2 量级。
2. **服务器端队列协议**（aria2 的 RPC 模式 / `--input-file` 批处理）。本插件目前一律以「一个文件一个子进程」的方式调用（`src/downloader.ts:313-353`），改成 aria2 RPC 会重写整个下载执行层与进度解析层。
3. **断点续传的跨任务合并**（多个半包合并成一个任务）。现有续传语义是「同一 output 路径的旁车指纹比对」（`src/resume.ts:142-220`），不做跨文件合并。
4. **面板上的拖拽排序 / 队列重排 UI**。优先级即便做，也只做数值排序，不做交互式重排。
5. **把 `download_status` 变成可写工具**（在其中取消/重试）。若走路线 B，写操作应交给宿主的 `job_kill`，而不是把只读工具改成双职责。

---

## 6. 待确证清单（本文未敢下断言的点）

| # | 待确证内容 | 为什么没确证 |
| --- | --- | --- |
| 1 | 多 agent / 多会话同时下载时，是否共用同一个 agent loop 的并行池（决定「跨调用并发上限」是否真的必要） | 未追到跨会话调度路径；只在 `@deepseek-ai/dsh-agent-loop/lib/index.js:619-621` 看到单 step 内的池 |
| 2 | `ctx.jobs.start()` 在**本机实际运行的 desktop profile** 里是否可用（profile 里确实加载了 `dsh-jobs-local` 与 `dsh-tool-jobs`，但 `start()` 还要求「controller 服务该 owner」，owner 作用域与插件所在 row 的关系未实测） | 需要一次真实插件加载实验，本轮不写代码 |
| 3 | 路线 A 的批量并发上限取多少合适（是否与 `decideConcurrency` 的 4/8 档位联动） | 取决于用户对「多个大文件同时下载」的取舍；且需要真实网络实测 |
| 4 | 面板在批量（>5 条）下的实际观感（是否需要滚动/折叠） | 需要真实浏览器渲染验证，本轮只做静态分析 |
| 5 | 现有 `dist/` 与 `src/` 的同步状态（`dist/client.js` 由 `scripts/copy-client.mjs` 复制，`package.json:87`）在改动 `src/client.js` 后是否需要重新构建发布 | 本轮不改代码，未验证构建链 |
| 6 | 已安装的 profile 里插件版本是 **1.1.2**（`C:\Users\Qing\.dsh-home\profiles\desktop\node_modules\@leisureyu\dsh-smart-dl\package.json`），而工作区是 **1.2.0** | 说明本机 GUI 里跑的不是工作区代码；任何「面板实测」结论都必须先确认跑的是哪一份 |

---

## 附录 A：本轮的验证动作（可复现）

```
# 工作目录
C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download

# 1. 测试基线（实测 343 tests / 341 pass / 2 skipped / 0 fail）
node --test --import tsx "test/**/*.test.ts"

# 2. 并发相关的否定证据（应只命中 progress.ts 的 queueMicrotask）
rg -n "semaphore|mutex|queue|maxConcurrent|concurrencyLimit|activeDownloads" src

# 3. 工具 schema 支持数组的证据
rg -n "SCHEMA_TYPES|items: \[\"array\"\]" \
  "C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js"

# 4. 宿主 job 能力与并行调度的证据
rg -n "maxParallelToolCalls|executionMode" \
  "C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js" \
  "C:\Users\Qing\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js"

# 5. profile 已加载的 job 相关插件
rg -n "jobs|tool-jobs" "C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml"
```

## 附录 B：本文引用的仓库外文件

| 路径 | 用途 |
| --- | --- |
| `…\dsh\node_modules\@deepseek-ai\dsh-jobs\README.md` | 后台任务契约（所有权、进程内生命周期、start 的前置条件） |
| `…\dsh\node_modules\@deepseek-ai\dsh-jobs-local\lib\index.js:412-434` | `start(spec)` 与 `updateProgress` 的实际签名 |
| `…\dsh\node_modules\@deepseek-ai\dsh-tool-jobs\lib\index.js:74-90` | `job_output` / `job_list` / `job_kill` 与默认等待超时 |
| `…\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js:3052-3064` | 工具并行/独占的判定规则（未声明即 exclusive） |
| `…\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:619-621`、`:1534` | 单 step 并行池与 `maxParallelToolCalls` 默认 10 |
| `…\dsh\node_modules\@deepseek-ai\dsh-tool-call-timeout-policy\lib\index.js:123-124` | 超时只对声明了 `timeoutMs` 的工具生效 |
| `C:\Users\Qing\.dsh-home\profiles\desktop\cordis.yml:53-54`、`:296-297`、`:710-711` | 本机 profile 实际加载的 jobs 相关插件 |
