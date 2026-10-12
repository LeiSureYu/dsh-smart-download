import type { ProgressSession } from './progress.js';
/** 保留窗口默认值：24 小时。 */
export declare const DEFAULT_RETENTION_MS: number;
/**
 * 保留窗口下限：1 分钟。
 *
 * 理由：正在跑的任务每秒都在重写文件，只有停手的任务才会超过 1 分钟没动静。
 * 这个下限让「调用方手滑传 0」无法变成「当场清空正在跑的任务」。
 */
export declare const MIN_RETENTION_MS: number;
/** 保留窗口上限：365 天（防止传一个把一切都算成过期的巨大值——那等价于不限）。 */
export declare const MAX_RETENTION_MS: number;
/** 单次调用默认最多删除多少个文件。 */
export declare const DEFAULT_CLEANUP_LIMIT = 200;
/** 单次调用最多删除多少个文件（硬上限，与 resolve 里的夹取一致）。 */
export declare const MAX_CLEANUP_LIMIT = 500;
/** 一次清理的请求参数（字段名与 `cleanupHistory` 的参数一一对应）。 */
export interface CleanupQuery {
    /** 早于「现在 - 该毫秒数」没被写过的进度文件才算历史；下限见 MIN_RETENTION_MS。 */
    olderThanMs?: number;
    /** 本次最多删除多少个文件（1..MAX_CLEANUP_LIMIT）。 */
    limit?: number;
}
/** 清理结果：**必须**逐报告知删了什么、留下了什么，否则无法判断它是不是在误删。 */
export interface CleanupResult {
    /** 实际生效的保留窗口（毫秒） */
    olderThanMs: number;
    /** 过期判定线（毫秒时间戳）；mtime **严格小于**它的文件才会被删 */
    threshold: number;
    /**
     * 本次真的参与扫描的轨道一目录；没有会话上下文且未设 `DSH_PROGRESS_DIR` 时为 `''`。
     *
     * 为什么必须报出来：轨道一（`<session.cwd>/.dsh-progress/<id>/`）**只能**靠调用方
     * 传上来的会话定位，Host 侧无从推断。定位不到时清理会安静地只扫轨道二 ——
     * 调用方看到「删了 N 个」就以为清完了，而实际上另一半目录根本没被看过。
     */
    taskDir: string;
    /**
     * 轨道一未参与清理时的固定说明（参与了就**不出现**）。
     *
     * 与 `scanFailedDirs` 同一套「字段存在与否就是信号」的约定：`taskDir === ''`
     * 只说明「没定位到」，而这条文案说明「为什么没定位到、下一步怎么办」。
     */
    taskDirSkipped?: string;
    /** 扫描到的候选进度文件数（两条轨道合计，最多 MAX_SCAN_FILES） */
    scanned: number;
    /** 是否因达到单文件上限或扫描上限而提前停下 */
    truncated: boolean;
    /** 本次真正删除的文件数 */
    deletedCount: number;
    /** 本次删除的文件路径 */
    deleted: string[];
    /** 仍在保留窗口内、被刻意留下的文件（附 mtime，便于核对判定线） */
    kept: Array<{
        file: string;
        mtimeMs: number;
    }>;
    /**
     * 两个轨道的目录定位失败信息，与 `DownloadStatusSnapshot.scanFailedDirs` 同语义。
     *
     * 注意它**不**改变这次调用的成败：清理本来就是幂等的、按目录尽力而为的，
     * 定位不到轨道一（没有会话上下文）是正常的单轨模式，把整个调用判失败会让
     * 调用方看不出「轨道二其实清干净了」。成功与否由 `ok` 表达（见 rpc.ts）。
     */
    scanFailedDirs?: string[];
}
/**
 * 轨道一未参与清理时的固定文案。
 *
 * 写成常量而不是就地拼串：它是调用方判断「这次清理覆盖了几个目录」的唯一依据，
 * 措辞被某处顺手改掉就会与测试和 README 的说明脱节。
 */
export declare const TASK_DIR_SKIPPED_TEXT = "\u8F68\u9053\u4E00\u672A\u53C2\u4E0E\u6E05\u7406\uFF1A\u672C\u6B21\u8BF7\u6C42\u6CA1\u6709\u5E26\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF08payload.session\uFF09\u4E14\u672A\u8BBE\u7F6E DSH_PROGRESS_DIR\uFF0C\u56E0\u6B64 <session.cwd>/.dsh-progress/<session.id>/ \u4E0B\u7684\u8FDB\u5EA6\u6587\u4EF6\u6CA1\u6709\u88AB\u626B\u63CF\u3002\u8981\u6E05\u7406\u8F68\u9053\u4E00\uFF0C\u8BF7\u5728 payload \u91CC\u5E26\u4E0A session: { id, cwd }";
/**
 * 解析清理请求参数。
 *
 * 与 `readPayload`（status）的差别：status 是只读查询，非法 limit 夹取到安全值
 * 是可以接受的；清理会删文件，因此**非法值一律拒绝**（字段缺省才走默认值）。
 * 「二选一」的另一条路（保留夹取 + 在返回里加机器可读的 fallback 说明）没有选，
 * 因为清理这条路径上「少删了」与「按你给的范围删了」必须一眼可分。
 *
 * @param payload 客户端传来的 payload（可能什么都不是）
 */
export declare function readCleanupQuery(payload: unknown): CleanupQuery;
/**
 * 删除过期的历史进度文件。
 *
 * 命中规则：候选文件的 mtime **严格小于** `now - olderThanMs`。
 *
 * @param query 清理参数（缺省时用默认保留窗口与默认条数）
 * @param session 当前会话；用于定位轨道一目录（缺省时轨道一不参与清理）
 * @param now 判定用的「现在」（毫秒）；测试注入固定值用
 */
export declare function cleanupHistory(query?: CleanupQuery, session?: ProgressSession, now?: number): CleanupResult;
