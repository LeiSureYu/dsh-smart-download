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
/**
 * `download_status` 在没有任何任务时的固定文案。
 *
 * 定成常量而不是就地拼串，理由与 `verify.ts` 的跳过文案相同：它现在会被
 * 「读不到目录」的诊断信息**追加**在后面，两段文案必须各自可断言，
 * 不能靠一个模板字符串把两件事混成一件。
 */
export declare const NO_TASKS_TEXT = "No download tasks found.";
export declare function apply(ctx: Context): void;
