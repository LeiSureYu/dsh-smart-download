# AGENTS.md

给在本仓库里干活的 agent 的交接说明。**不随 npm 包发布**（`package.json` 的 `files`
只列了 dist / 指定的 docs / README / CHANGELOG / LICENSE）。

最后更新：2026-11-24（2.0.0 发布完成之后）。

---

## 1. 当前状态（先看这段，别按旧印象动手）

| 项 | 值 |
| --- | --- |
| 分支 | 2.0.0 的发布提交是 `efcdbdc`；`main` 头在它之后还有 docs 提交（`9b2f8a1`、`8cb4a1d`…）。
  **main 头 ≠ 发布 tag 指向的提交，属正常**，docs-only 提交不需要为新版本重新打 tag |
| 发布 tag | `v2.0.0`（轻量 tag）**指向 `efcdbdc`** |
| npm | `@leisureyu/dsh-smart-dl@2.0.0` 已发布，`dist-tags.latest` = `2.0.0` |
| GitHub Release | `v2.0.0` 已建（2026-11-23），target `main`、无附件；**这一步不在 CI 里**，见第 4 节 |
| 6 个二进制子包 | 仍是 1.37.x（各自独立版本号，早已发布；发布时会按“已存在”跳过，正常） |

2.0.0 的 tag 最初打在 `8be7b78`（那次 tag 流水线在 Test 步骤红了、什么都没发出去），
后来被 `git tag -f` 移到修复后的 `efcdbdc` 并强推，重跑发布成功。

**不要做的事**

- ❌ 不要从 `8be7b78` 重新打 tag 或重跑发布 —— 那是坏代码（下面第 3 节的三条都还在里面）。
- ❌ 不要把 `dist/` 当生成物忽略。它入库，改了 `src/` 必须重建后一起提交，否则仓库里的
  dist 会和源码不一致（npm 发布侧 CI 会自己 build，所以线上产物不受影响，但仓库会分叉）。
- ❌ 不要用 Node 22 跑全量测试：`progress.test.ts`、`false-failure.test.ts` 会大量
  `cancelledByParent`（unref 计时器 + 事件循环排空），那是**假红**。CI 用的是 Node 24。
- ❌ 不要直接 `pnpm check`（本地 pnpm 11 会因 `ERR_PNPM_IGNORED_BUILDS` 提前失败）。
  用 `npx -y pnpm@9 …`，或直接调底层命令（见第 4 节）。

---

## 2. 2.0.0 的三个修复提交（都已在 main）

### `f61f6c2` POSIX 上 daemon 存活绑定改用 `--stop-with-process`

`ensureDaemon` 原本传 `--stop-with-pid`，aria2 没有这个选项，进程立刻以
`aria2c: unrecognized option: stop-with-pid=<pid>` 退出 → `pollReady` 三次全超时 →
`DaemonUnavailableError`。后果不只是 4 条用例红：**Linux/macOS 上 RPC 路径一次都没真正
跑起来**（`auto` 每次降级 spawn，`on` 直接失败）。Windows 走 watchdog 分支、argv 里没有
这个参数，所以本机永远测不出来，只有 Linux runner 会红。

正确选项名是 `--stop-with-process=PID`（aria2 1.36+）。

### `d831a7a` 常驻 daemon 不再钉住宿主事件循环

上一个提交让 daemon 真的起来了，于是暴露第二个问题：父进程持有 daemon 的 child 句柄
（Windows 还多一条 watchdog 的 stdin 管道），事件循环永远排不空。表现是**用例全绿、
测试文件却永不退出**，check job 在 `timeout-minutes: 15` 到点被**取消**（不是失败）。
修复：`child.unref()` + Windows 分支对 `watchdog.stdin` 取 `unref`。生命周期绑定没变
——父进程退出后 `--stop-with-process`（POSIX）与 watchdog stdin-EOF（Windows）照常收尸。

### `efcdbdc` 续传撞 416 按「本地已完整」收尾

`-C -` 让 curl 带 `Range: bytes=<本地长度>-`；本地已完整时起点等于资源长度，服务端回
416。**同一个响应，两个 curl 版本结论相反**：curl 8.13 自行按成功收场（exit 0），
curl 7.81 按 `--fail` 报错（exit 22）。CI 的 curl 8.x 与本机 Windows 8.13 都看不到，
只有老发行版会红。修复：`isResumeAlreadyCompleteError`（只认 curl + 退出码 22 + 文案里的
416，且要求 resume 模式与本地字节 > 0），文件是否真完整仍交给下游 verifySize / checksum。

---

## 3. 环境差异（踩过的坑都在这，别再花时间重新踩）

| | CI | 本机（Windows） | 老 Linux |
| --- | --- | --- | --- |
| Node | 24 | 22.23.x | 视环境 |
| pnpm | 9 | 11（`pnpm check` 会先炸） | 视环境 |
| curl | 8.x | 8.13 | 7.81（416 行为不同） |
| 平台 | ubuntu-latest | win32（daemon 走 watchdog 分支） | Linux |

- **daemon 相关用例在 Windows 上永远是绿的**：watchdog 分支不带 `--stop-with-process`，
  选项名错了也看不出来。判 POSIX 行为必须上 Linux。
- **`npm view` 有本地 metadata 缓存**：刚发布后仍显示旧版本是正常现象，以
  `https://registry.npmjs.org/-/package/@leisureyu%2Fdsh-smart-dl/dist-tags` 为准。
- 全量套件在本机 2 核 Linux 上约 4 分钟（727 条）；CI 上约 2 分钟。
- **push 走镜像偶发被拒**：`origin` 是 `https://ghfast.top/https://github.com/...`（全局
  `url.…insteadOf` 把 github.com 改写到这个镜像）。镜像有时对 `main` 返回
  `cannot lock ref 'refs/heads/main': is at <新 sha> but expected <旧 sha>`，此时
  直连推一次即可：临时 `git config --global --unset "url.https://ghfast.top/https://github.com/.insteadof"`，
  `git push https://github.com/LeiSureYu/dsh-smart-download.git main:main`，推完把
  insteadOf 加回去。push 时那句 `git-credential-wincred.exe … No such file or directory`
  是全局 helper 路径还指着旧版本的噪声，不影响结果。

---

## 4. 改代码的标准流程

```bash
node node_modules/typescript/bin/tsc                              # 构建（写 dist/）
node scripts/copy-client.mjs                                      # src/client.js -> dist/client.js
node node_modules/typescript/bin/tsc --noEmit                     # typecheck: src
node node_modules/typescript/bin/tsc -p tsconfig.test.json        # typecheck: test/ + scripts/
node --test --import tsx "test/**/*.test.ts"                      # 全量；单文件同理
```

提交时把 `dist/` 的改动一并带上。发布用 tag（`v*`）或 `workflow_dispatch`；
`publish.yml` 里 check job 只跑 `/^refs\/tags\//` 之外的推送，二进制与发布只在 tag / 手动时跑。

**发新版本**：改版本号 → 重建 dist → 提交 → 打**新** tag（不要复用已发过的 tag）→
push tag。tag 与 `package.json` 版本不一致时第一步就会红，不会静默空跑。

**发完 npm 还要单独建 GitHub Release**：`publish.yml` 从头到尾只做「取二进制 → 测试 →
npm publish」，没有建 Release 的步骤，1.x 的 release 都是网页手工建的。漏了这一步的形态是
tag 有、npm 有、releases 页面缺这一版（2.0.0 就这样漏过一次，隔天才补）。做法：
选已有的 tag、target `main`、不勾 pre-release、附件留空，正文按 CHANGELOG 对应小节改写
（章节用 `## 破坏性变更` / `## 新增` / `## 修复` / `## 安全` / `## 升级`，结尾写升级路径）。
