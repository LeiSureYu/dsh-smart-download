# 架构

本文说明 `@leisureyu/dsh-smart-dl` 的内部结构。面向想改代码或排查问题的人，
不面向第一次安装的人（安装看 [README](../README.md)）。

## 一次 `smart_download` 调用经过什么

```
execute(args, exec)                       src/index.ts
  │
  ├─[0] checkDownloadUrl(url)             src/url.ts
  │      协议白名单：只放行 http / https，其余直接抛错
  │
  ├─[0b] normalizeSha256(args.sha256)     src/hash.ts
  │      摘要不合法 → 在下载开始前就抛错（不白下一遍）
  │
  ├─[0c] buildRequestHeaders(...)         src/headers.ts
  │      headers + userAgent + referer 合成**一份**头表；
  │      自管头（Range / Accept-Encoding / Host / 连接级）与 CR/LF 注入一律拒绝
  │
  ├─[1] applyMirror(url, mirror)          src/mirror.ts
  │      显式前缀 → 前缀拼接；"auto" → 推迟到 [3b]
  │      输出文件名仍按原始 URL 推导
  │
  ├─[2] new ProgressReporter(...)         src/progress.ts
  │      确定两条进度轨道的落点（可能为 null = 不写）
  │
  ├─[3] probeUrl(requestedUrl, {headers}) src/probe.ts
  │      HEAD →（抛异常 / 405 / 无 Content-Length 时）Range GET
  │      强制 accept-encoding: identity
  │      → ProbeResult { supportsMultiThread, contentLength, etag, lastModified, contentEncoding }
  │
  ├─[3b] resolveAutoMirror(...)           src/auto-mirror.ts
  │      仅当 mirror === "auto"：并发探测候选表，采用第一个
  │      「长度一致、且原始有 ETag 时 ETag 也一致」的候选；
  │      否则退回原始地址并把原因写进 mirrorSkipped
  │
  ├─[4] planResume(outputPath, probe)     src/resume.ts
  │      比对旁车 .part.json 指纹；不能证实同源就删掉半包
  │
  ├─[5] decide(probe, aria2Available)     src/decision.ts
  │      → Decision { method, concurrency, fellback, reason }
  │
  ├─[6] downloadWithAria2 / downloadWithCurl   src/downloader.ts
  │      spawn 子进程 → 逐行解析进度 → reporter.report(...)
  │
  └─[7] assertIntegrity()                 src/verify.ts + src/hash.ts
          ① 落盘字节数 vs 远端声明长度
          ② 传了 sha256 时：实际摘要 vs 期望摘要（流式计算）
          全通过 → 清旁车、返回 success（+ sha256）
          长度跳过 → 返回 success + verifySkipped 文案
          长度不符 / 哈希不符 → reporter.fail + IntegrityError
                               （**不**回退 curl 重下，见下）
```

## 模块职责

| 文件 | 行数 | 职责 | 关键点 |
| --- | --- | --- | --- |
| `src/index.ts` | ~507 | 插件入口：注册 `smart_download` / `download_status` 两个工具，编排上面 10 步 | 唯一的流程编排点；`IntegrityError` 让它与「传输失败」在 catch 里可区分 |
| `src/types.ts` | ~214 | 所有跨模块类型与返回结构 | `verifySkipped` / `reason` / `mirrorSkipped` 三者语义不同，见下 |
| `src/url.ts` | ~160 | URL 校验与输出文件名净化 | 纯函数；协议白名单 + 单段文件名 |
| `src/mirror.ts` | ~144 | 镜像前缀归一化、拼接、GitHub 判定、候选表 | 纯函数、不发请求；`auto` 模式与候选表覆盖的入口 |
| `src/auto-mirror.ts` | ~216 | 自动镜像的挑选与「同源证明」 | 网络由调用方注入 `probe`；`ETag` 是镜像自报的，防不了投毒 |
| `src/headers.ts` | ~230 | 请求头合成、校验与三种落地形式 | 探测与下载**共用一份**；自管头与 CR/LF 注入拒绝 |
| `src/hash.ts` | ~143 | SHA-256 归一化、流式计算、比对与文案 | 纯函数 + 一次流式读取；四种官方文档写法归一化 |
| `src/probe.ts` | ~295 | 探测远端能力（Range / 长度 / 指纹 / 编码） | 异常绝不抛出；HEAD 失败会走 Range GET 兜底；HEAD 分支同样读 `Content-Range` |
| `src/decision.ts` | ~128 | 按大小与 aria2 可用性选方式 / 并发 | 纯函数；环境通过 `DecideEnv` 注入 |
| `src/resume.ts` | ~236 | 续传前的安全性判定与旁车指纹读写 | 唯一会主动删用户文件的模块 |
| `src/downloader.ts` | ~354 | 参数拼接、子进程执行、进度解析接线 | `-k 1M` 与 `--allow-overwrite=true` 不可删 |
| `src/progress-parse.ts` | ~63 | aria2 摘要行 / curl 进度条解析、行切分 | 纯函数；真实样本在 `test/fixtures/` |
| `src/progress.ts` | ~395 | 双轨进度上报（JSONL + JSON） | 异步批量落盘，`awaitFlush()` 给终态兜底 |
| `src/status.ts` | ~244 | `download_status` 的只读扫描与合并 | 任何读取失败都退化为「少一条任务」 |
| `src/rpc.ts` | ~188 | `/api/smartdl.status` Host 端点（web 面板数据源） | 非法请求一律回落到具体默认值 |
| `src/client.js` | ~365 | 浏览器端进度面板（classic script） | 不打包，只依赖 `react` |

## 数据流：进度怎么从子进程走到界面

```
aria2c --summary-interval=1 的 stdout
curl  --progress-bar 的 stderr
        │  逐行（LineBuffer 兼容 \r / \n / \r\n，保留半截行）
        ▼
parseAria2Summary / parseCurlProgress      src/progress-parse.ts
        │  { pct, spd, eta }
        ▼
ProgressReporter.report(pct, msg, spd, eta, state)   src/progress.ts
        │  按整条记录去重（pct|state|msg|spd|eta 全同才跳过）
        │  微任务批量落盘，保序
        ├──▶ 轨道一  <session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl   （append-only）
        └──▶ 轨道二  <DSH_HOME>/downloads/tasks/<taskId>.json                  （整体覆盖写）
                     │
                     ├─▶ download_status 工具          src/status.ts
                     └─▶ POST /api/smartdl.status      src/rpc.ts
                              │  client-request / server-response 信封
                              ▼
                         shell.overlay 进度胶囊       src/client.js
```

**为什么是两条轨道**：轨道一的格式属于 `dsh-task-progress`（DSH 宿主的进度协议），
名字和状态字段的约定由它决定；轨道二是本插件自己的快照，用来支撑 `download_status`
与面板。两者都写，`readDownloadStatus` 以 `id` 合并：轨道二提供 `status` / `updatedAt`，
轨道一补充 `msg` / `spd` / `eta`。

**为什么终态要 `awaitFlush()`**：`report()` 是异步落盘的，`done()` 之后调用方通常
立刻 `return`；不等一下，那条「已完成」还躺在队列里，面板就会永远停在「下载中」。

## 决策表

| 条件 | 方式 | 并发 | `fellback` |
| --- | --- | --- | --- |
| 探测判定不支持多线程 | curl | 1 | `true` |
| 探测拿到 `contentLength === undefined` | curl | 1 | `true` |
| `contentLength < 1MB` | curl | 1 | `true` |
| 没有可用的 aria2 二进制 | curl | 1 | `true` |
| `1MB ≤ size < 8MB` | aria2 | 4 | `false` |
| `size ≥ 8MB` | aria2 | 8 | `false` |
| aria2 已启动但下载失败 | curl 重试一次 | 1 | `true`，`reason` 记 aria2 的错 |

阈值不是拍脑袋定的，推导过程（受控限速实验、每连接 2MB/s、3 轮取中位数）写在
[README 的「并发阈值是实测的」](../README.md#并发阈值是实测的不是猜的) 一节。

## 返回字段的语义边界

`SmartDownloadResult` 里有四个容易混淆的字符串字段，写代码时必须分清：

| 字段 | 回答的问题 | 何时出现 |
| --- | --- | --- |
| `reason` | 「为什么选了这种下载方式」 | 发生回退时有值；aria2 正常路径下是决策依据说明 |
| `verifySkipped` | 「为什么这次没做**字节数**校验」 | 只在确实跳过了长度比对时有值；传了 `sha256` 且核对通过时**不出现**（内容已逐字节核对，再报只会误导） |
| `sha256` | 「内容核对过了吗」 | 只在调用方传了 `sha256` 且核对通过时出现；它的**存在本身**就是「已逐字节核对」的证明 |
| `mirrorSkipped` | 「请求了自动镜像，为什么没用上」 | 只在 `mirror: "auto"` 且未启用镜像时有值 |

四者可能同时出现（`reason` + `verifySkipped` + `mirrorSkipped`），因此不能合并成一个
字段——合并后总有一方被顶掉。`verifySkipped` 的取值只有两个（定义在 `src/verify.ts`），
`mirrorSkipped` 只有三个（定义在 `src/auto-mirror.ts`），都由测试断言字面量。

`reason` / `verifySkipped` / `mirrorSkipped` 都是给模型读的诊断文案：含中文与平台串
（例如 `未找到 aria2 二进制（当前平台 darwin-arm64 不受支持或子包未安装）`），
**不保证跨版本稳定**。程序化判断请用 `success` / `method` / `fellback` / `mirrored`
以及 `sha256` 是否存在。

### 为什么完整性校验失败不回退 curl

`downloadWithAria2` 失败会降级到 curl，但**完整性校验失败不会**。区别在 `src/index.ts`
里的 `IntegrityError`：产物已经落盘且内容不对，换一个下载器重下同一个地址不会改变
结果，只会让调用方白等一遍（传了 `sha256` 时尤其明显——摘要不符是内容问题，不是
传输问题）。取消（`AbortSignal`）同样不走回退：信号已经 abort，再起一个子进程只会
立刻再失败一次。

## 平台与二进制的对应

`ARIA2_TARGETS`（`src/downloader.ts`）把 `${process.platform}-${process.arch}`
映射到四个 npm 子包。子包用 `os` / `cpu` 字段声明适用平台，npm / pnpm 在不匹配的
平台上直接跳过安装。`getAria2Path()` 用 `require.resolve` 定位子包内的二进制；
解析不到就返回 `null`，由 `decide()` 回退 curl。

未列入 `ARIA2_TARGETS` 的平台（当前只有 macOS）行为是「插件可用但永远走 curl」，
不报错也不假装支持。详见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

## 相关文档

- [SECURITY.md](./SECURITY.md) —— 五层防护与威胁模型
- [COMPATIBILITY.md](./COMPATIBILITY.md) —— 平台 / 版本矩阵
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) —— 症状 → 原因 → 处理
- [REVIEW-1.0.md](./REVIEW-1.0.md) —— 1.0 代码审查记录
