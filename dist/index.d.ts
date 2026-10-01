/**
 * dsh-smart-dl 插件入口：
 * 注册两个工具：
 * - smart_download：先探测，再按文件大小与 aria2 可用性决定 aria2（4/8 连接）或 curl
 *   回退；支持镜像加速与断点续传，并通过 ProgressReporter 双轨上报进度；
 * - download_status：只读地查询这些下载任务的进度快照。
 *
 * 另外注册浏览器端进度面板所需的 Host RPC 端点（带 Web 界面的 profile 才生效：web / desktop）。
 *
 * 假设：基于 DSH 0.1.7-rc.1 起的 defineTool / ctx.tools.register API，
 * 已在 0.2.0-rc.2（含桌面版）上验证兼容。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-smart-dl";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
