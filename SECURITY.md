# 安全策略 / Security Policy

## 支持的版本

只有 **最新发布版本** 接收安全修复。本插件目前的最新版本见
[CHANGELOG.md](./CHANGELOG.md) 顶部的条目，或 npm 上的
`@leisureyu/dsh-smart-dl`。

## 报告漏洞

**请不要在公开 issue 里披露可利用细节。** 请用 GitHub 的
[private security advisory](https://github.com/LeiSureYu/dsh-smart-download/security/advisories/new)
私密报告。

报告时请尽量附上：

1. 复现步骤（具体命令、传入的 `url` / `output`）
2. 实际输出与期望输出
3. 平台、Node 版本、插件版本
4. 如果属于「退出码 0 但结果不对」，务必说明产物错在哪（大小、内容、路径）

这类静默失败是本插件最关注的缺陷类型。

## 完整安全模型

威胁模型、四层防护、权限清单、已知边界与每一层的实测复现，见
[docs/SECURITY.md](./docs/SECURITY.md)。

## 范围

在范围内：

- 协议白名单 / 文件名净化被绕过（`src/url.ts`）
- 写到 `output` 之外、或覆盖不该覆盖的文件
- 镜像前缀绕过白名单，或镜像返回脏数据却报成功
- 续传指纹判定错误（`src/resume.ts`）
- 子进程参数注入、取消不生效、进程泄漏（`src/downloader.ts`、`src/progress.ts`）
- 「下载失败却返回 success」的任何路径

不在范围内：

- 镜像服务器自身的行为（第三方中转，插件不控制；不要用它下敏感文件）
- 随包 `aria2c.exe` 未做代码签名触发的杀毒误报（见
  [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)）
- 需要攻击者已经能在本机执行代码的场景

## 披露节奏

收到报告后会先确认能否复现，再评估影响范围。修复发布前不会公开细节；
修复发布后，如报告人同意会在 advisory 里致谢。

---

**English.** Only the latest release receives security fixes. Report privately via GitHub
security advisories — do not open a public issue with exploit details. Include reproduction
steps, actual vs expected output, platform/Node/plugin versions, and for "exit code 0 but
wrong result" bugs, what exactly was wrong with the artifact. See
[docs/SECURITY.md](./docs/SECURITY.md) for the full threat model.