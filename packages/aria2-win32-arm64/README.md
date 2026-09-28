# @leisureyu/dsh-aria2-win32-arm64

为 **Windows arm64** 平台预打包的 [aria2](https://aria2.github.io/) `aria2c.exe` 二进制文件，作为 `dsh-smart-dl` 插件的随包依赖分发，使用户无需自行安装 aria2。

- 版本：aria2 **1.37.0**
- 平台：`win32` / `arm64`
- 二进制路径：`bin/aria2c.exe`

## 二进制来源

aria2 官方发布页只提供 Windows x64 与源码包，**没有** Windows arm64 的官方二进制。本子包使用第三方构建：

```
https://github.com/minnyres/aria2-windows-arm64/releases/download/v1.37.0/aria2_1.37.0_arm64.zip
```

- 压缩包 SHA256：`33C775256F64123515F32A8252200EF2AB5AD72963981C694DFF5E61D650F6BE`
- 二进制：`aria2c.exe`，PE32+ **ARM64**，仅依赖系统 DLL（KERNEL32 / WS2_32 / CRYPT32 / bcrypt / api-ms-win-crt-*），无需额外 mingw 运行时。

由 CI（`.github/workflows/publish.yml`）下载并复制到 `bin/aria2c.exe`，**不提交到 Git 仓库**。本地开发时请按主仓库 README 的说明手动放置该文件。

## 许可证

aria2 基于 **GPL-2.0-or-later** 许可，本子包同样声明为 `GPL-2.0-or-later`。详见 <https://github.com/aria2/aria2/blob/master/COPYING>。
