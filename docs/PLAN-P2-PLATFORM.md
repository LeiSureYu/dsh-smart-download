# P2 平台与协议扩展可行性（macOS / FTP / BitTorrent）

> 本文是 1.3 路线图 P2「扩展生态支持」的可行性论证，不是实施方案的承诺。
> 用户对 P2 的原话是「**探索**」，因此本文把「不做」与「做」摆在同等位置：
> 只要依据充分，**「仍然做不到」是合格结论**。
>
> - 全文只做调研与结论，**不修改任何源码**。
> - 所有外部结论均给出**来源 URL** 与**核对时间**（2026-10-12，Asia/Hong_Kong）。
> - 无法确证的标注 **「待确证」**。
> - 相关既有文档：[COMPATIBILITY.md](./COMPATIBILITY.md)（macOS 搁置原因）、
>   [SECURITY.md](./SECURITY.md)（五层防护）、[ARCHITECTURE.md](./ARCHITECTURE.md)（决策表与模块职责）。

## 0. 结论速览

| 需求 | 建议 | 一句话依据 |
| --- | --- | --- |
| macOS 支持（随包 aria2） | **不做**（维持现状） | 今天仍无可核对哈希的**可信** macOS 二进制来源。注意：**「不存在 macOS 二进制」这个说法是不准确的** —— 存在一个带发布方 SHA256 的 x64/arm64 候选（FerroDownload），但它在发布方可信度、构建证明、可复现性三条上全不满足，见 §A.2 ⑤ 与 §A.3 |
| FTP 下载 | **不做** | 放开白名单后，五层防护里只剩第五层（`sha256`）有效，而它是可选的；FTP 下**默认无防护** |
| BitTorrent 下载 | **不做进 `smart_download`**；若要探索，做**独立工具** | BT 与 HTTP 的威胁模型、进度/校验/续传语义**没有一层可以复用**，塞进来会把现有防护的契约表整体作废 |
| SFTP 下载 | **不做** | 与 FTP 同类问题，且引入 libssh2 依赖面 |

**macOS 唯一未排除的路径是「自建」**（在 GitHub Actions macOS runner 上从官方源码编译）。
它不是「补个子包」，而是**新增长期维护负担**（§A.6）。

---

# A. macOS 支持

## A.1 现状与待核实的结论

[COMPATIBILITY.md](./COMPATIBILITY.md) 第 29-42 行写明 macOS 搁置的原因是三条：

1. aria2 官方不发布 macOS 二进制；
2. 现有第三方 macOS 构建没有可核对的发布哈希，且需要按 Intel / Apple Silicon 分包；
3. Homebrew 的 `aria2` 属于用户环境依赖，不能假设存在，也不该由插件代管。

**任务要求核实「今天是否仍然成立」。下面逐条实测。**

## A.2 来源逐个核对（核对时间 2026-10-12）

### ① aria2 官方发布页（`aria2/aria2`）—— 官方，但**没有 macOS**

- 来源：<https://api.github.com/repos/aria2/aria2/releases?per_page=5>
  （人类可读页面：<https://github.com/aria2/aria2/releases>）
- 核对结果：最新版 `release-1.37.0`（发布 2023-11-15）的资产**只有 6 个**：
  `aria2-1.37.0-aarch64-linux-android-build1.zip`、`aria2-1.37.0-win-32bit-build1.zip`、
  `aria2-1.37.0-win-64bit-build1.zip`、`.tar.bz2` / `.tar.gz` / `.tar.xz`。
  **没有任何 darwin / macOS / osx 资产。**
- 官方最后一次发 macOS 包是 `release-1.35.0`（发布 2019-10-06），资产为
  `aria2-1.35.0-osx-darwin.dmg`（2,202,132 B）与 `aria2-1.35.0-osx-darwin.tar.bz2`（1,953,763 B）。
  `release-1.36.0`（2021-08-21）与 `release-1.37.0` 均**不再提供** macOS 资产。
- **该 1.35.0 的 macOS 包没有官方 SHA256**：发布正文
  （<https://api.github.com/repos/aria2/aria2/releases/tags/release-1.35.0> 的 `body`）只有
  「Release Note / Changes」条目，没有校验和清单；GitHub API 的资产 `digest` 字段对这两个
  2019 年的旧资产返回**空值**（新的 `release-1.37.0` 资产同样没有 `digest`）。
- 判定：**官方来源可信，但（a）版本落后两代、（b）仅 x86_64、（c）无官方摘要**。
  「官方」在这里帮不上忙 —— 本项目要的是「可核对的哈希」，而官方从未为 macOS 包提供摘要。

### ② abcfy2/aria2-static-build（**本项目现用的 Linux 来源**）—— 可信，但**不产 macOS**

- 来源：<https://api.github.com/repos/abcfy2/aria2-static-build/releases?per_page=4>
  与 <https://raw.githubusercontent.com/abcfy2/aria2-static-build/master/.github/workflows/build_and_release.yml>
- 核对结果：`1.37.0` 与 `continuous` 两版的资产全部是 `*-linux-musl_static.zip` 与
  `*-w64-mingw32_static.zip`；工作流文件里三个 job 全部 `runs-on: ubuntu-latest`。
  **不产出任何 darwin 目标。**
- 判定：发布方可信（本项目已在用），但**覆盖面不含 macOS**。

### ③ dmesg00/aria2-static-builds（735★，社区最知名的静态构建）—— 可信，但**不产 macOS**

- 来源：<https://api.github.com/repos/dmesg00/aria2-static-builds>
- 核对结果：仓库描述明写 `aria2 static builds for GNU/Linux & Windows (with OpenSSL).`；
  `v1.37.0`（发布 2025-08-07）的 11 个资产为 linux-gnu 32/64/arm 的
  `.deb` / `.rpm` / `.tar.bz2`、win-32/64 的 `.7z` 与 `ca-certificates.crt`。**无 darwin。**
- 判定：可信但**不覆盖 macOS**。

### ④ Homebrew `aria2` 1.37.0 revision 3 —— 有官方 SHA256，但**只覆盖 Apple Silicon 且非自包含**

- 来源：<https://formulae.brew.sh/api/formula/aria2.json>
- 核对结果：
  - `version=1.37.0`、`revision=3`、`license=GPL-2.0-or-later`；
  - bottle 的 SHA256 **有**，但文件键**只有**
    `arm64_golden_gate` / `arm64_tahoe` / `arm64_sequoia` / `arm64_linux` / `x86_64_linux`
    —— **没有任何 `x86_64_*` 的 macOS bottle**。也就是说 Homebrew 这一侧**只覆盖 Apple Silicon**。
  - 依赖：`c-ares, libssh2, openssl@4, sqlite, gettext`（另 `build_dependencies: pkgconf`）。
- 判定：发布方（Homebrew）可信、**哈希可核对**，但三条都不满足本项目的分发条件：
  (a) 覆盖不了 macOS x64；(b) 是**动态链接、带 5 个依赖**的可执行文件，不是自包含二进制，
  用户环境里缺 `openssl@4` 等任一依赖即无法运行；(c) 属用户环境依赖 ——
  COMPATIBILITY.md 已明确「不能假设存在，也不该由插件代管」，而 keg-only 的
  `openssl@4` / `gettext` 依赖链恰恰是「代管」的反面。

### ⑤ FerroDownload/aria2-static-builds —— **本次唯一带哈希的 macOS 候选，但过不了可信门槛**

这是本轮调研最重要的新发现，必须如实记录：**它确实提供了 macOS x64 与 arm64 的 aria2 1.37.0**。

- 来源：<https://api.github.com/repos/FerroDownload/aria2-static-builds/releases?per_page=3>
- 核对结果（`v1.37.0`，发布 2026-06-20，12 个资产）：

  | 资产 | 大小 | 发布方给出的 SHA256 |
  | --- | --- | --- |
  | `aria2c-1.37.0-macos-x64` | 4,056,152 B | `c96de7025d9c4fba2e2607a979d61d154a2ec66b110f6dedfbf9d78a3f6ab0ee` |
  | `aria2c-1.37.0-macos-arm64` | 4,221,960 B | `47f4f54095e2bde1774c344dc376d1c84d92c4bcff90eed4117055091e197dd2` |

  - 每个二进制都配一个同名 `.sha256` 文件（已下载核对，内容与上表一致）；
  - GitHub API 的资产 `digest` 字段同样给出 `sha256:` 前缀的摘要，**与 `.sha256` 文件一致**；
  - 构建方式（`.github/workflows/aria2.yml`，<https://raw.githubusercontent.com/FerroDownload/aria2-static-builds/HEAD/.github/workflows/aria2.yml>）：
    从 `https://github.com/aria2/aria2.git` 以 `--branch release-${ARIA2_VERSION} --depth 1` 克隆**官方源码**，
    macOS 侧 `brew install autoconf automake c-ares expat gettext libtool pkg-config sqlite zlib` 后
    `./configure --with-appletls --without-openssl …` 编译，构建后跑 `aria2c --version` 断言
    `BitTorrent` / `HTTPS` / `Metalink` / `AppleTLS` 均启用，再生成 `SHA256SUMS`。

- **为什么仍然判定「过不了可信门槛」**（这不是「没有哈希」，而是**哈希之外的可信性**不足）：

  1. **发布方可信度极低**：仓库 `created=2026-06-20`、`stargazers_count=0`、
     `license=null`（无许可证声明）、无 homepage、只有 1 次 release。
     一个刚创建、零关注、无许可证的个人仓库，作为**随 npm 包分发的可执行文件**来源，
     不满足本项目对 Windows arm64（`minnyres`）与 Linux（`abcfy2`）来源所隐含的标准。
  2. **二进制与源码之间没有可核验的绑定**：GitHub 的构建证明
     （`GET /repos/FerroDownload/aria2-static-builds/attestations/<digest>`）对这两个摘要
     均返回 **404 Not Found**（实测）。也就是说，**没有任何签名证明「这个二进制确实由这份
     workflow 从这份源码构建出来」**。哈希只证明「我这次下到的和上次下到的一样」，
     不证明「它是官方源码构建的」。
  3. **构建不可复现、不可在 CI 上复核**：工作流是 `workflow_dispatch` 手动触发，
     `ARIA2_VERSION` 是输入参数，**没有 pin 源码 commit**（只按 tag 克隆）；
     构建依赖 `brew install` 取当时最新版本（未固定版本号）；没有设置
     `SOURCE_DATE_EPOCH` 之类的可复现构建变量。结果是**无法重跑一次构建并比对哈希**——
     而「能否在 CI 上复核」正是任务要求核对的一条。
  4. **产物形态不利**：macOS 无法完全静态链接（工作流注释自己写了这句），
     因此这两个 4MB 的文件是**动态链接**的，HTTPS 走 `--with-appletls`（Apple SecureTransport）
     而非 OpenSSL。它比 Homebrew 的版本好（不依赖 `openssl@4` 等 brew 包），但仍是
     「非自包含 + 依赖宿主系统库版本」，与本项目现有四个子包（musl 静态 / 官方发布包）的形态不一致。

- 判定：**存在候选，但结论不变 —— macOS 仍然不做。** 若要采用它，本项目就得接受
  「从一个零 star、无许可证、无构建证明、不可复现的个人构建取可执行文件」，
  这正是 COMPATIBILITY.md 当初拒绝放宽的那条线。**放宽这条线去换「有产出」，是本轮明确禁止的。**

### ⑥ `aria2/aria2` Discussion #2296 —— 需求真实存在，且**至今无官方方案**

- 来源：<https://github.com/aria2/aria2/discussions/2296>
  （API：<https://api.github.com/repos/aria2/aria2/discussions/2296> 及其 `/comments`）
- 核对结果：标题 `Apple macOS binary version of Version 1.37 ?`，创建于 2025-04-16，
  最后更新 2026-06-23，**只有 1 条回复**；回复者指向 `FerroDownload/aria2-static-builds`
  （即上面 ⑤ 那个 0 star 仓库）。
- 判定：说明 (a) 该需求一年半来有人提、无人满足；(b) 官方没有计划发 macOS 二进制；
  (c) 社区能给出的最好答案就是 ⑤。

### ⑦ 其他个人仓库 —— **待确证**，不逐个深挖

搜索还命中一批声称提供 macOS 构建的小仓库，例如
`honify/aria2c-macos-static`（1★，最后推送 2026-02-05，无描述）
与若干 0★ 仓库。按「不为了有产出而放宽可信标准」的原则，**本轮不逐个深挖**：
它们与 ⑤ 同类（个人仓库、无可核验的构建证明），即使能下到也不改变结论。
**标注：待确证。**

## A.3 macOS 结论

> **现在能不能做？——不能。卡在「没有可核对哈希的**可信**二进制来源」这一条上。**
> 与 COMPATIBILITY.md 的搁置理由**一致**，且今天的证据比当初**更强**：
> 官方从未为 macOS 包提供摘要，官方 macOS 资产停在 2019 年的 1.35.0，
> Homebrew 只覆盖 Apple Silicon，而唯一带哈希的第三方候选（⑤）
> 在发布方可信度、构建证明、可复现性三条上**全不满足**。

**卡点的准确表述（这一点必须写清楚，避免被读成「根本没有 macOS 二进制」）：**

| 说法 | 是否成立 |
| --- | --- |
| 「没有 macOS 二进制」 | ❌ **不成立**。⑤ 的 FerroDownload 提供了 1.37.0 的 macOS x64 与 arm64，且发布方公布了 SHA256 |
| 「没有**可核对哈希的** macOS 二进制」 | ❌ **也不成立**。⑤ 的哈希可核对（`.sha256` 文件 + GitHub `digest` 字段，两处一致） |
| 「没有**可信**的 macOS 二进制来源」 | ✅ **成立**。哈希只解决「传输是否被篡改」，⑤ 缺的是**来源可信性**与**二进制↔源码的可核验绑定**（attestation 实测 404、构建不可复现、发布方 0★ 无许可证） |

也就是说，**卡点不在「找不到文件」，而在「找不到可以据以背书的来源」**。这个区别决定了：
如果将来有人愿意为 macOS 构建链背书（或用户明确接受这一风险），A.4 的自建路径是**唯一**不依赖第三方信任的出路。


补充两点必须一起记下的判断：

- **「有哈希」不等于「可信」。** ⑤ 的教训是：`.sha256` 文件、GitHub 的 `digest` 字段、
  甚至一段看起来正规的 workflow，都**不能替代**「发布方可信 + 二进制与源码有可核验绑定」。
  哈希只解决「传输是否被篡改」，不解决「来源是否可信」。
- **x64 与 arm64 都要有，不能只做一半。** ⑤ 两个架构都提供了，Homebrew 只覆盖 arm64。
  只覆盖 arm64 会让 Intel Mac 用户看到「装了子包但没有加速」——正是本项目反复强调的
  「静默降级」形态，比明确不支持更糟。

## A.4 如果坚持要 macOS：唯一未排除的路径是自建

### A.4.1 可行性：**技术路径存在**（已核实 runner 存在）

- 来源：<https://github.com/actions/runner-images/blob/main/README.md>
  与 <https://api.github.com/repos/actions/runner-images/contents/images/macos>
- 核对结果：GitHub 官方 runner 镜像**同时提供 Intel 与 Apple Silicon 的 macOS runner**：

  | 镜像 | 架构 | 标签（摘自 README） |
  | --- | --- | --- |
  | macOS 15 | x64 | `macos-15-large`、`macos-15-intel` |
  | macOS 15 Arm64 | arm64 | `macos-15`、`macos-15-xlarge` |
  | macOS 26 | x64 | `macos-latest-large`、`macos-26-intel`、`macos-26-large` |
  | macOS 26 Arm64 | arm64 | `macos-latest`、`macos-26`、`macos-26-xlarge` |

  注意：**macOS 14 的镜像已进入废弃流程**（README 标注 deprecated，指向
  <https://github.com/actions/runner-images/issues/13518>：2026-07-06 起开始废弃、
  2026-11-02 后完全不受支持）。若要自建，**必须选 `macos-15-intel` 与 `macos-15`/`macos-26`
  这一代标签，不要绑 `macos-14`**，否则会踩上「runner 被下架、发布流水线突然失败」的坑。
- 源码可自官方 tarball 取得：`aria2-1.37.0.tar.xz`（1,705,256 B）在 ① 的发布页上，
  这是官方来源，且**可以用官方发布的 tarball 摘要做输入固定**（待确证：官方是否为源码包
  提供摘要文件；本轮只确认了资产存在与大小，未确认摘要，见 §A.5）。

### A.4.2 但这不是「补个子包」，而是**新增长期维护负担**

现有四个子包的维护模式是：**从第三方取现成二进制 → 校验压缩包 SHA256 → 原样分发**。
自建 macOS 会把这一模式换成完全不同的形态：

| 维度 | 现有四个子包 | 自建 macOS |
| --- | --- | --- |
| 上游 | 官方发布包 / 两个第三方静态构建 | 官方**源码**（自己编译） |
| 谁负责「二进制是对的」 | 上游发布方 + 我们核对哈希 | **只有我们自己** |
| 构建环境 | 无（只下载解压） | macOS runner + `brew install` 一整套工具链 |
| 产物依赖 | musl 静态 / 官方自包含 | **无法完全静态链接**（工作流注释亦承认），依赖宿主系统库 |
| 可复现性 | 上游哈希固定即可 | 需自己固定源码 commit、依赖版本、`SOURCE_DATE_EPOCH` |
| 失败模式 | 下载失败（易发现） | 构建成功但产物在用户机上不可用（**静默**） |
| 维护触发 | 上游发新版 | 上游发新版 + **runner 镜像废弃** + Xcode/工具链变更 |

最后一行尤其要注意：`macos-14` 的废弃流程说明 **macOS runner 标签是有生命周期的**。
自建意味着本项目从此要跟踪 runner 废弃公告、重新编译、重发子包 —— 这是**持续的**负担，
不是一次性的工程量。

## A.5 自建路径需要**先确证**的两件事

按任务要求列出。这两条**本轮未完成核实**（工具通道在核对过程中一度整体故障，
见文末「本轮工具限制」），因此明确标注为**待确证**，不得当作已成立的前提：

1. **macOS 上的依赖能否收敛到「不依赖用户环境」的形态。**
   需要确证：`--with-appletls`（Apple SecureTransport）能否在**不装任何 brew 包**的
   干净 macOS 上运行；`c-ares` / `expat` / `sqlite` / `zlib` 是静态链入还是动态依赖；
   产物的 `otool -L` 依赖清单是否只含系统库（`/usr/lib/*` 与 `/System/Library/*`）。
   若仍依赖 brew 提供的库，则与本项目「零配置」的承诺冲突，自建的价值会被大幅削弱。
2. **构建是否可复现，从而「能在 CI 上复核」。**
   需要确证：固定源码 commit + 固定依赖版本 + `SOURCE_DATE_EPOCH` 后，
   两次独立构建能否产出**逐字节相同**的二进制；若不能，则只能退化为
   「哈希固定本次产物」（类似 ⑤ 的做法），必须**明确承认这弱于现有四个子包的保证**，
   并说明如何在文档里向用户披露这一差异。

（另有一条相关但非阻塞的待确证项：官方是否为 `aria2-1.37.0.tar.xz` 提供可引用的摘要。）

## A.6 macOS 行动建议

- **1.3 不做 macOS。** 维持 COMPATIBILITY.md 的现状描述（「能用但不加速」），
  并把 §A.2 的六项核对结果作为**更新后的证据**补进该文档的「macOS 为什么搁置」一节，
  使搁置理由从「没找到」升级为「逐个来源核对后仍不成立，且列出唯一带哈希的候选为何被否」。
- **不建议在 1.3 启动自建。** 若未来要做，应作为**独立立项**，前置条件是 §A.5 两条全部
  确证为「是」，并在路线图里按「新增长期维护负担」而不是「补个子包」来估算工作量。
- 代码侧**无需任何改动**：`ARIA2_TARGETS` 不含 `darwin-*`，`getAria2Path()` 返回 `null`，
  `decide()` 回退 `curl` 并在 `reason` 里写明原因 —— 这条现状路径已经是正确的降级行为。

---

# B. FTP / BitTorrent（以及 SFTP）

## B.1 现状（读代码所得，非推断）

- `src/url.ts:18`：`export const SUPPORTED_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:'])`
  —— 协议白名单只放行 http/https。
- `src/url.ts:61-78`：`checkDownloadUrl()` 在**任何网络请求之前**执行，解析失败或不匹配直接返回
  `{ ok: false, reason }`，不进入探测、不进入下载。
- 该白名单有**实测依据**（README 第 277-282 行、SECURITY.md 第 20-27 行）：
  `0.4.1` 实测 `file:///C:/Windows/win.ini` 被 `curl` 接受并**成功把本地文件复制**到目标路径，
  问题恰恰出在「探测失败 → 回退 curl」这条兜底路径上；`1.0.0` 又实测 `mirror` 前缀能绕过白名单。
- aria2 本身原生支持 FTP / SFTP / BitTorrent / Metalink（来源：<https://aria2.github.io/>，
  核对时间 2026-10-12，页面原文列举 `HTTP/HTTPS, FTP, SFTP, BitTorrent and Metalink`，
  并称具备 DHT 等完整 BT 客户端特性）。

## B.2 放开白名单后，安全模型怎么变

### B.2.1 五层防护逐层失效情况

| 层（SECURITY.md） | 实现 | 放开 FTP 后 | 放开 BT 后 |
| --- | --- | --- | --- |
| 一、协议白名单 | `src/url.ts` | **必须重写**：不再是「只放行两个协议」，而要变成「按协议分派到不同的防护组合」 | 同左，且 `magnet:` 不是 `new URL()` 能给出 `http(s)` 语义的东西，`deriveFilenameFromUrl` 的前提（从 pathname 推导）直接不成立 |
| 二、文件名净化 | `src/url.ts` | 部分有效（FTP 路径同样可推导文件名） | **失效**：BT 的「文件名」来自 torrent 元数据，不来自 URL；且 torrent 内含**多文件**与目录结构，单段文件名模型不成立 |
| 三、续传指纹 | `src/resume.ts` | **失效**：FTP 没有 ETag / Last-Modified 语义（`MDTM` 是弱信号且非普遍支持），旁车指纹无基准可比 | **失效**：BT 的续传由分片状态与 `.aria2` 控制文件决定，没有「远端声明长度 + ETag」这组概念 |
| 四、落盘字节数校验 | `src/verify.ts` | **弱化/失效**：FTP 的 `SIZE` 是可选命令，很多服务器不返回，长度基准拿不到 → 退回 `skipped` 分支，也就是**没有校验** | **失效**：BT 的「长度」来自 torrent 元数据，且多文件；`assertIntegrity()` 的「单文件字节数 vs 远端声明长度」模型不适用 |
| 五、调用方给的 SHA-256 | `src/hash.ts` | **有效，但它是可选的** —— 调用方不传就没有这一层 | 部分有效：若提供 info-hash / 文件摘要可比对，但它与现有 `sha256` 参数的语义不同（BT 应校验 info-hash 或分片校验和） |
| 请求头注入防护 | `src/headers.ts` | 部分有效：`userAgent`/`referer` 对 FTP 无意义；`headers` 落到 aria2 的 FTP 路径上行为未验证 | 大部分无意义 |

**关键判断：放开 FTP 之后，默认路径上只剩第五层有效，而第五层是「调用方不传就没有」的。**
换句话说，**不传 `sha256` 的 FTP 下载在默认情况下没有任何内容校验** ——
这正好是本项目从 0.5.0 到 1.2.0 一直在修的那类「静默失败」的极端形态：
下载报告成功、产物无法证实。

### B.2.2 FTP 特有的问题

- **无完整性保证**：FTP 协议本身不提供内容校验（没有 Metalink、没有内容摘要协商）。
  长度是唯一可得的弱信号，而它恰恰是第四层已经实测证明「挡不住等长内容替换」的东西。
- **凭证面**：FTP 的 `user:password@host` 形态会把**明文凭证**放进 URL。而
  SECURITY.md「请求头注入」一节已经明确警告「凭证会出现在进程命令行里」——
  FTP URL 会把这个问题从「请求头」扩大到「URL 本身」，且 FTP 默认明文传输。
  要做就得同时设计凭证处理策略（拒绝、还是走环境变量），这是新的一套设计。
- **主动/被动模式与端口**：aria2 的 FTP 支持涉及数据连接（PORT/PASV），
  与「只发起 HTTP 出站请求」的权限清单（README「权限说明」）不一致，需要重写权限声明。

### B.2.3 BitTorrent 特有的问题（面完全不同）

- **DHT / PEX / 磁力链接**：`magnet:` 链接进入后，客户端会连接 DHT 网络、
  交换 peer 列表。这意味着插件的出站行为从「访问调用方给的那一个 URL」
  变成「**访问一张由陌生人给出的、不断变化的 peer 表**」。
  README 的权限承诺是「除原始 URL（或镜像前缀 + 原始 URL）外不访问其他地址」——
  这条承诺在 BT 下**无法维持**。
- **监听端口**：BT 需要（或被要求）监听入站端口。一个「只做出站 HTTP 请求、不监听任何端口」
  的插件与一个「打开监听端口、接受陌生连接」的插件，是两种不同性质的安全边界。
- **做种 / 上传**：aria2 作为 BT 客户端默认会**上传**（做种）。用户从「下载者」变成
  「分发者」，涉及上行带宽占用与（在部分司法辖区）内容分发的法律面。
  这必须由用户显式决定，不能作为 `smart_download` 的副作用发生。
- **进度与状态语义**：BT 的进度是「已下载/总大小 + 上传量 + peer 数」，
  现有 `parseAria2Summary`（`src/progress-parse.ts`）解析的是 HTTP 摘要行；
  进度面板（`src/client.js`）展示「文件名 / 百分比 / 速度 / 剩余时间」的四元组，
  在 BT 下缺 peer / 上传语义。要么扩展、要么另做。
- **取消与清理**：取消一个 BT 任务要处理 `.aria2` 控制文件与分片状态，
  与现有 `runProcess` 的 SIGTERM/SIGKILL 兜底（`src/downloader.ts:247-267`）不是一回事。

## B.3 现有「静默失败防护」契约表会怎样被破坏

README 第 461-492 行是一张**契约表**：每个「返回默认值」的路径都对应一条**正向断言**，
并明确写着「如果未来发现某条返回默认值的路径没有被正向信号断言覆盖，**那是一个 bug，不是设计**」。

放开 FTP / BT 会直接让其中至少五行的断言失去意义或需要重写：

| 契约项 | 为什么在 FTP/BT 下失效 |
| --- | --- |
| `probeUrl` | 「已知支持的 URL 必须返回 `supportsMultiThread: true`」—— FTP/BT 不经过 HEAD/Range 探测，该函数根本不参与 |
| `decide` | 「已知大文件必须返回 `method: 'aria2'`」—— FTP/BT 只有 aria2 一条路，没有 curl 回退，决策表的两档模型不成立 |
| `verifySize` | 「字节数一致必须返回 `ok`；chunked 截断必须判失败」—— FTP 长度基准常缺失、BT 是多文件，`skipped` 会变成**常态**而不是例外 |
| `checkDownloadUrl` | 「`file://` / `ftp://` 必须被拒绝」—— **这条断言本身就要被改写**，而它是第一层防护唯一的测试锚点 |
| `planResume` / 旁车指纹 | 「无法证实同源就删半包全量重下」—— FTP/BT 没有可比的「同源」概念 |

这正是「做独立工具」的核心理由：**不是嫌代码多，而是这些断言的价值在于它们绑定了一组
HTTP 特有的前提**。把它们在同一个函数里改成「按协议分支」，等于让每一条断言都要
同时覆盖两种语义，最终退化成「只要不报错就行」—— README 明确说过这等于
「重新打开静默失败的后门」。

## B.4 建议

### B.4.1 FTP：**不做**

依据：
1. 放开白名单后，默认路径上**只剩可选的第五层**有效（§B.2.1），即「不传 `sha256` 就没有内容校验」；
2. 第一层防护唯一的测试锚点（`checkDownloadUrl` 拒绝 `ftp://`）必须被改写，而它的价值来自
   0.4.1 那次「`file://` 真的把本地文件复制出去了」的实测 —— 放宽它的成本远大于收益；
3. FTP 明文凭证进 URL、涉及数据连接与端口，权限清单要重写（§B.2.2）；
4. **需求侧证据不足**：现有文档与 issue 里没有出现「用户要下 FTP」的实际场景；
   `aria2` 支持 FTP 不等于「用户需要这个插件下 FTP」。

### B.4.2 BitTorrent：**不做进 `smart_download`；若要探索，做独立工具**

依据：
1. **没有一层防护可以复用**（§B.2.1 表格）；BT 的威胁模型（DHT、peer、监听端口、做种）
   与 HTTP 的威胁模型（不可信 URL、镜像、等长替换）是两套不同的东西；
2. **现有权限承诺无法维持**：「除原始 URL 外不访问其他地址」在 BT 下必然被打破，
   而这条承诺写在 README「权限说明」里，是用户安装时读到的东西；
3. **契约表会被破坏**（§B.3），且修复方式不是「加分支」而是「另一套断言」；
4. **副作用性质不同**：做种会让用户成为分发者，这必须由用户显式选择。

如果未来要做，独立工具的最小形态应是：
- 独立工具名（例如 `bt_download`）、独立参数（`magnet` / `.torrent` 路径 / `outputDir`）；
- **独立的权限声明与威胁模型文档**（明确 DHT、端口、上传、以及「不提供内容校验」）；
- 明确的上传策略（默认 `--seed-time=0`，让「上传」成为显式选择而不是默认副作用）；
- 复用范围仅限「子进程执行 / 进度上报 / 取消」这些与协议无关的基础设施，
  **不**复用 `probe.ts` / `verify.ts` / `resume.ts` / `decision.ts` 的语义。

### B.4.3 SFTP：**不做**

与 FTP 同类（无完整性保证、凭证面、权限清单），且额外引入 `libssh2` 依赖面
（注意现有 aria2 构建是 `--without-libssh2`，见 §A.2 ⑤ 的工作流）。除非出现明确的
企业内网 SFTP 场景需求，否则没有理由做。

### B.4.4 需要在文档里明确写的「不做」

按团队要求「明确标注不做」，建议在 1.3 的路线图文档中单列一节，逐条写明：

| 不做项 | 一句话理由 |
| --- | --- |
| macOS 随包 aria2 | 无可核对哈希的**可信**二进制来源；唯一带哈希的候选无构建证明、不可复现、发布方零关注 |
| FTP 下载 | 默认路径上只剩可选的 `sha256` 一层有效，即默认无内容校验 |
| SFTP 下载 | 同 FTP，另加 `libssh2` 依赖面 |
| BT 进 `smart_download` | DHT/端口/做种的面与 HTTP 完全不同，且会打破现有权限承诺与契约表 |
| 自建 macOS 二进制（1.3 内） | 属新增长期维护负担，且 §A.5 两条前置条件未确证 |

---

# C. 来源清单（核对时间均为 2026-10-12，Asia/Hong_Kong）

| # | 来源 URL | 用于 |
| --- | --- | --- |
| 1 | <https://api.github.com/repos/aria2/aria2/releases?per_page=5> | 官方无 macOS 资产；1.35.0 是最后一个 macOS 包 |
| 2 | <https://api.github.com/repos/aria2/aria2/releases/tags/release-1.35.0> | 官方 macOS 包无 SHA256（`body` 无校验和、资产 `digest` 为空） |
| 3 | <https://api.github.com/repos/abcfy2/aria2-static-build/releases?per_page=4> | 现用 Linux 来源不产 darwin |
| 4 | <https://raw.githubusercontent.com/abcfy2/aria2-static-build/master/.github/workflows/build_and_release.yml> | 三个 job 全是 `ubuntu-latest` |
| 5 | <https://api.github.com/repos/dmesg00/aria2-static-builds> 及其 releases | 735★ 静态构建不产 darwin |
| 6 | <https://formulae.brew.sh/api/formula/aria2.json> | Homebrew 有 SHA256 但只有 arm64 macOS bottle；依赖 `c-ares/libssh2/openssl@4/sqlite/gettext` |
| 7 | <https://api.github.com/repos/FerroDownload/aria2-static-builds/releases?per_page=3> | 唯一带哈希的 macOS x64/arm64 候选（4,056,152 / 4,221,960 B） |
| 8 | <https://raw.githubusercontent.com/FerroDownload/aria2-static-builds/HEAD/.github/workflows/aria2.yml> | 其构建方式：官方源码 + brew + `--with-appletls`；无 attestation、未 pin commit |
| 9 | `GET /repos/FerroDownload/aria2-static-builds/attestations/<digest>`（实测 404） | 无构建证明 |
| 10 | <https://github.com/aria2/aria2/discussions/2296> | macOS 需求 2025-04-16 提出，至今 1 条回复 |
| 11 | <https://github.com/actions/runner-images/blob/main/README.md> | macOS runner 标签与架构；macOS 14 已废弃 |
| 12 | <https://github.com/actions/runner-images/issues/13518> | macOS 14 镜像废弃时间表 |
| 13 | <https://aria2.github.io/> | aria2 原生支持 FTP / SFTP / BT / Metalink 与 DHT |
| 14 | 仓库内：`src/url.ts`、`src/probe.ts`、`src/downloader.ts`、`docs/SECURITY.md`、`docs/COMPATIBILITY.md`、`docs/ARCHITECTURE.md`、`README.md` | 现状与既有防护依据 |

## 待确证清单（不得当作已成立）

1. 自建 macOS 时，产物能否做到**不依赖用户环境**（`otool -L` 只含系统库）—— §A.5 第 1 条。
2. 自建 macOS 时，固定 commit + 固定依赖 + `SOURCE_DATE_EPOCH` 后能否**逐字节可复现**—— §A.5 第 2 条。
3. 官方是否为 `aria2-1.37.0.tar.xz` 提供可引用的摘要（本轮只确认资产存在与大小）。
4. `honify/aria2c-macos-static` 等一批 1★ / 0★ 个人 macOS 构建**未逐个核对**；
   按「不放宽可信标准」原则不深挖，但如需穷尽来源应补齐。
   （注：`FerroDownload/aria2-static-builds` 已于本轮复核，见附录 D；此处指其余个人仓库。）
5. aria2 在 FTP 路径上对自定义请求头（`--header`）的实际处理行为未实测。

## 本轮工具限制（影响范围）

核对过程中工具通道曾整体故障（所有文件/命令/搜索工具返回
`cannot get required service "sessionProjections" in inactive context`），导致：

- §A.2 ⑤ 的二进制**只做了哈希层面的核对**（`.sha256` 文件内容与 GitHub API `digest` 一致），
  未下载二进制做 `otool -L` / `file` 实测，因此「动态链接、依赖系统库」的结论来自
  其 workflow 注释与产物体积，**属推断而非实测**，已在 §A.2 ⑤ 与待确证清单中标注；
- §A.5 的两条前置条件因此**未完成**，明确列为待确证。

除上述之外，本文所有外部结论均来自上表来源的实际请求结果。

---

# D. 独立复核记录（attempt 6，req-p0，核对时间 2026-10-12）

本节由接手该任务的 `req-p0` 追加，**不改变**上文的任何结论。目的：把上文的关键外部结论
**重新实际发请求核对一遍**，并补上一条上文标为「待确证」的项。所有请求均带
`User-Agent: dsh-smart-dl-audit`，核对时间 **2026-10-12**。

## D.1 已复现的结论（逐条对上文）

| 上文结论 | 复核方式 | 结果 |
| --- | --- | --- |
| 官方 1.37.0 无 macOS 资产（§A.2 ①） | `GET /repos/aria2/aria2/releases/tags/release-1.37.0` | ✅ 复现。资产恰好 6 项，全部为 win-32/64、aarch64-linux-android、三个源码包；**无 darwin**。`published_at=2023-11-15T12:07:32Z` |
| 官方最后 macOS 包是 1.35.0（§A.2 ①） | `GET /repos/aria2/aria2/releases/tags/release-1.35.0` | ✅ 复现。含 `aria2-1.35.0-osx-darwin.dmg`（2,202,132 B）与 `aria2-1.35.0-osx-darwin.tar.bz2`（1,953,763 B），`published_at=2019-10-06T01:43:25Z` |
| 官方资产无摘要（§A.2 ①） | 同上 + 1.37.0 全资产的 `digest` 字段 | ✅ 复现。1.37.0 的 6 项资产 `digest` **全部为空** |
| 官方 release 序列（§A.2 ①） | `GET /repos/aria2/aria2/releases?per_page=100` | ✅ 24 个 release；最近三个为 1.37.0(2023-11-15) / 1.36.0(2021-08-21) / 1.35.0(2019-10-06) |
| abcfy2 不产 darwin（§A.2 ②） | releases + `build_and_release.yml` | ✅ 复现。8 个资产全为 `*-linux-musl*` / `*-w64-mingw32*`；workflow 只有 `runs-on: ubuntu-latest`，编译跑在容器 `ghcr.io/abcfy2/musl-cross-toolchain-ubuntu:*` 里 |
| dmesg00 不含 darwin（§A.2 ③） | `GET /repos/dmesg00/aria2-static-builds/releases/tags/v1.37.0` | ✅ 复现。11 个资产为 linux-gnu 32/64/arm 与 win-32/64 + `ca-certificates.crt`，**无 darwin** |
| Homebrew 只覆盖 Apple Silicon（§A.2 ④） | `GET https://formulae.brew.sh/api/formula/aria2.json` | ✅ 复现。`version=1.37.0 revision=3`，依赖 `c-ares, libssh2, openssl@4, sqlite, gettext`；bottle 仅 `arm64_golden_gate / arm64_tahoe / arm64_sequoia / arm64_linux / x86_64_linux`，**无任何 `x86_64_*` 的 macOS bottle** |
| FerroDownload 提供 macOS x64+arm64 且带哈希（§A.2 ⑤） | `GET /repos/FerroDownload/aria2-static-builds` + `releases?per_page=3` | ✅ 复现。`stars=0`、`created=2026-06-20T01:28:29Z`、`license` 为空、`description` 为空；`v1.37.0`（`published_at=2026-06-20T23:30:25Z`）**12 个资产**，其中 `aria2c-1.37.0-macos-x64`（4,056,152 B，digest `sha256:c96de7025d9c…ab0ee`）与 `aria2c-1.37.0-macos-arm64`（4,221,960 B，digest `sha256:47f4f54095e2…7dd2`），与上文表格逐字节一致 |
| 无构建证明（§A.2 ⑤ 第 2 条） | `GET /repos/FerroDownload/aria2-static-builds/attestations/<digest>` ×2 | ✅ 复现。两个摘要**均返回 HTTP 404 Not Found** |
| Discussion #2296（§A.2 ⑥） | `GET /repos/aria2/aria2/discussions/2296` + `/comments` | ✅ 复现。标题 `Apple macOS binary version of Version 1.37 ?`，category `Q&A`，`created_at=2025-04-16`、`updated_at=2026-06-23`、`comments=1` |
| macOS runner 存在（§A.4.1） | `GET /repos/actions/runner-images/contents/images/macos` | ✅ 复现。存在 `macos-14` / `macos-14-arm64` / `macos-15` / `macos-15-arm64` / `macos-26` / `macos-26-arm64` / `xcode-27-arm64` 各 Readme，**x64 与 arm64 两类都在** |
| aria2 构建依赖链（§A.4.2） | `GET https://raw.githubusercontent.com/aria2/aria2/release-1.37.0/README.rst` | ✅ 复现。HTTPS 可用 `OSX(Secure Transport)` / GnuTLS / OpenSSL；另有 libssh2、libxml2 或 Expat、zlib、c-ares、libsqlite3、libnettle/libgcrypt |
| 仓库内无 FTP/BT 代码（§B.1） | `grep -n "ftp\|FTP\|torrent\|magnet\|bt-\|dht\|DHT\|seed\|metalink" src/` | ✅ 复现。**0 命中** |

## D.2 上文「待确证」中已解决的一项

上文 §A.2 ⑥ 与「待确证清单」第 4 项提到「回复者指向 FerroDownload」属未读正文的转述。
本轮**已读回复正文**，原文如下（`GET /repos/aria2/aria2/discussions/2296/comments`）：

> `oovz`，2026-06-23T04:24:31Z：
> *"I created static builds for x64 and aarch64 at [FerroDownload/aria2-static-builds](...)"*

→ **确认**：社区能给出的最好答案就是 §A.2 ⑤ 那个 0★、无许可证、无构建证明的仓库。
这条从「待确证」升级为**已核实**，且**强化**了 §A.3 的结论。

## D.3 需要提醒 captain 的一处表述差异（不影响结论）

captain 转达的调研摘要把第 ⑥ 项写成「回复者指向 `FerroDownload/aria2-static-builds`（**0 star** 个人仓库）」，
读起来像是该仓库**什么也没有**。**实际不是**：该仓库**确实提供** macOS x64 与 arm64 的
aria2 1.37.0，并公布了 SHA256（本轮已复现）。

正确表述应是：**「存在 macOS 二进制候选，且带可核对的哈希；但它过不了本项目的可信门槛」**，
而不是「没有 macOS 二进制」。本文 §0 与 §A.3 已按此修正。

**这个区别重要**，因为它决定了卡点的性质：
- 若卡点是「没有文件」→ 只能自建，别无他路；
- 若卡点是「来源不可信」→ **一旦有人（本项目自己，或某个有信誉的发布方）愿意为构建背书，问题就解了**。
  自建（§A.4）之所以是唯一出路，是因为它是**唯一能把「背书」放在本项目自己手里**的方案 ——
  而不是因为「外面根本没有二进制」。

## D.4 本轮复核未覆盖的部分

- §A.2 ⑤ 的二进制**未下载做 `otool -L` / `file` 实测**，因此「动态链接、依赖宿主系统库」
  这一条仍是**推断**（依据其 workflow 注释与 4MB 体积），与上文「本轮工具限制」一节的标注一致。
- §A.5 的两条前置条件（产物不依赖用户环境 / 逐字节可复现）**仍未确证** —— 需要真实 spike，本轮不写代码。
- 未逐个核对 `honify/aria2c-macos-static` 等 1★/0★ 个人仓库。

**本轮未修改任何源码。** 本轮对该文档的改动仅限：§0 表格一行、§A.3 增加一张「卡点准确表述」表、
以及本附录 D（新增）。

