# PLAN-1.9 · aria2 常驻 RPC 模式

> 依据 [SPIKE-1.9-RPC.md](./SPIKE-1.9-RPC.md) 的实测结论（有条件 Go）立项。

## 范围决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| aria2 下载路径 | RPC 优先，spawn 降级为后备 | daemon 起不来（端口耗尽 / 二进制损坏）时下载必须照常工作——立刻退役 spawn 会让新的故障面直接变成不可用面 |
| curl 路径 | 不变 | 小文件 / 不支持 Range 的场景与 RPC 无关 |
| 暂停语义 | RPC 档 = `aria2.pause`（原地挂起）；spawn 后备与 curl 档 = 1.8 的杀进程 + 指纹续传 | 两条路径的内部动作不同，对外契约（paused 终态、半包保留、重试放行）完全一致 |
| `.part.json` 指纹 | 保留 | 与 `.aria2` 控制文件文件名不同可共存；RPC 模式的「继续」仍需同源核对 |
| 连接预算 | daemon `--max-connection-per-server=8` 原生强制；闸门信号量保留（curl 档仍需） | 预算从「调用内」升级为「daemon 内」，比信号量更根本 |
| 凭证 | `--rpc-secret` 强制；POSIX 上 daemon 带进程生命周期绑定（`--stop-with-pid`），Windows 用 stdin-EOF watchdog | SPIKE Q1 实测 |

## 明确不做（1.9）

- 不做 spawn-aria2 路径的代码删除：降级路径需要它，1.10 按 RPC 实跑数据再清理。
- 不做 daemon 跨 DSH 重启恢复：daemon 死 = 在途下载中断，与 1.8 模型相同；恢复仍靠 `.part.json` 指纹 + 重试。
- 不做 WebSocket 推送进度：轮询 tellStatus（500ms）已满足面板粒度。

## 测试计划

1. daemon 生命周期：懒启动幂等、getVersion、shutdown 后再 ensure 可重启。
2. RPC 下载端到端：本机 Range 源 8MiB → RPC 路径完成、字节数核对、吞吐观测产出。
3. 暂停：RPC 下载中 pause → paused 终态 → startRetry 续传到完成。
4. 降级：daemon 不可用时回退 spawn 路径完成下载。
5. 全量回归：既有 679 例不红（spawn 路径保留为后备，既有用例仍有效）。
