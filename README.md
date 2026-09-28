# dsh-smart-dl

[![npm version](https://img.shields.io/npm/v/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![npm downloads](https://img.shields.io/npm/dm/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![license](https://img.shields.io/npm/l/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![Publish](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml/badge.svg)](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux-0078D4)

**简体中文** · [English](./README.en.md)

> DSH 多线程下载插件，内置 aria2，**零配置**：安装即用，无需自行安装 aria2。

`dsh-smart-dl` 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 注册一个 `smart_download` 工具。当模型需要下载文件时，插件会先探测目标服务器是否支持多线程，支持则调用随插件分发的 `aria2c` 进行多线程加速下载，否则自动回退到系统自带的 `curl` 单线程下载，保证在任何情况下都能完成下载。

## 安装

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

安装后无需任何额外配置：aria2 二进制通过 npm 的 `optionalDependencies` 机制随插件一起安装。

> **版本要求：请使用 `0.2.1` 或更高。** `0.2.0` 起支持 **Windows arm64** 与 **Linux x64 / arm64**（此前仅 Windows x64）；更早的 `0.1.1` / `0.1.3` / `0.1.4` 在 DSH 插件清单或工具 schema 上存在缺陷，会导致两种失败：安装被拒（`Cannot validate installed package ... dsh.bundle.patch`），或装上了但激活失败（启动日志出现 `did not activate`）。当前发布版本见顶部版本徽章；如需固定，可写 `@leisureyu/dsh-smart-dl@0.2.1`。
>
> `0.2.1` 另修复了一个**必然安装失败**的问题：此前 `peerDependencies` 中 `@deepseek-ai/dsh-tools` 写作 `^0.1.0`，而该包从未发布过 0.1.x 正式版（实际可用版本均为预发布版），导致该范围解析不到任何版本，安装时报 `npm error notarget No matching version found for @deepseek-ai/dsh-tools@^0.1.0`。

## 工作原理

下载决策流程（文字版）：

```
调用 smart_download(url, output?)
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
     · 1MB ~ 50MB  -> aria2 4 连接
     · ≥ 50MB       -> aria2 8 连接（保守上限，不开 16）
        │
   ┌────┴──────────────────────────┐
   ▼ aria2 档                       ▼ curl 档
[3a] 能定位到随包 aria2c？         [3b] curl 单线程（含进度条）
   │ 是              │ 否
   ▼                 ▼
 aria2 4/8 连接     curl 单线程（回退）
 （每秒摘要进度）
   │ 失败
   ▼
 降级为 curl 单线程（回退）
        │
        ▼
 返回结果 { success, path, method, size, fellback, reason? }
```

要点：

- **任何探测异常**（超时、网络错误、无法获取文件大小）都会被安全地判定为“不支持多线程”，从而走 curl 回退，不会让下载直接失败。
- 并发数随文件大小动态选择（阈值 1MB / 50MB），`reason` 会区分“不支持 Range”“文件太小”“aria2 缺失”等情况。

## 进度上报

下载过程中通过 `ProgressReporter` **双轨**写入进度，任一轨道不可写都静默容错，不影响下载：

- 轨道一（dsh-task-progress 格式）：`$DSH_PROGRESS_DIR/<taskId>.jsonl`，每行一条 JSON，append-only；
- 轨道二（dsh-download-progress 格式）：`$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`，缺省为 `~/.dsh/downloads/tasks/<taskId>.json`，整体覆盖写。

进度按百分比去重，完成 / 失败终态会穿透去重。aria2 解析 `--summary-interval=1` 的摘要行（含速度与 ETA），curl 解析 `--progress-bar` 的百分比。

## 设计上的静默失败防护

开发过程中实测发现了三个**同类型的静默失败**：

1. **aria2 摘要格式变化**：关闭 readout 后，GID 变为十六进制、无 `SIZE:` 前缀、速度字段由 `SPD:` 变为 `DL:`；
2. **curl `--silent` 抑制进度**：即使进度走 stderr，`--silent` 也会把 `--progress-bar` 一并压掉；
3. **aria2 临近完成时省略 ETA**：快完成的摘要行整体不输出 ETA 字段。

它们都不是逻辑错误，而是**对外部程序真实行为的假设错了**：逻辑都对、测试都绿、下载也成功，只是某个环节悄悄返回了默认值（“不支持” / `curl` / `null` / 跳过写入）。这类问题的危险在于退出码仍是 0，“不抛错”的测试永远抓不住。

**契约**：本插件所有“返回默认值”的路径——

| 环节                  | 静默失败形态        | 必须断言的正向信号                                  |
| ------------------- | ------------- | ------------------------------------------ |
| `probeUrl`          | 探测异常 → 不支持    | 已知支持的 URL 必须返回 `supportsMultiThread: true` |
| `decide`            | 分支遗漏 → 落 curl | 已知大文件必须返回 `method: 'aria2'`                |
| `parseAria2Summary` | 认不出 → `null`  | 真实样本必须解析出 `pct/spd(/eta)`                  |
| `parseCurlProgress` | 认不出 → `null`  | 真实样本必须解析出单调递增到 100% 的百分比                   |
| `ProgressReporter`  | 目录不可写 → 跳过    | 可写目录必须存在文件且内容递增                            |
| `LineBuffer`        | 切分状态错误        | 跨 chunk / `\r` / `\r\n` 边界必须切出正确的行         |

所有断言都是**正向**的：检查“有没有真的产出”，而不是“有没有崩溃”。真实样本保存在 `test/fixtures/`（curl 为保留 `\r` 的 `.bin`），并对“fixture 必须含 `\r`”做了强制断言。

> 如果未来发现某条返回默认值的路径没有被正向信号断言覆盖，**那是一个 bug，不是设计**。把正向断言改回“只要不报错就行”，等于重新打开静默失败的后门。

此外，`test/meta-test-discovery.test.ts` 会枚举 `test/` 下所有测试文件，并断言 `test` 脚本（glob）确实覆盖它们——连“CI 是否真的跑了这些测试”这一层本身也被强制验证，防止防护措施自己在 CI 里静默失效。

## 支持平台

| 平台      | 架构    | 是否支持              | 二进制子包                          |
| ------- | ----- | ----------------- | ------------------------------ |
| Windows | x64   | ✅ 支持             | `@leisureyu/dsh-aria2-win32-x64`   |
| Windows | arm64 | ✅ 支持             | `@leisureyu/dsh-aria2-win32-arm64` |
| Linux   | x64   | ✅ 支持             | `@leisureyu/dsh-aria2-linux-x64`   |
| Linux   | arm64 | ✅ 支持             | `@leisureyu/dsh-aria2-linux-arm64` |
| macOS   | x64 / arm64 | ❌ 暂不支持     | —                              |

二进制子包通过 `os` / `cpu` 字段声明，npm / pnpm 在不匹配的平台上会自动跳过安装。

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

## 开发

环境要求：Node.js **22+**、pnpm **9+**。

```bash
# 安装依赖
pnpm install

# 本地构建（输出到 dist/）
pnpm build

# 运行测试（node:test，不依赖真实网络）
pnpm test

# 仅类型检查
pnpm typecheck
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

## License

- 本插件代码：[MIT](./LICENSE)
- 随包分发的 aria2 二进制：**GPL-2.0-or-later**
