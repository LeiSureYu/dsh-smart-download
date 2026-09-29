# 兼容性

本文说明 `@leisureyu/dsh-smart-dl` 在哪些平台上能跑、跑成什么样，以及为什么。
安装步骤见 [README](../README.md)，故障排查见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## 一句话结论

Windows 与 Linux 的 x64 / arm64 四个组合是**完整支持**：随包 aria2 多线程加速可用。
macOS **能用但不会加速** —— 插件装得上、下得动，只是永远走 `curl` 单线程。

## 平台矩阵

| 平台 | 架构 | 插件可用 | 多线程（aria2） | 二进制子包 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Windows | x64 | ✅ | ✅ | `@leisureyu/dsh-aria2-win32-x64` | aria2 官方发布包 |
| Windows | arm64 | ✅ | ✅ | `@leisureyu/dsh-aria2-win32-arm64` | 第三方 ARM64 构建（官方无此架构） |
| Linux | x64 | ✅ | ✅ | `@leisureyu/dsh-aria2-linux-x64` | musl 静态构建，任意发行版可用 |
| Linux | arm64 | ✅ | ✅ | `@leisureyu/dsh-aria2-linux-arm64` | 同上 |
| macOS | x64 / arm64 | ⚠️ 走 curl | ❌ | — | 缺二进制子包，见下 |

**「插件可用」与「多线程可用」是两件事。** 每个支持平台对应一个独立 npm 子包，
子包用 `os` / `cpu` 字段声明适用平台。包管理器在不匹配的平台上会**直接跳过安装**，
不会报错；`src/downloader.ts` 的 `getAria2Path()` 解析不到二进制时返回 `null`，
由 `decide()` 回退到 `curl`，并在返回结果的 `reason` 里写明「未找到 aria2 二进制
（当前平台 … 不受支持或子包未安装）」。

因此**不支持的平台不会装出一个坏掉的插件**，只会装出一个单线程下载器。

### macOS 为什么搁置

不是兼容性问题，是**缺一个可用的 aria2 二进制**。本项目只分发自己验证过哈希的二进制
（见 README 的「第三方组件声明」），而 macOS 上没有找到满足条件的来源：

- aria2 官方不发布 macOS 二进制；
- 现有的第三方 macOS 构建没有可核对的发布哈希，且需要按 Intel / Apple Silicon 分包；
- Homebrew 的 `aria2` 属于用户环境依赖，不能假设存在，也不该由插件代管。

自建 macOS 二进制并验证哈希在当前条件下做不了，因此如实搁置。**没有硬做的版本。**
在 macOS 上插件保持可用、行为可预测：所有下载走 `curl`，路径与校验逻辑与其他平台一致。

如果后续补齐了 macOS 子包，只需要往 `ARIA2_TARGETS`（`src/downloader.ts`）加
`darwin-x64` / `darwin-arm64` 两项并发布对应子包，其余代码不用改。

## DSH 与运行时版本

| 项目 | 要求 | 依据 |
| --- | --- | --- |
| Node.js | `>=22.0.0`（`engines.node`） | 用到 `AbortSignal.any` 与 `AbortSignal.timeout`，二者在 Node 22 才齐全。探测层与取消路径都依赖它们，低版本会直接抛错。 |
| `@deepseek-ai/cordis` | peerDependency，可选 | 插件按 host 提供的 `Context`（`ctx.tools.register` / `ctx.inject`）工作。 |
| `@deepseek-ai/dsh-tools` | peerDependency，可选 | 提供 `defineTool`。 |
| DSH 运行时 | **0.1.7-rc.1 起验证；0.2.0 已适配（含桌面版）** | `peerDependencies` 已声明覆盖 `>=0.2.0-rc.1 <0.3.0-0`；0.2.0 起这份声明被真正强制，见下节。 |
| `@deepseek-ai/dsh-client-connection` | peerDependency，可选 | 仅进度面板用；缺失时 `registerStatusRpc` 静默跳过。 |
| `@deepseek-ai/dsh-client-locale` | peerDependency，可选 | 面板双语文案（zh / en）。 |
| `@deepseek-ai/dsh-client-ui-slots` | peerDependency，可选 | 面板挂载到 `shell.overlay`。 |

全部 peerDependency 都在 `peerDependenciesMeta` 里标为 `optional: true`：
不想用面板、或 host 没提供 connection 服务时，不该因为缺包而装不上。

### 为什么 peerDependency 范围写成「预发布元组」

DSH 系的包**只发布预发布版本**（`0.1.7-rc.1` 这种）。npm 的常规范围默认排除预发布版，
所以下面这种写法会解析不到任何版本：

```
"@deepseek-ai/dsh-tools": "^0.1.7-rc.1"   ❌ 解析为空
```

现在的写法是显式列出允许的预发布分支：

```
">=0.1.7-rc.1 <0.1.8-0 || >=0.1.8-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0"
```

**这是需要维护的**：DSH 每开一个新的预发布分支（下一个是 `0.3.0-rc.*`），
这份范围就要同步追加一段 `||`，否则用户的 harness 升到该分支后会被**拒绝**（见下节）。
改动点只有 `package.json` 的 `peerDependencies`。

#### 0.2.0 起：范围写错不再只是 ERESOLVE

0.1.x 时代，范围解析不到预发布版只表现为包管理器报 `ERESOLVE`，用户加个 `--force` 或
换 npm 还能装上、也能跑。**0.2.0 起这条路径被收紧**：DSH 自己在装配阶段核对每个插件的
`peerDependencies`（只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这几个名字），
不覆盖当前运行版本时，普通插件行被标 `disabled`，而 **bundle 行会让整个 bundle 被跳过**，
插件完全不会加载，日志只有一行 `dsh: skipping profile bundle ...`。

安装时也一样：`dsh plugin add` 会**先检查再动包管理器**，不兼容直接拒绝，不下载任何东西。
换句话说，`peerDependencies` 的范围从「装得上但可能有噪音」变成了「装不装得上」的开关。

判定用的是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，
运行时版本取自 dsh 自身（例如 `0.2.0-rc.2`），因此范围里**必须显式写预发布段**，
`^0.2.0` 这种写法同样解析不到 `0.2.0-rc.2`。

暂时放行某个旧版本可以用「精确版本豁免」：

```bash
dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <精确 dsh 版本> --accept-risk
dsh plugin --profile <profile> version-exemptions     # 查看
dsh plugin --profile <profile> revoke-version <包@版本> --dsh-version <精确 dsh 版本>  # 撤销
```

豁免写在该 profile 的 `compatibility.json`，粒度是**精确的包版本 + 精确的 dsh 版本**，
换任一版本都不再生效。

**本插件已发布版本在 `0.2.0-rc.2` 上的实际判定**（用 0.2.0 自带的
`evaluatePluginCompatibility` 逐个跑出来的，不是推断）：

| 版本 | 判定 | 说明 |
| --- | --- | --- |
| `0.1.5` / `0.2.0` | ❌ 被拒 | `dsh-tools` 写的是 `^0.1.0`，解析不到任何预发布版 |
| `0.2.1` ~ `0.3.0` | ✅ 通过 | 已经写成预发布元组 |
| `0.4.0` | ❌ 被拒 | 三个 `dsh-client-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0-0` |
| `0.4.1` ~ `1.0.1` | ✅ 通过 | 三个 `dsh-client-*` peer 补上了 0.2.0 分支 |
| `1.1.0` | ✅ 通过 | 当前版本 |

因此 0.4.0 的用户升级后即可恢复；0.4.1 ~ 1.0.1 的用户在 0.2.0 上本来就能用，
升级到 1.1.0 主要是拿到桌面版说明与这份兼容性文档。

### 包管理器要求

npm 与 pnpm 都可以，但**必须支持 `optionalDependencies` 的 `os` / `cpu` 过滤**
（npm 7+ / pnpm 6+ 均支持）。极老的镜像源可能没有同步这四个子包，表现为
「装完一直走 curl」；切回官方 npm 源重装即可，具体排查见
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## profile 兼容性

插件注册两个工具（`smart_download` / `download_status`），这部分**与 profile 无关**，
任何 profile 都能用。有区别的只有 UI 面板：

| profile | 工具可用 | 进度面板 | 说明 |
| --- | --- | --- | --- |
| `web` | ✅ | ✅ | 唯一验证过面板的 profile |
| `desktop`（0.2.0 起） | ✅ | ✅ | 桌面版，同样带 Web 界面，与 `web` 同源 |
| 其他 | ✅ | ❌ | 功能不受影响，用 `download_status` 查进度 |

面板只在带 Web 界面的 profile 注册，因为它依赖 connection 服务提供的 `/api` 载体
（`ctx.inject(['connection'], ...)`）。纯 CLI profile 下没有这个服务，
`registerStatusRpc` 静默跳过，**不会**让插件加载失败。

安装命令形如 `dsh plugin --profile web add @leisureyu/dsh-smart-dl`，
把 `web` 换成你实际使用的 profile 名称即可。

> **桌面版（`desktop` profile）必须用桌面版自带的 CLI 安装**（`<安装目录>/resources/runtime/cli/bin/dsh.cmd`），
> 或侧边栏的 Plugins 页面：这个 profile 由 Electron 应用独占管理，外部 CLI 会被拒绝。
> 本插件在 `desktop` 上的工具注册与 `web` 完全一致（`platform: 'web'` 沿用，客户端清单不需要改）。

## 二进制子包版本

四个子包版本号统一为 **`1.37.0`**，与它们打包的 aria2 版本一致（不是本插件的版本）。
主包通过 `optionalDependencies` 精确 pin 到该版本，避免「主包升级了、子包还是旧二进制」
这类错配。

子包内的二进制哈希在发布前由 CI 校验，来源与压缩包 SHA256 见 README 的
「第三方组件声明」一节。

## 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) —— 内部结构与决策表
- [SECURITY.md](./SECURITY.md) —— 四层防护与威胁模型
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) —— 症状 → 原因 → 处理
- [REVIEW-1.0.md](./REVIEW-1.0.md) —— 1.0 代码审查记录
