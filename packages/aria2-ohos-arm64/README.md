# @leisureyu/dsh-aria2-ohos-arm64

为 **HarmonyOS / OpenHarmony arm64** 平台预打包的 [aria2](https://aria2.github.io/) `aria2c` 二进制文件，作为 `dsh-smart-dl` 插件的随包依赖分发，使用户无需自行安装 aria2。

- 版本：aria2 **1.37.0**
- 平台：`ohos` / `arm64`（目标三元组 `aarch64-linux-ohos`）
- 二进制路径：`bin/aria2c`

> **⚠️ 本子包尚未发布（1.9.1）。** 主插件自 1.9.1 起在代码里认识
> `process.platform === 'ohos'` 并预留了本子包的解析路径，但构建配方还在
> 落地途中；在那之前鸿蒙上由 PATH 上的 `aria2c` 或 `DSH_SMARTDL_ARIA2_PATH`
> 提供多线程，缺省回退 curl 单线程。现状与计划见主仓库
> [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md) 的 HarmonyOS 一节。

## 二进制来源（计划）

aria2 官方发布页不提供 OHOS 二进制，第三方也没有可核对来源的候选；与 darwin
子包（1.7.0 起）同一信任模型：**由本仓库 CI 用 OpenHarmony SDK 的原生工具链
（target `aarch64-linux-ohos`）从官方源码构建**，产物附 SLSA provenance。
HarmonyOS NEXT 内核不是 Linux，linux-arm64 的 musl 静态二进制**不能**复用，
这是独立子包存在的理由。

由 CI（`.github/workflows/publish.yml`）构建、`chmod 755` 后复制到 `bin/aria2c`，
**不提交到 Git 仓库**（本目录当前的 `bin/` 仅有占位文件）。

> 为什么必须在 Linux 上打包：npm 打包时会记录文件的执行位，在 Windows 上打包会把 `aria2c` 记为 `0644`（不可执行），安装后无法直接调用。

## 许可证

aria2 基于 **GPL-2.0-or-later** 许可，本子包同样声明为 `GPL-2.0-or-later`。详见 <https://github.com/aria2/aria2/blob/master/COPYING>。
