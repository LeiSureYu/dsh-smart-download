# 最终集成验证报告（1.3.0 交付前）

> 验证者：verify-a（未参与 t5–t22 中任何一项的实现）
> 验证对象：`dsh-smart-download` 工作区全部 P0 / P1 / P2 累计改动 + `dist/` 入库产物
> 权威规格：`docs/ROADMAP-1.3.md` §4（「不做」清单）、§5（用户决策 D1–D11）、§6（风险与未知 R1–R10）
> 结论：**pass** —— dist 与源码完全同步、全量验证全绿、端到端真实下载成功且缓存写入有实证；
> roadmap §4 三张「不做」清单与 §5 全部已拍板决策逐条核对无越界。
> 残留 1 条环境依赖项（GUI 面板无法实测，R1）与 1 条观察记录（缓存样本 `cn:1`，非缺陷）。

---

## 1. 写者已停（本任务的前置条件）

任务要求先确认 t21 / t22 均 completed 且无人还在写入。**第一次检查不通过，我wait了 90 秒再查**：

| 时刻 | 观察 |
| --- | --- |
| 11:07:42（首次） | 最近 20 分钟内有 **39 个文件**被改，最后一个是 `test/execute.test.ts`（11:05:05）；`impl-b` 状态为 **working/running** |
| 11:09:22（等 90s 后） | 最近 5 分钟内**零写入**；`agent_teams_status` 显示 `impl-b` 已变 **idle/ready**，22 个前置任务全部 completed/cancelled |
| 11:09:55 | 我执行 `pnpm build`，无人竞争 |

**判定：写者已停。** 进程表里剩余的两个 node 进程 StartTime 均为 04:08（DSH 本体），与本仓库无关。

---

## 2. dist 最终重建与同步核对

### 2.1 重建前：确认落后

```
src  max: 10/12/2026 10:59:43
dist max: 10/12/2026 10:49:03     ← dist 落后 10 分 40 秒
```

> 这正是本会话反复出现的问题（t18 后落后 14 秒、t20 后再次落后）。**逐文件核对显示没有任何单个产物
> 早于其 src 源**——落后源于 `src/downloader.ts`(10:59:43)、`src/index.ts`(10:56:41) 等 t21 的改动
> 发生在最后一次构建（10:49:03）之后。目录级 mtime 反映的是这一点。

### 2.2 重建

```
$ pnpm build
$ tsc && node scripts/copy-client.mjs
copied ...src\client.js -> ...dist\client.js
exit=0
```

### 2.3 重建后：逐文件核对零落后

```
src  max: 10/12/2026 10:59:43
dist max: 10/12/2026 11:09:55
逐个 src → dist 核对：无落后产物（每个 dist 产物都晚于其 src 源文件）
```

`dist/client.js` 与 `src/client.js` **SHA256 相同**：
`8273210FA1BE5591EBFE9924E2227092BD7BD2EF5234BC6A93FF417E6290969E`

### 2.4 产物符号抽查（安装方拿到的就是这一份）

| 符号 | dist 命中 | 说明 |
| --- | --- | --- |
| `timeoutMs` | 9 | 单条目超时参数 |
| `batchWindow` | 3 | 批内窗口反推 |
| `targets` | 36 | 批量入参 |
| `maxBandwidth` | 15 | 总带宽上限 |
| `recordThroughput` | 3 | 缓存写入 |
| `readThroughput` | 2 | 缓存读取 |
| `recordObservedThroughput` | 2 | **唯一写入点**（t21 接线） |
| `summarySpeedBytes` | 2 | 速度单位换算 |
| `dist/throughput-cache.js` / `.d.ts` | 存在（9536 / 4790 B） | P1-2 缓存模块 |
| `Aria2Observation` | `.d.ts:150` 有、`.js` 无 | **正常**：interface 是类型层，编译后擦除 |
| `executableName(command)` 在取消分支 | `dist/downloader.js:325`、`:337` | **P0V-01 已修**（另 `:348` 退出码分支） |
| `SmartDownloadArgsWithTimeout` | **0 hits**（dist + src） | 已删别名零残留 |

---

## 3. 全量验证

### 3.1 `pnpm check`（两套 tsconfig）

```
$ pnpm typecheck && pnpm typecheck:test
$ tsc --noEmit
$ tsc -p tsconfig.test.json
exit=0
```

### 3.2 `pnpm test`

```
ℹ tests 451
ℹ pass 449
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ duration_ms 22452
```

**skip 仍为 2**，与规格基线一致（`test/runprocess.test.ts` 的平台既有项：Windows 上拿不到信号名、
构造不出「忽略 SIGTERM」的子进程）。规格基线为 343 / 341 / 2 / 0 → **用例 +108，fail 仍 0，skip 仍 2**。

### 3.3 产物卫生

`dist/` 全部文件 **LF、无 BOM**（逐字节扫描）；`README.md` / `README.en.md` / `CHANGELOG.md` /
`package.json` 同样全部 LF、无 BOM。`package.json` version = **1.3.0**。

---

## 4. 端到端真实下载验证（含缓存写入证据）

**这是「P1-2 缓存真的被写入」的唯一可信证据** —— t20 交付时 `recordThroughput()` 除测试外零调用点，
t21 才接线。我用**入库产物 `dist/index.js`**（不是 `src/`）驱动，这样同时验证「产物可用」与「缓存写入」。

### 4.1 构造

本机 127.0.0.1 受控 server：8MB 文件（= `LARGE_FILE`，档位即上限档 8）、支持 Range、
分 32KB 块每 40ms 发一块，并在第 4MB 处插 1 秒停顿（保证跨过 aria2 的 `--summary-interval=1`，
否则下载几十毫秒就结束、一条带速度的摘要都来不及吐）。缓存目录指向独立临时目录。

### 4.2 结果

| 项 | 实测值 |
| --- | --- |
| 下载成功 | `success: true` |
| 走的方法 | `method: 'aria2'`、`fellback: false` |
| 落盘字节 | `8388608`（= 8MB，与远端声明一致） |
| 耗时 | 2584 ms |
| **缓存文件数** | **1 个**（`12ca17b49af2289436f303e0166030a2-1643.json`） |
| `hostHash` | `12ca17b49af2289436f303e0166030a2`，**等于 `sha256('127.0.0.1').slice(0,32)`** |
| `port` | `1643`（本次 server 的真实端口） |
| `concurrency` | `8`（= `decideConcurrency(LARGE_FILE)`） |
| `cn` | `1`（见 §4.4） |
| `samples` | `[3984588.8]`，长度 1 |
| `medianThroughput` | `3984588.8`（> 0） |
| `updatedAt` | number 类型 |
| 文件名是哈希 | ✅ `/^[0-9a-f]{32}/` |
| **文件名含明文主机名** | **false** |
| **文件内容含明文主机名** | **false** |
| 读侧能读回 | ✅ `readThroughput()` 返回 `{key:{hostHash,port}, record:{...}}`，写-读形状契约成立 |

### 4.3 隐私口径实证

缓存文件名是 `<hostHash>-<port>.json`，内容只有 `hostHash` / `port` / `samples` /
`medianThroughput` / `concurrency` / `cn` / `updatedAt`。**没有 URL、没有路径、没有查询串、
没有文件名、没有 IP 以外的任何主机标识** —— 与 `docs/SECURITY.md` 新增的「本地持久化：吞吐缓存」
一节口径一致。

### 4.4 一条观察记录（**不是缺陷**）：本次样本 `cn = 1`

我的受控 server 是**单连接限速**（每 40ms 才发 32KB），aria2 多开连接也拿不到更多数据，
所以实际有效连接数是 1。这正是 `RAISE_MIN_EFFECTIVE_CONNECTIONS = 4`
（`src/decision.ts:30`、`:136`）要挡的情况：`cn < 4` 的记录**不会**触发抬档。

换句话说，`cn:1` 是**正确的观测**，而读侧的守卫正确地拒绝用它抬档。我把这条写进报告是为了
防止有人看到 `cn:1` 误以为「CN 解析坏了」——它没坏，是服务器的特性。

---

## 5. roadmap 交付核对

### 5.1 §4「不做」清单逐条核对

**P0 范围（9 项）**：全部未越界。

| 不做项 | 核实结果 |
| --- | --- |
| 后台常驻任务（路线 B） | `src/*.ts` 中 `ctx.jobs` **0 hits**；无 `fire-and-forget` |
| 跨进程 / 跨重启持久化 | 无持久化队列代码 |
| 服务器端队列协议（aria2 RPC / `--input-file`） | `enable-rpc` / `changeOption` / `aria2.shutdown` **0 hits** |
| 断点续传跨任务合并 | `src/resume.ts` 未改 |
| 面板拖拽排序 / 重排 UI | `src/client.js` 无交互元素 |
| `download_status` 改成可写工具 | 仍纯只读 |
| 面板按钮（取消 / 重试） | `client.js` 中 `onClick` / `<button>` **0 hits** |
| 面板交互式折叠 / 滚动 | 只做了 `maxHeight:260 + overflowY:auto`（P0-4 验收标准 1 的必要配套） |
| 29 条错误文案全量重写 | 只动 D1 / E 类 / G1 三处 |

**P1 范围（7 项）**：全部未越界。

| 不做项 | 核实结果 |
| --- | --- |
| 下载中动态降并发 | 无 RPC 模式 |
| 下载中动态调并发作为默认行为 | 无 RPC 模式 |
| 下载前预探测吞吐（方案 A） | `probeUrl` 仅 2 个调用点：`index.ts:616`（既有探测）与 `:635`（`mirror:"auto"` 候选同源证明），**无新增测速请求** |
| 「并发下同一文件取消慢的」式竞速 | 无 |
| 新增下载后端（wget / axel / 自研分片器） | `wget` / `axel` **0 hits** |
| 调高 8 连接上限 | `src/decision.ts:19` `MAX_CONCURRENCY = 8` 维持 |
| 用 RPC 包装「智能调整」叙事 | 无 RPC 模式 |

**P2 范围（6 项）**：全部未越界。

| 不做项 | 核实结果 |
| --- | --- |
| macOS 随包 aria2 | `ARIA2_TARGETS` 仍不含 `darwin-*`（我在此前 t11 已核实并写入 COMPATIBILITY.md） |
| 自建 macOS 二进制 | 无构建脚本 |
| FTP 下载 | `src` 中 `ftp:` **0 hits** |
| SFTP 下载 | `src` 中 `sftp:` **0 hits** |
| BitTorrent 进 `smart_download` | `magnet:` / `torrent` / `dht` / `bittorrent` **0 hits** |
| 为「有产出」放宽第三方二进制可信标准 | 无新增二进制来源 |

**模块级可变状态**（captain 明确禁止的跨调用状态）：
`src/index.ts` / `src/progress.ts` / `src/decision.ts` / `src/throughput-cache.ts` 中
`^let` / `^var` / `globalThis` / 模块级 `new Map(` / `new Set(` **全部零命中**；
`setInterval` 仅 `src/client.js:358` 一处（浏览器面板轮询，组件卸载时清理，t13 已修）。
带宽均分仍是纯局部计算。

### 5.2 §5 用户已拍板决策逐条核对

| 决策 | 拍板内容 | 落地证据 |
| --- | --- | --- |
| **D1** | A：单次调用内批量（路线 A） | `src/index.ts` 的 `targets` / `runBatch`；`ctx.jobs` 0 hits（无后台常驻） |
| **D4** | ②：部分成功照常返回，逐条给结果 | `runBatch` + `toItemResult` / `toFailedItem`；`renderBatch` 逐条 `[ok]`/`[failed]`/`[cancelled]` |
| **D6** | ②：面板交互做不到 | `client.js` 0 按钮；宿主 `ClientConnectionRpc` 无触发 API（t15 已读类型定义原文核实） |
| **D7** | ②：加一个清理入口 | `src/rpc.ts` 的 `/api/smartdl.cleanup`（`:34`、`:286`） |
| **批量并发** | 收紧为「总连接数有界」反推 | `src/index.ts:360` `batchWindow(decideConcurrency(LARGE_FILE))` → 窗口 2（t15 实测 `peakConcurrent=2`） |
| **timeoutMs** | 单条目超时 | `src/types.ts:68` `timeoutMs?: number`；`parseTimeoutMs` 1000..1800000 |
| **D5③** | 总带宽上限（一批内均分，无跨调用状态） | `maxBandwidth` + 纯局部 `perItem` 计算；模块级无可变状态 |
| **D8** | P1 缓存隐私口径 | `docs/SECURITY.md` 新增「本地持久化：吞吐缓存」；§4.3 实证只存哈希 |
| **D9 / D10 / D11** | macOS / FTP-SFTP / BT 均不做 | 见 §5.1 P2 表 |

---

## 6. 冻结快照（交付基线）

> 每个被改文件的 mtime + SHA256 前 12 位。合并前如发现不一致，说明又有人写过。

### 6.1 源码（`src/`）

| 文件 | mtime | sha256 前 12 |
| --- | --- | --- |
| `src/index.ts` | 10-12 10:56:41 | `CE0C8F2302BB` |
| `src/downloader.ts` | 10-12 10:59:43 | `DC8256EA2103` |
| `src/throughput-cache.ts` | 10-12 10:47:42 | `716168AB54A8` |
| `src/decision.ts` | 10-12 10:49:40 | `95F013E52EC4` |
| `src/types.ts` | 10-12 10:32:41 | `7FB99A284A50` |
| `src/status.ts` | 10-12 08:53:41 | `8CE35A3716C4` |
| `src/progress.ts` | 10-12 08:45:28 | `9590D75F6639` |
| `src/verify.ts` | 10-12 07:30:20 | `0E8A7E23EDFF` |
| `src/hash.ts` | 10-12 07:30:27 | `DA99AB31679E` |
| `src/progress-parse.ts` | 10-12 07:42:45 | `3A8E59140BF4` |
| `src/cleanup.ts` | 10-12 09:10:00 | `DD807DAD4135` |
| `src/rpc.ts` | 10-12 09:10:19 | `C9EEC42ABC53` |
| `src/client.js` | 10-12 07:57:44 | `8273210FA1BE` |
| `src/mirror.ts` / `auto-mirror.ts` / `headers.ts` / `probe.ts` | 10-12 05:56:44 | `B264BB5F57A1` / `08A3AF256C22` / `9E9F570A7C5C` / `C7184E615A87` |
| `src/url.ts` / `resume.ts` | 09-29 21:40:36 | `0901870E6EDC` / `17711CFC9851` |

### 6.2 测试（`test/`，P0/P1 相关）

| 文件 | mtime | sha256 前 12 |
| --- | --- | --- |
| `test/execute.test.ts` | 10-12 11:05:05 | `B4836A19E13A` |
| `test/downloader.test.ts` | 10-12 11:00:24 | `95B725A3E33A` |
| `test/throughput-cache.test.ts` | 10-12 10:48:39 | `92F958E3CBD5` |
| `test/decision.test.ts` | 10-12 10:49:45 | `C931B20027ED` |
| `test/tool-schema.test.ts` | 10-12 10:19:04 | `59D12B7D67B8` |
| `test/runprocess.test.ts` | 10-12 10:20:21 | `C464EAD07EB3` |
| `test/client.test.ts` | 10-12 08:30:29 | `3BA44B4CF5D2` |
| `test/status.test.ts` | 10-12 08:53:49 | `BA468871439B` |
| `test/progress.test.ts` | 10-12 08:53:23 | `C667DF21D285` |
| `test/rpc.test.ts` | 10-12 09:13:03 | `D11D53B8B460` |
| `test/hash.test.ts` / `verify.test.ts` | 10-12 07:32:11 / 07:32:16 | `72762709797F` / `0EA4578FD48F` |

### 6.3 产物（`dist/`，本次 11:09:55 统一重建）

除 `dist/client.js`（07:57:44，`8273210FA1BE`，与 `src/client.js` 内容一致）外，
**全部 39 个文件 mtime 均为 10-12 11:09:55**。关键产物：

| 文件 | sha256 前 12 |
| --- | --- |
| `dist/index.js` | `7F69D1AC3745` |
| `dist/index.d.ts` | `BC36F7EA1C32` |
| `dist/downloader.js` | `EDF5E0EB7A15` |
| `dist/throughput-cache.js` | `21F6C7427533` |
| `dist/types.d.ts` | `EE05B0E1ED0F` |
| `dist/rpc.js` | `28C1D2DE02F1` |
| `dist/cleanup.js` | `A1B8D4C644A0` |

### 6.4 文档与清单

| 文件 | mtime | sha256 前 12 |
| --- | --- | --- |
| `package.json`（version 1.3.0） | 10-12 10:59:11 | `3A4B1CA25D5B` |
| `README.md` | 10-12 10:56:14 | `3F1E3973E393` |
| `README.en.md` | 10-12 10:56:30 | `DCB31AA1A387` |
| `CHANGELOG.md` | 10-12 10:58:59 | `F66A03B0290C` |

---

## 7. 残留与未验证项（如实报告）

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | **GUI 面板真实浏览器表现** | **未验证（环境依赖）** | 本机 desktop profile 装的是 **1.1.2**（`C:\Users\Qing\.dsh-home\profiles\desktop\node_modules\@leisureyu\dsh-smart-dl\package.json`），工作区是 **1.3.0**。按 roadmap §6 R1，未确认跑的是哪一份之前不得把面板观察当证据。面板部分只有代码级 + 单元测试级结论（`test/client.test.ts` 11/11 真跑）。**这是我在 t8/t15 一贯的口径，保持不变。** |
| 2 | **`_p1lab/` 实验脚本目录不存在** | 已自行构造替代 | 任务描述提到「`_p1lab/` 目录下有你此前的实验脚本可参考」，但该目录在工作区与 TEMP 下均不存在。我按 `test/execute.test.ts:1623-1671` 的 `serveThrottledRanged` 同思路自建了探针，并用 **dist/** 而非 src 驱动。 |
| 3 | **缓存样本 `cn:1`** | 观察记录，非缺陷 | 我的受控 server 单连接限速，aria2 实际只开 1 条连接；`RAISE_MIN_EFFECTIVE_CONNECTIONS = 4` 正确地拒绝用它抬档。详见 §4.4。 |
| 4 | **抬档路径的端到端证据** | **未验证** | 我验证了「缓存被写入」与「读侧能读回」，但**没有**构造「第二次下载同主机时 `decide()` 真的抬档」的端到端场景 —— 那需要同一主机先产生一条 `cn>=4` 的记录。`test/decision.test.ts` 对抬档逻辑有单测，但端到端串联未做。如实标注。 |
| 5 | **npm 发布 / git commit** | **未做（按设计）** | t22 明确「仅本地」，未 commit / push / publish。本任务也未做。版本号 1.3.0 只写在 `package.json` 里。 |

---

## 8. 结论

**verdict = pass。**

- **写者已停**（等 90 秒复核确认，`impl-b` 转 idle）。
- **dist 与源码完全同步**：39 个产物全部晚于其 src 源，`client.js` 哈希一致，`pnpm build` exit 0。
- **产物符号完整**：`timeoutMs` / `batchWindow` / `targets` / `maxBandwidth` / `recordThroughput` /
  `readThroughput` / `recordObservedThroughput` / `summarySpeedBytes` 全部进产物；
  `throughput-cache` 模块在产物中；已删别名 `SmartDownloadArgsWithTimeout` **零残留**；
  `executableName(command)` 在取消与退出码分支都用上了（P0V-01 收官）。
- **全量验证全绿**：`pnpm check` exit 0；`pnpm test` **451 / 449 / 0 / 2**（skip 仍 2）；
  产物与根文档全部 LF、无 BOM。
- **端到端真实下载成功且缓存写入有实证**（用 dist 驱动）：8MB 文件经 aria2 下载成功、
  落盘字节一致、缓存出现 1 条记录、`hostHash` 等于 `sha256(hostname).slice(0,32)`、
  端口正确、`concurrency:8`、中位数吞吐 > 0、**文件名与内容都不含明文主机名**、读侧能读回。
- **roadmap 交付核对无越界**：§4 三张「不做」清单（P0 9 项 / P1 7 项 / P2 6 项）逐条核实未实现；
  §5 全部已拍板决策（D1=A / D4=② / D6=② / D7=② / 批量并发收紧 / timeoutMs / D5③ / D8 隐私口径）
  逐条有落地证据；模块级零可变状态。

**残留 5 项已逐条列在 §7**，其中只有第 1 项（GUI 面板）是真正的环境限制，
第 4 项（抬档端到端）是我主动标注的验证边界，其余是说明性记录。

---

*验证者：verify-a｜验证时间：2026-10-12 11:07–11:2x（Asia/Hong_Kong）｜
本次仅写入 `docs/VERIFY-FINAL.md` 与重建 `dist/`；探针脚本写在仓库外 Temp 目录，跑完即清理。*
