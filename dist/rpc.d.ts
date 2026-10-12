/**
 * Host 侧 RPC：把下载进度快照与历史清理暴露给浏览器端（进度面板 UI）。
 *
 * 为什么不用 `ctx.connection.rpc.handle`：web profile 里 webserver 是
 * 同级 loader row，不是本插件 fiber 的祖先，专用 RPC channel 无法挂载。
 * 唯一可行的挂载点是 `connection.fetch.register`（共享 `/api` 载体上的
 * 精确 Fetch 路由）。
 *
 * 协议（与 dsh-client-connection 的 `createWebConnectionRpc` 对齐）：
 *   请求  POST /api/smartdl.status
 *         POST /api/smartdl.cleanup
 *         { "type": "client-request", "rpcId": "<id>", "method": "<端点名>", "payload": {...} }
 *   响应  200 { "type": "server-response", "rpcId": "<id>", "result": { "ok": true, "value": {...} } }
 *         或 { ..., "result": { "ok": false, "error": { code, message, details } } }
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 注册本插件的两个 HTTP 端点：`/api/smartdl.status`（读快照）与
 * `/api/smartdl.cleanup`（清历史）。
 *
 * 通过 `ctx.inject(['connection'], ...)` 挂载：只有当 profile 真的提供了
 * connection 服务（web profile）时才注册，纯 CLI profile 下静默跳过，
 * 不会因为缺少 connection 而让整个插件加载失败。
 *
 * 浏览器端目前只调用 status（面板保持只读）；cleanup 是 D7-② 拍板要加的
 * **清理入口** —— 从前 `ProgressReporter.cleanup()` 只有调用方在代码里显式
 * 调用才有效，这个端点把它变成可被外部（脚本、未来的面板按钮）触发的入口。
 *
 * @param ctx 插件上下文
 */
export declare function registerStatusRpc(ctx: Context): void;
