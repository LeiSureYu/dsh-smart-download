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
import type { ProgressSession } from './progress.js';
/**
 * `inspect` 的 `presence` 取值。**这是与浏览器端（t32）钉死的契约**，
 * 值集合不得单方面增删 —— 客户端按它渲染文案。
 */
export type ManagePresence = 'present' | 'changed' | 'missing' | 'unknown' | 'blocked';
/** `delete` 的 `reason` 取值。同样是与客户端钉死的契约。 */
export type DeleteReason = 'gone' | 'busy' | 'denied' | 'is-dir' | 'is-link' | 'changed' | 'no-path' | 'running';
/** 固定文案做成常量：客户端与测试都按同一份措辞断言，散落的字面量迟早对不上。 */
export declare const MANAGE_BAD_PAYLOAD = "\u62D2\u7EDD\u7BA1\u7406\u8BF7\u6C42\uFF1Abody \u5FC5\u987B\u662F\u5BF9\u8C61\uFF0C\u4E14\u5E26 op\uFF08inspect / forget / delete\uFF09\u4E0E taskId";
export declare const MANAGE_CONFIRM_REQUIRED = "\u62D2\u7EDD\u5220\u9664\u672C\u5730\u6587\u4EF6\uFF1A\u9700\u8981 confirm:true\uFF1B\u53EA\u60F3\u5220\u8BB0\u5F55\u8BF7\u7528 op:\"forget\"";
/**
 * 不可逆性必须明写（1.4.0）：删除不进回收站。
 *
 * 为什么：本插件是 Node 侧宿主代码，运行时里没有可用的回收站服务（Electron 的
 * `shell.trashItem` 不在我们的能力面里），所以 `unlink` 就是**永久删除**。
 * 这句话同时出现在这里、返回结果的 reason 文案里与 docs/SECURITY.md。
 */
export declare const MANAGE_DELETE_IRREVERSIBLE = "\u5220\u9664\u672C\u5730\u6587\u4EF6\u662F\u6C38\u4E45\u5220\u9664\uFF08\u4E0D\u8FDB\u56DE\u6536\u7AD9\uFF09\uFF1A\u5220\u4E86\u5C31\u6CA1\u4E86";
/** `delete` / `forget` 的返回形状（契约）。 */
export interface ManageDeleteResult {
    fileDeleted: boolean;
    reason?: DeleteReason;
    /**
     * 附加诊断（非契约字段，客户端可以不看）：底层 errno 代码。
     *
     * 为什么加：契约的 `reason` 集合是冻结的，而真实世界里还有 `ENOSPC`、
     * `EROFS` 这类失败。把它们一律塞进 `busy` 会丢掉唯一能排查的信息 ——
     * 加一个**只增不改**的字段比悄悄改 reason 语义安全。
     */
    errorCode?: string;
    recordRemoved: string[];
    /** 契约外的补充：不可逆提示，客户端可直接展示 */
    irreversible: string;
}
/** `inspect` 的返回形状（契约字段 + 一个只增的 `found`）。 */
export interface ManageInspectResult {
    /** 契约外补充：这个 taskId 是否真的有记录（区分「记录里没路径」与「没有这条记录」） */
    found: boolean;
    presence: ManagePresence;
    outPath: string;
    size?: number;
    fileSize?: number;
    fileMtimeMs?: number;
    /** 记录里的任务状态（`running` / `completed` / `failed` / `cancelled`），无记录时为 '' */
    state: string;
}
/** 已校验的管理请求。 */
export interface ManageRequest {
    op: 'inspect' | 'forget' | 'delete';
    taskId: string;
    confirm: boolean;
    session?: ProgressSession;
}
/**
 * 解析并校验管理请求。
 *
 * **R1 落点**：这里只接受 `taskId` / `op` / `confirm` / `session` —— 载荷里
 * 出现任何路径字段都不会被读取，更不会被当成删除目标。删除目标只能来自本插件
 * 自己写下的记录（`outPath`），这是「只删自己的下载」这条前提的根。
 *
 * @param payload 信封里的 payload（任何东西）
 * @returns 合法请求，或固定文案的错误
 */
export declare function readManagePayload(payload: unknown): {
    request: ManageRequest;
} | {
    error: string;
};
/** 一条记录指向的产物在磁盘上的判定结果（`inspect` 与 `delete` 共用同一套）。 */
type TargetCheck = {
    kind: 'no-path';
}
/** 记录里的路径不合规（非绝对 / 未归一化 / 落在本插件自己的记录目录里） */
 | {
    kind: 'bad-path';
    why: string;
} | {
    kind: 'missing';
} | {
    kind: 'dir';
} | {
    kind: 'link';
} | {
    kind: 'other';
} | {
    kind: 'changed';
    fileSize: number;
} | {
    kind: 'present';
    fileSize: number;
};
/**
 * 检查记录里的 `outPath` 是否是一个**可以安全删除的普通文件**。
 *
 * 这一串就是 R3–R6、R9 的落点，顺序是刻意的（从最便宜、最不能跳过的开始）：
 *
 * - **R3 绝对路径**：相对路径的含义取决于进程 cwd，删的时候可能与写的时候不是
 *   同一个文件。
 * - **R4 归一化 + 无 NUL**：`..\..\Windows\System32\x` 这类构造能在「看起来是
 *   自己记录过的路径」外壳下指向别处；归一化比较是最便宜的防线。
 * - **R5 只用 `lstat`**：`stat`/`realpath` 会跟进符号链接，于是「删记录里的那个
 *   文件」会变成「删链接指向的任意目标」。目录也在这里被拒（目录删除会退化成
 *   递归删除，代价不可控）。
 * - **R6 尺寸核对**：原文件被移走后，另一个文件占了同一个名字时，只看存在性会
 *   删错东西。记录里没有尺寸（0）时跳过核对（那只是少一道保险，不会更宽松）。
 * - **R9 不许删自己的记录目录**：那条路属于「删除记录」的职责。
 *
 * @param outPath 记录里的输出路径
 * @param recordedSize 记录里的字节数（0 = 没记录）
 * @param session 当前会话（用于判定 R9 的轨道一目录）
 */
export declare function checkManagedTarget(outPath: string, recordedSize: number, session?: ProgressSession): TargetCheck;
/**
 * `op:'inspect'`：报告这条任务的产物当前是什么样子。
 *
 * 纯只读（`lstat`），不做任何修改；没有记录时如实报 `found:false` ——
 * 「没有这条记录」与「记录里没有路径」在 UI 上是两种文案，不能混。
 */
export declare function inspectManagedTask(taskId: string, session?: ProgressSession): ManageInspectResult;
/**
 * `op:'forget'`：只删本插件的两条进度记录（不碰任何产物）。
 *
 * 与产物删除的区别：这一步只删**我们自己写的文件**，路径由 taskId + 目录规则
 * 推导（R2 + `taskRecordFiles` 的 lstat 校验），不接受调用方给路径。
 */
export declare function forgetManagedTask(taskId: string, session?: ProgressSession): string[];
/**
 * `op:'delete'`：**先删产物、成功后再删记录**（顺序不得颠倒）。
 *
 * ⚠️ **此函数不做 confirm 校验。** 确认（`confirm:true`）由分派层
 * （`registerStatusRpc` 里 `MANAGE_CONFIRM_REQUIRED` 那一处）负责，函数本体
 * **拿到 `taskId` 就会真的删产物**。任何新调用方必须先过 `readManagePayload`
 * 并检查 confirm，再调这里 —— 绕过分派层直调本函数等于绕过不可逆操作的确认
 * 门（对抗性审查 PANEL-DL-3）。
 *
 * 为什么顺序是硬要求：先删记录的话，产物删除失败时用户就永久失去了重试的入口
 * （记录没了 = 面板上再也看不到这一条，而文件还躺在磁盘上）。
 *
 * 哪些情况**仍然删记录**（用户的目标「清掉这一条」可以做全）：
 * - `gone`：文件本来就不在了，没有什么可重试的；
 * - `no-path`：记录里根本没有路径（1.4.0 之前的历史记录），这是 ③↔④ 的降级矩阵，
 *   面板在这条路径上只会给「删除记录」一个动作。
 *
 * 哪些情况**保留记录**：其余所有原因 —— 产物还在（`busy`/`denied`/`changed`/
 * `is-dir`/`is-link`）、或任务还在跑（`running`）。保留记录 = 保留重试入口。
 *
 * @param taskId 已通过白名单的 task id
 * @param session 当前会话（定位轨道一记录）
 */
export declare function deleteManagedTask(taskId: string, session?: ProgressSession): ManageDeleteResult;
/**
 * 注册本插件的三个 HTTP 端点：`/api/smartdl.status`（读快照）、
 * `/api/smartdl.cleanup`（按保留窗口清历史）与 `/api/smartdl.manage`
 * （1.4.0：下载管理器的 inspect / forget / delete）。
 *
 * 通过 `ctx.inject(['connection'], ...)` 挂载：只有当 profile 真的提供了
 * connection 服务（web profile）时才注册，纯 CLI profile 下静默跳过，
 * 不会因为缺少 connection 而让整个插件加载失败。
 *
 * 浏览器端目前只调用 status（面板保持只读）；cleanup 是 D7-② 拍板要加的
 * **清理入口** —— 从前 `ProgressReporter.cleanup()` 只有调用方在代码里显式
 * 调用才有效，这个端点把它变成可被外部（脚本、未来的面板按钮）触发的入口。
 * manage 是 1.4.0 下载管理器要的**单条操作入口**，删除规则见上方那一节。
 *
 * @param ctx 插件上下文
 */
export declare function registerStatusRpc(ctx: Context): void;
export {};
