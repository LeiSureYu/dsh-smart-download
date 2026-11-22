/**
 * aria2 常驻 RPC daemon（1.9.0 引入，2.0.0 起真正接线运行）：懒启动、单例、
 * 进程生命周期绑定。
 *
 * 为什么要有这一层：1.8 及之前每次下载 spawn 一个 aria2c 进程，暂停 = 杀进程，
 * 继续 = 重启 + 断点续传——亚秒级但不是原地语义。常驻 daemon 之后：暂停/继续是
 * `aria2.pause` / `aria2.unpause` 的原地操作，进度从 stdout 摘要解析变成结构化
 * tellStatus。SPIKE 实测（docs/SPIKE-1.9-RPC.md）：pause 23ms / unpause 41ms。
 *
 * ⚠️ 1.9.0–1.9.3 勘误（2.0.0 审计确认）：这两个模块在 1.9.0–1.9.3 里**从未被
 * 任何代码 import**——「RPC 优先」只在 CHANGELOG 里存在，运行时始终走 spawn。
 * 2.0.0 完成接线（src/index.ts 的 runAria2：RPC → daemon 层失败降级 spawn →
 * curl），并在接线前修掉了审计发现的三个隐患：
 *   1. daemon 崩溃无检测：rpcCall 的**传输层**失败现在会把 daemon 状态作废并
 *      杀掉残骸，下次 ensureDaemon 自动重新拉起（aria2 返回的 JSON-RPC error
 *      是另一回事，不触发重建，见 RpcMethodError）；
 *   2. rpc-secret 下 argv：secret 走一次性 conf 文件（`--conf-path`），启动就绪
 *      后立即删除 —— argv 与磁盘上都不再有 secret（aria2 只在启动时读一次 conf）；
 *   3. pause/remove 打在已完成的 gid 上：完成竞态按**真实完成**收尾，不再把
 *      已完成的下载盖成 cancelled（见 download-rpc.ts 的 RpcCompletedRace）。
 *
 * 生命周期绑定（SPIKE Q1 实测）：
 * - POSIX：daemon 带 `--stop-with-pid=<插件进程 pid>`，插件死亡 daemon 跟随退出；
 * - Windows：该选项不存在，改为 stdin-EOF watchdog——插件持有 watchdog 的
 *   stdin 管道，插件死亡 → EOF → watchdog 杀 daemon 后退出。两平台都保证
 *   「daemon 绝不比插件进程活得更久」。
 *
 * 安全：`--rpc-secret` 强制（随机生成，经 conf 文件下发）；daemon 的 RPC 端口
 * 没有 bind-address 选项、监听所有网卡——这是 aria2 的限制，1.9 立项时已记录
 * （SPIKE 附带发现），SECURITY.md 的暴露面说明需随之更新。
 */
import { type ChildProcess } from 'node:child_process';
/** daemon 不可用时的专用错误：调用方据此回退 spawn / curl 路径。 */
export declare class DaemonUnavailableError extends Error {
}
/**
 * aria2 返回的 JSON-RPC 层错误（GID 不存在、状态不允许该操作等）。
 *
 * 为什么与传输层失败分开：JSON-RPC error 是 **aria2 的回答**——daemon 活得好好的，
 * 绝不能触发「daemon 状态作废 / 重新拉起」；而传输层失败（ECONNREFUSED、超时）
 * 意味着 daemon 已死，必须作废状态。1.9.0 的实现把两者混在一个 Error 里，
 * daemon 崩溃后每次下载都对着同一个死端口失败（审计隐患 ①）。
 */
export declare class RpcMethodError extends Error {
}
interface DaemonState {
    port: number;
    secret: string;
    process: ChildProcess;
    /** Windows 模式下的 watchdog 子进程（POSIX 为 undefined） */
    watchdog?: ChildProcess;
    /** 随包二进制路径（用于降级路径复用） */
    aria2Path: string;
    /** 携带 rpc-secret 的 conf 文件；启动就绪后立即删除（aria2 只在启动时读一次） */
    configFile?: string;
}
/** daemon 是否已在运行（诊断 / 测试用） */
export declare function isDaemonRunning(): boolean;
/**
 * 关停 daemon（杀进程树 + 作废状态 + 清 conf 残留）。测试的 after 钩子用它：
 * daemon 的 watchdog stdin 管道由本进程持有，只 reset 状态不杀进程会让
 * node:test 的事件循环永远排不空。
 */
export declare function shutdownDaemon(): void;
/** 仅供测试：重置单例状态（不杀真实进程） */
export declare function resetDaemonForTest(): void;
/**
 * RPC 模式开关（2.0.0）。
 *
 * - `auto`（缺省）：优先 RPC；**daemon 层**失败（起不来 / 失联）自动降级 spawn
 *   路径；aria2 级下载错误与既有路径一样走 curl 回退。
 * - `on`：强制 RPC——daemon 层失败也直接按 aria2 失败处理（走 curl 回退），
 *   不再动用 spawn；调试 RPC 路径用。
 * - `off`：完全回到 spawn 路径（2.0.0 之前的行为）。
 *
 * 未知值与缺省一律按 `auto`：这是内部调优开关而非用户入参，静默回退到最安全
 * 的默认比拒绝调用更合适。
 */
export type Aria2RpcMode = 'auto' | 'on' | 'off';
export declare const ARIA2_RPC_MODE_ENV = "DSH_SMARTDL_ARIA2_RPC";
export declare function aria2RpcMode(env?: NodeJS.ProcessEnv): Aria2RpcMode;
/**
 * 懒启动 daemon（幂等）：已在运行就直接返回；启动失败抛 DaemonUnavailableError
 * （调用方回退 spawn / curl），绝不静默降级。
 */
export declare function ensureDaemon(): Promise<DaemonState>;
/**
 * RPC 调用（token 鉴权）。
 *
 * 失败分两类（2.0.0，审计隐患 ①）：
 * - **传输层失败**（daemon 已死 / 端口失联 / 超时）：daemon 状态作废、残骸清掉，
 *   抛 `DaemonUnavailableError` —— 调用方（index.ts 的 runAria2）在 auto 模式下
 *   降级 spawn，下一次下载会重新拉起 daemon；
 * - **JSON-RPC 层错误**（aria2 的回答，如 GID 不存在）：daemon 活得好好的，
 *   抛 `RpcMethodError`，绝不清状态。
 *
 * 1.9.0 的实现把两类混在一个 Error 里：daemon 崩溃后状态永远指着死端口，
 * 之后每一次下载都以同样的方式失败。
 */
export declare function rpcCall<T = Record<string, unknown>>(method: string, params: unknown[]): Promise<T>;
export {};
