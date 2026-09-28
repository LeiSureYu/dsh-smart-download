# @leisureyu/dsh-aria2-linux-x64

为 **Linux x64** 平台预打包的 [aria2](https://aria2.github.io/) `aria2c` 二进制文件，作为 `dsh-smart-dl` 插件的随包依赖分发，使用户无需自行安装 aria2。

- 版本：aria2 **1.37.0**
- 平台：`linux` / `x64`
- 二进制路径：`bin/aria2c`

## 二进制来源

aria2 官方发布页**不提供** Linux 二进制，本子包使用第三方静态构建（musl 静态链接，无 glibc / 动态库依赖，可跨发行版直接运行）：

```
https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-x86_64-linux-musl_static.zip
```

- 压缩包 SHA256：`80E577DC58348B96DA46DD12D326BC99794B5021BE395A3E890F2D67C8790C22`
- 二进制：`aria2c`，ELF **x86-64**，静态链接。

由 CI（`.github/workflows/publish.yml`）在 **Linux** runner 上下载、`chmod 755` 后复制到 `bin/aria2c`，**不提交到 Git 仓库**。

> 为什么必须在 Linux 上打包：npm 打包时会记录文件的执行位，在 Windows 上打包会把 `aria2c` 记为 `0644`（不可执行），安装后无法直接调用。

## 许可证

aria2 基于 **GPL-2.0-or-later** 许可，本子包同样声明为 `GPL-2.0-or-later`。详见 <https://github.com/aria2/aria2/blob/master/COPYING>。
