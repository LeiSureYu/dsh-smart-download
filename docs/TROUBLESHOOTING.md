# 排查手册

按症状查。每条都给出「怎么确认」与「怎么处理」，尽量给出能自己验证的命令。

## 升级到 0.2.0 后插件整层消失（skipping profile bundle）

**症状**：升级 DSH 到 0.2.0（含桌面版）后，`smart_download` / `download_status` 两个工具都不在了，
面板也没有。启动日志里有一行：

```
dsh: skipping profile bundle "@leisureyu/dsh-smart-dl": Error: Plugin
@leisureyu/dsh-smart-dl@0.4.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {...}
```

**原因**：0.2.0 新增了安装前置检查 —— 插件声明的 `peerDependencies` 必须覆盖当前 DSH 运行版本，
否则**整个 bundle 被跳过**（不是单个插件行被禁用）。**`0.4.0` 及更早**给三个 `dsh-client-*` peer
写的是 `>=0.1.7-rc.1 <0.2.0-0`，因此在 0.2.0 上会被跳过；`0.4.1` ~ `1.0.1` 已经覆盖 0.2.0，不会。
跳过是整层的，所以两个工具都不会注册。

**处理**：升到最新的 **1.1.0**（`0.4.1` 起就能在 0.2.0 上跑，升到最新即可）：

```bash
# 桌面版用桌面版自带的 CLI
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @leisureyu/dsh-smart-dl@1.1.0
# 普通 web profile
dsh plugin --profile web add @leisureyu/dsh-smart-dl@1.1.0
```

**只想临时放行旧版本**（不推荐，需要显式接受风险；粒度是精确的包版本 + 精确的 dsh 版本）：

```bash
dsh plugin --profile <profile> allow-version @leisureyu/dsh-smart-dl@0.4.0 --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile <profile> version-exemptions   # 查看
```

豁免写在 `<DSH_HOME>/profiles/<profile>/compatibility.json`；DSH 升级后豁免失效，要重新授予。
桌面版也可以在侧边栏 Plugins 页面里点授权。

**怎么确认是这个问题而不是别的问题**：装完之后跑一次
`dsh --profile <profile> --dump-config`，输出里应该能找到 `- id: dsh-smart-dl`。
找不到就还是被跳过了，日志开头会有那条 `skipping profile bundle`。

## 面板不显示 / 显示成「下载中」卡住

`web` profile 面板的数据源是 `/api/smartdl.status`，它读的是与 `download_status` 同一份
进度文件。面板不显示时按顺序排除：

1. **profile 不对**。面板只在带 Web 界面的 profile 注册（`web` 与桌面版的 `desktop`）；
   其他 profile 下插件功能照常，只是没有界面。用 `download_status` 工具验证进度有没有写进去。
2. **拿不到会话上下文**。轨道一写在 `<session.cwd>/.dsh-progress/<session.id>/`，读取端按
   session 过滤。拿不到 session 时插件**不写**轨道一（写进一个没人读的目录等于没写），
   此时只有轨道二可查。检查 `<cwd>/.dsh-progress/` 下是否出现了以会话 ID 命名的目录。
3. **`DSH_PROGRESS_DIR` 被覆盖**。设了这个环境变量时轨道一改写该目录，而面板仍按会话目录找。
   确认你没有为别的用途设置过它。
4. **陈旧任务**。超过 10 分钟没有更新的 `running` 任务会被面板主动忽略（`STALE_RUNNING_MS`），
   避免进程崩溃后留下的残留文件让面板永久卡住。若确实是刚跑的下载，看第 2、3 条。

面板停在「下载中」而 `pct` 已经是 100，是 `0.5.0` 之前的症状：轨道一记录缺少 `state` 字段，
而 dsh-task-progress 的读取端只认 `state`，缺失时一律当 `running`。升级即可；也可以在
`<cwd>/.dsh-progress/<session.id>/<taskId>.jsonl` 里直接确认最后一行有没有 `"state":"done"`。

## 速度或 ETA 是空的

先看 `download_status` 返回里 `spd` / `eta` 是不是空串（schema 要求 string，不支持时返回空串
而不是 `null`）。两种情况：

- **aria2 1.38+**：摘要行的速度字段由 `SPD:` 变成 `DL:`，`0.9.0` 之前的正则匹配不到，整行被
  当成非摘要丢弃，于是面板永远看不到速度。升级到 `0.9.0` 或更新。
- **curl 路径**：`curl` 只输出百分比，本来就没有速度与 ETA，这是预期行为，不是缺陷。

想确认解析是否生效，可以直接喂一行真实摘要给解析函数：

```bash
node --import tsx -e "console.log(require('./src/progress-parse.ts').parseAria2Summary('[#de8d33 11MiB/40MiB(27%) CN:4 DL:10MiB ETA:2s]'))"
```

## 提示「下载完整性校验失败」

错误信息形如：

```
下载完整性校验失败：落盘 1048576 字节，远端声明 4194304 字节
```

这不是误报，是**这次下载的产物确实不对**：子进程退出码是 0，但落盘字节数与远端声明长度不符。
常见成因：

- 服务器/代理提前断开但没报错（chunked 截断时 aria2 与 curl 都是 exit 0）；
- 镜像站返回了一个 200 的 HTML 错误页；
- 磁盘写满或配额限制，最后一段被静默丢弃；
- 续传起点算错，拼接出了长度不对的文件。

下载失败时**旁车指纹会刻意保留**（`<output>.part.json`），正好给下一次续传做比对基准。
坏文件也留在原地便于你自己看。处理方式：直接重试一次；若重试仍失败，检查磁盘剩余空间与
该 URL 是否能被浏览器正常完整下载。

如果错误信息里的「远端声明」明显偏小（比如 41 字节而文件看着有几千字节），那说明服务器无视了
`accept-encoding: identity` 仍返回压缩内容 —— 这种情况插件应当**跳过**校验而不是报错，
属实现缺陷，请连同 URL 一起报 issue。

## 看到「未做字节数校验」是怎么回事

工具返回里的 `verifySkipped` 与进度终态会出现这句话，取值只有两个：

| 取值 | 含义 |
| --- | --- |
| `未做字节数校验：远端未声明文件长度` | 服务器没给 `Content-Length`，没有基准可比 |
| `未做字节数校验：远端声明了压缩编码` | 服务器返回了 gzip / br，压缩后长度与落盘字节数不可比 |

它是**显式告知**，不是错误：下载本身成功了，只是这一次没法证明字节数对。
`0.9.0` 之前这两种情况与「校验通过」在返回值里完全相同，所以现在专门把它标出来。

> 传了 `sha256` 且核对通过时，`verifySkipped` **不会**出现，取而代之的是 `sha256` 字段。
> 内容已经逐字节核对过，再报「未做字节数校验」只会误导。反过来说：**看到 `sha256`
> 就是看到「内容已核对」，看到 `verifySkipped` 就是「这次只比了长度或压根没比」。**

## 看到「SHA-256 不匹配」/「无法读取落盘文件以计算 SHA-256」

| 文案 | 含义 | 处理 |
| --- | --- | --- |
| `SHA-256 不匹配（期望 …，实际 …）` | 落盘内容与调用方给的摘要不一致 | 先确认摘要是不是抄错了（比如抄成了另一个版本 / 另一个架构的包）；摘要没错就是内容真的不对，**不要**直接使用该文件 |
| `无法读取落盘文件以计算 SHA-256` | 下载退出码 0，但文件读不到 | 磁盘 / 权限问题；这条与「内容不对」是两句不同的话，别混 |

两种都会**保留**旁车指纹（`<output>.part.json`），方便下次续传时比对。

摘要写错（长度不是 64 位、含非十六进制字符、用了 `md5:` / `sha1:` 前缀）会在**下载开始前**
就被拒绝，报 `拒绝下载：sha256 不是合法的 SHA-256 摘要…` —— 不会白下一遍。

## 请求头没生效 / 报「请求头 … 由插件自身管理」或「含换行或控制字符」

- `请求头 X 由插件自身管理，不允许覆盖（会破坏探测 / 续传 / 完整性校验）`：
  `Range` / `Accept-Encoding` / `Content-Length` / `Host` 与连接级头不允许自定义。
  它们各自承载着探测、续传与校验的语义，覆盖会**静默**改变行为。
- `请求头值含换行或控制字符（属于请求头注入，已拒绝）`：头值里出现了 CR / LF / NUL。
  制表符是允许的。
- 头传了但站点仍返回 403：确认 `userAgent` / `referer` 是不是站点要求的那一个；
  插件会把这一套头**同时**用在探测与下载上，所以不会出现「探测过了、下载 403」的错位。

## `mirror: "auto"` 没生效

看返回值的 `mirrorSkipped`，只有三种取值：

| 取值 | 原因 | 处理 |
| --- | --- | --- |
| `未使用自动镜像：只有 GitHub 地址支持` | 目标不是 GitHub 域名 | 非 GitHub 地址没有可用的公开前缀镜像，用原始地址即可 |
| `未使用自动镜像：无法从原始地址取得文件长度，无从证实镜像返回的是同一个文件` | 探测没拿到 `Content-Length` | 目标服务器问题；自动镜像需要长度做比对基准，此时退回原始地址是正确行为 |
| `未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致` | 候选全部落空 | 换网络，或用 `DSH_SMARTDL_MIRRORS` 指定你自己的镜像 |

三种情况下插件都会**照常从原始地址下载**，不会因此失败。另外注意：**部分镜像会剥掉
`ETag`**，对这类镜像插件一律不采用（宁可慢也不接受无法证实的来源），所以某些镜像
永远不会被自动选中 —— 这是有意的取舍，不是 bug。

## 一直走 curl / 提示未找到 aria2 二进制

返回结果的 `reason` 会写明具体原因，常见几种：

| `reason` 里的字样 | 原因 | 处理 |
| --- | --- | --- |
| `未找到 aria2 二进制（当前平台 … 不受支持或子包未安装）` | 平台不在支持列表，或子包没装上 | 见下 |
| `服务器不支持 Range` | 目标服务器不给分片 | 无解，curl 单线程是正确行为 |
| `文件仅 N KB，多线程无收益` | 小于 1MB | 预期行为 |
| `无法获取 Content-Length / Content-Range` | 探测拿不到大小 | 目标服务器问题，curl 能下完 |

确认当前平台是否受支持（`win32-x64` / `win32-arm64` / `linux-x64` / `linux-arm64`）：

```bash
node -e "console.log(process.platform + '-' + process.arch)"
```

再确认子包是否真的解析得到（把平台串换成上面查到的值）：

```bash
node -e "const {createRequire}=require('module');const r=createRequire(process.cwd()+'/x.js');console.log(r.resolve('@leisureyu/dsh-aria2-win32-x64/bin/aria2c.exe'))"
```

解析不到时，多半是 npm 镜像源没同步 `@leisureyu/dsh-aria2-*` 这些子包。切回官方
`https://registry.npmjs.org/` 后重装。

**macOS 会始终走 curl**：不是兼容性问题，而是缺 macOS 的 aria2 二进制子包，这一点是
有意搁置的，见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

## Linux 上 `aria2c: Permission denied`

tarball 里的二进制缺少可执行位。本项目的发布流水线在 Linux runner 上打包，并对
`bin/aria2c` 的执行位做了正向断言，正常安装不会出现。

如果你自己重打过包，打包前执行：

```bash
chmod 755 packages/aria2-linux-*/bin/aria2c
```

Windows 上打包 Linux 二进制会把它记成 `0644`，装完直接调用就会失败 —— 发布必须在 Linux 上做。

## 杀毒软件报 `aria2c.exe`

对 `node_modules` 里未签名二进制的常见启发式告警。二进制均未做修改：Windows x64 取自 aria2
官方发布包，Windows arm64 取自第三方 ARM64 构建，压缩包 SHA256 在 README 里可核对。

处理：把项目的 `node_modules` 加入排除项（Windows Defender：“病毒和威胁防护 → 管理设置 →
排除项”）。

## 下载速度没有提升

按可能性排序：

1. **服务器不支持 Range**。分不了片，curl 单线程是唯一选择。看 `fellback` 与 `reason`。
2. **文件小于 1MB**。本就不走 aria2。
3. **目标站点按 IP 限并发**。8 连接会被服务器压回单连接速度；这是对端策略，插件不做规避。
4. **单连接已经把带宽打满**。此时多连接不会有额外收益（实测公网上 npmmirror 单连接即打满本地带宽，
   方差 10.6~26.9 MB/s）。

想验证多线程本身有没有生效，看返回的 `method` 与 `reason`：`method: 'aria2'` 且
`reason: 支持 Range，文件 N MB，使用 8 连接` 说明分档正常。

## 下载中断后要不要重下

不需要。用同样的 `url` 与 `output` 再调用一次 `smart_download`。插件会：

1. 比对远端长度与旁车指纹；
2. 能证实同源 → 从断点续传；
3. 无法证实 → 删掉半包全量重下，并在 `reason` 里写明是哪一项不一致。

第 3 步可能让「明明只差一点」的下载从头开始，这是刻意的：`0.6.0` 实测过续传在「远端变小」
与「等长但内容变了」两种场景下都是**退出码 0 但文件是错的**，重下比拿到坏文件划算。

## 取消下载后进程没退出 / 工具调用不返回

`0.9.0` 之前 `SIGKILL` 兜底只在 Windows 上挂。POSIX 上进程可以装一个 `SIGTERM` handler
然后继续跑，此时取消就永远等不到 `close` 事件，`smart_download` 会一直不返回。
`1.0.0` 起兜底对所有平台生效（`SIGTERM` 后 1 秒 `SIGKILL`）。若你仍在旧版本上遇到，升级。

## 进度文件把磁盘写满了

进度文件不会被自动清理，这是刻意的：面板依赖它们渲染「已完成 / 失败」回执，立刻删除会让回执
永远看不到。清理方式是手动删除这两个目录下的旧任务：

- `<cwd>/.dsh-progress/<session.id>/`
- `<DSH_HOME>/downloads/tasks/`（或 `$DSH_DOWNLOAD_PROGRESS_DIR`）

`ProgressReporter.cleanup()` 提供了显式删除接口，但它只给「明确想清理」的调用方用，
不在下载结束时自动调用。

## 侧边栏没有「下载管理」入口 / 点了打不开面板

入口注册在 `sidebar.panellist`，面板是 `main` keyed slot。按顺序排除：

1. **profile 不对**。和进度浮层一样，只在带 Web 界面的 profile 注册（`web` / `desktop`）。
2. **客户端清单缺声明**。入口依赖 `@deepseek-ai/dsh-client-ui-slots`，面板开合依赖
   `@deepseek-ai/dsh-client-ui-layout` —— 这些写在 **manifest 的 `dsh.client.inject`** 里，
   不是代码里的 `inject` 数组。缺了时插件不会崩，但对应插槽进 `waitingFor`，界面什么都不出现。
3. **改完 manifest 必须重启 DSH**。客户端脚本改动刷新页面即可；manifest 改动在加载时确定，
   刷新没用。

## 「在文件夹中显示」提示「打不开文件夹位置」

这句提示意味着**两条路径都失败了**：

1. 首选 `remote.session`（`ctx.remote.session.openWorkspacePath`）。注意它在「宿主没有该服务」
   「调用抛错」「宿主拒绝」三种情况下都是**返回 `ok:false` 而不是抛异常** —— 只看 `try/catch`
   会让它变成「点了没反应」。
2. 降级到服务端 `op:'reveal'`：宿主进程起 `explorer.exe /select,` / `open -R` / `xdg-open`。

常见原因：

- **文件已不在原位**（被移走 / 改名 / 内容变了）。此时服务端**什么都不会打开** ——
  打开一个「看起来对」的邻居路径比不做更糟。看行内的 `presence` 徽标确认是哪一种。
- **Linux 上没有 `xdg-open`**（无头环境常见）：会报 `busy` + `errorCode: ENOENT`。
- **该服务在你的 profile 下不存在**：不影响功能，只是少一点原生贴合度
  （见 [COMPATIBILITY.md](COMPATIBILITY.md) 的「客户端插件的服务依赖」）。

## 删除后「文件没了、记录还在」/ 记录删不掉

先看那一行还在不在：

- **行还在 + 提示失败**：这是**设计如此**。服务端 `ok:true` 只代表「请求被处理」，
  `fileDeleted` 才是「文件没了」；删除失败时记录**故意保留**，这样你还看得见、还能重试。
  提示会给出具体原因：`busy`（被占用 / 磁盘只读）、`denied`（权限不足）、`changed`
  （文件被换过）、`running`（还在下载）等。
- **记录删不掉**（服务端报 `recordRemoved` 为空）：多半是**请求没带会话**。轨道一的路径是
  `<cwd>/.dsh-progress/<session.id>/`，没有会话就只能扫轨道二，于是文件删了、记录还在。
  这是 1.4.0 修过的 bug；若仍复现，请附上 `download_status` 的输出。

## 面板上没有「同时删除本地文件」

这是**安全边界，不是缺陷**：只有当记录里的产物**确实还在原位**（`presence: present`）时才
提供该选项。文件被移走、改名、或与下载完成时的大小 / 修改时间不一致时，只能删除记录 ——
否则「删的是当初下载的那个文件」这句话就不成立了。行内的 `presence` 徽标会说明是哪一种。

## 批量删除为什么不能连文件一起删

刻意的：批量删除**只删记录**。一次误选就是多个文件永久消失（不进回收站），代价和
「少点几次」完全不对称。要删本地文件，请逐行走该行的确认框 —— 那里会显示完整路径、
大小与不可恢复声明。

## 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) —— 一次调用经过哪些模块
- [SECURITY.md](./SECURITY.md) —— 四层防护与威胁模型
- [COMPATIBILITY.md](./COMPATIBILITY.md) —— 平台 / 版本矩阵
- [REVIEW-1.0.md](./REVIEW-1.0.md) —— 1.0 代码审查记录
