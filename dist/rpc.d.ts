/**
 * Host 侧 RPC：把下载进度快照暴露给浏览器端（进度面板 UI）。
 *
 * 为什么不用 `ctx.connection.rpc.handle`：web profile 里 webserver 是
 * 同级 loader row，不是本插件 fiber 的祖先，专用 RPC channel 无法挂载。
 * 唯一可行的挂载点是 `connection.fetch.register`（共享 `/api` 载体上的
 * 精确 Fetch 路由）。
 *
 * 协议（与 dsh-client-connection 的 `createWebConnectionRpc` 对齐）：
 *   请求  POST /api/smartdl.status
 *         { "type": "client-request", "rpcId": "<id>", "method": "smartdl.status", "payload": {...} }
 *   响应  200 { "type": "server-response", "rpcId": "<id>", "result": { "ok": true, "value": {...} } }
 *         或 { ..., "result": { "ok": false, "error": { code, message, details } } }
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 注册 `/api/smartdl.status` 精确 Fetch 路由。
 *
 * 通过 `ctx.inject(['connection'], ...)` 挂载：只有当 profile 真的提供了
 * connection 服务（web profile）时才注册，纯 CLI profile 下静默跳过，
 * 不会因为缺少 connection 而让整个插件加载失败。
 *
 * @param ctx 插件上下文
 */
export declare function registerStatusRpc(ctx: Context): void;
