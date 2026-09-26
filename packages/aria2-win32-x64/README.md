# @leisureyu/aria2-win32-x64

为 **Windows x64** 平台预打包的 [aria2](https://aria2.github.io/) `aria2c.exe` 二进制文件，作为 `dsh-smart-dl` 插件的随包依赖分发，使用户无需自行安装 aria2。

- 版本：aria2 **1.37.0**
- 平台：`win32` / `x64`
- 二进制路径：`bin/aria2c.exe`

## 二进制来源

`aria2c.exe` 来自 aria2 官方发布页：

```
https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip
```

由 CI（`.github/workflows/publish.yml`）下载并复制到 `bin/aria2c.exe`，**不提交到 Git 仓库**。本地开发时请按主仓库 README 的说明手动放置该文件。

## 许可证

aria2 基于 **GPL-2.0-or-later** 许可，本子包同样声明为 `GPL-2.0-or-later`。详见 <https://github.com/aria2/aria2/blob/master/COPYING>。
