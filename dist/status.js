/**
 * download_status：读取本插件写下的进度文件，给出任务快照。
 *
 * 只读两条既有轨道（与 ProgressReporter 写的目录完全一致）：
 * - 轨道一：$DSH_PROGRESS_DIR/<taskId>.jsonl，缺省
 *           <session.cwd>/.dsh-progress/<session.id>/<taskId>.jsonl
 *           （dsh-task-progress 格式，append-only）
 * - 轨道二：$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json 或
 *           <DSH_HOME>/downloads/tasks/<taskId>.json（本插件自有格式，整体覆盖写）
 *
 * 设计约束：
 * - 纯只读，绝不写文件、绝不联网；
 * - 任何读取失败（目录不存在 / 权限 / 内容损坏）都退化为“该任务不出现在结果里”，
 *   整个调用仍然成功返回，只是任务列表更短；
 * - 任务按 updatedAt 倒序，最新的排在最前。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDownloadProgressDir, resolveTaskProgressDir, } from './progress.js';
/** 默认返回条数 */
export const DEFAULT_STATUS_LIMIT = 10;
/**
 * 上限条数。
 *
 * 与 `DEFAULT_STATUS_LIMIT` 放在一起，是因为两者原本分散在两个文件里
 * （默认值在 `status.ts`，「夹到 50」硬编码在 `rpc.ts` 的 `readPayload`），
 * 改了一个忘了另一个就会出现「RPC 认为上限是 50、工具认为不是」的偏差。
 * 两个调用方（`readPayload` 与 `readDownloadStatus`）现在共用这一个常量。
 */
export const MAX_STATUS_LIMIT = 50;
/** 兜底字符串：schema 要求 string 类型，缺省时不能写 undefined */
const EMPTY = '';
/** 只保留受支持的字符串字段，且必须返回 string（不能是 undefined / null） */
function str(value) {
    return typeof value === 'string' ? value : EMPTY;
}
/** 解析 JSONL 的最后一行有效记录 */
function readLastJsonlLine(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    }
    catch {
        return null;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object')
                return parsed;
        }
        catch {
            // 半截行 / 损坏行：继续往上一行找
            continue;
        }
    }
    return null;
}
/**
 * 判定任务状态。
 *
 * 优先读进度记录里显式的 `state` 字段（dsh-task-progress 的协议字段，
 * `running` / `done` / `failed` / `cancelled`）；老版本进度文件没有该字段，
 * 此时回退到按文案与百分比推断，保证向后兼容。
 */
function statusFrom(pct, msg, state) {
    if (state === 'done')
        return 'completed';
    if (state === 'failed')
        return 'failed';
    if (state === 'cancelled')
        return 'cancelled';
    if (state === 'running')
        return 'running';
    // 无 state（0.5.0 之前的进度文件）：按文案与百分比兜底
    if (msg.includes('失败'))
        return 'failed';
    if (msg.includes('完成') || pct >= 100)
        return 'completed';
    return 'running';
}
/** 收集一个目录下的任务快照（.jsonl 或 .json） */
function collectFromDir(dir, ext) {
    const out = new Map();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        if (!name.endsWith(ext))
            continue;
        const id = name.slice(0, -ext.length);
        if (!id)
            continue;
        const file = path.join(dir, name);
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(file).mtimeMs;
        }
        catch {
            // 拿不到 mtime 就用 0，仍会排在最末
        }
        if (ext === '.jsonl') {
            const rec = readLastJsonlLine(file);
            if (!rec)
                continue;
            const pct = Number.isFinite(rec.pct) ? Math.max(0, Math.min(100, rec.pct)) : 0;
            const msg = str(rec.msg);
            out.set(id, {
                id,
                name: str(rec.name),
                pct,
                msg,
                status: statusFrom(pct, msg, rec.state),
                spd: str(rec.spd),
                eta: str(rec.eta),
                updatedAt: mtimeMs,
            });
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object')
            continue;
        const rec = parsed;
        const rawProgress = Number(rec.progress);
        const pct = Number.isFinite(rawProgress)
            ? Math.max(0, Math.min(100, Math.round(rawProgress * 100)))
            : 0;
        const statusRaw = rec.status;
        const status = statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled'
            ? statusRaw
            : 'running';
        const updatedRaw = Number(rec.updatedAt);
        out.set(id, {
            id,
            name: str(rec.name),
            pct,
            // 轨道二没有独立的状态文案，沿用旧行为用任务名兜底
            msg: str(rec.name),
            status,
            spd: str(rec.speed),
            eta: str(rec.eta),
            updatedAt: Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : mtimeMs,
        });
    }
    return out;
}
/**
 * 读取下载任务进度快照。
 *
 * 只做只读扫描；两条轨道任一不可用都跳过，整体仍返回 ok=true（只要扫到任意任务）。
 *
 * @param limit 最多返回多少个任务，默认 10
 * @param taskId 指定任务 ID 时只返回该任务
 * @param session 当前会话；用于定位轨道一的目录（缺省时轨道一目录为 null）
 */
export function readDownloadStatus(limit = DEFAULT_STATUS_LIMIT, taskId, session) {
    const taskDir = resolveTaskProgressDir(session);
    const downloadDir = resolveDownloadProgressDir();
    const merged = new Map();
    // 先铺轨道二（JSON，含明确的 status/updatedAt），再用轨道一（JSONL，含 msg/spd/eta）覆盖补充
    for (const [id, task] of collectFromDir(downloadDir, '.json'))
        merged.set(id, task);
    if (taskDir) {
        for (const [id, task] of collectFromDir(taskDir, '.jsonl')) {
            const existing = merged.get(id);
            // 轨道一的 name 可能为空（老版本进度文件），此时保留轨道二给出的名字
            merged.set(id, existing ? { ...existing, ...task, name: task.name || existing.name } : task);
        }
    }
    let tasks = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (taskId)
        tasks = tasks.filter((t) => t.id === taskId);
    const total = tasks.length;
    const cap = Number.isFinite(limit) && limit > 0
        ? Math.min(MAX_STATUS_LIMIT, Math.floor(limit))
        : DEFAULT_STATUS_LIMIT;
    tasks = tasks.slice(0, cap);
    // taskDir 可能是 null（没有会话上下文且未设 DSH_PROGRESS_DIR）；schema 要求
    // string，因此统一收敛成空串，避免 download_status 因类型不合法而报错。
    return { ok: true, taskDir: taskDir ?? '', downloadDir, total, tasks };
}
