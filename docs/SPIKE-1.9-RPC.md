# SPIKE-1.9-RPC · aria2 常驻 RPC 模式三问实测

> 目的：在立项 1.9（aria2 常驻 RPC 模式）之前，用真机实验回答三个问题：
> 生命周期绑定、pause/unpause 与 1.8 重启路径的真实延迟差、控制文件共存。
> 实测环境：Windows 11 x64（本仓库开发机），随包 aria2 1.37.0，2026-11-02。
> 脚本：`scripts/spike-1.9-rpc.mjs` + `scripts/spike-1.9-rpc-watchdog.mjs`，全程本机回环。

## 实测结果一览

| 问题 | 结论 |
| --- | --- |
| Q1 生命周期绑定 | Windows：`--stop-with-pid` **不存在**（POSIX-only，实测 unknown option）；宿主死亡后 daemon 实测跟随退出（机制待考）；**stdin-EOF watchdog 实测有效**（无孤儿）。POSIX：`--stop-with-pid` 直接可用。→ 两平台都有绑定方案，Q1 不构成立项障碍 |
| Q2 延迟 | RPC pause 23ms / unpause 恢复传输 41ms；1.8 spawn `-c` 重启 94ms（纯 aria2 侧）。RPC 快 2~4 倍，且 1.8 真实路径还要加探测重试（数百 ms~5s）。→ 有真实收益，但两者都是亚秒级 |
| Q3 控制文件 | `<output>.aria2`（aria2 控制）与 `<output>.part.json`（本插件指纹）文件名不同、可共存；暂停后 .aria2 存在、完成后自动清理 ✓ |

## Q1 · 生命周期绑定

| 实验 | 结果 |
| --- | --- |
| `--stop-with-pid` 在 Windows 构建 | **实测 unknown option** —— POSIX-only 选项。之前 `--version` 探测能过是因为 version 参数先于参数校验退出 |
| 宿主死亡（无绑定机制） | daemon 在观测窗口内**跟随退出**（8s 内，Windows 实测；机制待考——可能是控制台/RPC 关联）。注意：这意味着 Windows 上 daemon 无法比宿主活得更久，孤儿风险低于 POSIX |
| 宿主死亡（stdin-EOF watchdog） | watchdog 的 stdin 由宿主持有，宿主死亡 → stdin EOF → watchdog 杀 daemon 后退出。**实测无孤儿**，纯 Node 约 20 行 |

POSIX 上 `--stop-with-pid` 直接可用（官方选项）。结论：**两平台的生命周期绑定都有方案**，Q1 不构成立项障碍；但 Windows 侧需要 watchdog 子进程（多一个进程、多一份代码），且「宿主崩溃 → daemon 跟随死」意味着在途下载照样中断——与 1.8 模型的崩溃语义相同，不是退步。

## Q2 · pause/unpause vs 杀进程重启

| 路径 | 实测延迟 | 说明 |
| --- | --- | --- |
| RPC pause（调用 → 状态 paused） | **23ms** | 连接原地挂起 |
| RPC unpause（→ 字节继续增长） | **41ms** | 不重启进程、不重探测 |
| 1.8 spawn `-c` 重启（重启 → 字节继续增长） | **94ms** | 纯 aria2 侧；本插件真实路径还要加重试探测（数百 ms~5s 超时风险）与指纹核对 |

结论：RPC 快 2~4 倍。但两条路径都是**亚秒级**——真实收益取决于用户对「继续延迟」的敏感度。RPC 模式的更大收益在别处：队列原生管理、限速热调、结构化进度（stdout 摘要解析的脆弱性消失，见 0.9.0 的 DL: 格式回归）。

## Q3 · 控制文件共存

- 暂停后 `<output>.aria2`（aria2 自有控制文件）存在 ✓
- 下载完成后 `.aria2` 自动清理 ✓
- 本插件指纹文件 `<output>.part.json` 与 `.aria2` **文件名不同、互不冲突**，可继续各司其职：`.aria2` 管字节偏移，`.part.json` 管同源指纹（ETag / Last-Modified）

## 附带发现（非三问，但影响设计）

- aria2 的 RPC 端口**没有 bind-address 选项**，`--enable-rpc` 监听所有网卡——1.9 若立项，`--rpc-secret` 必须强制、且要在 SECURITY.md 写明本地端口暴露面
- RPC pause 在队列语义下是「挂起」，与「移除后重试」是两个操作；UI 的暂停/继续要映射到 pause/unpause 而不是 remove + addUri

## Go / No-Go

**有条件 Go。** Q1 与 Q3 都不构成障碍；Q2 的绝对收益（亚秒级对亚秒级）不如结构化进度与队列原生管理的架构收益大。1.9 若立项，建议：

1. curl 回退路径与 RPC 路径**长期共存**（aria2 不可用 / 小文件仍走 curl），spawn-aria2 路径退役
2. 常驻 daemon 生命周期：懒启动 + 宿主退出时 `aria2.shutdown` 优雅关闭 + POSIX `--stop-with-pid` / Windows stdin-EOF watchdog 兜底
3. `.part.json` 指纹机制保留（与 `.aria2` 共存），RPC 模式下继续作为「继续前同源核对」的依据
