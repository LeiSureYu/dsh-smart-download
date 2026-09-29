# 贡献指南 / Contributing

感谢愿意改进这个插件。本文件说明提交改动的方式，以及几条**不会妥协**的要求。

Thanks for improving this plugin. This file explains how to submit changes, and the few
requirements that are **not negotiable**.

## 环境

- Node.js **22+**、pnpm **9+**（CI 用 pnpm 9，本地可以更新）
- 不需要预先准备 aria2 二进制就能跑测试：测试不依赖真实网络，也不依赖随包二进制
- 想跑真实下载验证时，按 README「开发」小节的表格手动放置各平台二进制

## 流程

1. 从 `main` 切分支，命名 `feat/<主题>`、`fix/<主题>` 或 `docs/<主题>`
2. 改代码 + 加/改用例，本地跑通 `pnpm check` 与 `pnpm test`
3. 提交，message 用中文，形如 `fix(verify): 描述做了什么`
4. 开 PR 到 `main`，说明里写清「现象 / 根因 / 改法 / 实测证据」

CI（`.github/workflows/publish.yml` 的 `check` job）在 PR 上会跑 `pnpm check` → build → test，
红了不合并。

## 硬性要求

### 1. 禁止静默失败

这是本项目最重要的红线。**任何「返回默认值 / 跳过 / 回落到兜底路径」的分支，都必须有正向
断言**——断言它回落到了**哪一个具体值**，而不是断言「没抛异常」或「跑完了」。

反例（不接受的写法）：

```ts
// 只是确认调用没崩，等于没测
await verifySize({ ... })
```

正例：

```ts
// 断言跳过时返回的具体形态，以及原因文案里的具体字段
assert.deepEqual(result, { kind: "skipped", reason: "gzip" })
```

历史教训：`0.9.0` 之前「校验跳过」与「校验通过」共用同一个 `{ kind: 'ok' }`，在返回值里长得
一模一样，导致「退出码 0 但产物是坏的」查了很久才定位。详见
[REVIEW-1.0.md](./docs/REVIEW-1.0.md)。

### 2. 覆盖率数字只认一个来源

用 Node 自带的覆盖率：

```bash
node --test --import tsx --experimental-test-coverage "test/**/*.test.ts"
```

不要手搓 `NODE_V8_COVERAGE` —— 它在 Windows + tsx 下源码映射错位，会虚增函数个数，本项目
已经作废过一批这样的数字（见 CHANGELOG 的 0.9.0 条目）。

**必须在 LF 工作区测量。** V8 的行归属建立在对源码的字节偏移上：把同一份代码的行尾
改成 CRLF，报告出来的行百分比与未覆盖行号会整体漂移（
`index.ts` 的未覆盖行甚至从「有」变「无」）。`.gitattributes` 已把所有文本文件定为
LF 存储，检出后保持 LF 即可；不要用会改写行尾的编辑器设置。对照数据见
[REVIEW-1.0.md](./docs/REVIEW-1.0.md) 的「同一份代码，行尾一换」一节。

### 3. 不要「硬做」平台

某个平台缺可验证的 aria2 二进制时，正确做法是如实搁置并在文档里说明，不是塞一个没校验过
哈希的二进制进去。macOS 就是这么搁置的，见
[COMPATIBILITY.md](./docs/COMPATIBILITY.md)。

### 4. 性能参数要实测

并发数、`min-split-size`、大小阈值这类数字，必须在 PR 里给出实测数据（方法 + 前后对比）。
`-k 1M` 不能删：aria2 默认 `min-split-size=20M`，删掉后 `-x/-s` 会静默失效，
实测 8 MB 文件从 11.99 MB/s 掉回 1.61 MB/s。

## 不要提交的东西

临时脚本（`_patch-*.mjs`、`_probe-*.mts`）、`coverage.lcov`、`.pack-probe/`、
`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与 aria2 二进制都在 `.gitignore` 里。
打包产物走 CI，不要手动提交。

## 报告问题

- 普通 bug / 功能请求：用仓库 issue 模板
- 安全问题：走 private security advisory，见 [SECURITY.md](./SECURITY.md)

---

**English summary.** Branch from `main` as `feat/*`, `fix/*` or `docs/*`; keep commit messages
in Chinese in the form `fix(verify): ...`; open a PR and make sure the `check` CI job is green.
Non-negotiables: every fallback/skip/default path needs a positive assertion on the concrete
value it falls back to (no "it did not throw" tests); coverage numbers come only from
`node --test --experimental-test-coverage`; do not ship an unverified aria2 binary for a
platform — shelve it and say so; performance constants must come with measured before/after
data. Do not commit temporary scripts, coverage artifacts, lockfiles or binaries.