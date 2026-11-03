# 兼容性

本文说明 `@leisureyu/dsh-smart-dl` 在哪些平台上能跑、跑成什么样，以及为什么。
安装步骤见 [README](../README.md)，故障排查见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## 一句话结论

六个平台组合（Windows / Linux / macOS 的 x64 / arm64）自 1.7.0 起全部**完整支持**：
随包 aria2 多线程加速可用。macOS 的两个子包由**本仓库自己的 CI 从官方源码构建**
（1.7.0 起，见下）—— 1.3 时代「macOS 只在 `PATH` 有 `aria2c` 时才多线程」的
结论已被这一新事实推翻，历史核对记录保留在下方作为「为什么选择自构建而非
第三方」的依据。

**HarmonyOS（鸿蒙）自 1.9.1 起「可用但未完整」**：插件识别 `ohos` 运行时并在
其上开箱工作（回退 curl 单线程；PATH 或 `DSH_SMARTDL_ARIA2_PATH` 自备 aria2c
即可多线程），随包 ohos-arm64 子包在路线图上 —— 与 macOS 1.3 → 1.7.0 完全相同
的两阶段节奏（见下节末尾）。

## 平台矩阵

| 平台 | 架构 | 插件可用 | 多线程（aria2） | 二进制子包 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Windows | x64 | ✅ | ✅ | `@leisureyu/dsh-aria2-win32-x64` | aria2 官方发布包 |
| Windows | arm64 | ✅ | ✅ | `@leisureyu/dsh-aria2-win32-arm64` | 第三方 ARM64 构建（官方无此架构） |
| Linux | x64 | ✅ | ✅ | `@leisureyu/dsh-aria2-linux-x64` | musl 静态构建，任意发行版可用 |
| Linux | arm64 | ✅ | ✅ | `@leisureyu/dsh-aria2-linux-arm64` | 同上 |
| macOS | x64 | ✅ | ✅ | `@leisureyu/dsh-aria2-darwin-x64` | 本仓库 CI 自构建（1.7.0 起），见下 |
| macOS | arm64 | ✅ | ✅ | `@leisureyu/dsh-aria2-darwin-arm64` | 同上，Apple Silicon 原生构建 |
| HarmonyOS | arm64 | ✅（1.9.1 起） | 🟡 需自备 aria2c | `@leisureyu/dsh-aria2-ohos-arm64`（尚未发布） | OpenHarmony 运行时，见下节 |

**「插件可用」与「多线程可用」是两件事。** 六个受支持组合（Windows / Linux / macOS）各对应独立
npm 子包，子包用 `os` / `cpu` 字段声明适用平台；包管理器在不匹配的平台上会**直接跳过安装**，
不会报错。`src/downloader.ts` 的 `getAria2Path()` 按以下顺序定位 aria2：

1. 环境变量 `DSH_SMARTDL_ARIA2_PATH` 显式指定的二进制（1.9.1 起；**验证失败时不
   回落其它来源** —— 自动换一个来源会把配置错误静默掩盖掉，直接返回 `null` 回退
   curl，`decide()` 的 reason 会提示核对环境变量）；
2. 尝试 `require.resolve` 随包二进制子包；
3. 子包不可用时，在 `PATH` 上查找 `aria2c`（Windows 按 `PATHEXT` 展开）；
4. 对找到的候选执行一次 `aria2c --version`，退出码为 0 才采用；
5. 所有路径都失败才返回 `null`，由 `decide()` 回退到 `curl`，并在返回结果的 `reason`
   里写明「未找到 aria2 二进制（当前平台 … 不受支持或子包未安装）」。

因此**没有随包子包的平台不会装出一个坏掉的插件**，只会装出一个单线程下载器；
如果用户在 `PATH` 上自备了可用的 aria2（或用 `DSH_SMARTDL_ARIA2_PATH` 显式指定），
则仍可多线程。

### HarmonyOS：1.9.1 的阶段性适配

1.9.1 做的是「让插件在鸿蒙上被正确识别并开箱工作」，不是「随包二进制完整支持」。
拆成两阶段的原因与 macOS 完全同构：卡点不在代码，在**缺一个可信来源、可复现
构建的 OHOS aria2 二进制**；而代码不先认识 `ohos` 平台，子包发布那天插件也用不上。

**运行时事实（1.9.1 依赖的假设，均有生态先例）**：

- OpenHarmony / HarmonyOS 的 Node 运行时报告 `process.platform === 'ohos'`、
  `process.arch === 'arm64'`。npm 生态已按该值分发 OHOS 预编译产物
  （如 lightningcss 的 `aarch64-unknown-linux-ohos` 目标、napi-rs 的 ohos 平台），
  npm 子包的 `os: ["ohos"]` 字段按同一语义匹配。
- HarmonyOS NEXT 的内核不是 Linux，linux-arm64 的 musl 静态 aria2 **不能**复用，
  必须以 `aarch64-linux-ohos` 目标独立构建 —— 这是 ohos 需要独立子包的理由。
- DSH 若以 Linux 兼容环境（虚拟机 / 容器）形态跑在鸿蒙 PC 上，则
  `process.platform` 是 `linux`，走既有 linux-arm64 子包，无需本节任何改动；
  本节只覆盖「DSH 原生跑在 OHOS Node 运行时」的形态。

**1.9.1 落地的部分**：

- `ARIA2_TARGETS` 新增 `ohos-arm64` → `@leisureyu/dsh-aria2-ohos-arm64`；子包
  发布并进入主包 optionalDependencies 的那天，解析零改动生效。
- 回退链在鸿蒙上原样成立：随包子包（暂缺）→ PATH 上的 `aria2c` → curl，
  且每一级降级都在 reason 里显式写明。
- 新增 `DSH_SMARTDL_ARIA2_PATH`（全平台）：OHOS 应用沙箱的 PATH 不含侧载
  目录，「把自建 aria2c 放上 PATH」常常不可行，该变量给出第三条路。
- 断点续传、校验、镜像、代理、后台模式等纯 Node 逻辑不依赖平台，鸿蒙上行为
  与其它平台一致；RPC daemon 的 POSIX 生命周期绑定（`--stop-with-pid`）对
  OHOS 运行时同样适用。

**尚未落地（后续版本）**：

- 随包 ohos-arm64 二进制：由本仓库 CI 用 OpenHarmony SDK 原生工具链从 aria2
  官方源码构建（darwin 同款信任模型，附 SLSA provenance）。构建配方涉及
  zlib / openssl 等 OHOS 目标的交叉编译，配方验证通过之前不会发布任何二进制
  —— 与 macOS 1.3 时代「宁可搁置也不发不可信二进制」的门槛一致。
- 「在文件夹中显示」：OHOS 没有统一的 `xdg-open` 等价命令，该按钮在鸿蒙上
  会如实报告启动失败（既有 `openWithCommand` 契约），不影响下载本身。

### macOS：从「搁置」到「CI 自构建」（1.7.0 起）

1.3 时本节叫「macOS 为什么搁置」：不是兼容性问题，而是**缺一个可信来源的 aria2 二进制**。
那一核对（2026-10-12）的全部事实今天仍然成立 —— 但它证明的是「第三方来源不可信」，
而不是「这件事做不成」。1.7.0 换了信任模型：**不找可信的第三方构建者，而是让本仓库的
CI 成为构建者**，把三条否决理由逐条变成工程约束：

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
   `--with-appletls`），仍依赖宿主系统库版本，与现有（当时的）子包形态不一致 —— 1.7.0 的自构建子包同样以「只链系统库」收口。

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

**CI 实测（2026-10-31，run #6 双架构全绿）**：`otool -L` 三条系统依赖
（Security.framework / libc++ / libSystem）、ad-hoc 签名、真实 HTTPS 下载与
「插件自身命令行构造器下载 1MiB 逐字节核对」的集成冒烟全部通过；六轮迭代
（缺 Security.framework → 断言名单 → 落盘目录被 `cd` 拖进 `$WORK` 随 trap 删除 →
绝对路径下的 `require('./…')`）的修复全部带实测注释进脚本，详见 CHANGELOG 1.7.0。

**1.7.0 的落地方式**（`scripts/build-aria2-darwin.sh` + `publish.yml` 的
`binaries-darwin` job）：

- **源码锚定**：aria2 1.37.0 官方 release tarball，SHA256
  `a75c8534902ff1a64a23d7a47c033032329002553634251a89d53a9cb8b20efa`
  （2026-10-31 从官方 release 取回自算），构建前核对，不匹配立即失败；
- **构建环境**：GitHub 官方 macOS runner 原生构建（`macos-15` = Apple Silicon，
  `macos-15-intel` = Intel，不交叉编译）。runner 标签有生命周期（`macos-13/14`
  已退役，见 <https://github.com/actions/runner-images/blob/main/README.md>，
  2026-10-31 核对）—— 这是选择当前标签的依据，也是这个子包比 win/linux 多出来的
  一项真实维护负担，如实在此记录；
- **可复现与可核验**：构建配置全部写死在脚本里（openssl 静态归档为 TLS 后端，
  与 win/linux 平台一致；metalink / SFTP / SQLite / libz 等本插件用不到的组件
  全部关闭）；产物断言 `otool -L` 动态依赖**只有系统库**（链进 brew 路径的
  二进制在用户机器上无法运行 —— FerroDownload 候选的第 3 条否决理由由此收口）；
  `actions/attest-build-provenance` 给产物签发 SLSA provenance（第 2 条「构建
  证明 404」由此收口）；发布方就是本仓库自己的 CI（第 1 条「发布方不可信」
  由此收口）；
- **签名口径**：ad-hoc 签名（arm64 内核要求至少 ad-hoc 才能运行；npm 安装路径
  不产生 Gatekeeper quarantine 属性，无公证需求）。

`PATH` 查找（1.5.0 起）保留不变：子包未安装（旧版本插件、镜像源未同步）时，
`brew install aria2` 的 `aria2c` 经 `--version` 验证后仍会被采用。**`PATH` 上的
aria2 是用户自行安装、非本项目分发的二进制**，项目不校验它的来源或哈希；随包
二进制才有发布前的核对。这一点是信任边界，不是兼容性差异。

升级 aria2 版本时：改构建脚本与子包的版本 pin、跑一次
`.github/workflows/spike-darwin.yml`（手动触发，不发布），再走正常发布流程。

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
| `1.1.0` ~ `1.4.6` | ✅ 通过 | 已发布版本 |
| `1.5.0` | ✅ 通过 | 当前版本 |

因此 0.4.0 的用户升级后即可恢复；0.4.1 ~ 1.0.1 的用户在 0.2.0 上本来就能用，
升级到 1.5.0 可拿到通用摘要校验、`ifExists`、磁盘预检、服务器文件名与 `PATH` aria2 支持。

### 包管理器要求

npm 与 pnpm 都可以，但**必须支持 `optionalDependencies` 的 `os` / `cpu` 过滤**
（npm 7+ / pnpm 6+ 均支持）。极老的镜像源可能没有同步这四个随包子包，表现为
「在四个随包平台上装完一直走 curl」；切回官方 npm 源重装即可，具体排查见
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
>
> ⚠️ **不要在这个 profile 的目录里手跑 `pnpm install` / `npm install`。** 不只是「会被拒绝」——
> profile 的 `package.json` **不声明** DSH 的核心包（`@deepseek-ai/dsh-session`、`dsh-tools`、
> `dsh-llm` 等 9 个），它们在 pnpm 眼里是「多余的包」，一次手跑 install 就会把它们 prune 掉。
> 后果是 **DSH 启动即崩溃**（`N required plugin did not activate`，几十个插件在等
> `sessions` / `tools`），且**所有工具调用都不会返回结果**。完整症状与恢复步骤见
> [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#在-desktop-profile-里手跑-pnpm--npm-install-后dsH-启动即崩溃)。

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

## 运行时依赖（`1.7.0` 起）

主包新增一个**普通**运行时依赖：`undici`（`^7`）。为什么必须引入：探测走显式
代理需要 undici 的 `ProxyAgent`，而 Node 没有把内置 undici 的这个类暴露出来
（没有 `node:undici` 模块）。版本选择：`undici@8` 要求 Node `>=22.19.0`，
与插件声明的 engines `>=22.0.0` 冲突，因此固定在 `^7`（engines
`>=20.18.1`，同时兼容 Node 22 与 24）。纯 JS 依赖、无传递依赖、不参与
`optionalDependencies` 的平台过滤 —— 安装面与原有依赖一致。

## 二进制子包版本

六个子包版本号统一为 **`1.37.0`**，与它们打包的 aria2 版本一致（不是本插件的版本）。
主包通过 `optionalDependencies` 精确 pin 到该版本，避免「主包升级了、子包还是旧二进制」
这类错配。

子包内的二进制哈希在发布前由 CI 校验，来源与压缩包 SHA256 见 README 的
「第三方组件声明」一节。

## 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) —— 内部结构与决策表
- [SECURITY.md](./SECURITY.md) —— 五层防护与威胁模型
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) —— 症状 → 原因 → 处理
- [REVIEW-1.0.md](./REVIEW-1.0.md) —— 1.0 代码审查记录
