# dsh-smart-dl

[![npm version](https://img.shields.io/npm/v/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![license](https://img.shields.io/npm/l/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux-0078D4)

**简体中文** · [English](https://github.com/LeiSureYu/dsh-smart-download/blob/main/README.en.md)

> 给 DSH 装一个内置 aria2 的下载器。大文件自动多线程加速，服务器不支持就自动回退，中途断了还能续传。

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

## 功能一览

- **自动多线程** —— 下载前探测服务器，支持多连接就用 aria2 并发下载，不支持就回退 `curl`，两种情况都能下完
- **零配置** —— aria2 二进制随插件安装，不用自己下载或配 PATH
- **进度可见** —— Web 界面右下角实时进度面板（文件名 / 百分比 / 速度 / 剩余时间）
- **断点续传** —— 中断后用同样的 `url` + `output` 再调一次即可续传
- **连接数可选** —— 输入框旁下拉选 `auto` 或 1–16，选定后一直生效
- **一次下一批** —— `targets` 单次调用下多个文件，逐条给结果，一条失败不影响其余
- **内容核对** —— 传官方文档里的摘要（`sha256` / `checksum`），下载后逐字节核对
- **同名文件有策略** —— 覆盖 / 跳过 / 另存新名，批量可逐条设置
- **下载前查磁盘** —— 空间不够在发请求前就拒绝，不会下到一半写满
- **服务器给的真文件名** —— 从 `Content-Disposition` 读取并净化
- **能带请求头** —— `userAgent` / `referer` / `headers`，探测与下载用同一套
- **镜像自动挑** —— `mirror: "auto"` 从内置候选里选一个同源的
- **下完还能管** —— 下载管理器可取消进行中的任务、原地重试失败的

## 支持平台

| 平台 | 架构 | 多线程 |
| --- | --- | --- |
| Windows | x64 / arm64 | ✅ 随包 aria2 |
| Linux | x64 / arm64 | ✅ 随包 aria2 |
| macOS | x64 / arm64 | ⚠️ 需 `PATH` 上有 `aria2c` |

macOS 没有随包子包，但 `PATH` 上有可用的 `aria2c`（如 `brew install aria2`）时同样会多线程；没有则回退 `curl` 单线程。四个完整支持的平台不会装出坏插件，最差也就是单线程下载器。

## 安装

### 在 DSH 界面里装（推荐）

1. 打开 DSH，侧边栏选「**插件**」
2. 点「**添加插件**」，粘贴包名 `@leisureyu/dsh-smart-dl`
3. 点「安装」，装完**重启 DSH** 一次

### 命令行

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

**支持的 profile**：`web` 与 `desktop`。桌面版请用桌面版自带的 CLI，不要用系统里另外装的 `dsh`：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @leisureyu/dsh-smart-dl
```

### 从 Git 仓库地址安装

```bash
dsh plugin --profile web add https://github.com/LeiSureYu/dsh-smart-download
# 或
dsh plugin --profile web add github:LeiSureYu/dsh-smart-download
```

地址必须是 `https://<host>/<owner>/<repo>` 三段形态（可带 `.git` 或 `#<ref>`）。带路径前缀的代理镜像地址不被接受。安装时 DSH 会探测 `github.com`（5 秒超时），访问不了就改用 npm 包名。

## 两个工具

| 工具 | 作用 |
| --- | --- |
| `smart_download` | 下载文件 |
| `download_status` | 查询进度（只读） |

## 照着官方文档下载

大多数「按官方文档装东西」的场景：文档给**地址**，通常还给**摘要**，有时需要**请求头**。

```
文档里写什么                          传给哪个参数
─────────────────────────────────────────────────────
https://example.com/tool-1.4.0.zip   url（必填）
SHA256: 9f86d081884c7d65…             sha256（可选，但建议）
「需要 Referer / 请用浏览器 UA」        referer / userAgent
「国内请用 GitHub 加速」                mirror: "auto"
「装到某个目录」                        output
```

一个照抄即可的调用：

```
smart_download(
  url:    "https://github.com/owner/repo/releases/download/v1.4.0/tool.zip",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  mirror: "auto"
)
```

返回结果会说明本次做了什么：

```json
{
  "success": true,
  "path": "tool.zip",
  "method": "aria2",
  "size": 52428800,
  "fellback": false,
  "reason": "支持 Range，文件 50.0MB，使用 8 连接",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "requestedUrl": "https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.4.0/tool.zip",
  "mirrored": true,
  "mirror": "https://gh-proxy.com/"
}
```

### `sha256`：把文档里的摘要粘进来

| 文档里的写法 | 是否接受 |
| --- | --- |
| `9f86d081884c7d65…`（裸十六进制，大小写均可） | ✅ |
| `sha256:9f86d081…` / `sha256=9f86d081…` / `SHA256(9f86d081…)` | ✅ |
| `sha256-<base64>`（SRI 形式） | ✅ |
| 长度不是 64 位、含非十六进制字符、`md5:` / `sha1:` 前缀 | ❌ 下载前拒绝 |

- 参数不合法会在**下载开始前**拒绝，不会白下几百 MB
- 核对失败一律判失败并保留旁车指纹
- 流式计算，大文件不整份读进内存
- 不依赖远端信息，长度校验被迫跳过时依然给出确定结论

### `checksum`：文档只给 MD5 / SHA-1 / SHA-512 时

| 写法 | 识别为 |
| --- | --- |
| 32 位裸十六进制 | MD5 |
| 40 位裸十六进制 | SHA-1 |
| 64 位裸十六进制 | SHA-256 |
| 128 位裸十六进制 | SHA-512 |
| `md5:<hex>` / `sha1=<hex>` / `SHA512(<hex>)` | 按前缀指定 |
| `sha256-<base64>` / `sha512-<base64>` | 按前缀指定 |

- 与 `sha256` **二选一**，同时给会在下载前拒绝
- 带前缀时仍核对长度，`md5:<64 位>` 直接拒绝
- MD5 / SHA-1 只能发现损坏，防篡改请用 SHA-256 / SHA-512

### `ifExists`：同名文件已经在了

| 值 | 行为 |
| --- | --- |
| `overwrite` | 覆盖旧文件（默认） |
| `skip` | 不发下载请求，返回 `skipped: true`；有摘要时仍校验 |
| `rename` | 另存为 `name (1).ext`，绝不覆盖；禁用续传 |

批量时可在调用层设默认值，也可逐条覆盖。

### 服务器给的文件名

地址不带文件名时，优先级：

1. 显式传入的 `output`（永远优先）
2. `Content-Disposition` 里的 `filename*=` 或 `filename=`
3. 查询串 `?filename=` / `?file=`
4. URL 末段；都没有则回落 `download`

服务器给的名字会过净化函数：只保留单段、替换非法字符、规避 Windows 保留设备名、限制长度，不会写到目录之外。

### 磁盘空间预检

远端声明大小且响应未压缩时，发下载请求前检查：

```
可用空间 ≥ 文件大小 + max(64MB, 5% × 文件大小)
```

不足时直接抛错并给出「可用 / 需要」两个数字。三种情况跳过预检并在结果里说明（`diskCheckSkipped`）：远端未声明大小、响应是压缩编码、`statfs` 不可用。

### `userAgent` / `referer` / `headers`

三者合成**一份**头表，**探测与下载共用**。站点按 UA 分流时两边不一致会导致探测 200、下载 403。

```
smart_download(
  url:       "https://example.com/gated/model.bin",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  referer:   "https://example.com/downloads",
  headers:   { "Authorization": "Bearer <token>" }
)
```

- 插件自管的头不允许覆盖：`Range`、`Accept-Encoding`、`Content-Length`、`Host` 及连接级头
- 头值含 CR / LF / NUL 一律拒绝（请求头注入）
- 命名参数优先于 `headers` 里的同名项
- 上限：32 条头、头名 128 字符、头值 8192 字符

### `mirror: "auto"`

由插件从内置候选里挑一个镜像：

1. 只对 GitHub 域名生效，其它地址返回 `mirrorSkipped` 说明
2. 候选表内置，可用 `DSH_SMARTDL_MIRRORS` 换成自己的
3. 候选必须**被证实与原地址同源**：长度一致，且原始有 `ETag` 时候选 `ETag` 也相等
4. 一个都没证实就退回原始地址，并在 `mirrorSkipped` 里写明原因

> 自动镜像必须**显式传入**才生效——它会让下载内容经过第三方服务器。
>
> 同源证明防的是无心之失，**不是投毒**。要防投毒请传 `sha256` / `checksum`（摘要来自官方文档，镜像伪造不了）。

## 镜像加速

给 `smart_download` 传 `mirror` 前缀，插件把原始 URL 拼到前缀后面：

```
smart_download(
  url: "https://github.com/owner/repo/releases/download/v1/a.zip",
  mirror: "https://gh-proxy.com/"
)
# 实际请求：https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1/a.zip
```

- 只做**前缀拼接**，不做路径改写
- 前缀缺尾斜杠自动补上，也可写裸域名
- 镜像前缀本身也必须过白名单（非 `http(s)` 不生效）
- 输出文件名始终按**原始 URL** 推导

### 换成自己的镜像：`DSH_SMARTDL_MIRRORS`

逗号分隔的前缀表，**顺序即优先级**：

```bash
# Linux / macOS
export DSH_SMARTDL_MIRRORS="https://my-mirror.corp/,http://10.0.0.9:8080"

# Windows PowerShell
$env:DSH_SMARTDL_MIRRORS = "https://my-mirror.corp/,http://10.0.0.9:8080"
```

常见的公开镜像（可用性随网络环境变化）：

| 镜像前缀 |
| --- |
| `https://gh-proxy.com/` |
| `https://ghfast.top/` |
| `https://ghproxy.net/` |

> 镜像是**第三方服务**，请勿用它下载含敏感信息的文件。

## 断点续传

同样的 `url` 与 `output` 再调用一次即可从断点继续：

- **aria2 路径**：能证实同源时启用 `-c`，否则不续传并覆盖写
- **curl 路径**：仅在探测确认支持 Range 且能证实同源时才加 `-C -`

续传前会比对远端长度与 `ETag` / `Last-Modified`（指纹存在 `<output>.part.json` 旁车里，成功时清除、中断时保留）。无法证实同源就删掉半包全量重下。

## 一次下载多个文件

```
smart_download(
  targets: [
    { url: "https://example.com/a.iso", output: "a.iso" },
    { url: "https://example.com/b.iso", output: "b.iso", sha256: "<摘要>" }
  ],
  maxBandwidth: "4M",
  timeoutMs: 600000
)
```

- **`url` 与 `targets` 二选一**，都给或都不给都在发请求前拒绝
- **空数组**同样拒绝
- **单批上限 50 条**，超限显式拒绝并回报实际条数，不截断
- 每条可带自己的 `output` / `sha256` / `checksum` / `ifExists`；`mirror` / `userAgent` / `referer` / `headers` / `maxBandwidth` / `timeoutMs` 整批共享
- **同步返回**：整批跑完才返回

### 逐条结果

返回 `batch`（批次 ID）、`succeeded` / `failed` / `cancelled` 三个计数，以及逐条的 `results[]`：

- 一条失败不影响其余条目，每行有自己的 `success`、`path` 与 `error`
- `failed`（下载坏了）与 `cancelled`（整批被取消）分开计数
- 每个条目的进度记录都带同一个 `batch` ID

### 批内并发

批内用滑动窗口并发：

```
批内连接预算 = 单条目最高档 × 2   （= 16）
窗口         = 预算 ÷ 单条目可能占用的连接数
```

每条 8 连接时窗口 2，每条 4 连接时窗口 4，峰值都在 16 附近。批量开工前不知道各条目大小，因此按最高档保守计算。

### `maxBandwidth`：整批共享带宽上限

接受裸字节数或 K/M/G 后缀（1024 进制），如 `"4M"` / `"500K"` / `"1500000"`。是**一次调用**的上限，批量时按实际并发均分。**非法值在发请求前抛错**。

### `timeoutMs`：单条目超时

毫秒，`1000`–`1800000`（1 秒到 30 分钟）。本工具同步调用，一个卡死的条目会让整批不返回。

- 超时的那条记 `failed`（不是 `cancelled`）
- 批量里其余条目继续跑
- 已完成条目的结果不会被改判
- 超时**不**回退 curl
- 不传表示不设超时；非法值发请求前抛错

## 参数速查

### `smart_download`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 单个文件地址。与 `targets` 二选一 |
| `targets` | array | 一次下一批，最多 50 条。每条 `{ url, output?, sha256?, checksum?, ifExists? }` |
| `output` | string | 输出路径。不传则依次尝试 `Content-Disposition`、查询串、URL 末段 |
| `mirror` | string | 镜像前缀，或字面量 `"auto"` |
| `sha256` | string | 期望的 SHA-256 |
| `checksum` | string | 期望摘要，支持 MD5 / SHA-1 / SHA-256 / SHA-512 |
| `ifExists` | string | `overwrite` / `skip` / `rename` |
| `userAgent` | string | User-Agent 头，探测与下载共用 |
| `referer` | string | Referer 头，探测与下载共用 |
| `headers` | object | 额外请求头 |
| `maxBandwidth` | string | 整次调用共享的带宽上限 |
| `timeoutMs` | integer | 单条目超时，`1000`–`1800000` |
| `connections` | string | 连接数：`"auto"` 或 `"1"`–`"16"`。不传时用界面保存的值 |

### `download_status`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `taskId` | string | 只查某一个任务 |
| `limit` | integer | 最多返回多少条（默认 `10`） |

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_SMARTDL_MIRRORS` | 覆盖内置镜像候选表 |
| `DSH_PROGRESS_DIR` | 覆盖进度轨道一的目录 |
| `DSH_DOWNLOAD_PROGRESS_DIR` | 覆盖进度轨道二的目录 |

## 手动选择连接数

输入框右侧（模型选择器左边）有一个「下载连接数」下拉：`auto` 或 **1–16 任意整数**。选完立即生效并跨会话保留——之后你只要发链接，Agent 就按这个数下载。

值存在 `$DSH_HOME/smart-dl-prefs.json`：

```json
{
  "connections": 9
}
```

读失败一律回落 `auto`，不会让下载失败。

### 优先级

```
显式传参（这次用 4）
      ↓ 没传
界面保存的值
      ↓ 没设过
auto（按大小分档）
```

### `auto` 模式按大小分档

| 文件大小 | 行为 |
| --- | --- |
| < 1MB | curl 单线程 |
| 1MB – 8MB | aria2 4 连接 |
| ≥ 8MB | aria2 8 连接 |

### 上限为什么是 16

aria2 的 `-x/--max-connection-per-server` 取值范围是 **1–16**，传 32 会直接失败。

## 查询进度：download_status

只读返回最近任务的状态快照：

```
download_status()                      # 最近 10 个任务
download_status(limit: 3)              # 只列最近 3 个
download_status(taskId: "dl-xxx")      # 指定任务
```

```json
{
  "ok": true,
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

- 纯只读，不写文件不联网
- 容错优先：目录不可读时该任务不出现，调用仍成功返回
- 按 `updatedAt` 倒序，`total` 是未截断的真实总数
- `spd` / `eta` 未知时返回空字符串

## 进度上报

双轨写入，任一轨道不可写都静默容错：

- **轨道一**（dsh-task-progress 格式）：`$DSH_PROGRESS_DIR/<taskId>.jsonl`。需第三方插件 `dsh-task-progress` 才能读；没有会话上下文时不写
- **轨道二**（本插件格式）：`$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`，缺省 `<DSH_HOME>/downloads/tasks/`

每条记录带 `state` 字段（`running` / `done` / `failed` / `cancelled`）。

## 界面进度面板

带 Web 界面的 profile 下，右下角挂载实时进度面板：显示文件名、百分比、速度、剩余时间；完成后短暂显示「已完成」然后消失。

- 走 `/api/smartdl.status`，与 `download_status` 读同一份进度文件
- 注册到 `shell.overlay` 插槽，不覆盖宿主界面
- 超过 10 分钟未更新的 `running` 任务自动忽略

## 下载管理器

左侧边栏「**下载管理**」入口，占满主区的一页列表。

**列表能力**：按状态筛选（全部 / 下载中 / 已完成 / 失败·取消）、按文件名搜索、多选批量删除记录。批量**只删记录，不删本地文件**。

**每行显示**：状态色点 + 进度条 + 文件名与百分比 + 大小 + 更新时间 + `presence` 徽标（原位 / 已移走 / 已改变）。

行内操作：

- **在文件夹中显示**：打开文件管理器并选中该文件
- **删除**：二次确认显示完整路径与大小；「同时删除本地文件」只在文件仍在原位时提供
- **取消**（仅下载中）：`SIGTERM` → 1 秒后 `SIGKILL`
- **重试**（仅失败/取消）：复用同一 `taskId` 后台重发，不重放请求头

**键盘**：行获焦点后按 `Delete` 打开确认框。

## 权限说明

本插件只做这些事：

| 行为 | 说明 |
| --- | --- |
| 网络请求 | 仅 `http` / `https`，其他协议下载前拒绝。不发任何遥测 |
| 请求头 | 默认只发 `accept-encoding: identity`；调用方传的头同时用于探测与下载 |
| 读取文件 | 校验摘要时流式读取刚落盘的文件，不读其他文件 |
| 写入文件 | 写入 `output` 指定路径；文件名推导结果必定是单段 |
| 读取磁盘 | `statfs` 查询目标目录可用空间 |
| 进度文件 | 读写出上述两条轨道目录 |
| HTTP 端点 | 仅 Web profile 注册 `/api/smartdl.status`、`/api/smartdl.cleanup`、`/api/smartdl.manage` |
| 子进程 | 启动 `aria2c` 或 `curl`，`windowsHide: true`，响应 `AbortSignal` |

**不需要**的权限：不读 DSH 会话内容、不访问凭证、不修改 DSH 配置、无遥测。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.0.0` |
| `@deepseek-ai/cordis` | `>=4.0.0 <4.0.1-0` 或 `>=4.0.1-rc.1 <5.0.0-0` |
| `@deepseek-ai/dsh-tools` | `>=0.1.7-rc.1 <0.3.0-0`（按预发布元组声明） |
| 包管理器 | npm / pnpm，需支持 `optionalDependencies` 的 `os` / `cpu` 过滤 |

### DSH 0.2.0 的安装前置检查

0.2.0 起安装前会核对 `peerDependencies`，不覆盖会拒绝安装或跳过整个 bundle。请使用 **`1.1.0` 或更高**。

## 工作原理

```
调用 smart_download
        │
        ▼
[0] 参数前置校验（下载开始前，不合法直接拒绝）
     · url 必须是 http(s)
     · sha256 / checksum 必须能识别，且不能同时给
     · ifExists 只能是 overwrite / skip / rename
     · headers 不能覆盖插件自管的头
        │
        ▼
[1] 组装请求头（探测与下载共用一份）
        │
        ▼
[2] 镜像解析
     · 显式前缀：镜像前缀 + 原始 URL
     · "auto"：探测候选，只采用被证实同源的
        │
        ▼
[3] 探测 URL（超时 5s）
     · 先 HEAD；失败或缺少 Content-Length 则用 GET + Range 兜底
     · 顺带读取 Content-Disposition
        │
        ▼
[3c] 确定落盘路径
     · output 优先，否则 Content-Disposition → 查询串 → URL 末段
        │
        ▼
[3d] ifExists=skip 且目标已存在 → 不发下载请求，有摘要仍校验
        │
        ▼
[3e] 磁盘空间预检
        │
        ▼
[4] decide() 按大小与 aria2 可用性分档
     · 不支持 Range / 探测失败 / <1MB → curl
     · 1MB–8MB → aria2 4 连接
     · ≥8MB → aria2 8 连接
        │
   ┌────┴────┐
   ▼         ▼
[5a] aria2  [5b] curl 单线程
   │ 失败
   ▼
降级 curl（完整性校验失败不走这条回退）
        │
        ▼
[6] 完整性校验（字节数 + 可选摘要）
        │ 通过           │ 失败
        ▼                ▼
   清除旁车，返回成功   抛错，保留旁车
```

要点：

- 探测异常不会让下载失败，HEAD 失败会改用 Range GET 兜底再判一次
- 下载完成后校验落盘字节数（退出码 0 不代表字节数对）
- 传了 `sha256` / `checksum` 就再核对内容
- 返回的 `requestedUrl` 是实际请求的地址，`mirrored` 标明是否走了镜像
- 只允许 `http` / `https`，重定向也只允许这两种
- 瞬时故障会重试（aria2 `-m 3 --retry-wait=2`，curl `--retry 3`）
- 不支持 FTP / SFTP / BitTorrent
- 输出文件名会被净化（单段、无穿越）

## 常见问题

**Q：下载速度没有提升？**
A：通常服务器不支持 Range，或文件本身较小。插件会自动回退 `curl`，返回结果的 `fellback` 与 `reason` 会说明原因。

**Q：提示找不到 aria2？**
A：确认平台在支持表内，且 `optionalDependencies` 里对应二进制装成功。macOS 需先在 `PATH` 上装可用的 `aria2c`。

**Q：官方文档给了 SHA-256 怎么核对？**
A：把摘要传给 `sha256`，四种写法都接受。

**Q：文档只给了 MD5 / SHA-1？**
A：用 `checksum`，裸十六进制按长度识别算法。

**Q：文件已下过，重跑会覆盖吗？**
A：默认会。想保留就传 `skip` 或 `rename`。

**Q：下载到一半提示磁盘空间不足？**
A：下载前预检要求「大小 + max(64MB, 5%)」。清理磁盘或换 `output` 路径。

**Q：下载的文件叫 `download`，没扩展名？**
A：优先用 `Content-Disposition` 的名字。想完全掌控就传 `output`。

**Q：地址直接下会 403？**
A：多半按 UA 或 Referer 分流。传 `userAgent` / `referer` / `headers`。

**Q：`mirror: "auto"` 没生效？**
A：看返回的 `mirrorSkipped`。常见原因：不是 GitHub 域名、拿不到原始长度、镜像都不可达。

**Q：下载中断要重新开始吗？**
A：不需要，同样的 `url` + `output` 再调一次即可续传。

**Q：会弹黑色命令行窗口吗？**
A：不会，子进程都是 `windowsHide: true`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](https://github.com/LeiSureYu/dsh-smart-download/blob/main/docs/ARCHITECTURE.md) | 内部结构与模块职责 |
| [SECURITY.md](https://github.com/LeiSureYu/dsh-smart-download/blob/main/docs/SECURITY.md) | 威胁模型与五层防护 |
| [COMPATIBILITY.md](https://github.com/LeiSureYu/dsh-smart-download/blob/main/docs/COMPATIBILITY.md) | 平台 / Node / profile 矩阵 |
| [TROUBLESHOOTING.md](https://github.com/LeiSureYu/dsh-smart-download/blob/main/docs/TROUBLESHOOTING.md) | 症状 → 原因 → 处理 |
| [CHANGELOG.md](https://github.com/LeiSureYu/dsh-smart-download/blob/main/CHANGELOG.md) | 完整版本记录 |

## 开发

```bash
npm install
npm run build    # 构建到 dist/
npm test         # 运行测试（node:test，不依赖真实网络）
npm run typecheck
```

## 第三方组件声明

aria2 二进制来自 aria2 官方发布包（Windows x64 / Linux）。Windows arm64 来自第三方 ARM64 构建。均未做任何修改。

## License

见 [LICENSE](https://github.com/LeiSureYu/dsh-smart-download/blob/main/LICENSE)。

---

> 本仓库是 [LeiSureYu/dsh-smart-download](https://github.com/LeiSureYu/dsh-smart-download) 的 fork，README 做过精简。
