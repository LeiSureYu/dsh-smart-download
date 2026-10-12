# dsh-smart-dl 1.3 实施方案与验收标准（P0 / P1 / P2 合并稿）

> 本文是 1.3 的**唯一实施方案依据**。上游三份调研稿：
> [PLAN-P0-QUEUE.md](./PLAN-P0-QUEUE.md)（t1）、[PLAN-P1-CONCURRENCY.md](./PLAN-P1-CONCURRENCY.md)（t2）、
> [PLAN-P2-PLATFORM.md](./PLAN-P2-PLATFORM.md)（t3）。
>
> - 本文**不修改任何源码**，只产出这一份文档。
> - 每条结论后面标注来源：`[t1]` / `[t2]` / `[t3]` = 上游文档，`src/x.ts:12` = 本轮亲自核对过的源码行号。
> - 凡上游文档与源码不一致的地方，**以源码为准**，并在 [§0.2](#02-对上游三份文档的纠正本轮实测) 逐条写明纠正了什么。
> - 基线：工作区 `package.json:3` = **1.2.0**；本轮实测 `pnpm test` → **343 tests / 341 pass / 2 skipped / 0 fail**（2026-10-12）。
> - 未确证的判断一律标注**「待确证」**，不得当作已成立的前提。

---

## 0. 摘要

### 0.1 三阶段各一句话

| 阶段 | 一句话结论 | 依据 |
| --- | --- | --- |
| **P0 完善基础体验** | **做**：下载队列只做「单次调用内批量（路线 A）」，**不做**后台常驻（路线 B）；可视化与错误提示各做三处定点收口，不做重设计。 | `[t1]` §0、§3.1、§4；本轮核对 `src/index.ts:72-108`、`src/decision.ts:44-47`、`src/status.ts:126-133`、`src/progress-parse.ts:22-23` |
| **P1 强化智能核心** | **部分做**：「多引擎」= 多镜像源按实测吞吐排序，不是多后端；「动态并发调整」**本轮不做**（上调可做但收益不成比例、下调实测失败），改为做「记录实际吞吐与实际有效连接数」这一件不需要 RPC 的事。 | `[t2]` §1.3、§3.4、§3.5、§5 |
| **P2 扩展生态支持** | **不做**：macOS 维持现状（无可核对哈希的**可信**二进制来源）；FTP / SFTP 不做；BitTorrent **不进 `smart_download`**，若探索则做独立工具。本轮只更新文档证据，零代码改动。 | `[t3]` §A.3、§B.4；本轮核对 `src/url.ts:18`、`src/downloader.ts:44-49` |

### 0.2 对上游三份文档的纠正（本轮实测）

> 口径：上游三份文档的**结论**全部复核通过；以下 5 条是**表述或事实细节**需要纠正的地方。
> 纠正不改变任何一条「做 / 不做」的结论，但会改变某些工作项的**理由**与**边界**，必须写下来。

| # | 上游的说法 | 源码/实测事实 | 影响 |
| --- | --- | --- | --- |
| **C1** | `[t1]` §1.2 说 `cleanup()` 「在生产代码里从未被调用」——即进度文件只增不减，读起来像**疏漏** | 属实但**不是疏漏**：源码注释明写「刻意**不**在下载结束时自动调用：面板依赖这些文件渲染『已完成 / 失败』回执，立刻删除会让回执永远看不到」，它是给调用方准备的**显式接口**（`src/progress.ts:372-394`） | P0 的「清理历史」决策点要重新表述为「要不要**新增一个触发入口**」，而不是「有个死代码没接上」。禁止把它当成「顺手删掉就干净了」的理由 |
| **C2** | `[t1]` §3.2 只提到面板侧 `STATUS_LIMIT = 5`（`src/client.js:29`），没提服务端还有一层硬上限 | 服务端另有 `MAX_STATUS_LIMIT = 50`（`src/status.ts:74`），在 `readDownloadStatus()`（`src/status.ts:237`）与 RPC（`src/rpc.ts:94`）两处夹取；`download_status` 工具侧默认 `DEFAULT_STATUS_LIMIT`（`src/status.ts:210`） | 批量路线的**批次大小上限是 50，不是「随便多大」**；面板取数（5）与工具默认（10）是两个不同的数，都要分别处理 |
| **C3** | `[t1]` §1.3.1 统计口径：29 条错误路径 = ✅12 / ⚠️16 / ❌1 | 计数本身可复核，但**逐条明细与表头对不上**：表头写「✅ 可操作 12 条」，而明细列出的 A 类 ✅ 是 8 条（A2/A3/A4/A5/A7/A8/A9/A11），加上 B 类 2 + C 类 3 + D 类 1 = 14，且 E 类 4 条全记 ⚠️、F5 记 ⚠️、G1 记 ❌ | 「有 12 条已经可操作」这个**量级**结论不受影响（缺口在 3 处，见 P0-2 依据），但 **1.3 实施时不得引用精确数字**，只引用「缺口集中在 D1 / E 类 / G1 三处」 |
| **C4** | `[t1]` §1.2 把自动镜像的选择依据描述为「按候选表顺序取第一个通过校验的」 | 与源码一致，**不是矛盾**：`Promise.allSettled` 的返回顺序即输入顺序（`src/auto-mirror.ts:130-146`），所以「并行探测 + 按表序取第一个」两句同时成立 | 明确保留：P1 的「按速度排序」是对这条既有顺序的**替换**，不是新增探测（`[t2]` §2） |
| **C5** | 三份文档都提到「工作区 1.2.0 / 本机 profile 1.1.2」，但没把它写成**验收前置** | 属实。`package.json:3` = `1.2.0`；本机 profile 装的是 `1.1.2` | **所有涉及 GUI 面板的验收，必须先在目标 profile 上确认跑的是哪一份代码**，否则测到的是旧版本（见 [§6](#6-风险与未知) R1） |
| **C6** | `[t1]` §1.3.1 把 D1 的修法描述为「退出码 → 人话」的翻译层，隐含「退出码表是现成的」 | 部分不成立：**随包 aria2 二进制查不到退出码表**——`aria2c -h#help` 的合法 tag 里**没有 `#exit-status`**（本轮实测，完整 tag 列表见 P0-1 备注）；curl 的 `--help all` 也只列选项不列退出码 | P0-1 增加一条硬约束：映射表里每个码必须能追到官方文档或受控实测，**不得凭记忆填表** |

### 0.3 一件必须先说清楚的事：本轮的「做」有多大

| 阶段 | 本轮做 | 本轮不做 | 估量 |
| --- | --- | --- | --- |
| P0 | 7 个工作项（3 项错误提示 + 2 项可视化 + 1 项批量队列 + 1 项可选限速） | 后台常驻、面板写操作、跨重启持久化 | 错误提示+可视化 = 小；批量 = 中；合计一次迭代可完成 |
| P1 | 2 个工作项（解析 `CN` / 本地吞吐缓存） | 下载中动态调并发、预探测、新增后端 | 小～中，且**不引入 RPC** |
| P2 | 0 行代码，只有文档证据更新 | macOS、FTP、SFTP、BT | 文档级 |

---

## 1. P0：完善基础体验

### 1.1 结论

| P0 子项 | 本轮 | 后续 | 明确不做 |
| --- | --- | --- | --- |
| **下载队列管理** | ✅ **做**：单次调用内批量（路线 A），含批次可见性 | 路线 B（后台常驻）留待用户拍板后另立项 | 跨进程/跨重启持久化、服务器端队列协议、面板拖拽排序、把 `download_status` 改成可写工具 |
| **可视化进度反馈** | ✅ **做**：面板显示失败原因、`STATUS_LIMIT` 对齐批量、进度记录加批次 id | 交互式按钮（取消/重试）需扩建 RPC 写端点，留待拍板 | 重做面板、历史任务浏览器、按批次的折叠/滚动交互（未确证需要） |
| **优化错误提示** | ✅ **做**：退出码翻译层（D1）、校验失败补「怎么办」（E 类）、`download_status` 区分「读不到」与「没有」（G1） | 其余 ⚠️ 文案（A1/A6/A10/A12、F5）作为同一批字符串改动一并收口 | 把 29 条全部重写（其中大部分已经可操作，见 §0.2 C3） |

### 1.2 依据（可追）

- 队列是**能力缺失**：全仓 grep `semaphore|mutex|queue|maxConcurrent|concurrencyLimit|activeDownloads` 只命中 `src/progress.ts:255` 的 `queueMicrotask`，与并发无关 `[t1]` §2.3.1。
- 同一轮内的 `smart_download` 调用**已经天然串行**：工具未声明 `isConcurrencySafe`，DSH 的判定是「未声明即 exclusive」（`[t1]` §2.3.1 引 `@deepseek-ai/dsh-tools` `executionMode`）。本轮 grep 复核：`src/` 内确实**没有** `isConcurrencySafe` 也没有 `timeoutMs`。
- 参数 DSL 支持数组：`test/tool-schema.test.ts:55-59` 已断言 7 个参数与 `required: ['url']`，且 `headers` 已是嵌套 object 节点（`test/tool-schema.test.ts:69-71`）；DSH 的 schema 子集含 `array` + `items` `[t1]` §3.1。
- 错误提示缺口是三处定点：D1 原始 stderr 直出（`src/downloader.ts:301-307`，本轮核对命中）、E 类四条（`src/verify.ts:128-132`、`src/hash.ts:118-126`，本轮核对命中）、G1 读取失败与「没有任务」同形（`src/status.ts:126-133` 的 `catch { return out }` + `src/status.ts:243` 的 `ok: true`，本轮核对命中）。
- 可视化缺的是表达：面板每行只有 4 个信息位、无交互，失败原因 `msg` 只在 `title` 悬停里（`src/client.js:119`）`[t1]` §1.2。
- `decideConcurrency()` 的档位是 1（curl）/ 4 / 8（aria2），阈值 `SIZE_THRESHOLD = 1MB`、`LARGE_FILE = 8MB`（`src/decision.ts:18`、`:32`、`:44-47`，本轮核对命中）——批量队列的并发上限若与它联动，必须走这个函数而不是另立一套。

### 1.3 工作项拆分

> 每项格式固定：**改动文件 / 验收标准 / 验证命令**。验证命令可直接复制执行。
> 统一前置（下称 `$REPO`）：
>
> ```powershell
> $REPO = "C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download"
> cd $REPO
> pnpm test          # 基线：343 tests / 341 pass / 2 skipped / 0 fail（2026-10-12 实测）
> ```

---

#### P0-1 子进程退出码翻译层（对应 D1）

- **改动文件**：`src/downloader.ts`（`runProcess` 的 `close` 分支，`src/downloader.ts:301-307`）；建议把映射做成同文件的纯函数 `describeExitCode(command, code, signal, stderrTail)`，纯函数放 `src/downloader.ts` 或新建 `src/exit-code.ts`（二选一，不新增抽象层）。
- **验收标准**：
  1. 退出码 0 的行为**逐字节不变**（仍 `resolve()`，不产生任何文案）；
  2. 已知退出码给出中文原因与下一步：curl 侧至少覆盖 18（传输不完整）/ 22（HTTP 错误）/ 28（超时）/ 33（服务器不支持续传）/ 56（接收失败）；aria2 侧至少覆盖 1 / 3 / 9 / 13 / 24；
  3. 未知退出码**必须原样保留**退出码与 stderr 尾部，不得丢弃、不得编造原因；
  4. 原文案里的 `command` 绝对路径**不再出现**在用户可见文案里（改为 `aria2c` / `curl`），但完整命令仍进日志或保留在详情字段。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/downloader.test.ts test/runprocess.test.ts
  pnpm typecheck
  ```
- **备注**：纯函数优先单测覆盖「未知码不丢信息」这一条；不得为了好看而吞掉 stderr。
  **退出码取值必须先查证再写，不得凭记忆填表**（写错映射比不翻译更糟：它会给出错误的下一步）。
  本轮实测了查证通道，结论如下：
  - curl 侧：`curl --help all` 只列选项、**不列退出码**；退出码定义在 man page / 官方文档里。
  - aria2 侧：**随包二进制查不到退出码表**——`aria2c -h#help` 列出的合法 tag 只有
    `#basic, #advanced, #http, #https, #ftp, #metalink, #bittorrent, #cookie, #hook, #file, #rpc, #checksum, #experimental, #deprecated, #help, #all`，
    **没有 `#exit-status`**（本轮实测：`--help=#exit-status` 只回一句「Refer to man page for more information.」）。
  - 因此 aria2 侧的码只能来自：官方文档/man page（带 URL 引用）或**对受控服务器实测观察**。
    P0-1 的映射表里每一个码都必须能追到上述来源之一，否则该码不进表（宁可不翻译，不可翻译错）。

---

#### P0-2 完整性校验失败文案补「怎么办」（对应 E 类）

- **改动文件**：`src/verify.ts`（`describeMismatch`，`src/verify.ts:128-132`）、`src/hash.ts`（`HASH_UNREADABLE_MESSAGE` 与 `describeHashMismatch`，`src/hash.ts:118-126`）。
- **验收标准**：
  1. 四条文案（长度不符 / 文件不存在 / SHA-256 不匹配 / 无法读取）都补上**下一步**，至少包含「半包与旁车已保留、可重试」这一事实；
  2. 文案里必须**保留**原有的可核对数据（落盘字节数、远端声明字节数、期望与实际摘要），只加不删；
  3. SHA-256 不匹配时，两个 64 位 hex **不得**以「并排一整行」的形式呈现（改为截断展示或分行），且截断后仍能区分二者；
  4. 断言只依赖「文案包含下一步关键词」，**不得**对完整句子逐字断言（避免以后改措辞就红）。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/verify.test.ts test/hash.test.ts test/execute.test.ts
  ```
- **备注**：改文案会动 `test/` 里的既有断言，必须同步更新——这是**允许**的，但更新后必须仍能断言「下一步信息存在」。

---

#### P0-3 `download_status` 区分「读不到」与「没有任务」（对应 G1）

- **改动文件**：`src/status.ts`（`collectFromDir` 的 `catch`，`src/status.ts:126-133`；返回结构 `src/status.ts:243`）、`src/types.ts`（`DownloadStatusSnapshot` 加字段）、`src/index.ts`（`download_status` 的 output schema `src/index.ts:449-475` 与 `render` `src/index.ts:476-491`）。
- **验收标准**：
  1. 新增字段（建议名 `scanFailedDirs`：目录路径数组），**只在有目录读取失败时非空**；
  2. 两个目录都读不到时，返回**必须**能让调用方区分「没有任务」与「读不到」——`tasks: []` 与 `ok: true` 单独出现时不足以表达，需配套一个明确的诊断字段或 `ok: false`（**具体形态由实现者定，但必须可被断言**）；
  3. 目录读得到但确实为空时，行为与今天**逐字段相同**（这是回归项，防止把正常空目录也报成失败）；
  4. 新增字段必须**向后兼容**：老的读取端忽略它不会报错。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/status.test.ts test/tool-schema.test.ts
  pnpm typecheck
  ```
- **备注**：这条与 README 的「静默失败防护」契约表（`README.md:461-492`）是**冲突项**，属于既有设计的自相矛盾处，修它是修 bug 不是加功能 `[t1]` §1.3.1。

---

#### P0-4 面板显示失败原因 + 容量对齐批量（对应可视化①②）

- **改动文件**：`src/client.js`（`STATUS_LIMIT` `src/client.js:29`、`TaskRow` 的 meta 行 `src/client.js:99-186`、`title` 用法 `src/client.js:119`）；`dist/client.js` 由构建生成，**不手改**。
- **验收标准**：
  1. `STATUS_LIMIT` 由 5 提到 **50**（与服务端 `MAX_STATUS_LIMIT = 50`，`src/status.ts:74` 对齐；见 §0.2 C2）；
  2. 任务处于 `failed` / `cancelled` 时，失败原因在**面板正文可见**，不再只存在于悬停 `title`；
  3. 单行信息位数量**不减少**（文件名 / 百分比 / 进度条 / 速度·ETA 全部保留）；
  4. `role="progressbar"` 与 `aria-valuenow` 保持（`src/client.js:147-171`，无障碍不能退）；
  5. 改完必须 `pnpm build` 让 `dist/client.js` 同步（`scripts/copy-client.mjs`，`package.json` 的 `build` 脚本），否则面板加载的还是旧文件。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/rpc.test.ts
  pnpm build
  # 构建产物与源同步（应无差异输出）
  git diff --stat -- dist/client.js src/client.js
  ```
- **备注**：本轮**不做**面板按钮（取消/重试）。那需要新增写端点（现有 RPC 只有只读的 `POST /api/smartdl.status`，`[t1]` §3.2 ③④），属于新能力，不在本轮。

---

#### P0-5 进度记录加「批次 id」并贯通四层

- **改动文件**：`src/types.ts`（`ProgressRecord` 加可选字段，`src/types.ts:184-211`）、`src/progress.ts`（写入 `src/progress.ts:136-144` 的 `DownloadTaskFile` 与轨道一写入路径）、`src/status.ts`（读取，`src/status.ts:148-163`）、`src/client.js`（显示，可选分组）。
- **验收标准**：
  1. 新增字段**可选**：老进度文件缺该字段时，读取端不得报错、不得改变原有 `status`/`pct`/`msg` 的解析结果（这是硬回归项）；
  2. 一次批量调用的所有条目共享**同一个批次 id**，且该 id 在两条进度轨道里都写入（缺轨道一时不报错，与既有行为一致）；
  3. 单条目调用（非批量）产生的批次 id 也必须存在且唯一，便于统一显示；
  4. 批次 id 只做**分组标签**，不参与任何执行/并发决策。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/progress.test.ts test/status.test.ts
  pnpm typecheck
  ```
- **备注**：四层都要改，是本轮 P0 里除批量之外**唯一**要动数据格式的项；向后兼容的先例是 `src/status.ts:114-123` 的 `statusFrom()` 垫片。

---

#### P0-6 单次调用内批量下载（路线 A）——P0 的核心项

- **改动文件**：`src/index.ts`（新增数组参数、`execute` 拆成「单条目执行 + 批量编排」两层，现有 `execute` 是 288 行单体 `src/index.ts:141-428`）、`src/types.ts`（批量入参与结果类型）、`src/index.ts` 的 output schema 与 `render`（批量结果的文案）、`src/progress.ts`（每条目一个 taskId + P0-5 的批次 id）、`test/execute.test.ts`（新增批量用例）。
- **验收标准**：
  1. 新增可选数组参数（建议名 `targets`，`items` 为对象，元素字段与现有单条参数同构：`url` 必填，`output` / `sha256` 可选），**不破坏现有 7 个参数**：`test/tool-schema.test.ts:55-59` 的断言更新后仍必须通过，且 `required: ['url']` 保持（要么 `url` 仍必填、要么明确改为「`url` 或 `targets` 二选一」并更新断言——**必须二选一并写清**）；
  2. `url` 与 `targets` **同时提供**时必须有确定行为（拒绝并给可操作文案，或明确以某一个为准），且该行为被断言；
  3. 批量执行有**显式并发上限**，且上限值来自 `decideConcurrency()`（`src/decision.ts:44-47`）而不是另立常量；单条目内部仍按现有决策走（不改变 `decide()`）；
  4. **失败语义明确**：部分失败时，返回值必须能逐条看出「哪条成功、哪条失败、失败原因」，且失败条目**不得**让成功条目的结果丢失；
  5. 取消：整批 `exec.signal` 取消时，所有未完成条目必须走 `reporter.cancel()`（与现有三处 `exec.signal.aborted` 判定，`src/index.ts:362`、`:392`、`:420` 的语义一致），已完成条目的结果**不得**被改成失败；
  6. 批量大小超过服务端 `MAX_STATUS_LIMIT = 50`（`src/status.ts:74`）时必须**显式拒绝或分批**，不得静默丢弃进度记录（见 §0.2 C2）；
  7. 单条目路径（只传 `url`）的返回结构与文案与今天**逐字段相同**（回归项，`test/tool-schema.test.ts:88-179` 的 render 断言必须仍绿）。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/execute.test.ts test/tool-schema.test.ts
  pnpm test
  pnpm typecheck
  ```
- **备注**：
  - 这是**破坏性风险最低**的队列路线：不动 DSH 模型，工具仍是 exclusive `[t1]` §3.1 路线 A。
  - 无超时保护（`smart_download` 未声明 `timeoutMs`，而超时策略插件只对声明了该字段的工具生效）`[t1]` §3.1 —— 批量会放大这个问题，**是否声明 `timeoutMs` 需要拍板**（见 §5 D3）。

---

#### P0-7 每任务限速参数（可选，取决于 §5 D5）

- **改动文件**：`src/downloader.ts`（`buildAria2Args` `src/downloader.ts:108-137` 加 `--max-download-limit`；`buildCurlArgs` `src/downloader.ts:152-173` 加 `--limit-rate`）、`src/index.ts`（新增入参 + schema + description）。
- **验收标准**：
  1. 新参数**可选**，缺省时两条命令行**逐字节不变**（回归项）；
  2. 参数值必须校验（拒绝非正数 / 非法单位），非法时**在发起任何请求之前**抛错（与 `sha256` 的既有做法一致，`src/index.ts:154-164`）；
  3. 语义写清楚是**每任务上限**（不涉及跨调用共享状态）；若要做总带宽上限，必须另立工作项（需要跨调用状态，`[t1]` §3.3）；
  4. description 必须说明「单位」与「这是每任务上限」。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/downloader.test.ts test/tool-schema.test.ts
  ```

---

## 2. P1：强化智能核心

### 2.1 结论

| P1 子项 | 本轮 | 后续 | 明确不做 |
| --- | --- | --- | --- |
| **「多引擎」** | ✅ 做（收窄定义）：**对候选镜像源按实测吞吐排序** | 无 | 新增下载后端（wget / axel / 自研分片器）；「并发下同一文件再取消慢的」式竞速 |
| **「测速」** | ✅ 做：把下载本身免费产生的吞吐与**实际有效连接数**记下来（方案 B 第一步） | 方案 B 第二步（用缓存数据判断「瓶颈不在并发数」）1.4 再评估 | 下载前预探测（方案 A）；下载中自适应（方案 C） |
| **「动态并发调整」** | ❌ **不做**（有实测证据） | 无 | 上调可做但收益不成比例；**下调实测失败** |

### 2.2 依据（可追，全部来自本机受控实测）

**能力边界（这是本节的硬结论）：**

| 结论 | 证据 |
| --- | --- |
| 命令行方式**不可能**改运行期并发 | `buildAria2Args()` 把 `-x/-s` 拼进 argv 后 `spawn`（`src/downloader.ts:108-137`、`:325`），进程启动即固定 `[t2]` §1.1 |
| RPC 方式**可以**改，但方向不对称 | `--enable-rpc` 后 `aria2.changeOption` 返回 `OK`、`getOption` 读回新值；**上调 x1→x8 完整成功 3/3（exit 0）；下调 x8→x1 失败 2/2**（`errorCode=1`、`errorMessage="No URI available."`、落盘 30618416/33554432 缺字节）；下调到 x4 成功 2/2 `[t2]` §1.3 |
| 「下调失败」不是测试环境的问题 | 对照实验：no-op `changeOption`（值不变）2/2 完整成功；`changeGlobalOption` 对该选项无效且下载始终 8 连接、成功；同一服务器 `-c` 续传 4.81s 精确补完 `[t2]` §1.4、§4.3 |
| RPC 模式有额外硬前置 | `--enable-rpc` 下 aria2 下载完成后**不自己退出**，必须 `aria2.shutdown`；直接给现有 `spawn` 加 RPC 会「成功但永不返回」（`downloadWithAria2` 依赖 `child.on('close')`，`src/downloader.ts:287`）`[t2]` §1.6 |
| curl 路径上不存在运行期并发接口 | `--parallel` 是跨多 URL，不是单文件多连接；`buildCurlArgs` 也没用这些开关（`src/downloader.ts:152-173`）`[t2]` §1.5 |
| 「多引擎」= 多镜像源，不是多后端 | 已有雏形：`mirror: "auto"` **并行探测**所有候选（`Promise.allSettled`，`src/auto-mirror.ts:130-132`），再按候选表顺序取第一个通过「长度 + ETag 同源证明」的（`src/auto-mirror.ts:134-146`）；注释明写「顺序仍然由候选表决定」（`src/auto-mirror.ts:106-110`）——本轮核对命中。缺的只是「按速度选」 |
| 数据是**免费**的，只是被丢了 | `parseAria2Summary()` 的正则**已经匹配 `CN:\d+`**（`src/progress-parse.ts:22-23`）但 `ParsedSummary` 只有 `pct/spd/eta`（`src/progress-parse.ts:13-20`），解析结果只取 `m[1]`/`m[2]`/`m[3]`（`src/progress-parse.ts:48-51`）——本轮核对命中 |
| 收益上限很小 | 32MB 受控实验中「先慢后快」（x1→x8）19.5s vs 固定 x8 的 17.35s，**反而慢 2.2s**；收益只在「猜低了并发」时为正，且随文件变大占比变小，但**实现成本不随文件大小变化** `[t2]` §3.3、§3.4 |

**为什么推荐方案 B 而不是 A / C：**

- 方案 A（预探测）对 **1–8MB 档净亏**（该档本来走 x4，8MB 只要约 7s，插一次 2MB 探测等于先用单连接重下 25%），且单连接速率在真实网络**不可外推**（受控服务器是「每连接限速」才有线性关系）`[t2]` §3.1。
- 方案 C（下载中自适应）只有上调方向可用，收益 ≤2.2s，代价是 5 类**新增失败面**（RPC + shutdown 生命周期 + gid 管理 + 端口冲突/认证失败 + 运行期控制器不得破坏 `runProcess` 的取消语义）`[t2]` §3.4。
- 方案 B 的数据由下载本身免费产生，**不产生额外请求**，因此不触碰指纹链路（`src/probe.ts:31` 的 `identity` 强制、`src/probe.ts:244-245` 的 Range GET 优先、`src/resume.ts:95-108` 的旁车），也不影响 `verifySize()`（`src/verify.ts:93-118`）`[t2]` §4.1、§4.2。

### 2.3 工作项拆分

#### P1-1 解析出「实际有效连接数」（纯观测，不改行为）

- **改动文件**：`src/progress-parse.ts`（`ParsedSummary` 加字段、`parseAria2Summary()` 取出捕获组）、`test/progress-parse.test.ts`（用 `test/fixtures/` 里既有的摘要行做 fixture）。
- **验收标准**：
  1. `parseAria2Summary()` 对同一行 fixture 返回新增的 `cn`（整数），值等于该行 `CN:` 后面的数字；
  2. `pct` / `spd` / `eta` 三个既有字段**逐字段不变**（回归项）；
  3. 非摘要行仍返回 `null`（`src/progress-parse.ts:42-46` 的行为不变）；
  4. **本项不得改变任何下载行为**：`src/downloader.ts:326-331` 的调用点只用 `pct/spd/eta`，新增字段在此项里**不消费**。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/progress-parse.test.ts
  pnpm typecheck
  ```

#### P1-2 按主机分桶的吞吐缓存（方案 B 第一步）

- **改动文件**：新建一个缓存模块（例如 `src/throughput-cache.ts`）；`src/index.ts` 或 `src/downloader.ts` 在下载结束时写入观测值；`src/decision.ts`（读取缓存用于**抬档**）；对应新增测试文件。
- **验收标准**：
  1. 缓存键按**主机 + 端口**分桶，且**默认只存主机名的 sha256 哈希**（不是明文主机名）—— 缓存文件里 grep 不到任何明文域名；
  2. 每条记录包含：最近 N 次（建议 5）的吞吐中位数、当时的并发数、当时**实际有效连接数**、更新时间；
  3. TTL 建议 24h，过期视为无历史并顺手淘汰；
  4. **只用于抬档，不用于降档**：无历史 / 缓存不存在 / 缓存损坏 / 目录不可写 / 目录只读时，`decide()` 的返回值与今天**逐字段相同**（回归项，必须用注入时钟 + 临时目录做单测）；
  5. 缓存命中抬档时，`decide()` 的 `reason` 必须**显式写明**「依据历史吞吐抬档」并带上主机标识与数值——不允许出现无法区分「按大小分档」与「按历史抬档」的返回值；
  6. 缓存写入失败**必须静默忽略**，不得让下载失败（与 `writeMarker()` 的既有处理方式一致，`src/resume.ts:95-108`）；
  7. 并发上限**不得**因此超过 8（`src/decision.ts:41-42` 的既有取舍：避免触发服务器按 IP 限并发）。
- **验证命令**：
  ```powershell
  cd $REPO
  node --test --import tsx test/decision.test.ts
  pnpm test
  pnpm typecheck
  ```
- **备注**：隐私口径要同步进 `docs/SECURITY.md`（缓存里是「这台机器下过哪些主机」的哈希）`[t2]` §3.2。

#### P1-3 下载中动态并发调整

**不做。** 见 §3 与 §2.2 的能力边界表。

### 2.4 推荐方案不成立时的退化行为（逐条，必须实现）

| 失效情形 | 必须的退化行为 | 依据 |
| --- | --- | --- |
| 缓存文件不存在 / 损坏 / 不可写 | 完全按现有 `decideConcurrency()` 大小分档（`src/decision.ts:44-47`），行为与今天一致 | `[t2]` §3.5 |
| 主机从未见过（无历史） | 同上，**不猜测、不加探测请求** | `[t2]` §3.5 |
| 历史数据过期（> 24h） | 同上，并顺手淘汰该条 | `[t2]` §3.5 |
| 缓存目录不可用（只读 / 权限） | 静默跳过缓存，**不得**让下载失败 | `[t2]` §3.5，对齐 `src/resume.ts:95-108` |
| 未来引入 RPC 上调后，RPC 启动失败 | **直接按原并发启动纯命令行 aria2**，不重试 RPC，不降级为「无并发」 | `[t2]` §3.5 |
| 镜像候选的「速度」与「同源证明」冲突 | **同源证明优先**，速度不能替代它；未通过同源证明的候选一律不用 | `[t2]` §4.4、`src/auto-mirror.ts:134-146` |

---

## 3. P2：扩展生态支持

### 3.1 结论

| P2 子项 | 结论 | 一句话依据 |
| --- | --- | --- |
| **macOS 随包 aria2** | **不能做**（维持现状） | 卡点是「没有**可信**的 macOS 二进制来源」，不是「没有二进制」`[t3]` §A.3 |
| **FTP** | **不做** | 放开白名单后默认路径上只剩第五层（`sha256`）有效，而它是**可选参数** → 默认无内容校验 `[t3]` §B.2.1、§B.4.1 |
| **SFTP** | **不做** | 同 FTP，且额外引入 `libssh2` 依赖面 `[t3]` §B.4.3 |
| **BitTorrent** | **不做进 `smart_download`**；若要探索，做**独立工具** | 五层防护没有一层可复用；DHT / 监听端口 / 做种会打破 README 的权限承诺 `[t3]` §B.2.3、§B.4.2 |
| **自建 macOS 二进制** | **1.3 内不做** | 不是「补个子包」，是新增长期维护负担；两条前置条件未确证 `[t3]` §A.4.2、§A.5 |

### 3.2 依据（macOS：为什么是「不能做」而不是「没找到」）

- 官方 `release-1.37.0`（2023-11-15）的 6 个资产**无 darwin**；官方最后一次发 macOS 包是 `release-1.35.0`（2019-10-06），且**官方从未为 macOS 包提供摘要**（`body` 无校验和、资产 `digest` 为空）`[t3]` §A.2 ①、附录 D.1。
- 现用的 Linux 来源 `abcfy2/aria2-static-build` 与社区最知名的 `dmesg00/aria2-static-builds`（735★）**都不产 darwin** `[t3]` §A.2 ②③。
- Homebrew 有 SHA256，但 bottle **只有 arm64 macOS**（无任何 `x86_64_*`），且是动态链接带 5 个依赖，属「不该由插件代管」的用户环境依赖 `[t3]` §A.2 ④。
- **唯一带哈希的 macOS 候选（`FerroDownload/aria2-static-builds`）过不了可信门槛**：确实提供 macOS x64（4,056,152 B）与 arm64（4,221,960 B）的 aria2 1.37.0 并公布 SHA256（`.sha256` 文件与 GitHub `digest` 两处一致，已复现），但仓库 `0★`、无许可证、创建于 2026-06-20、**构建证明实测 404**、构建不可复现（`workflow_dispatch`、未 pin commit、`brew install` 未固定版本）`[t3]` §A.2 ⑤、附录 D.1。
- **卡点的准确表述**（这一点必须写清楚，避免被读成「根本没有 macOS 二进制」）：

  | 说法 | 是否成立 |
  | --- | --- |
  | 「没有 macOS 二进制」 | ❌ 不成立（⑤ 提供 x64 + arm64） |
  | 「没有**可核对哈希的** macOS 二进制」 | ❌ 也不成立（⑤ 的哈希两处一致） |
  | 「没有**可信**的 macOS 二进制来源」 | ✅ **成立** —— 哈希只解决传输是否被篡改，不解决来源可信与二进制↔源码绑定 |

- 现状代码路径**已经是正确的降级行为**：`ARIA2_TARGETS` 不含 `darwin-*`（`src/downloader.ts:44-49`，本轮核对命中），`aria2TargetFor()` 返回 `null` → `getAria2Path()` 返回 `null`（`src/downloader.ts:61-81`）→ `decide()` 回退 curl 并在 `reason` 写明原因（`src/decision.ts:108-116`）。**P2 不需要任何代码改动。**
- 自建路径技术上存在（GitHub 官方 runner 同时提供 x64 与 arm64 的 macOS 镜像，且 `macos-14` 已在废弃流程中，必须选 `macos-15-intel` / `macos-15` / `macos-26` 这一代标签），但代价形态完全不同 `[t3]` §A.4.1、§A.4.2。

**FTP / BT 的依据**：五层防护逐层失效表见 `[t3]` §B.2.1；README 的「静默失败防护」契约表（`README.md:461-492`）中至少 5 行断言会失去意义或需重写 `[t3]` §B.3。第一层防护唯一的测试锚点 `checkDownloadUrl` 拒绝非 http(s)（`src/url.ts:18` 的 `SUPPORTED_PROTOCOLS`，本轮核对命中）是 0.4.1 那次「`file://` 真的把本地文件复制出去」实测换来的，放宽它的成本远大于收益 `[t3]` §B.1。

### 3.3 工作项拆分

> P2 **本轮零代码改动**。唯一的工作项是文档证据更新，且必须可验收。

#### P2-1 把 P2 的核对结果写进既有文档（文档级）

- **改动文件**：`docs/COMPATIBILITY.md`（「macOS 为什么搁置」一节，现为 `docs/COMPATIBILITY.md:29-42`）、`README.md` 与 `docs/SECURITY.md`（「不支持 FTP/BT 及其理由」的落点）、`docs/PLAN-P2-PLATFORM.md`（**不删不改结论**，作为证据来源被引用）。
- **验收标准**：
  1. `docs/COMPATIBILITY.md` 的搁置理由从「没找到」升级为「逐个来源核对后仍不成立，并列出唯一带哈希的候选为何被否」，且**明确写出卡点是「来源不可信」而不是「没有二进制」**；
  2. `README.md` 明确写出「不支持 FTP / SFTP / BitTorrent」及一句话理由，并指向 `docs/PLAN-P2-PLATFORM.md`；
  3. 文档中出现的所有外部结论都带来源 URL 与核对日期（沿用 `[t3]` §C 的来源清单）；
  4. 不改动任何 `src/` / `test/` / `dist/` 文件。
- **验证命令**：
  ```powershell
  cd $REPO
  # 文档里必须出现这三条（应有输出）
  Select-String -Path docs/COMPATIBILITY.md -Pattern '不可信|可信'
  Select-String -Path README.md,docs/SECURITY.md -Pattern 'FTP'
  Select-String -Path README.md,docs/COMPATIBILITY.md -Pattern 'PLAN-P2-PLATFORM'
  # 确认没有源码改动：src/ test/ dist/ 下不应有任何文件的修改时间晚于被改的文档
  $doc = (Get-Item docs/COMPATIBILITY.md).LastWriteTime
  Get-ChildItem src,test,dist -Recurse -File | Where-Object { $_.LastWriteTime -gt $doc } |
    Select-Object FullName   # 期望：无输出
  ```

#### P2-2 保留一条既有防线的回归断言（已存在，只需确认）

- **改动文件**：**无需改动**。`test/url.test.ts` 已经覆盖了这条防线（本轮核对命中）：
  `test/url.test.ts:29`（`isSupportedProtocol('ftp:') === false`）、`:33-38`（拒绝 `file://`）、
  `:39-44`（拒绝 `ftp://` / `data:` / 相对路径）、`:67-69`（拒绝理由含「不支持的协议 ftp:」）。
- **验收标准**：上述四条断言在 1.3 全过程中**保持存在且通过**；任何「支持 FTP」的改动都必须先让它们红，
  也就是说**它们红掉本身就是「决定改变」的信号**，不允许顺手删掉或放宽。
- **验证命令**：
  ```powershell
  cd $REPO
  Select-String -Path test/url.test.ts -Pattern 'ftp|file://'
  node --test --import tsx test/url.test.ts
  ```
- **备注**：本项**没有实现动作**，它的价值是把「P2 不做 FTP/BT」这个决定钉在一条会被 CI 执行的断言上。

---

## 4. 「不做」清单（本轮与近期都不做）

> 本节的作用是**防止以后有人以为漏了**。每条都写明理由与证据出处；如要移出，必须由用户明确要求。

### 4.1 P0 范围

| 不做项 | 理由（证据） |
| --- | --- |
| 后台常驻任务（路线 B：`fire-and-forget` + 轮询） | 引入**可选**服务 `ctx.jobs`（没有 controller 时 `start()` 直接失败）→ 同步/异步双模式都要写都要测；进程内 registry **不跨重启**；与现有两条进度轨道并行会变成三套真相；面板归属需再决策。改动面「大」`[t1]` §3.1、§4 |
| 跨进程 / 跨重启的任务持久化与恢复 | DSH 的 `ctx.jobs` 契约本身声明进程内 registry 不跨重启；自建持久化队列属 P2 量级 `[t1]` §5.1 |
| 服务器端队列协议（aria2 RPC 模式 / `--input-file` 批处理） | 会重写整个下载执行层与进度解析层（现在一律「一个文件一个子进程」，`src/downloader.ts:313-353`）`[t1]` §5.2 |
| 断点续传的跨任务合并（多个半包合成一个任务） | 现有续传语义是「同一 output 路径的旁车指纹比对」（`src/resume.ts:190-220`），不做跨文件合并 `[t1]` §5.3 |
| 面板拖拽排序 / 队列重排 UI | 优先级即便做也只做数值排序 `[t1]` §5.4 |
| 把 `download_status` 改成可写工具（在其中取消/重试） | 只读工具不应双职责；若走路线 B，写操作应交给宿主的 `job_kill` `[t1]` §5.5 |
| 面板按钮（取消 / 重试） | 需要新增写端点 + 任务元数据（原 URL / output / sha256 现在**没有**存进进度文件）+ 幂等与并发语义 ≈ 一次小型 RPC 体系扩建 `[t1]` §3.2 ③④ |
| 面板交互式折叠 / 滚动（批量 >5 条时） | **待确证**：需要真实浏览器渲染验证才能判断是否必要 `[t1]` §6.4 |
| 把 29 条错误文案全部重写 | 其中大部分**已经可操作**，缺口只在 D1 / E 类 / G1 三处 `[t1]` §1.3.1（口径见 §0.2 C3） |

### 4.2 P1 范围

| 不做项 | 理由（证据） |
| --- | --- |
| **下载中动态降并发** | 实测 **2/2 失败**（`errorCode=1` "No URI available."、落盘 30618416/33554432 缺字节）`[t2]` §1.3 |
| **下载中动态调并发作为默认行为** | 需 RPC 模式 + shutdown 生命周期（RPC 下 aria2 不自己退出），32MB 上收益 ≤ 0 或 2.2s，代价是 5 类新增失败面 `[t2]` §1.6、§3.3、§3.4 |
| **下载前预探测吞吐** | 对 1–8MB 档净亏；单连接速率在真实网络不可外推；多一次完整请求会与指纹/落盘校验产生新耦合 `[t2]` §3.1、§4.1、§4.2 |
| **「并发下同一个文件、取消慢的」式多镜像竞速** | 白烧流量、破坏同源证明前提、可能触发服务器限流 `[t2]` §2、§5 |
| **新增下载后端（wget / axel / 自研分片器）** | 「多引擎」的三种解释里最不可能是这个，且不解决任何已知问题 `[t2]` §2、§5 |
| **调高 8 连接上限** | 实测 32/64MB 下 x=16 确实更快（23~24 MB/s），但保守维持 8 以避免触发服务器按 IP 限并发；本次实验未推翻该结论（`src/decision.ts:41-42` 已把这条写进注释）`[t2]` §5 |
| **用 RPC 做「智能调整」的包装叙事** | 上调可做但不该做、下调做不到——不得包装成「已实现智能调整」`[t2]` §5 |

### 4.3 P2 范围

| 不做项 | 理由（证据） |
| --- | --- |
| macOS 随包 aria2 | 无可核对哈希的**可信**二进制来源；唯一带哈希的候选无构建证明（attestation 404）、不可复现、发布方 0★ 无许可证 `[t3]` §A.3 |
| 自建 macOS 二进制（1.3 内） | 属**新增长期维护负担**（runner 镜像有生命周期、Xcode/工具链变更都会触发重编译重发布），且「不依赖用户环境」与「逐字节可复现」两条前置条件**未确证** `[t3]` §A.4.2、§A.5 |
| FTP 下载 | 默认路径上只剩可选的 `sha256` 一层有效，即**默认无内容校验**；第一层防护唯一的测试锚点必须被改写；明文凭证进 URL、涉及数据连接与端口 `[t3]` §B.2.1、§B.2.2、§B.4.1 |
| SFTP 下载 | 同 FTP，另加 `libssh2` 依赖面（现有 aria2 构建是 `--without-libssh2`）`[t3]` §B.4.3 |
| BitTorrent 进 `smart_download` | 五层防护没有一层可复用；DHT/监听端口/做种会打破 README 的权限承诺；契约表大面积失效 `[t3]` §B.2.3、§B.3、§B.4.2 |
| 为「有产出」而放宽第三方二进制的可信标准 | 这是 COMPATIBILITY.md 当初拒绝放宽的那条线，本轮明确禁止 `[t3]` §A.2 ⑤ |

---

## 5. 需要用户拍板的决策

> **本节只列选项与取舍，不替用户选。** 正文各节的推荐（P0 路线 A、P1 方案 B、P2 全不做）是**建议**，与本节并列时以用户拍板为准。

| # | 决策 | 选项 | 取舍 |
| --- | --- | --- | --- |
| **D1** | 「队列」的语义 | **A. 单次调用内批量（同步返回）** / **B. 后台常驻任务（回执 + 轮询）** | A：不动 DSH 模型、改动集中在本插件、风险可控；代价是「一次调用更慢、失败语义要新定义」，且取消只能整批。B：真正的后台并行 + 免费的 `job_kill` 单任务取消；代价是可选依赖 + 双模式降级 + 三套进度取舍 + **跨重启不保证**，且改变 `smart_download` 的返回语义（**破坏性变更**）。两者**不互斥**，可以先 A 后 B |
| **D2** | 批量大小上限 | ① 不设上限（只受 `MAX_STATUS_LIMIT=50` 的进度可见性约束） / ② 显式设上限（如 10）并在超出时拒绝 | ① 简单，但一次 tool call 可能跑很久；② 可控，但多一条拒绝路径要维护 |
| **D3** | 是否为 `smart_download` 声明 `timeoutMs` | ① 不声明（维持现状：超时策略插件对它不生效） / ② 声明并给出上限 | ① 现状；② 批量会放大「一次调用跑很久」的问题，但超时会中断大文件下载且需要定义「超时后进度如何呈现」 |
| **D4** | 批量部分失败的语义 | ① 任一条失败即整批失败 / ② 部分成功照常返回，逐条给结果 / ③ 返回成功但把失败条目列在 `reason` 里 | 这是**新增的语义决定**，不是技术问题；②最贴近工具调用方的直觉但返回值结构最复杂 |
| **D5** | 是否需要限速 | ① 不做 / ② 只做**每任务上限** / ③ 做**总带宽上限** | ②小（两个 flag + 两个入参）；③需要**跨调用共享状态**，成本高一档，且路线 A 下「同时只有一批在跑」使总带宽上限的意义下降 |
| **D6** | 面板形态 | ① 只做展示（本轮方案） / ② 加交互按钮（取消/重试） / ③ 把队列视图交给宿主已有的 job 面板（`dsh-client-ui-jobs`） | ②需要扩建 RPC 到写方向 + 存任务元数据（≈ 一次小型体系扩建）；③会让本插件现有 pill 与宿主面板形成两套 UI，需明确谁负责显示 |
| **D7** | 历史进度文件是否清理 | ① 不处理（现状：只增不减，`cleanup()` 是给调用方的显式接口，见 §0.2 C1） / ② 加一个清理入口（工具参数或 RPC） / ③ 加自动淘汰（按时间/条数） | ①零成本但信噪比持续下降；②需要新增入口；③需要定义「哪些算历史」并防止误删正在跑的任务回执 |
| **D8** | P1 缓存是否默认开启 | ① 默认开启 / ② 默认关闭，由参数或环境变量开启 | ①「更智能」是默认体验，但新增本地持久化信息（主机名哈希）；②保守，但等于默认拿不到收益。**注意隐私口径要同步进 `docs/SECURITY.md`** |
| **D9** | macOS | ① 维持不做（本轮建议） / ② 自建（GitHub Actions macOS runner） / ③ 接受 `FerroDownload` 的二进制 | ①零成本、行为可预测（走 curl）；②唯一能把「背书」放在本项目自己手里的方案，但是**新增长期维护负担**，且两条前置条件未确证；③明确接受「从零 star、无许可证、无构建证明的个人仓库取可执行文件」，本轮明确禁止 |
| **D10** | FTP / SFTP | ① 不做（本轮建议） / ② 做，但强制要求 `sha256`（不传即拒绝） / ③ 做，接受默认无内容校验 | ②把「可选防护」变成「强制防护」，是唯一能让 FTP 满足本项目标准的形态，但会让 FTP 在「官方文档没给摘要」的场景下完全不可用；③与本项目从 0.5.0 到 1.2.0 一直在修的「静默失败」形态直接冲突 |
| **D11** | BitTorrent | ① 不做 / ② 做独立工具（`bt_download`，独立参数/权限/威胁模型文档，默认 `--seed-time=0`） | ②不是「在现有工具里加个协议分支」，而是新工具 + 新的权限承诺；复用范围仅限子进程执行/进度上报/取消这些与协议无关的基础设施 |

---

## 6. 风险与未知

| # | 风险 / 未知 | 影响 | 处置 |
| --- | --- | --- | --- |
| **R1** | 本机 profile 跑的是 **1.1.2**，工作区是 **1.2.0**（`package.json:3`） | 任何 GUI 面板实测都可能测到旧代码，得出错误结论 | 面板相关验收（P0-4）前必须先在目标 profile 上确认版本；未确认前不得把面板观察当作证据 |
| **R2** | `ctx.jobs.start()` 在本机实际运行的 desktop profile 里**是否可用**未实测（profile 确实加载了 `dsh-jobs-local` 与 `dsh-tool-jobs`，但 `start()` 还要求 controller 服务该 owner） | 决定路线 B 的可行性；若不可用则路线 B 在纯 CLI profile 下必须整体降级 | **待确证**：需要一次真实插件加载实验（本轮不写代码）。路线 B 未拍板前不阻塞 P0 |
| **R3** | 多 agent / 多会话同时下载时是否共用同一个 agent loop 的并行池 | 决定「跨调用并发上限」是否真的必要 | **待确证**：`[t1]` §6.1 未追到跨会话调度路径；只在单 step 内看到并行池。P0-6 的并发上限**不依赖**这条 |
| **R4** | 批量（>5 条）下面板的实际观感（是否需要滚动/折叠） | 影响 P0-4 的工作量 | **待确证**：需要真实浏览器渲染验证 |
| **R5** | 改动 `src/client.js` 后 `dist/client.js` 的同步（`scripts/copy-client.mjs`）与发布链 | 不同步则面板加载旧文件，出现「改了没效果」的假故障 | P0-4 的验收命令里已包含 `pnpm build` 与 `git diff --stat`；**发布前必须再确认一次** |
| **R6** | P1 缓存引入新的本地持久化信息（主机名，即使哈希化） | 隐私口径变化 | 默认只存哈希；同步进 `docs/SECURITY.md`；缓存文件里不得出现明文域名（P1-2 验收标准 1） |
| **R7** | 批量会放大「无超时保护」的问题（`smart_download` 未声明 `timeoutMs`） | 一次 tool call 可能长时间占用 | 见决策 D2 / D3；未拍板前 P0-6 的批量大小应保守 |
| **R8** | P1「下调并发失败」的实测只在**本机受控服务器**（每连接限速 512KiB/s）上做过 | 结论外推到真实网络未必逐字成立 | 结论已按「本机受控实测」表述；**不得**包装成普适规律。若要在真实网络复现，属独立验证工作 |
| **R9** | `parseAria2Summary()` 的 `CN` 字段来自 `--summary-interval=1` 的摘要行格式，aria2 升级后格式可能变 | P1-1 的解析可能失效 | 解析失败时返回 `null` 的既有行为即安全退化；fixture 用 `test/fixtures/` 里既有的摘要行，格式变更时该测试会先红 |
| **R10** | 三份上游文档的**待确证清单共 13 条**（`[t1]` §6 六条、`[t3]` 五条 + §A.5 两条） | 其中若干条（R2/R3/R4）会影响决策 | 本文已把影响决策的抽成 R1–R4；其余（如 `honify/aria2c-macos-static` 未逐个核对）**不影响本轮结论**，如需穷尽来源应另立项 |

---

## 附录 A：本轮的验证动作（可复现）

> **注意（本轮实测）**：本机**没有安装 `rg`**（`rg --version` → `'rg' is not recognized`），
> 因此下面全部改用 PowerShell 原生的 `Select-String`，保证命令**可直接复制执行**。
> 另：本仓库工作区**本来就是脏的**（`src/`、`test/`、`dist/` 有本轮之前就存在的未提交改动），
> 所以「确认本轮没改源码」**不能**用 `git status --porcelain`（它会把既有改动一起列出来，是假阳性），
> 改用**修改时间**判定（见第 11 条）。

```powershell
$REPO = "C:\Users\Qing\Documents\Codex\2026-09-28\https-github-com-leisureyu-dsh-smart\work\dsh-smart-download"
cd $REPO

# 1. 测试基线（本轮实测：343 tests / 341 pass / 2 skipped / 0 fail）
pnpm test

# 2. 源码核对：退出码直出（D1）→ 命中 src/downloader.ts:301-307
Select-String -Path src/downloader.ts -Pattern '退出码'

# 3. 源码核对：校验失败文案（E 类）→ 命中 verify.ts:129-132、hash.ts:118-126
Select-String -Path src/verify.ts,src/hash.ts -Pattern '下载完整性校验失败'

# 4. 源码核对：读取失败被吞（G1）→ 命中 status.ts:126-133 与 status.ts:243
Select-String -Path src/status.ts -Pattern 'return out|ok: true'

# 5. 源码核对：aria2 解析丢弃了 CN（P1-1 的落点）→ 命中 progress-parse.ts:22-23
Select-String -Path src/progress-parse.ts -Pattern 'CN:'

# 6. 源码核对：并发档位与阈值（P0-6 的上限来源）→ 命中 decision.ts:18/32/44-47
Select-String -Path src/decision.ts -Pattern 'SIZE_THRESHOLD|LARGE_FILE|decideConcurrency'

# 7. 源码核对：平台映射表不含 darwin（P2 结论）→ 命中 downloader.ts:42-49
Select-String -Path src/downloader.ts -Pattern 'ARIA2_TARGETS|darwin'

# 8. 源码核对：进度文件只增不减是刻意的（§0.2 C1）→ 命中 progress.ts:372-394
Select-String -Path src/progress.ts -Pattern '刻意|cleanup'

# 9. 服务端批量上限（§0.2 C2）→ 命中 status.ts:74/237、rpc.ts:94
Select-String -Path src/status.ts,src/rpc.ts -Pattern 'MAX_STATUS_LIMIT'

# 10. 并发相关的否定证据（应只命中 progress.ts:255 的 queueMicrotask）
Select-String -Path src/*.ts,src/*.js -Pattern 'semaphore|mutex|queue|maxConcurrent|concurrencyLimit|activeDownloads'

# 11. 确认本轮未改任何源码：src/ test/ dist/ 下不应有任何文件的修改时间晚于本文档
$doc = (Get-Item docs/ROADMAP-1.3.md).LastWriteTime
Get-ChildItem src,test,dist -Recurse -File | Where-Object { $_.LastWriteTime -gt $doc } |
  Select-Object FullName,LastWriteTime   # 期望：无输出
```

## 附录 B：工作项 → 验收命令总表

| 项 | 一句话 | 主要验证命令 |
| --- | --- | --- |
| P0-1 | 退出码翻译层 | `node --test --import tsx test/downloader.test.ts test/runprocess.test.ts` |
| P0-2 | 校验失败补「怎么办」 | `node --test --import tsx test/verify.test.ts test/hash.test.ts test/execute.test.ts` |
| P0-3 | 区分「读不到」与「没有」 | `node --test --import tsx test/status.test.ts test/tool-schema.test.ts` |
| P0-4 | 面板显示失败原因 + 容量对齐 | `node --test --import tsx test/rpc.test.ts` + `pnpm build` |
| P0-5 | 批次 id 贯通四层 | `node --test --import tsx test/progress.test.ts test/status.test.ts` |
| P0-6 | 单次调用内批量（路线 A） | `node --test --import tsx test/execute.test.ts test/tool-schema.test.ts` + `pnpm test` |
| P0-7 | 每任务限速（可选） | `node --test --import tsx test/downloader.test.ts test/tool-schema.test.ts` |
| P1-1 | 解析 `CN` | `node --test --import tsx test/progress-parse.test.ts` |
| P1-2 | 按主机吞吐缓存 | `node --test --import tsx test/decision.test.ts` + `pnpm test` |
| P2-1 | 文档证据更新 | `Select-String -Path README.md,docs/SECURITY.md -Pattern 'FTP'` + 修改时间判定（见附录 A 第 11 条） |
| P2-2 | 保留 `ftp://` 拒绝断言 | `node --test --import tsx test/url.test.ts` |

**全局门（每项完成后都必须过）**：

```powershell
cd $REPO
pnpm test        # 343 tests / 341 pass / 2 skipped / 0 fail（基线）
pnpm check       # typecheck + typecheck:test
```

---

**本轮未修改任何源码。** 本轮唯一新增产物即本文件。
