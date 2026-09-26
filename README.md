# dsh-smart-dl

> DSH 多线程下载插件，内置 aria2，**零配置**：安装即用，无需自行安装 aria2。

`dsh-smart-dl` 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 注册一个 `smart_download` 工具。当模型需要下载文件时，插件会先探测目标服务器是否支持多线程，支持则调用随插件分发的 `aria2c` 进行多线程加速下载，否则自动回退到系统自带的 `curl` 单线程下载，保证在任何情况下都能完成下载。

## 安装

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

安装后无需任何额外配置：aria2 二进制通过 npm 的 `optionalDependencies` 机制随插件一起安装。

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
[3a] 能定位到随包 aria2c.exe？    [3b] curl 单线程（含进度条）
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

| 平台      | 架构          | 是否支持   |
| ------- | ----------- | ------ |
| Windows | x64         | ✅ 首发支持 |
| Windows | arm64       | ⏳ 计划中  |
| macOS   | x64 / arm64 | ⏳ 计划中  |
| Linux   | x64 / arm64 | ⏳ 计划中  |

二进制子包通过 `os` / `cpu` 字段声明，npm / pnpm 在不匹配的平台上会自动跳过安装。

## 常见问题

**Q：安装或运行时被 Windows Defender（或其他杀毒软件）拦截？**
A：这是对 `node_modules` 内未签名 `aria2c.exe` 的常见启发式告警。可将项目的 `node_modules` 目录加入 Windows Defender 的白名单（“病毒和威胁防护 → 管理设置 → 排除项”）。`aria2c.exe` 直接来自 aria2 官方发布包，未做任何修改。

**Q：下载速度没有提升？**
A：通常是目标服务器**不支持 Range 请求**（无法分片），或文件本身较小。插件会自动回退到 `curl` 单线程下载；返回结果中的 `fellback` 与 `reason` 字段会说明具体原因。

**Q：提示找不到 aria2 / 始终走 curl？**
A：请确认当前为 **Windows x64**，且 `optionalDependencies` 中的 `@leisureyu/aria2-win32-x64` 安装成功（部分镜像源可能未同步该包，可切换官方 npm 源后重装）。

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

本地开发时，`packages/aria2-win32-x64/bin/aria2c.exe` 需要手动放置（该二进制不入库）：

1. 下载 <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip>；
2. 解压后将其中的 `aria2c.exe` 复制到 `packages/aria2-win32-x64/bin/aria2c.exe`。

### 发布

推送 `v*` tag 即触发 GitHub Actions（`.github/workflows/publish.yml`）：CI 在 Windows 上下载并填入 `aria2c.exe`，**先发布二进制子包，再发布主包**（主包依赖子包，顺序不可颠倒）。

> 注意：本仓库已使用 npm scope `@leisureyu`。如需改换 scope，需同步修改主包 `optionalDependencies`、子包 `name`、`src/downloader.ts` 中的 `ARIA2_PACKAGE` 以及 `test/downloader.test.ts` 中的断言。

## 第三方组件声明

本插件分发的 `aria2c.exe` 来自 [aria2](https://aria2.github.io/) 官方发布包，aria2 依据 **GPL-2.0-or-later** 许可，二进制子包 `@leisureyu/aria2-win32-x64` 同样声明为 `GPL-2.0-or-later`。

## License

- 本插件代码：[MIT](./LICENSE)
- 随包分发的 aria2 二进制：**GPL-2.0-or-later**
