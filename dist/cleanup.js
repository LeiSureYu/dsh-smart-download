/**
 * 历史进度文件清理：删除**过期**的进度文件（两条轨道都扫）。
 *
 * 为什么不用 `ProgressReporter.cleanup()`（`src/progress.ts:379`）：
 * 那是**单任务实例方法**，而且它的注释明写「刻意不自动调用」—— 面板靠这些文件
 * 渲染「已完成 / 失败」回执，立刻删除会让回执永远看不到。所以本轮做的是
 * **新增一个触发入口**，不是把那个显式接口接上自动调用。
 *
 * 为什么按 mtime 而不是解析 status 字段判「历史」：
 *   1. 正在跑的任务每次百分比变化都重写文件（`ProgressReporter` 的批量落盘），
 *      因此「文件很久没被碰过」就等价于「没人在写它」，这个条件直接落在
 *      **写入事实**上，不依赖任何状态字段的语义；
 *   2. 不解析就能删，就少一条「解析失败 -> 判断错 -> 删错东西」的路径：
 *      解析出错的文件这里只会因为过期而被删，而正在写的文件永远不会过期。
 *   保留窗口下限（{@link MIN_RETENTION_MS}）是给这条性质的第二道保险。
 *
 * 与 `src/status.ts` 的镜像关系：这里镜像 `readDownloadStatus` 的目录解析与
 * 扩展名取值（`.jsonl` 轨道一、`.json` 轨道二）。为此禁止「把两个常量统一成
 * 一个」的重构 —— 两个扩展名就是两条不同的轨道，合并会立刻变成删错文件。
 *
 * 本模块只删「符合文件名规则的**文件**」：目录、符号链接、不符合后缀的东西一律不动，
 * 所以 `DSH_PROGRESS_DIR` 指错到别的目录时损失也被限制在这两类命名上。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDownloadProgressDir, resolveTaskProgressDir, } from './progress.js';
/** 保留窗口默认值：24 小时。 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * 保留窗口下限：1 分钟。
 *
 * 理由：正在跑的任务每秒都在重写文件，只有停手的任务才会超过 1 分钟没动静。
 * 这个下限让「调用方手滑传 0」无法变成「当场清空正在跑的任务」。
 */
export const MIN_RETENTION_MS = 60 * 1000;
/** 保留窗口上限：365 天（防止传一个把一切都算成过期的巨大值——那等价于不限）。 */
export const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** 单次调用默认最多删除多少个文件。 */
export const DEFAULT_CLEANUP_LIMIT = 200;
/** 单次调用最多删除多少个文件（硬上限，与 resolve 里的夹取一致）。 */
export const MAX_CLEANUP_LIMIT = 500;
/**
 * 单次扫描的候选文件上限。
 *
 * 为什么需要它：目录里可能有成千上万个进度文件，逐个 `stat` 是同步系统调用，
 * 放在一次 RPC 里会阻塞事件循环。取「最近修改的 5000 个」即可 —— 清理要找的是
 * **最旧**的那些，把列表按 mtime 升序排之后，被这一刀切掉的只会是较新的文件。
 */
const MAX_SCAN_FILES = 5000;
/**
 * 轨道一未参与清理时的固定文案。
 *
 * 写成常量而不是就地拼串：它是调用方判断「这次清理覆盖了几个目录」的唯一依据，
 * 措辞被某处顺手改掉就会与测试和 README 的说明脱节。
 */
export const TASK_DIR_SKIPPED_TEXT = '轨道一未参与清理：本次请求没有带会话上下文（payload.session）且未设置 DSH_PROGRESS_DIR，因此 <session.cwd>/.dsh-progress/<session.id>/ 下的进度文件没有被扫描。要清理轨道一，请在 payload 里带上 session: { id, cwd }';
/**
 * 取一个**显式给出**的整数字段，超出允许范围就地拒绝。
 *
 * 为什么不再夹取（1.3.0 收口）：清理是**不可逆**的，而「夹取」会让调用方以为
 * 自己给的值生效了 —— 传 30 秒被悄悄抬成 60 秒、传 10 万条被悄悄压到 500 条，
 * 返回里都看不出差别。现在只有「没给」才用默认值，给了就必须在范围内，否则
 * 整个请求以 ok:false 结束（与 maxBandwidth 的校验方式一致）。
 *
 * @param raw 原始值（可能什么都不是）
 * @param field 字段名，用于错误文案
 * @param min 下限（含）
 * @param max 上限（含）
 * @param fallback 字段缺省时的默认值
 */
function requireIntInRange(raw, field, min, max, fallback) {
    if (raw === undefined)
        return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`拒绝清理：${field} 必须是 ${min}..${max} 之间的整数（收到 ${JSON.stringify(raw)}）` +
            `；缺省时为 ${fallback}。这里不接受「夹取」——清理不可逆，静默改写参数会让调用方以为给的值生效了`);
    }
    return n;
}
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
export function readCleanupQuery(payload) {
    if (payload === null || typeof payload !== 'object')
        return {};
    const body = payload;
    const query = {};
    const olderThanMs = requireIntInRange(body.olderThanMs, 'olderThanMs', MIN_RETENTION_MS, MAX_RETENTION_MS, DEFAULT_RETENTION_MS);
    // 缺省时不写进 query（保持「没给」与「给了默认值」在对象形状上也可分）
    if (body.olderThanMs !== undefined)
        query.olderThanMs = olderThanMs;
    const limit = requireIntInRange(body.limit, 'limit', 1, MAX_CLEANUP_LIMIT, DEFAULT_CLEANUP_LIMIT);
    if (body.limit !== undefined)
        query.limit = limit;
    return query;
}
/**
 * 收集一个目录下属于本插件的进度文件。
 *
 * 与 `collectFromDir`（status.ts）的差别：这里只要 mtime，不解析内容；
 * 并且显式排除目录与符号链接 —— 删除是不可逆的，值得多两次系统调用。
 *
 * @param dir 待扫描目录
 * @param ext 该目录下属于本插件的后缀（`.jsonl` 或 `.json`）
 * @param out 结果累加器
 * @param onScanError 目录读不到时回调（收到目录路径）
 */
function collectCandidates(dir, ext, out, onScanError) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        onScanError(dir);
        return;
    }
    for (const name of entries) {
        if (!name.endsWith(ext))
            continue;
        const id = name.slice(0, -ext.length);
        if (!id)
            continue;
        const file = path.join(dir, name);
        try {
            // lstat（而非 stat）：符号链接要按链接本身判断，不能跟进目标
            const st = fs.lstatSync(file);
            if (!st.isFile())
                continue;
            out.push({ file, mtimeMs: st.mtimeMs });
        }
        catch {
            // 拿不到状态的条目直接跳过：删不掉的东西不该让整次清理失败
            continue;
        }
    }
}
/**
 * 删除过期的历史进度文件。
 *
 * 命中规则：候选文件的 mtime **严格小于** `now - olderThanMs`。
 *
 * @param query 清理参数（缺省时用默认保留窗口与默认条数）
 * @param session 当前会话；用于定位轨道一目录（缺省时轨道一不参与清理）
 * @param now 判定用的「现在」（毫秒）；测试注入固定值用
 */
export function cleanupHistory(query = {}, session, now = Date.now()) {
    // 与 readCleanupQuery 用的是同一套校验：清理会删文件，因此任何「给了但越界」
    // 的值都必须在此止步，而不是被夹到边界后照删。
    const olderThanMs = requireIntInRange(query.olderThanMs, 'olderThanMs', MIN_RETENTION_MS, MAX_RETENTION_MS, DEFAULT_RETENTION_MS);
    const limit = requireIntInRange(query.limit, 'limit', 1, MAX_CLEANUP_LIMIT, DEFAULT_CLEANUP_LIMIT);
    const threshold = now - olderThanMs;
    const scanFailedDirs = [];
    const noteScanError = (dir) => {
        scanFailedDirs.push(dir);
    };
    const candidates = [];
    const taskDir = resolveTaskProgressDir(session);
    const downloadDir = resolveDownloadProgressDir();
    // 轨道二先扫、轨道一后扫，与 readDownloadStatus 的顺序一致（便于对照诊断）。
    collectCandidates(downloadDir, '.json', candidates, noteScanError);
    if (taskDir)
        collectCandidates(taskDir, '.jsonl', candidates, noteScanError);
    // 按 mtime 升序：最旧的排最前。这样单次条数上限切掉的永远是最新的那些，
    // 剩下的过期文件留给下一次调用 —— 不会出现「随机删掉一批、剩下一批更旧的」。
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const scanned = Math.min(candidates.length, MAX_SCAN_FILES);
    const deleted = [];
    const kept = [];
    let truncated = candidates.length > MAX_SCAN_FILES;
    for (const candidate of candidates.slice(0, MAX_SCAN_FILES)) {
        if (candidate.mtimeMs >= threshold) {
            kept.push({ file: candidate.file, mtimeMs: candidate.mtimeMs });
            continue;
        }
        if (deleted.length >= limit) {
            // 达到本次条数上限就停：剩下的过期文件仍然过期，下次调用可以继续清。
            truncated = true;
            break;
        }
        try {
            fs.unlinkSync(candidate.file);
            deleted.push(candidate.file);
        }
        catch {
            // 删不掉（占用 / 权限）就跳过：整次清理不因为一个文件失败
            continue;
        }
    }
    return {
        olderThanMs,
        threshold,
        // 轨道一没定位到时如实报出来（'' + 说明文案），而不是让它静默地不参与
        taskDir: taskDir ?? '',
        ...(taskDir === null ? { taskDirSkipped: TASK_DIR_SKIPPED_TEXT } : {}),
        scanned,
        truncated,
        deletedCount: deleted.length,
        deleted,
        kept,
        ...(scanFailedDirs.length > 0 ? { scanFailedDirs } : {}),
    };
}
