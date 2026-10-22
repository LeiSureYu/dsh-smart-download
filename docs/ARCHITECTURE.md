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
  ├─[0b] normalizeChecksum / normalizeSha256   src/hash.ts
  │      checksum 支持 md5 / sha1 / sha256 / sha512；裸 hex 按长度识别；
  │      sha256 与 checksum 二选一；写法不合法 → 在下载开始前就抛错（不白下一遍）
  │
  ├─[0c] ifExists ∈ {overwrite, skip, rename}  src/index.ts
  │      非法值在下载前拒绝，避免把拼错的值静默当成 overwrite
  │
  ├─[0d] buildRequestHeaders(...)         src/headers.ts
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
  │      同时读取 Content-Disposition（真实文件名可能只在这里）
  │      → ProbeResult { supportsMultiThread, contentLength, etag, lastModified,
  │                      contentEncoding, contentDisposition }
  │
  ├─[3b] resolveAutoMirror(...)           src/auto-mirror.ts
  │      仅当 mirror === "auto"：并发探测候选表，采用第一个
  │      「长度一致、且原始有 ETag 时 ETag 也一致」的候选；
  │      否则退回原始地址并把原因写进 mirrorSkipped
  │
  ├─[3c] 确定最终 outputPath             src/url.ts + src/index.ts
  │      显式 output → Content-Disposition → ?filename= / ?file= → URL 末段
  │      服务器文件名必须过 sanitizeFilename()（单段、无穿越、长度上限）
  │      ifExists=rename：找第一个不存在的 `name (n).ext`，绝不覆盖
  │
  ├─[3d] ifExists=skip 且目标已存在       src/index.ts
  │      不发下载请求；有摘要时仍校验已有文件，不匹配照样抛错
  │
  ├─[3e] checkDiskSpace(dir, size)        src/disk.ts
  │      大小已知且响应未压缩时，要求可用空间 ≥ size + max(64MB, 5% × size)
  │      不足 → 发请求前抛错；statfs 不可用 → 继续并记 diskCheckSkipped
  │
  ├─[4] planResume(outputPath, probe)     src/resume.ts
  │      比对旁车 .part.json 指纹；不能证实同源就删掉半包
  │      ifExists=rename 时禁用续传（半包属于另一个文件名）
  │
  ├─[5] decide(probe, aria2Available)     src/decision.ts
  │      → Decision { method, concurrency, fellback, reason }
  │
  ├─[6] downloadWithAria2 / downloadWithCurl   src/downloader.ts
  │      spawn 子进程 → 逐行解析进度 → reporter.report(...)
  │
  └─[7] assertIntegrity()                 src/verify.ts + src/hash.ts
          ① 落盘字节数 vs 远端声明长度
          ② 传了 sha256 / checksum 时：实际摘要 vs 期望摘要（流式计算）
          全通过 → 清旁车、返回 success（+ sha256 或 checksum / checksumAlgorithm）
          长度跳过 → 返回 success + verifySkipped 文案
          长度不符 / 哈希不符 → reporter.fail + IntegrityError
                               （**不**回退 curl 重下，见下）
```

## 模块职责

| 文件 | 行数 | 职责 | 关键点 |
| --- | --- | --- | --- |
| `src/index.ts` | ~1379 | 插件入口：注册 `smart_download` / `download_status` 两个工具，编排上面这些步骤 | 唯一的流程编排点；`IntegrityError` 让它与「传输失败」在 catch 里可区分 |
| `src/types.ts` | ~404 | 所有跨模块类型与返回结构 | `verifySkipped` / `reason` / `mirrorSkipped` / `diskCheckSkipped` 语义不同，见下 |
| `src/url.ts` | ~243 | URL 校验、输出文件名推导与净化 | 纯函数；协议白名单 + 单段文件名 + `Content-Disposition` 解析 |
| `src/mirror.ts` | ~134 | 镜像前缀归一化、拼接、GitHub 判定、候选表 | 纯函数、不发请求；`auto` 模式与候选表覆盖的入口 |
| `src/auto-mirror.ts` | ~198 | 自动镜像的挑选与「同源证明」 | 网络由调用方注入 `probe`；`ETag` 是镜像自报的，防不了投毒 |
| `src/headers.ts` | ~212 | 请求头合成、校验与三种落地形式 | 探测与下载**共用一份**；自管头与 CR/LF 注入拒绝 |
| `src/hash.ts` | ~255 | MD5 / SHA-1 / SHA-256 / SHA-512 归一化、流式计算、比对与文案 | 纯函数 + 一次流式读取；裸 hex 按长度识别，支持前缀与 SRI；旧 `sha256` 路径保留 |
| `src/probe.ts` | ~279 | 探测远端能力（Range / 长度 / 指纹 / 编码 / 文件名） | 异常绝不抛出；HEAD 失败会走 Range GET 兜底；HEAD 分支同样读 `Content-Range` |
| `src/decision.ts` | ~215 | 按大小与 aria2 可用性选方式 / 并发，并按吞吐历史抬档 | 纯函数；环境通过 `DecideEnv` 注入；只抬不降 |
| `src/throughput-cache.ts` | ~252 | 按「主机 + 端口」缓存**真实观测到**的吞吐与并发 | 数据是下载本身免费产生的，不发额外探测；损坏 / 不可写一律当「无历史」 |
| `src/resume.ts` | ~217 | 续传前的安全性判定与旁车指纹读写 | 唯一会主动删用户文件的模块 |
| `src/verify.ts` | ~137 | 落盘字节数校验（退出码 0 **之后**）与跳过文案 | 远端长度未知或被压缩时如实报 `skipped`，不假装校验过 |
| `src/disk.ts` | ~70 | 下载前磁盘空间预检 | `requiredFreeBytes` / `evaluateDiskSpace` 为纯函数；`statfs` 失败返回 `checked:false`，不阻断下载 |
| `src/downloader.ts` | ~614 | 参数拼接、子进程执行、进度解析接线 | 随包子包缺失时查 `PATH` 上的 `aria2c` 并跑 `--version` 验证；aria2 / curl 均带重试；curl 重定向仅 http(s)；`-k 1M` 与 `--allow-overwrite=true` 不可删 |
| `src/progress-parse.ts` | ~73 | aria2 摘要行 / curl 进度条解析、行切分 | 纯函数；真实样本在 `test/fixtures/` |
| `src/progress.ts` | ~519 | 双轨进度上报（JSONL + JSON）与记录增删 | 异步批量落盘，`awaitFlush()` 给终态兜底；`setTarget()` 在文件名确定后修正 label / outPath；1.4.0 起记 `outPath` / `size` / `fileMtimeMs` |
| `src/status.ts` | ~346 | `download_status` 的只读扫描与两条轨道合并 | 任何读取失败都退化为「少一条任务」，并用 `scanFailedDirs` 如实报出 |
| `src/cleanup.ts` | ~291 | `/api/smartdl.cleanup`：按保留窗口删**过期**的进度文件 | 与 `ProgressReporter.cleanup()` 不同 —— 这是给外部的触发入口，不接自动调用 |
| `src/rpc.ts` | ~770 | 三个 Host 端点：`status`（读快照）/ `cleanup`（清历史）/ `manage`（下载管理器的 `inspect`·`forget`·`delete`·`reveal`） | 路径**只能来自本插件自己的记录**；非法请求一律 `ok:false`，绝不按默认值执行 |
| `src/client.js` | ~2333 | 浏览器端：进度浮层 + 侧边栏入口 + 下载管理页（classic script） | 不打包，只依赖 `react`；会话由浮层写进共享 store，供 `manage` 定位轨道一 |

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

## 下载管理器：删除与「在文件夹中显示」

这两件事都必须在**宿主进程**里做（浏览器既拿不到文件系统，也起不了文件管理器），
所以它们走同一条 `POST /api/smartdl.manage`，用 `op` 区分；客户端只发 `taskId`。

```
浏览器（下载管理页）
   │  op:'inspect' | 'forget' | 'delete' | 'reveal'  +  taskId  +  session
   ▼
/api/smartdl.manage ──► readManagePayload（op 白名单 + taskId 白名单 + confirm 检查）
                          │
                          ├─ inspect → checkManagedTarget：lstat 判定产物现状（只读）
                          ├─ forget  → 只删本插件的两条进度记录，不碰产物
                          ├─ delete  → **先删产物、成功后再删记录**（顺序不可颠倒）
                          └─ reveal  → 宿主进程起 explorer / open / xdg-open
```

三条硬约束：

1. **路径只能来自本插件自己的记录。** 调用方给不了路径（给了也忽略）—— 删除不可逆，
   「删什么」必须由我们记下的那个 `outPath` 决定，而不是由请求决定。
2. **只有「文件确实还在原位」才动手。** `checkManagedTarget` 用 `lstat`（不是 `stat` ——
   否则会顺着符号链接把**目标**删掉），要求绝对路径、`normalize` 一致、尺寸与记录相符；
   目录、符号链接、尺寸不符、任务未终态一律拒绝并如实回告 `reason`。
3. **绝不假装成功。** `ok:true` 只代表「请求被处理」，`fileDeleted` 才是「文件没了」。
   删除失败时记录**保留**（用户还看得见、还能重试），失败按 8 种 `reason` 分类回告。

`op:'reveal'` 另有一层：客户端优先用宿主的 `remote.session`，该服务不可用时**自动降级**到
服务端实现。注意 `spawn` 的错误是**异步 emit** 的 —— 必须挂 `error` 监听，否则「命令不存在」
会变成未捕获异常，把整个宿主进程打崩（1.4.0 修的就是这个）。

**会话必须随请求带上**：轨道一的路径是 `<cwd>/.dsh-progress/<session.id>/`，没有它就只能扫
轨道二，于是出现「文件删得掉、记录删不掉」。会话由浮层（唯一读 `useSessions` 的组件）写进
共享 store，`manage` 从那里取。

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

`SmartDownloadResult` 里有几个容易混淆的字段，写代码时必须分清：

| 字段 | 回答的问题 | 何时出现 |
| --- | --- | --- |
| `reason` | 「为什么选了这种下载方式」 | 发生回退时有值；aria2 正常路径下是决策依据说明 |
| `verifySkipped` | 「为什么这次没做**字节数**校验」 | 只在确实跳过了长度比对时有值；传了 `sha256` 且核对通过时**不出现**（内容已逐字节核对，再报只会误导） |
| `sha256` | 「内容核对过了吗」 | 只在调用方传了 `sha256` 且核对通过时出现；它的**存在本身**就是「已逐字节核对」的证明 |
| `checksum` / `checksumAlgorithm` | 「通用摘要核对过了吗、用的哪种算法」 | 只在调用方传了 `checksum` 且核对通过时出现；旧 `sha256` 路径不会额外返回这两个字段 |
| `skipped` | 「这次是不是因为文件已存在而没下载」 | 只在 `ifExists: "skip"` 命中已有文件时出现；此时没有 `method` 字段 |
| `diskCheckSkipped` | 「为什么这次没做磁盘空间预检」 | 只在远端大小已知、但 `statfs` 查询失败时出现；大小未知或响应被压缩时不出现 |
| `mirrorSkipped` | 「请求了自动镜像，为什么没用上」 | 只在 `mirror: "auto"` 且未启用镜像时有值 |

它们可能同时出现（例如 `reason` + `verifySkipped` + `mirrorSkipped` + `diskCheckSkipped`），
因此不能合并成一个字段——合并后总有一方被顶掉。`verifySkipped` 的取值只有两个
（定义在 `src/verify.ts`），`mirrorSkipped` 只有三个（定义在 `src/auto-mirror.ts`），
都由测试断言字面量。

`reason` / `verifySkipped` / `mirrorSkipped` / `diskCheckSkipped` 都是给模型读的诊断文案：含中文与平台串
（例如 `未找到 aria2 二进制（当前平台 darwin-arm64 不受支持或子包未安装）`），
**不保证跨版本稳定**。程序化判断请用 `success` / `method` / `fellback` / `mirrored`
以及 `sha256` / `checksum` / `skipped` 是否存在。

### 为什么完整性校验失败不回退 curl

`downloadWithAria2` 失败会降级到 curl，但**完整性校验失败不会**。区别在 `src/index.ts`
里的 `IntegrityError`：产物已经落盘且内容不对，换一个下载器重下同一个地址不会改变
结果，只会让调用方白等一遍（传了 `sha256` 时尤其明显——摘要不符是内容问题，不是
传输问题）。取消（`AbortSignal`）同样不走回退：信号已经 abort，再起一个子进程只会
立刻再失败一次。

## 平台与二进制的对应

`ARIA2_TARGETS`（`src/downloader.ts`）把 `${process.platform}-${process.arch}`
映射到四个 npm 子包。子包用 `os` / `cpu` 字段声明适用平台，npm / pnpm 在不匹配的
平台上直接跳过安装。`getAria2Path()` 先尝试 `require.resolve` 定位子包内的二进制；
解析不到时再在 `PATH` 上查找 `aria2c`（Windows 会按 `PATHEXT` 展开），并对候选执行
一次 `--version` 验证。只有两者都失败才返回 `null`，由 `decide()` 回退 curl。

因此未列入 `ARIA2_TARGETS` 的平台（当前是 macOS）不再是「永远走 curl」：
`PATH` 上有可用的 `aria2c` 时同样会多线程下载，没有时插件仍可用，只是走 curl
单线程。详见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

## 相关文档

- [SECURITY.md](./SECURITY.md) —— 五层防护与威胁模型
- [COMPATIBILITY.md](./COMPATIBILITY.md) —— 平台 / 版本矩阵
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) —— 症状 → 原因 → 处理
- [REVIEW-1.0.md](./REVIEW-1.0.md) —— 1.0 代码审查记录
