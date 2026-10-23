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
import type { RetryStartResult } from './tasks.js';
/**
 * `inspect` 的 `presence` 取值。**这是与浏览器端（t32）钉死的契约**，
 * 值集合不得单方面增删 —— 客户端按它渲染文案。
 */
export type ManagePresence = 'present' | 'changed' | 'missing' | 'unknown' | 'blocked';
/** `delete` 的 `reason` 取值。同样是与客户端钉死的契约。 */
export type DeleteReason = 'gone' | 'busy' | 'denied' | 'is-dir' | 'is-link' | 'changed' | 'no-path' | 'running';
/** 固定文案做成常量：客户端与测试都按同一份措辞断言，散落的字面量迟早对不上。 */
export declare const MANAGE_BAD_PAYLOAD = "\u62D2\u7EDD\u7BA1\u7406\u8BF7\u6C42\uFF1Abody \u5FC5\u987B\u662F\u5BF9\u8C61\uFF0C\u4E14\u5E26 op\uFF08inspect / forget / delete / reveal / cancel / retry\uFF09\u4E0E taskId";
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
/** `reveal` 的返回形状（契约）。 */
export interface ManageRevealResult {
    found: boolean;
    presence: ManagePresence;
    /** 是否真的让系统文件管理器定位了它 */
    revealed: boolean;
    outPath?: string;
    reason?: DeleteReason;
    errorCode?: string;
}
/**
 * `cancel` 的返回形状（1.6.0 契约）。
 *
 * `cancelled:false` 的两种原因刻意分开：
 * - `not-running`：记录存在，但当前 Host 进程里没有它的下载（已结束 / 别的进程）；
 * - `unknown`：连记录都没有，调用方给的 id 不对。
 *
 * 为什么不在没在跑时返回 `ok:false`：这是一次**有效**的查询，答案就是「它没在跑」。
 * 用错误信封会把「已经结束」与「请求坏了」混在一起，面板只能报一句笼统的失败。
 */
export interface ManageCancelResult {
    cancelled: boolean;
    taskId: string;
    reason?: 'not-running' | 'unknown';
    /** 记录里的状态（没在跑时给出，便于面板显示「它其实已经完成了」） */
    state?: string;
}
/** 已校验的管理请求。 */
export interface ManageRequest {
    op: 'inspect' | 'forget' | 'delete' | 'reveal' | 'cancel' | 'retry';
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
 * 各平台上「打开文件管理器并定位文件」的命令。
 *
 * `DSH_SMARTDL_REVEAL_CMD` 是**测试接缝**（与 `DSH_SMARTDL_THROUGHPUT_DIR`
 * 等同一套做法）：真实跑测试时不该在开发者桌面上弹出资源管理器窗口，
 * 无头 CI 里也没有 `xdg-open`。覆盖成任意存在的命令即可走完整路径，
 * 且不产生副作用。
 *
 * @param target 产物的绝对路径
 * @returns 命令与参数（参数走数组，不拼 shell 字符串）
 */
export declare function revealCommand(target: string): {
    command: string;
    args: string[];
};
/**
 * 起一个「打开文件管理器」的子进程，**如实报告它到底起没起来**。
 *
 * 为什么不能用 `spawn(...).unref()` 加 try/catch：`spawn` 在命令不存在时
 * **不同步抛错**，而是异步 emit `'error'`；没有监听器时它就是未捕获异常，
 * 会直接崩掉整个宿主进程。CI 上（Linux 容器里没有 `xdg-open`）就是这样把
 * 测试进程打挂的；换成用户的机器同样会崩 —— 点一下「在文件夹中显示」把
 * DSH 弄崩，代价远大于这个功能本身。
 *
 * 所以这里两条路都堵上：同步抛（参数非法）与异步 `'error'` 都返回 `false`，
 * 只有真的收到 `'spawn'` 事件才返回 `true`（不假装成功）。
 *
 * @param command 可执行文件名（不拼 shell 字符串，参数走数组）
 * @param args 参数数组
 * @returns 是否成功启动；启动成功后 `unref()`，子进程不随宿主退出而被杀
 */
export declare function openWithCommand(command: string, args: string[]): Promise<boolean>;
/**
 * `op:'reveal'`：在系统的文件管理器里**定位**该任务的产物。
 *
 * 为什么需要它：客户端插件拿不到 `remote.session`（`ctx.remote.session` 在这份
 * profile 下是 undefined，实测「在文件夹中显示」一直失败），而**宿主进程**能起
 * 子进程 —— Windows 用 `explorer.exe /select,<file>`，macOS 用 `open -R`，
 * Linux 用 `xdg-open <dir>`。所以把这一步挪到服务端，客户端只发 `taskId`，
 * 功能不再依赖任何客户端注入。
 *
 * 安全边界与 `delete` 完全一致：路径**只能来自本插件自己的记录**（调用方给不了
 * 路径），并走同一套 `checkManagedTarget` 校验（绝对路径 / 归一化 / lstat /
 * 拒目录与符号链接 / 尺寸不符…）。产物不在原位置时如实报 `presence` 且**什么
 * 都不打开** —— 打开一个「看起来对」的邻居路径比什么都不做更糟。
 */
export declare function revealManagedTask(taskId: string, session?: ProgressSession): Promise<ManageRevealResult>;
/**
 * `op:'forget'`：只删本插件的两条进度记录（不碰任何产物）。
 *
 * 与产物删除的区别：这一步只删**我们自己写的文件**，路径由 taskId + 目录规则
 * 推导（R2 + `taskRecordFiles` 的 lstat 校验），不接受调用方给路径。
 */
export declare function forgetManagedTask(taskId: string, session?: ProgressSession): string[];
/**
 * `op:'cancel'`：中止当前 Host 进程里正在跑的那一条（1.6.0）。
 *
 * 只对**本进程**有效：`AbortController` 无法跨进程使用，重启 Host 后旧任务本来
 * 也不存在了。因此「没在跑」不是错误，而是如实回答；再结合进度记录区分
 * 「已结束」与「未知 id」。
 */
export declare function cancelManagedTask(taskId: string, session?: ProgressSession): ManageCancelResult;
/**
 * `op:'retry'`：以同一个 taskId 重新发起一条已失败 / 已取消的下载（1.6.0）。
 *
 * 真正的实现由插件入口通过 `setRetryHandler` 注入（rpc.ts 不 import index.ts，
 * 否则会形成循环依赖）。没注入时如实回 `unavailable`，而不是假装开始。
 */
export declare function retryManagedTask(taskId: string, session?: ProgressSession): Promise<RetryStartResult>;
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
 * 浮层进度面板只调用 status（保持只读）；下载管理器另外调用 manage 的
 * cancel / retry（1.6.0）。cleanup 是 D7-② 拍板要加的**清理入口** ——
 * 从前 `ProgressReporter.cleanup()` 只有调用方在代码里显式调用才有效，
 * 这个端点把它变成可被外部（脚本、面板按钮）触发的入口。
 * manage 是 1.4.0 下载管理器要的**单条操作入口**，删除规则见上方那一节。
 *
 * @param ctx 插件上下文
 */
export declare function registerStatusRpc(ctx: Context): void;
export {};
