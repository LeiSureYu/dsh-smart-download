# dsh-smart-dl

[![npm version](https://img.shields.io/npm/v/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![npm downloads](https://img.shields.io/npm/dm/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![license](https://img.shields.io/npm/l/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![Publish](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml/badge.svg)](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux-0078D4)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leisureyu/dsh-smart-download)

**简体中文** · [English](./README.en.md)

> **给 DSH 装上一个内置 aria2 的下载器。** 一条命令装好，不用自己配环境：大文件自动多线程加速，服务器不支持就自动回退，中途断了还能续传。

![实时进度面板](docs/progress-pill.png)

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

桌面版（DeepSeek Harness 0.2.0 起）装同一个包：用桌面版自带的 CLI，或侧边栏的 Plugins 页面。

- **自动多线程加速** —— 下载前先探测目标服务器，支持多连接就调用内置 `aria2c` 并发下载，不支持则自动回退到系统 `curl`，两种情况都能下完。
- **零配置** —— aria2 二进制随插件一起安装（npm `optionalDependencies`），无需自行下载或配置 PATH。
- **进度看得见** —— 带 Web 界面的 profile（`web` / 桌面版）右下角有实时进度面板（文件名 / 百分比 / 速度 / 剩余时间），下载完成后自动消失。
- **断点续传** —— 中断后用同样的 `url` + `output` 再调用一次即可续传。
- **进度可查询** —— `download_status` 工具只读查询最近任务的百分比 / 速度 / ETA。

支持 **Windows x64 / arm64** 与 **Linux x64 / arm64**，这四组合是完整支持（随包 aria2 多线程）。
macOS 能装能用，但永远走 `curl` 单线程 —— 原因见[兼容性说明](./docs/COMPATIBILITY.md)，那里也写清了为什么没硬做。

`dsh-smart-dl` 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 注册两个工具：

- **`smart_download`**：下载文件。先探测目标服务器是否支持多线程，支持则调用随插件分发的 `aria2c` 多线程加速，否则自动回退到系统自带的 `curl` 单线程下载，保证任何情况下都能完成下载。可选镜像加速与断点续传。
- **`download_status`**：查询下载进度。只读地返回最近任务的状态快照（百分比、速度、ETA），可用来回答“刚才那个下载到百分之几了”。

## 安装

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

安装后无需任何额外配置：aria2 二进制通过 npm 的 `optionalDependencies` 机制随插件一起安装。

**支持的 profile**：`web` 与 `desktop`（0.2.0 起的桌面版）。安装命令形如 `dsh plugin --profile <profile> add <包名>`，请把 `<profile>` 换成你实际使用的 profile 名称。

**桌面版请用桌面版自带的 CLI 安装**，不要用系统里另外装的 `dsh`（桌面版的 profile 由 Electron 应用独占管理）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @leisureyu/dsh-smart-dl
```

也可以在桌面版侧边栏的 Plugins 页面里添加。

> **进度面板只在带 Web 界面的 profile 生效**（`web` 与桌面版的 `desktop`）。纯 CLI 等 profile 下插件功能完全不受影响，只是没有界面面板，仍可用 `download_status` 工具查询进度。

> **1.1.0 为 DSH 0.2.0 适配。** 0.2.0 起安装前会核对 `peerDependencies`：`0.4.0` 及更早版本声明的范围不含 `0.2.0`，装上后整个 bundle 会被跳过，插件完全不加载。如果你装的是 `0.4.0` 或更早，升级即可；`0.4.1` 起已覆盖 0.2.0。详见 [COMPATIBILITY.md](./docs/COMPATIBILITY.md)。
>
> **1.0.0 是首个正式版。** 相较于 0.9.x，这一版把「哪些情况在静默降级」全部摊开：完整性校验的**跳过**与**通过**不再共用同一个返回值（新增 `verifySkipped` 字段），取消下载会真的上报 `cancelled` 而不是伪装成失败，并且修掉了两个 0.9.0 遗留的真问题 —— `mirror` 参数可以绕过协议白名单（`file://` 前缀会把本地文件复制出来），以及 `awaitFlush` 的超时计时器没 `unref` 导致 CLI 每次下载多卡约 2 秒。逐条依据见 [REVIEW-1.0.md](./docs/REVIEW-1.0.md)。
>
> **版本要求：请使用 `1.1.0` 或更高。** 0.7.0 ~ 0.9.0 的历史（完整性校验、续传指纹、进度轨道 `state`、面板、跨平台二进制）不再在这里复述，完整记录见 [CHANGELOG.md](./CHANGELOG.md)。
>
> 更早的 `0.1.x` / `0.2.1` 有安装期缺陷（插件清单校验、`peerDependencies` 范围解析不到预发布版），不要再用；升级到 `1.1.0` 即可。

## 工作原理

下载决策流程（文字版）：

```
调用 smart_download(url, output?, mirror?)
        │
        ▼
[0] 若传入 mirror，则把原始 URL 拼到镜像前缀后
     · 镜像前缀 + 完整原始 URL
     · 非 http(s) URL 不走镜像
     · 输出文件名仍按原始 URL 推导
        │
        ▼
[1] 探测 URL（超时 5s）
     · 先发送 HEAD 请求
     · 若 HEAD 返回 405 或缺少 Content-Length，
       则改用 GET + "Range: bytes=0-0"
        │
        ▼
[2] decide() 按文件大小与 aria2 可用性分档：
     · 不支持 Range / 探测失败 / 无法获取大小 / <1MB  -> curl
     · 1MB ~ 8MB   -> aria2 4 连接
     · ≥ 8MB        -> aria2 8 连接（保守上限，不开 16）
        │
   ┌────┴──────────────────────────┐
   ▼ aria2 档                       ▼ curl 档
[3a] 能定位到随包 aria2c？         [3b] curl 单线程（含进度条）
   │ 是              │ 否
   ▼                 ▼
  aria2 4/8 连接     curl 单线程（回退）
  （每秒摘要进度）
  （-c 续传）        （支持 Range 时 -C - 续传）
    │ 失败
    ▼
  降级为 curl 单线程（回退）
         │
         ▼
[4] 完整性校验：落盘字节数 vs 远端声明长度
        │ 一致            │ 不一致
        ▼                 ▼
   清除 .part.json    抛错，保留旁车
   返回 success

  返回结果 { success, path, method, size, fellback, reason?, verifySkipped?, requestedUrl, mirrored }
```

要点：

- **任何探测异常**（超时、网络错误、无法获取文件大小）都会被安全地判定为“不支持多线程”，从而走 curl 回退，不会让下载直接失败。
- 并发数随文件大小动态选择（阈值 1MB / 8MB），`reason` 会区分“不支持 Range”“文件太小”“aria2 缺失”等情况。
  阈值是 0.7.0 实测定下的，不是拍脑袋（见下方「并发阈值是实测的，不是猜的」）。
- **下载完成后会校验落盘字节数**：`curl` / `aria2` 的退出码 0 只代表“它自己认为完成了”，不代表字节数对。
  少发、多发、镜像返回 200 的错误页等场景都不会有非零退出码，只有校验能拦下（详见「设计上的静默失败防护」）。
- 返回的 `requestedUrl` 是**实际请求的地址**（启用镜像时为「镜像前缀 + 原始 URL」），`mirrored` 标明本次是否走了镜像。
- **只允许 `http` / `https`**：URL 来自模型读到的任意页面，属于不可信输入。其他协议（`file:`、`ftp:` 等）在下载开始前直接被拒绝，不会进入探测或下载流程。
- **输出文件名会被净化**：未传 `output` 时按 URL 推导文件名，推导结果只取**单个路径段**——URI 解码后的 `/`、`\`、`..` 等一律丢弃，因此不会写到工作目录之外。

### 为什么必须做协议白名单与文件名净化（实测结论，勿移除）

> `0.4.1` 实测：`file:///C:/Windows/win.ini` 会被 `curl` 接受并**成功复制本地文件**到目标路径；
> `http://host/..%2F..%2F..%2Fescaped.txt` 会解码出 `../../../escaped.txt`，未指定 `output` 时
> 文件被写到**当前工作目录之外**（实测确认写入成功）。两者都在 `0.4.2` 修复：前者由协议白名单
> 拦截，后者由「解码后再切分、只取最后一段 + 净化」拦截。

## 镜像加速

下载 GitHub Release 等境外资源较慢时，可给 `smart_download` 传入 `mirror` 前缀，插件会把原始 URL 拼到该前缀后面再下载：

```
smart_download(
  url: "https://github.com/owner/repo/releases/download/v1/a.zip",
  mirror: "https://gh-proxy.com/"
)
# 实际请求：https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1/a.zip
```

细节：

- 只做**前缀拼接**，不做路径改写，因此适配绝大多数「前缀 + 完整原始 URL」形式的公开镜像；
- 前缀**缺尾斜杠会自动补上**，也可直接写裸域名（`ghfast.top` 会补成 `https://ghfast.top/`）；
- 非 `http(s)` 的 URL 不使用镜像；**镜像前缀本身也必须过白名单** —— 非 `http(s)` 的前缀（`file://`、`javascript://`、`data://` 等）一律不生效、原样走原始 URL。字符串拼接后整串的 scheme 由前缀决定，不判前缀就等于给 `file://` 开了后门（1.0.0 修正，实测见 [SECURITY.md](./docs/SECURITY.md)）；
- 输出文件名始终按**原始 URL** 推导，不会把镜像域名带进文件名。

常见的公开镜像（任选其一，可用性随网络环境变化）：

| 镜像前缀 |
| --- |
| `https://gh-proxy.com/` |
| `https://ghfast.top/` |
| `https://ghproxy.net/` |

> 镜像是**第三方服务**：请求内容会经过该镜像服务器，请勿用它下载含敏感信息的文件。

## 断点续传

下载中断后再次调用 `smart_download`（同样的 `url` 与 `output`）会从断点继续，而不是从头重下：

- **aria2 路径**：能证实同源时启用 `-c`，否则不续传并带 `--allow-overwrite=true` 覆盖写。
- **curl 路径**：**仅在探测确认服务器支持 Range 且能证实同源时**才加 `-C -`。

为什么续传除了「支持 Range」还要多一道校验（实测结论，勿简化）：

> `0.6.0` 用真实 curl 8.13.0 与随包 aria2 1.37.0 在 127.0.0.1 上实测：远端从 400 字节变成 200 字节时，`curl -C -` 与 `aria2 -c` 都是**退出码 0、落盘仍是 400 字节**；远端等长但内容换了时，两者同样是**退出码 0、文件保留旧内容**。也就是说「支持 Range」只保证能续，不保证续的是同一个文件。
> 因此续传前会比对远端长度与 `ETag` / `Last-Modified`（指纹记在 `<output>.part.json` 旁车里，下载成功时清除、中断时保留），无法证实同源就删掉本地半包全量重下。只比长度挡得住前两行，挡不住「等长但内容变了」，这也是必须有旁车指纹的原因。

为什么 curl 的续传是条件式的（实测结论，勿改成无条件）：

> `curl -C -` 在服务器**不支持** Range 且本地已存在半截文件时，会以**退出码 33 直接失败**——实测：1000 字节资源、已有 400 字节半包 → `exit 33`，文件保持 400 字节不损坏；而同一场景**不带** `-C -` 能正常全量重新下载成功。
> 支持 Range 时三种情况均实测正确：半包续传、已下载完整后重跑、文件不存在从头下。

## 查询下载进度：download_status

`download_status` 只读地返回本插件下载任务的状态快照，可用来回答“刚才那个下载到百分之几了”。

```
download_status()                      # 列出最近 10 个任务
download_status(limit: 3)              # 只列最近 3 个
download_status(taskId: "dl-xxx")      # 只查指定任务
```

返回示例：

```json
{
  "ok": true,
  "taskDir": "/path/.dsh-progress/<session-id>",
  "downloadDir": "/home/u/.dsh/downloads/tasks",
  "total": 1,
  "tasks": [
    {
      "id": "dl-mulfpr76-z47a",
      "name": "local-24MiB.bin",
      "pct": 100,
      "msg": "下载完成",
      "status": "completed",
      "spd": "8.2MB/s",
      "eta": "",
      "updatedAt": 1759000000000
    }
  ]
}
```

约束与设计取舍：

- **纯只读**：不写文件、不联网。读取的就是「进度上报」那一节里的两条轨道目录。
- **容错优先**：目录不存在、权限不足、文件内容损坏，都退化为「该任务不出现在结果里」，整个调用依然成功返回（只是任务列表更短），不会因为查状态而让下载失败。
- 任务按 `updatedAt` **倒序**，最新的排在最前；`total` 是**未截断**的真实总数，`tasks` 会被 `limit` 截断。
- `name` 是输出文件名（面板与列表显示用），未知时回退为任务 ID。
- `spd` / `eta` 在不支持或未知时返回**空字符串**（schema 要求 string），不会返回 `null` 或 `undefined`。

## 进度上报

下载过程中通过 `ProgressReporter` **双轨**写入进度，任一轨道不可写都静默容错，不影响下载：

- 轨道一（dsh-task-progress 格式）：`$DSH_PROGRESS_DIR/<taskId>.jsonl`，每行一条 JSON，append-only。**DSH 0.2.0 起官方不再内置这个读取端**，只有第三方插件 [`dsh-task-progress`](https://www.npmjs.com/package/dsh-task-progress) 会读；轨道二与内置面板不受影响。未设置该环境变量时，缺省为 `<session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl`（会话 ID 与工作目录来自 `exec.agent.session.header`）。**拿不到会话上下文时不写轨道一**——dsh-task-progress 的读取端按 session 过滤，写进错误的目录等于没写；
- 轨道二（本插件自有格式）：`$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`，缺省为 `<DSH_HOME>/downloads/tasks/<taskId>.json`（`DSH_HOME` 缺省为 `~/.dsh`），整体覆盖写。

每条记录都带 `state` 字段（`running` / `done` / `failed` / `cancelled`）：dsh-task-progress 的读取端只认 `state`，缺失时一律当作 `running`，因此 0.5.0 之前的进度记录即使 `pct=100`、`msg=下载完成`，面板也永远显示「下载中」。进度**按整条记录去重**（`pct + state + msg + spd + eta` 完全一致才跳过），任一项变化都会写入，因此面板能看到实时的速度与剩余时间；完成 / 失败 / 取消等终态因为 `state` 变化，必然穿透去重。aria2 解析 `--summary-interval=1` 的摘要行（含速度与 ETA），curl 解析 `--progress-bar` 的百分比。

写盘自 `0.6.0` 起是**异步**的：`report()` 只把记录放进队列，由 microtask 批量写出并保序，下载主流程不再被同步 `appendFileSync` 阻塞；调用方在返回前会 `await reporter.awaitFlush()` 等待终态落盘，因此 `download_status` 与面板读到的必定是终态，而不是上一次的中间状态。

## 界面进度面板（web / desktop）

在带 Web 界面的 profile（`web`，以及桌面版的 `desktop`）下，插件会在界面右下角挂载一个**实时进度面板**：只要有下载在进行就自动出现，显示**输出文件名、百分比、传输速度与剩余时间**；下载完成后短暂显示「已完成」回执，然后自动消失。空闲时不占位、不显示。

![进度面板](docs/progress-pill.png)

实现要点（如遇面板不显示，可据此排查）：

- **走宿主 RPC**：客户端通过 `connection.fetch.register` 注册的 `/api/smartdl.status` 拉取进度快照，与 `download_status` 工具读的是同一份进度文件。
- **插槽**：注册到 `shell.overlay`（`kind: 'list'`，`order: 100`），因此不会覆盖宿主自身界面；无内容时渲染为 `null`。
- **只依赖 `react`**：客户端脚本以 classic script 形式通过 `window.__ModuleLoader__.load` 注册，不做打包。
- **陈旧任务自动忽略**：超过 10 分钟没有更新的 `running` 任务不再计入面板，避免历史残留文件让面板永久卡住。

> 该面板仅在带 Web 界面的 profile 提供；CLI 等 profile 下插件会静默跳过客户端注册，工具与下载功能不受影响。

## 设计上的静默失败防护

开发过程中实测发现了三个**同类型的静默失败**：

1. **aria2 摘要格式变化**：关闭 readout 后，GID 变为十六进制、无 `SIZE:` 前缀、速度字段由 `SPD:` 变为 `DL:`；
2. **curl `--silent` 抑制进度**：即使进度走 stderr，`--silent` 也会把 `--progress-bar` 一并压掉；
3. **aria2 临近完成时省略 ETA**：快完成的摘要行整体不输出 ETA 字段。

它们都不是逻辑错误，而是**对外部程序真实行为的假设错了**：逻辑都对、测试都绿、下载也成功，只是某个环节悄悄返回了默认值（“不支持” / `curl` / `null` / 跳过写入）。这类问题的危险在于退出码仍是 0，“不抛错”的测试永远抓不住。

0.5.0 又抓到同一类的三个：**轨道一缺 `state`**（面板永远显示「下载中」）、**无会话时把进度写进没人读的目录**、**`DSH_HOME` 未生效导致写进陈旧的 home**。0.6.0 抓到的是最危险的一类：**续传静默损坏**（`curl -C -` / `aria2 -c` 在远端变小或内容变更时退出码 0 但文件是错的）与 **aria2 覆盖时把新内容写进 `f.1.bin` 而返回的 `path` 指向旧文件**——两者都是「报告成功、产物错误」，只有「落盘内容是否等于远端内容」这种正向断言才能发现。它们同样不抛错、测试也曾经全绿——只有「面板/查询是否真的显示了正确状态」「文件是否真的是远端那份」这种正向断言才能发现。

**0.7.0 抓到的是「工具报告成功、但字节数不对」**：随包 aria2 1.37.0 在服务器用 chunked 只发 1MB 就干净断开时，
退出码是 **0**、摘要里写着 `OK`，落盘文件却只有 1MB（声明 4MB）；`curl` 在同一场景下同样是 exit 0。
没有任何非零退出码可供判断，只有落盘后比对字节数才能发现。详见下节。

**0.8.0 补的是「防护网自己漏了一个角」**：`/api/smartdl.status`（浏览器进度面板与 `download_status`
共用的唯一 Host 端点）此前是全项目覆盖率最低的模块——剔除它的专属测试文件后实测函数覆盖只有
**2/7**、行覆盖 **62.37%**，`ok` / `fail` / `envelopeResponse` / `readPayload` 与整个 handler
主体 `count=0`，一次都没被执行过。换句话说，这类「非法请求静默回落、业务异常不裸奔 500」的防护
**写在代码里但从未被任何测试证明过**，属于最容易被后续重构悄悄改坏的部分。0.8.0 补上
`test/rpc.test.ts`（21 例）后为 **9/9**、行覆盖 **99.46%**，每条跳过 / 回落路径都断言了它回落到的
**具体值**，而不是「不抛错」。

> 覆盖率数字统一取自 Node 自带的 `--experimental-test-coverage`（见下方「开发」小节）。0.8.0 时
> 文档里的 `6/16` / `16/26` 来自手搓的 `NODE_V8_COVERAGE` 统计，该方式在 Windows + tsx 下会因
> 源码映射错位而虚增函数个数，已作废；本版本起一律以自带覆盖率为准。

**1.0.0 把「静默降级」本身当成要修的对象**，抓到三类：

1. **校验跳过与校验通过同形**：`verifySize` 在「远端没声明长度」「服务器返回压缩编码」两种情形下返回的
   与「真的比过且一致」一模一样。一次**没有做过任何校验**的下载，在返回值里看起来和校验通过完全一样。
   现在跳过是独立分支，带机器可读的 `reason` 与用户可见的 `verifySkipped` 文案。
2. **取消伪装成失败**：`reporter.cancel()` 在生产代码里从未被调用过，用户按取消看到的是「下载失败」。
   现在取消路径（`exec.signal.aborted`）会记 `cancelled`。
3. **`mirror` 绕过协议白名单**：`mirror` 是**字符串拼接**，拼接后整串的 scheme 由前缀决定，
   于是 `file:///C:/Windows/win.ini?x=` 这种前缀能把第一层防护整个绕过去（实测：`curl` 退出码 0，
   把本地 `win.ini` 复制了出来）。现在前缀本身也要过白名单。

另有两个「不抛错但明显不对」的问题一并修掉：`awaitFlush` 的超时计时器没有 `unref`，
CLI 下每次下载结束都要多卡约 2 秒才退出；以及 aria2 失败回退 curl 时，进度文案写的是 aria2 的错误、
抛出的却是 curl 的错误，排查时对不上。逐条复现步骤与改法见 [REVIEW-1.0.md](./docs/REVIEW-1.0.md)。

**契约**：本插件所有“返回默认值”的路径——

| 环节                  | 静默失败形态        | 必须断言的正向信号                                  |
| ------------------- | ------------- | ------------------------------------------ |
| `probeUrl`          | 探测异常 → 不支持    | 已知支持的 URL 必须返回 `supportsMultiThread: true` |
| `decide`            | 分支遗漏 → 落 curl | 已知大文件必须返回 `method: 'aria2'`                |
| `parseAria2Summary` | 认不出 → `null`  | 真实样本必须解析出 `pct/spd(/eta)`                  |
| `parseCurlProgress` | 认不出 → `null`  | 真实样本必须解析出单调递增到 100% 的百分比                   |
| `ProgressReporter`  | 目录不可写 → 跳过    | 可写目录必须存在文件且内容递增                            |
| `LineBuffer`        | 切分状态错误        | 跨 chunk / `\r` / `\r\n` 边界必须切出正确的行         |
| `applyMirror`       | 拼错 → URL 仍合法；**非 http(s) 前缀 → 绕过白名单** | 拼接结果必须可 `new URL()` 解析，且以原始 URL 结尾；`file://` / `javascript://` / `data://` 前缀必须**不生效**并原样返回原始 URL |
| `readDownloadStatus`| 读不到 → 空列表      | 目录里有合法任务文件就必须扫出并解析出字段                 |
| `buildCurlArgs`     | 续传开关插错位置     | `resume` 为真时 `-C -` 必须存在，为假时必须不存在，且 `-o` 与路径紧邻 |
| `checkDownloadUrl`  | 不校验协议 → 读本地文件 | `file://` / `ftp://` 必须被拒绝，`http(s)` 必须被放行并返回解析后的 URL |
| `deriveFilenameFromUrl` | 不净化 → 路径穿越 | `..%2F..%2F..%2Fescaped.txt` 必须推导为单段 `escaped.txt`，且实际写入不得逃出当前目录 |
| `ProgressReporter`  | 轨道一缺 `state` → 面板永远「下载中」 | 终态记录必须含 `state: 'done' / 'failed' / 'cancelled'`，`readDownloadStatus` 必须据此返回 completed / failed / cancelled |
| `resolveTaskProgressDir` | 无会话 → 写进没人读的目录 | 无 `DSH_PROGRESS_DIR` 且无会话时必须返回 `null`（即不写轨道一），有会话时必须是 `<cwd>/.dsh-progress/<id>` |
| `resolveDshHome`    | 不读 `DSH_HOME` → 写进陈旧 home | `DSH_HOME` 必须生效，空 / 纯空白必须回落 `~/.dsh` |
| `statusFrom`        | 只认文案 → 状态判错 | 记录带 `state` 时必须以 `state` 为准（`state: 'running'` + 文案「下载完成」仍是 running） |
| `verifySize`        | 退出码 0 但字节数不对 → 当成成功 | 字节数一致必须返回 `ok`；**chunked 截断**（aria2/curl 均 exit 0）必须被判为失败；「探测长度未知」与「服务器返回压缩编码」必须返回**独立的 `skipped`**（带机器可读 `reason`）而不是与 `ok` 同形 |
| `probeUrl` 的 `accept-encoding` | 默认带 `gzip, deflate` → 拿到压缩长度 | 服务器必须收到 `identity`，且必须取回**未压缩**长度（5000 而非 41） |
| `registerStatusRpc` 的 handler | 非法请求 → 回默认值 / 静默放行 | 无 `connection` 时必须**恰好注册 0 条路由**；信封非法必须回 `rpcId='invalid-request'` 的 `ok:false`；非法 `limit` 必须回落到 `DEFAULT_STATUS_LIMIT`（10，而非 0 / `Infinity`）；业务异常必须仍是 200 + `ok:false`（不裸奔 500） |

所有断言都是**正向**的：检查“有没有真的产出”，而不是“有没有崩溃”。真实样本保存在 `test/fixtures/`（curl 为保留 `\r` 的 `.bin`），并对“fixture 必须含 `\r`”做了强制断言。

> 如果未来发现某条返回默认值的路径没有被正向信号断言覆盖，**那是一个 bug，不是设计**。把正向断言改回“只要不报错就行”，等于重新打开静默失败的后门。

此外，`test/meta-test-discovery.test.ts` 会枚举 `test/` 下所有测试文件，并断言 `test` 脚本（glob）确实覆盖它们——连“CI 是否真的跑了这些测试”这一层本身也被强制验证，防止防护措施自己在 CI 里静默失效。

## 并发阈值是实测的，不是猜的

`0.7.0` 之前，1MB / 50MB 两个阈值是拍脑袋定的。实测后改了其中一个，并坐实了两个此前不知道的坑。

**受控实验**：本地服务器按**每连接**限速 2MB/s（模拟“单连接被限速、多连接能叠加”的真实场景），
参数取自插件真实的 `buildAria2Args`，每种组合跑 3 轮取中位数：

| 文件大小 | curl（1 连接） | x=2 | x=4 | x=8 | x=16 |
| --- | --- | --- | --- | --- | --- |
| 2MB | 1.74 | **3.26** | 3.18 | 3.16 | 3.11 |
| 8MB | 1.65 | 3.25 | 6.26 | **11.99** | 12.23 |
| 32MB | 1.67 | 3.08 | 6.22 | 12.21 | **23.15** |
| 64MB | 1.62 | 3.29 | 6.63 | 12.88 | **24.42** |

（单位 MB/s。公网对照实验不可用：npmmirror 上单连接已打满本地带宽，方差 10.6~26.9 MB/s；
aliyun 镜像对 aria2 的 UA 直接返回 403。）

由此得到三条结论：

1. **并发确实有用，且收益接近线性** —— 8MB 以上，2 连接 ≈ 2×、4 连接 ≈ 4×。
2. **有效并发数被文件大小封顶**：2MB 文件在 x=2 就到顶（3.26），开到 4/8/16 反而略降到 3.1x，
   因为分片数与连接数超过文件能承载的量之后只剩建连开销。
3. 因此 **`LARGE_FILE` 阈值从 50MB 下调到 8MB**：8~50MB 这一整段长年被压在 4 连接上，
   实测 8MB 文件 x=8（11.99）比 x=4（6.26）快将近一倍。

维持 8 连接上限不动：32/64MB 下 x=16 确实还能再快一倍（23~24 MB/s），
但出于“避免触发服务器按 IP 限并发”的保守考虑不引入。

### 两个差点让并发全部失效的坑

- **aria2 的 `-x/-s` 会被 `min-split-size` 悄悄废掉**。aria2 默认 `--min-split-size=20M`，
  文件小于 20MB 时它**完全不分片**——实测 8MB 文件在默认参数下只发出 1 个不带 Range 的 GET，
  `-x 16 -s 16` 形同虚设，吞吐与单连接相同。本插件已传 `-k 1M` 侥幸避开。
  删掉 `-k 1M` 会让上面所有档位静默退化成单连接且不报任何错，因此这一行在源码里带了一份警告注释。
  另外实测 `--min-split-size=512K` 会让 aria2 以退出码 28 直接失败，故 1M 是当前验证过的安全取值。
- **探测必须强制 `accept-encoding: identity`**。Node 的 `fetch` 默认带 `gzip, deflate`，
  而 curl / aria2 默认不带。5000 字节的 body 在默认探测下会报 41 字节；若不修，
  0.7.0 新增的大小校验会对**任何支持 gzip 的服务器** 100% 误报，把正确的下载判成损坏。

## 支持平台

| 平台      | 架构    | 是否支持              | 二进制子包                          |
| ------- | ----- | ----------------- | ------------------------------ |
| Windows | x64   | ✅ 支持             | `@leisureyu/dsh-aria2-win32-x64`   |
| Windows | arm64 | ✅ 支持             | `@leisureyu/dsh-aria2-win32-arm64` |
| Linux   | x64   | ✅ 支持             | `@leisureyu/dsh-aria2-linux-x64`   |
| Linux   | arm64 | ✅ 支持             | `@leisureyu/dsh-aria2-linux-arm64` |
| macOS   | x64 / arm64 | ⚠️ 能用但不加速 | —                              |

二进制子包通过 `os` / `cpu` 字段声明，npm / pnpm 在不匹配的平台上会自动跳过安装，
`getAria2Path()` 解析不到时返回 `null`、由 `decide()` 回退 `curl`。**「插件可用」与「多线程可用」
是两件事** —— 不支持的平台不会装出一个坏掉的插件，只会装出一个单线程下载器。
macOS 为什么没做、需要补什么，见 [COMPATIBILITY.md](./docs/COMPATIBILITY.md)。

## 权限说明

本插件只做两件事：**发起下载**与**写进度文件**。逐项说明如下。

| 行为 | 说明 |
| --- | --- |
| 网络出站请求 | **仅接受 `http` / `https`**，其他协议在下载前直接拒绝（`checkDownloadUrl`）。传入 `mirror` 时，**镜像前缀本身也要过同一道白名单**（前缀非 `http(s)` 时镜像不生效）。对通过校验的地址发起 `HEAD` / `Range` 探测（`probeUrl`，5s 超时），以及实际下载（`aria2c` 或系统 `curl`）。除「原始 URL」或「镜像前缀 + 原始 URL」外不访问其他地址。 |
| 写入下载文件 | 写入 `output` 参数指定的路径；未指定时由 URL 推导文件名，落在当前工作目录。推导结果**必定是单个路径段**（`/`、`\`、`..` 等被丢弃，并替换 Windows 非法字符、规避保留设备名），因此不会写到工作目录之外。父目录不存在时会自动创建（`mkdir -p`）。不会删除任何已有文件。启用断点续传后，同名文件会被**续写**而非重头覆盖；未传 `output` 之外的路径不改动。aria2 一律带 `--allow-overwrite=true`（**必须**）：aria2 默认遇到同名文件既不截断也不覆盖，而是另存为 `f.1.bin`，而插件返回的 `path` 仍指向旧文件 —— 前一个版本的静默路径错位就是这么来的。 |
| 读取进度文件 | `download_status` 只**读**取上述两条进度轨道目录，不写文件、不联网。 |
| 写进度文件 | 轨道一 `$DSH_PROGRESS_DIR/<taskId>.jsonl`，未设置该环境变量时写 `<session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl`（拿不到会话上下文则不写）；轨道二 `$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`，缺省为 `<DSH_HOME>/downloads/tasks/<taskId>.json`。目录不可写时静默跳过，不影响下载。 |
| 子进程 | 启动随包 `aria2c` 或系统 `curl`，均以 `windowsHide: true` 启动（不弹控制台窗口），并响应 `AbortSignal` 取消（先 `SIGTERM`，1s 内未退出则 `SIGKILL`；该兜底**所有平台**都挂，POSIX 上进程同样可以忽略 `SIGTERM`）。取消会记为 `cancelled` 状态，与「下载失败」区分。 |
| 读取环境变量 | 仅读取 `DSH_PROGRESS_DIR`、`DSH_DOWNLOAD_PROGRESS_DIR`、`DSH_HOME`（用于定位缺省进度目录；缺省值由 `os.homedir()` 提供，不直接读 `USERPROFILE` / `HOME`）。 |

**不需要**的权限：不读取 DSH 会话内容、不访问凭证或密钥、不修改 DSH 配置（仅在安装时由 DSH 自身应用 `cordis.patch.yml`）、无遥测与联网上报。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.0.0`（用到 `AbortSignal.any` / `AbortSignal.timeout`） |
| `@deepseek-ai/cordis` | `>=4.0.0 <4.0.1-0` 或 `>=4.0.1-rc.1 <5.0.0-0`（peerDependency；可选） |
| `@deepseek-ai/dsh-tools` | `>=0.1.7-rc.1 <0.1.8-0` / `>=0.1.8-rc.1 <0.2.0-0` / `>=0.2.0-rc.1 <0.3.0-0`（peerDependency；该包只发布预发布版，因此按元组显式声明，DSH 每开一个新预发布分支都要同步追加） |
| npm 包管理器 | npm / pnpm 均可；需支持 `optionalDependencies` 的 `os` / `cpu` 过滤 |

### DSH 0.2.0 的安装前置检查

0.2.0 起，DSH 在**安装前**就会核对插件声明的 `peerDependencies` 是否覆盖当前运行版本，不覆盖会直接拒绝安装；已经装上的也会在启动时**整个 bundle 被跳过**，日志里出现：

```
dsh: skipping profile bundle "@leisureyu/dsh-smart-dl": Error: Plugin ... is incompatible with dsh 0.2.0-rc.2
```

跳过是整层跳过——`smart_download` / `download_status` 两个工具都不会注册。**`0.4.0` 及更早的版本会被拒**（0.4.0 给三个 `dsh-client-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0-0`）；`0.4.1` 起已把范围补成 `>=0.2.0-rc.1 <0.3.0-0`，在 0.2.0 上正常加载。**升级到最新的 `1.1.0` 即可**。

如果只是想临时放行某个旧版本，0.2.0 提供了按「包@版本 + 精确 dsh 版本」的豁免，需要显式接受风险：

```bash
dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <精确 dsh 版本> --accept-risk
```

豁免记录在该 profile 的 `compatibility.json` 里，可以用 `dsh plugin version-exemptions` 查看、`revoke-version` 撤销。豁免的粒度是**精确版本**：换了 dsh 版本就不再生效。

macOS 未列入支持平台：**不是兼容性问题，而是缺少对应的 aria2 二进制子包**。在 macOS 上插件仍可安装并正常工作，但 `getAria2Path()` 返回 `null`，所有下载都会走 `curl` 单线程回退（返回结果的 `reason` 会写明原因）。

## 常见问题

**Q：安装或运行时被 Windows Defender（或其他杀毒软件）拦截？**
A：这是对 `node_modules` 内未签名 `aria2c.exe` 的常见启发式告警。可将项目的 `node_modules` 目录加入 Windows Defender 的白名单（“病毒和威胁防护 → 管理设置 → 排除项”）。`aria2c.exe` 均未做任何修改：Windows x64 取自 aria2 官方发布包，Windows arm64 取自第三方 ARM64 构建（见下方“第三方组件声明”）。

**Q：下载速度没有提升？**
A：通常是目标服务器**不支持 Range 请求**（无法分片），或文件本身较小。插件会自动回退到 `curl` 单线程下载；返回结果中的 `fellback` 与 `reason` 字段会说明具体原因。

**Q：提示找不到 aria2 / 始终走 curl？**
A：请确认当前平台属于上表四行之一（Windows x64 / arm64、Linux x64 / arm64），且 `optionalDependencies` 中对应的二进制子包安装成功（部分镜像源可能未同步该包，可切换官方 npm 源后重装）。返回结果的 `reason` 字段会说明具体原因。macOS 暂不支持，将始终回退 curl。

**Q：Linux 上提示 `aria2c: Permission denied`？**
A：这是 tarball 里二进制缺少可执行位。本项目在 CI 中**于 Linux runner 上打包**并强制断言 `bin/aria2c` 为 `0755`，正常安装不会出现；若你手动重打包过，请在打包前 `chmod 755`。

**Q：下载会弹黑色命令行窗口吗？**
A：不会。子进程均以 `windowsHide: true` 启动。

**Q：怎么知道下载到百分之几了？**
A：调用 `download_status`，它会返回最近任务的百分比、速度与 ETA。传 `taskId` 可只查某一个任务。它是纯只读的，不会影响正在进行的下载。

**Q：GitHub Release 下载太慢，能用镜像吗？**
A：可以。给 `smart_download` 传 `mirror` 前缀即可，例如 `mirror: "https://gh-proxy.com/"`。请注意镜像是第三方服务，不要用它下载含敏感信息的文件。

**Q：下载中断后要重新开始吗？**
A：不需要。用同样的 `url` 与 `output` 再调用一次 `smart_download`，支持 Range 的服务器会从断点继续。

## 文档

| 文档 | 内容 |
| --- | --- |
| [README](./README.md) / [English](./README.en.md) | 安装、用法、权限说明 |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 内部结构：一次调用经过哪些步骤、模块职责、进度数据流 |
| [SECURITY.md](./docs/SECURITY.md) | 威胁模型与四层防护，每层对应的实测复现 |
| [COMPATIBILITY.md](./docs/COMPATIBILITY.md) | 平台 / Node / profile / 包管理器矩阵，macOS 为什么搁置 |
| [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | 症状 → 原因 → 处理 |
| [REVIEW-1.0.md](./docs/REVIEW-1.0.md) | 1.0 代码审查：必修 / 建议 / 已知折衷 |
| [CHANGELOG.md](./CHANGELOG.md) | 逐版本变更记录 |

## 开发

环境要求：Node.js **22+**、pnpm **9+**。

当前基线：**261 例用例（259 通过 / 2 跳过 / 0 失败）**，行覆盖 **99.81%** / 分支 **92.50%**。
覆盖率数字**必须在 LF 工作区测量** —— V8 的行归属依赖源码偏移，把行尾换成 CRLF，
同一份代码会报出另一组数字与另一组未覆盖行号（对照数据见 [REVIEW-1.0.md](./docs/REVIEW-1.0.md)）。
2 个跳过用例是平台限制（只在 Linux 复现），CI 的 Ubuntu job 会真跑。详见 [REVIEW-1.0.md](./docs/REVIEW-1.0.md)。

```bash
# 安装依赖
pnpm install

# 本地构建（输出到 dist/）
pnpm build

# 运行测试（node:test，不依赖真实网络）
pnpm test

# 运行测试并输出覆盖率（Node 自带，勿用手搓 NODE_V8_COVERAGE：
# 它在 Windows + tsx 下源码映射错位，会虚增函数个数。
# 另：必须在 LF 工作区跑，行尾不同会让未覆盖行号整体漂移）
node --test --import tsx --experimental-test-coverage "test/**/*.test.ts"

# 仅类型检查（产物 src/ 与 test/ 分两个 tsconfig）
pnpm check
```

本地开发时，各平台的二进制需要手动放置（这些二进制不入库），下载地址与目标路径：

| 平台 | 下载 | 放置到 |
| --- | --- | --- |
| Windows x64 | <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip> | `packages/aria2-win32-x64/bin/aria2c.exe` |
| Windows arm64 | <https://github.com/minnyres/aria2-windows-arm64/releases/download/v1.37.0/aria2_1.37.0_arm64.zip> | `packages/aria2-win32-arm64/bin/aria2c.exe` |
| Linux x64 | <https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-x86_64-linux-musl_static.zip> | `packages/aria2-linux-x64/bin/aria2c` |
| Linux arm64 | <https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-aarch64-linux-musl_static.zip> | `packages/aria2-linux-arm64/bin/aria2c` |

Linux 二进制解压后记得 `chmod 755`，否则本地 `npm pack` 出来的 tarball 也会缺少可执行位。

### 发布

推送 `v*` tag 即触发 GitHub Actions（`.github/workflows/publish.yml`），分三个 job：

1. `binaries-windows`（windows runner）：下载 Windows x64 / arm64 二进制并校验 SHA256；
2. `binaries-linux`（ubuntu runner）：下载 Linux x64 / arm64 静态二进制、校验 SHA256、`chmod 755`；
3. `publish`（ubuntu runner）：还原上述二进制 → 构建 → 测试 → **先发布全部二进制子包，再发布主包**（主包依赖子包，顺序不可颠倒）。

> 发布必须在 Linux 上完成：npm 打包会记录文件执行位，在 Windows 上打包会把 `bin/aria2c` 记成 `0644`，装完直接调用会失败。CI 里对此有正向断言（tarball 中 `bin/aria2c` 必须是 `-rwxr-xr-x`）。

认证采用「先 OIDC、后 token」双保险：每个包先尝试 npm trusted publishing（OIDC，无需长期 token）；失败则回退仓库密钥 `NPM_TOKEN`——新包**首次**发布无法用 OIDC 引导（[npm/cli#8544](https://github.com/npm/cli/issues/8544) 仍未修复），必须用 token，之后即可只靠 OIDC。

> 启用 OIDC 需要在 npm 网页为每个包配置 Trusted Publisher（Organization or user `LeiSureYu`、Repository `dsh-smart-download`、Workflow `publish.yml`，并勾选允许直接 `npm publish`）。配置前流水线会自动走 token 回退，不会失败。

> 注意：本仓库已使用 npm scope `@leisureyu`。如需改换 scope，需同步修改主包 `optionalDependencies`、子包 `name`、`src/downloader.ts` 中的 `ARIA2_PACKAGE` 以及 `test/downloader.test.ts` 中的断言。

## 第三方组件声明

本插件分发的 `aria2c` 均来自 [aria2](https://aria2.github.io/) 1.37.0，aria2 依据 **GPL-2.0-or-later** 许可，各二进制子包同样声明为 `GPL-2.0-or-later`。

aria2 官方仅提供 **Windows x64** 与源码包，因此另外三个平台使用第三方构建（均未做任何修改，仅原样分发）：

| 平台 | 来源 | 压缩包 SHA256 |
| --- | --- | --- |
| Windows x64 | aria2 官方发布包 | `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288` |
| Windows arm64 | [minnyres/aria2-windows-arm64](https://github.com/minnyres/aria2-windows-arm64) `v1.37.0` | `5694080902fff84c8636e561c48f7a65278e8d4f05efefe953637f60a397c81f` |
| Linux x64 | [abcfy2/aria2-static-build](https://github.com/abcfy2/aria2-static-build) `1.37.0`（musl 静态） | `e0a09b12ef67f35f8a8e4fdddbec851d235b7c31da549d0578bff459032b499a` |
| Linux arm64 | [abcfy2/aria2-static-build](https://github.com/abcfy2/aria2-static-build) `1.37.0`（musl 静态） | `0c681a89a40e0f82d1f5137608e86257eb0af201459c002941ea098f2b8c26b6` |

## 声明

本项目为**社区维护的第三方插件**，**非官方项目**，与 DeepSeek AI 及其关联公司**无隶属关系**，也未获其背书或赞助。插件名称中的 "dsh" 指代其运行所依托的 DeepSeek Harness（DSH）平台，仅用于说明兼容性。

## License

- 本插件代码：[MIT](./LICENSE)
- 随包分发的 aria2 二进制：**GPL-2.0-or-later**
