# @leisureyu/dsh-aria2-darwin-arm64

为 **macOS arm64（Apple Silicon）** 平台预打包的 [aria2](https://aria2.github.io/) `aria2c` 二进制文件，作为 `dsh-smart-dl` 插件的随包依赖分发，使用户无需自行安装 aria2。

- 版本：aria2 **1.37.0**
- 平台：`darwin` / `arm64`
- 二进制路径：`bin/aria2c`

## 二进制来源

与 win32 / linux 子包不同，aria2 官方**不发布** macOS 二进制，第三方候选又过不了可信门槛（逐个来源的核对结论见主仓库 `docs/COMPATIBILITY.md` 与 `docs/PLAN-P2-PLATFORM.md`）。本子包的二进制由**本仓库自己的 CI** 从官方源码构建：

- 源码：`https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2`
- 源码 SHA256：`a75c8534902ff1a64a23d7a47c033032329002553634251a89d53a9cb8b20efa`（构建前核对，任何不匹配立即失败）
- 构建脚本：`scripts/build-aria2-darwin.sh`（跑在 `macos-15` runner 上，Apple Silicon 原生构建，非 Rosetta）
- 构建配置：openssl 静态归档链入（TLS 后端与 win/linux 平台一致）；metalink / SFTP / SQLite / libz 等本插件用不到的组件全部关闭；`otool -L` 断言动态依赖**只有系统库**（链接进 brew 路径的二进制在用户机器上无法运行）
- 签名：ad-hoc（本机可运行；npm 安装路径不经过 Gatekeeper，无公证需求）
- 每次发布的工作流与提交一一对应，可复现：同一段脚本、同一份 pin 过的源码

由 CI（`.github/workflows/publish.yml` 的 `binaries-darwin` job）构建并复制到 `bin/aria2c`，**不提交到 Git 仓库**。本地开发时请按主仓库 README 的说明手动放置该文件。

## 许可证

aria2 基于 **GPL-2.0-or-later** 许可，本子包同样声明为 `GPL-2.0-or-later`。详见 <https://github.com/aria2/aria2/blob/master/COPYING>。
