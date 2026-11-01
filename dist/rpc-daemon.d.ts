/**
 * aria2 常驻 RPC daemon（1.9.0）：懒启动、单例、进程生命周期绑定。
 *
 * 为什么要有这一层（1.9.0）：1.8 及之前每次下载 spawn 一个 aria2c 进程，
 * 暂停 = 杀进程，继续 = 重启 + 断点续传——亚秒级但不是原地语义。常驻 daemon
 * 之后：暂停/继续是 `aria2.pause` / `aria2.unpause` 的原地操作，队列与连接
 * 预算由 daemon 原生管理，进度从 stdout 摘要解析变成结构化 tellStatus。
 * SPIKE 实测（docs/SPIKE-1.9-RPC.md）：pause 23ms / unpause 恢复 41ms。
 *
 * 生命周期绑定（SPIKE Q1 实测）：
 * - POSIX：daemon 带 `--stop-with-pid=<插件进程 pid>`，插件死亡 daemon 跟随退出；
 * - Windows：该选项不存在，改为 stdin-EOF watchdog——插件持有 watchdog 的
 *   stdin 管道，插件死亡 → EOF → watchdog 杀 daemon 后退出。两平台都保证
 *   「daemon 绝不比插件进程活得更久」。
 *
 * 安全：`--rpc-secret` 强制（随机生成）；daemon 的 RPC 端口没有 bind-address
 * 选项、监听所有网卡——这是 aria2 的限制，1.9 立项时已记录（SPIKE 附带发现），
 * SECURITY.md 的暴露面说明需随之更新。
 */
import { type ChildProcess } from 'node:child_process';
/** daemon 不可用时的专用错误：调用方据此回退 spawn / curl 路径。 */
export declare class DaemonUnavailableError extends Error {
}
interface DaemonState {
    port: number;
    secret: string;
    process: ChildProcess;
    /** Windows 模式下的 watchdog 子进程（POSIX 为 undefined） */
    watchdog?: ChildProcess;
    /** 随包二进制路径（用于降级路径复用） */
    aria2Path: string;
}
/** daemon 是否已在运行（诊断 / 测试用） */
export declare function isDaemonRunning(): boolean;
/** 仅供测试：重置单例状态（不杀真实进程） */
export declare function resetDaemonForTest(): void;
/**
 * 懒启动 daemon（幂等）：已在运行就直接返回；启动失败抛 DaemonUnavailableError
 * （调用方回退 spawn / curl），绝不静默降级。
 */
export declare function ensureDaemon(): Promise<DaemonState>;
/** RPC 调用（token 鉴权）。 */
export declare function rpcCall<T = Record<string, unknown>>(method: string, params: unknown[]): Promise<T>;
export {};
