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
| macOS | x64 / arm64 | ⚠️ 走 curl | ❌ | — | 无可信来源的二进制子包，见下 |

**「插件可用」与「多线程可用」是两件事。** 每个支持平台对应一个独立 npm 子包，
子包用 `os` / `cpu` 字段声明适用平台。包管理器在不匹配的平台上会**直接跳过安装**，
不会报错；`src/downloader.ts` 的 `getAria2Path()` 解析不到二进制时返回 `null`，
由 `decide()` 回退到 `curl`，并在返回结果的 `reason` 里写明「未找到 aria2 二进制
（当前平台 … 不受支持或子包未安装）」。

因此**不支持的平台不会装出一个坏掉的插件**，只会装出一个单线程下载器。

### macOS 为什么搁置

不是兼容性问题，是**缺一个可信来源的 aria2 二进制**。本项目只分发自己验证过哈希的二进制
（见 README 的「第三方组件声明」）。这一条在 1.3 被**逐个来源重新核对过**（2026-10-12），
结论不变、证据更强：**卡点是「来源不可信」，不是「没有二进制」**。

| 说法 | 是否成立 |
| --- | --- |
| 「没有 macOS 二进制」 | ❌ 不成立。存在提供 macOS x64 与 arm64 的 aria2 1.37.0 并公布 SHA256 的第三方候选（见下） |
| 「没有可核对哈希的 macOS 二进制」 | ❌ 也不成立。该候选的 `.sha256` 文件与 GitHub `digest` 字段两处一致（已复现） |
| 「没有**可信**的 macOS 二进制来源」 | ✅ **成立** —— 哈希只证明「传输是否被篡改」，不证明「来源可信、二进制由官方源码构建」 |

**为什么「有哈希」仍然不够**：哈希解决的是传输完整性，不解决来源可信性与「二进制 ↔ 源码」
的可核验绑定。本项目的四个既有子包（官方发布包 / 两个第三方静态构建）都在这一点上说得清，
唯一带哈希的 macOS 候选说不清。

**唯一带哈希的候选：`FerroDownload/aria2-static-builds`**（来源：
<https://api.github.com/repos/FerroDownload/aria2-static-builds/releases?per_page=3>，核对时间 2026-10-12）

它确实提供 macOS x64（4,056,152 B）与 arm64（4,221,960 B）的 aria2 1.37.0，并公布 SHA256。
被否的原因是哈希之外的三条，全部实测：

1. **发布方可信度极低**：仓库创建于 2026-06-20、`stargazers_count=0`、无许可证声明、
   无描述、只有 1 次 release。一个刚创建、零关注、无许可证的个人仓库，作为**随 npm 包
   分发的可执行文件**来源，够不上本项目对 Windows arm64（`minnyres`）与 Linux（`abcfy2`）
   来源所隐含的标准。
2. **二进制与源码之间没有可核验的绑定**：GitHub 的构建证明
   （`GET /repos/FerroDownload/aria2-static-builds/attestations/<digest>`）对这两个摘要
   **均返回 404**。也就是说没有任何签名证明「这个二进制确实由那份 workflow 从官方源码
   构建出来」。工作流本身也未 pin 源码 commit、依赖 `brew install` 当时最新版本，
   无法重跑一次构建并比对哈希。
3. **产物形态不利**：macOS 无法完全静态链接，因此这两个文件是动态链接的（HTTPS 走
   `--with-appletls`），仍依赖宿主系统库版本，与现有四个子包的形态不一致。

其余来源逐个核对的结果（全部 2026-10-12，来源清单与逐条证据见
[PLAN-P2-PLATFORM.md](./PLAN-P2-PLATFORM.md) §A.2 与附录 C）：

- aria2 官方最后一次发 macOS 包是 `release-1.35.0`（2019-10-06，仅 x86_64），且
  **官方从未为 macOS 包提供摘要**（`body` 无校验和清单、资产 `digest` 为空）；
  最新版 `release-1.37.0`（2023-11-15）的 6 个资产无 darwin。
  来源：<https://api.github.com/repos/aria2/aria2/releases/tags/release-1.35.0>
- 现用的 Linux 来源 `abcfy2/aria2-static-build` 与社区最知名的 `dmesg00/aria2-static-builds`
  （735★）**都不产 darwin**。来源：
  <https://api.github.com/repos/abcfy2/aria2-static-build/releases?per_page=4>、
  <https://api.github.com/repos/dmesg00/aria2-static-builds>
- Homebrew 的 `aria2` 有 SHA256，但 bottle **只有 arm64 macOS**（无任何 `x86_64_*`），
  且是动态链接带 5 个依赖（`c-ares, libssh2, openssl@4, sqlite, gettext`），属用户环境
  依赖。来源：<https://formulae.brew.sh/api/formula/aria2.json>

自建 macOS 二进制技术上存在（GitHub 官方 runner 同时提供 x64 与 arm64 的 macOS 镜像，
来源：<https://github.com/actions/runner-images/blob/main/README.md>，核对时间 2026-10-12），
但那是**新增长期维护负担**而不是「补个子包」（runner 标签有生命周期：`macos-14` 已进入
废弃流程，见 <https://github.com/actions/runner-images/issues/13518>），且两条前置条件
未确证，1.3 内不做。因此如实搁置。**没有硬做的版本。**
在 macOS 上插件保持可用、行为可预测：所有下载走 `curl`，路径与校验逻辑与其他平台一致。

如果后续补齐了 macOS 子包，只需要往 `ARIA2_TARGETS`（`src/downloader.ts`）加
`darwin-x64` / `darwin-arm64` 两项并发布对应子包，其余代码不用改。

**本插件不支持 FTP / SFTP / BitTorrent**，理由见 README「权限说明」与
[SECURITY.md](./SECURITY.md)「已知边界」。

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

**pnpm 11 的本机注意事项**：`pnpm.onlyBuiltDependencies` 写在 `package.json` 的 `pnpm`
字段里时，**pnpm 11 不再读它**（该设置搬到了 `pnpm-workspace.yaml`）。未批准构建脚本时
`pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` **失败**（本项目需要 `esbuild` 的构建脚本，
`tsx` 依赖它）。按提示在本机的 `pnpm-workspace.yaml` 里填上即可：

```yaml
allowBuilds:
  esbuild: true
```

该文件被 `.gitignore` 忽略（它是**本机**的构建审批状态，不入库），CI 固定用 pnpm 9
（读 `package.json` 里的字段），所以这一条只影响本机开发。
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

### 客户端插件的服务依赖（1.4.0 起）

客户端脚本（`src/client.js`）除了 `react` 平台基线外，还通过 manifest 的
`dsh.client.inject` 声明了这些宿主服务：

| 声明 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-slots` | 注册浮层 / 侧边栏入口 / 主区面板 | 面板完全不出现 |
| `@deepseek-ai/dsh-client-locale` | 中英文案 | 界面只剩键名 |
| `@deepseek-ai/dsh-client-connection` | `/api` 载体（`connection.rpc.call`） | 拉不到进度 |
| `@deepseek-ai/dsh-client-ui-layout` | `ctx.layout.selectPanel`（面板开合） | 点入口打不开面板 |
| `@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-api-session-controller` | `ctx.remote.session`（「在文件夹中显示」的**首选**路径） | **自动降级到服务端实现**，功能照常 |

**光在代码里写 `inject: ['remote.session']` 不够** —— manifest 才决定插件拿不拿得到这些
命名空间。这是 1.4.0 踩过的坑：清单漏声明时 `ctx.remote.session` 恒为 `undefined`，
而代码里的 `inject` 数组看不出任何问题。

**`remote.session` 不是必需的**：实测这份 `desktop` profile 下即使清单补齐也拿不到它，
所以「在文件夹中显示」实现了**两条路径** —— 优先 `remote.session`（原生「选中文件」），
不可用时由服务端（`op:'reveal'`）起宿主进程打开（Windows `explorer.exe /select,`、
macOS `open -R`、Linux `xdg-open`）。缺这个服务只会少一点原生贴合度。

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
