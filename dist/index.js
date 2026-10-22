import { defineTool } from '@deepseek-ai/dsh-tools';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { probeUrl } from './probe.js';
import { downloadWithAria2, downloadWithCurl, getAria2Path, } from './downloader.js';
import { decide, decideConcurrency, LARGE_FILE } from './decision.js';
import { ProgressReporter } from './progress.js';
import { applyMirror, isAutoMirror } from './mirror.js';
import { resolveAutoMirror } from './auto-mirror.js';
import { buildRequestHeaders } from './headers.js';
import { CHECKSUM_LABELS, HASH_VERIFIED_MESSAGE, checksumVerifiedMessage, describeHashFailure, hashFile, normalizeChecksum, normalizeSha256, sha256File, verifyChecksum, verifySha256, } from './hash.js';
import { checkDownloadUrl, deriveFilenameFromUrl, FALLBACK_FILENAME, filenameFromContentDisposition, sanitizeFilename, withConflictSuffix, } from './url.js';
import { checkDiskSpace, describeInsufficientSpace } from './disk.js';
import { registerStatusRpc } from './rpc.js';
import { DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT, readDownloadStatus } from './status.js';
import { clearMarker, localFileSize, planResume, writeMarker } from './resume.js';
import { recordThroughput } from './throughput-cache.js';
import { describeMismatch, describeSkip, normalizeContentEncoding, verifySize, } from './verify.js';
export const name = 'dsh-smart-dl';
export const inject = ['tools'];
/**
 * 完整性校验失败。
 *
 * 单独一个类型，是为了让 aria2 分支的 `catch` 能把它与「传输失败」分开：
 * 产物已经落盘且内容不对时，换 curl 重下同一个地址不会改变结果，只会让
 * 调用方白等一遍（传了 `sha256` 时尤其明显 —— 摘要不符是内容问题，不是
 * 传输问题）。普通 Error 仍然走「aria2 失败 → 回退 curl」那条既有路径。
 */
class IntegrityError extends Error {
}
/**
 * `download_status` 在没有任何任务时的固定文案。
 *
 * 定成常量而不是就地拼串，理由与 `verify.ts` 的跳过文案相同：它现在会被
 * 「读不到目录」的诊断信息**追加**在后面，两段文案必须各自可断言，
 * 不能靠一个模板字符串把两件事混成一件。
 */
export const NO_TASKS_TEXT = 'No download tasks found.';
/**
 * 目录扫描失败时的诊断后缀（没有失败时返回空串）。
 *
 * 为什么必须有：`tasks: []` 本身无法区分「目录读不到」与「确实没有任务」，
 * 而两者的下一步完全相反 —— 前者要去查权限/路径，后者什么都不用做。
 * 这条文案是 `scanFailedDirs` 字段在**模型可见回执**上的落点：只加字段不加
 * 文案的话，模型仍然只会看到那句「No download tasks found.」。
 */
function scanDiagnostic(value) {
    const failed = value.scanFailedDirs;
    if (!failed || failed.length === 0)
        return '';
    const lines = failed
        .slice()
        .sort()
        .map((dir) => `- ${dir}`)
        .join('\n');
    // 两个目录都读不到时才说「本次没有扫到任何任务」：只有一个失败时，另一个
    // 目录的扫描结果是可信的，那句结论会与上面列出的任务自相矛盾。
    // 措辞必须说「上面的空列表」—— 这段文案是追加在列表**之后**的。
    const lead = value.ok
        ? '部分进度目录读取失败（下列目录未被扫描）：'
        : '进度目录全部读取失败，本次没有扫到任何任务（上面的空列表不代表真的没有任务）：';
    return `\n${lead}\n${lines}\n下一步：确认这些目录是否存在、是否有读取权限；DSH_HOME 与 DSH_DOWNLOAD_PROGRESS_DIR 会决定它们的落点`;
}
/**
 * 生成任务 ID：`dl-<base36 时间>-<4 位随机>`。
 *
 * 批量调用会给每条目各生成一个（P0-5 要求「每条目一个 taskId」），因此抽成
 * 函数而不是留在 execute 里就地拼串。
 */
function makeTaskId() {
    return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
/**
 * 生成批次 ID：`b-<base36 时间>-<4 位随机>`。
 *
 * 单条目调用也生成一个（P0-5 要求「单条目的批次 id 也必须存在且唯一」），
 * 只是**不**出现在单条目返回值里 —— 那条路径的返回结构必须与 1.2.0 逐字段
 * 相同，它是给两条进度轨道做分组标签用的。
 *
 * 前缀特意与任务 ID 不同：两者会在同一批进度记录里并排出现，前缀不同才能一眼
 * 看出哪个是任务、哪个是批次。
 */
function makeBatchId() {
    return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
/**
 * 批量结果里每一行的状态标签。
 *
 * 定成常量而不是就地拼串：这三行是模型判断「该不该重试某几条」的唯一依据，
 * 措辞被某处顺手改掉就会与调用方的判断脱节（`failed` 与 `cancelled` 混为一谈
 * 正是 1.0.0 修过的坑，批量不能把它带回来）。
 */
const BATCH_LABEL_OK = '[ok]';
const BATCH_LABEL_SKIPPED = '[skipped]';
const BATCH_LABEL_FAILED = '[failed]';
const BATCH_LABEL_CANCELLED = '[cancelled]';
/**
 * 摘要校验通过时的模型可见标记。
 *
 * `sha256` 是 1.2.0 的旧字段，保持原来的 `(SHA-256 verified)` 逐字不变；
 * 通用 `checksum` 则按实际算法输出，避免把 MD5 说成 SHA-256。
 */
function verifiedNote(item) {
    if (item.sha256)
        return ' (SHA-256 verified)';
    if (!item.checksum)
        return '';
    const algorithm = item.checksumAlgorithm;
    const label = algorithm ? CHECKSUM_LABELS[algorithm] : 'checksum';
    return ` (${label} verified)`;
}
/**
 * 批量结果的模型可见文案：先给一行汇总，再逐条列出。
 *
 * 为什么必须逐条列出而不是只报「N 条成功 M 条失败」：D4=② 的落点就是「哪条成功、
 * 哪条失败、失败原因」，只给计数的话调用方仍然不知道要不要重试、重试哪一条。
 */
function renderBatch(value) {
    const head = `Batch ${value.batch}: ${value.succeeded} succeeded, ${value.failed} failed, ${value.cancelled} cancelled`;
    const lines = value.results.map((item) => {
        if (item.success) {
            const via = item.method ? ` via ${item.method}` : '';
            const path = item.path ? ` -> ${item.path}` : '';
            const label = item.skipped === true ? BATCH_LABEL_SKIPPED : BATCH_LABEL_OK;
            return `${label} ${item.url}${via}${path}${verifiedNote(item)}`;
        }
        const label = item.cancelled === true ? BATCH_LABEL_CANCELLED : BATCH_LABEL_FAILED;
        return `${label} ${item.url}${item.error ? `: ${item.error}` : ''}`;
    });
    return [head, ...lines].join('\n');
}
export function apply(ctx) {
    // 浏览器端进度面板的数据源；纯 CLI profile 下没有 connection 服务时静默跳过。
    registerStatusRpc(ctx);
    ctx.tools.register(defineTool({
        name: 'smart_download',
        description: 'Download a file with multi-threading when possible. It probes the server, then uses bundled aria2 with 4 or 8 connections based on file size, and automatically falls back to single-threaded curl if Range is unsupported, the file is small, or aria2 is unavailable. Resumes an interrupted download when the server supports Range. Pass the checksum printed in the project\'s official documentation as sha256 to verify the downloaded bytes against it, and pass userAgent / referer / headers when that documentation\'s download link needs them. Set mirror to a prefix such as "https://gh-proxy.com/" or to "auto" to accelerate a GitHub download. Pass targets instead of url to download several files in one call: each entry is verified and reported on its own, a failing entry never discards the entries that succeeded, and maxBandwidth caps the whole call. Poll progress with download_status.',
        parameters: {
            url: {
                type: 'string',
                // 不再是必填：url 与 targets 二选一（见 description）。
                // ⚠️ 这条「二选一」在本轮**没有**在 schema 层表达。表述限定在**当前版本**上，
                // 因为证据只覆盖手上这两个东西的形状（见 test/tool-schema.test.ts 的 DSL 探针用例）：
                // 按当前版本的 `ParameterSchemaSpec` / `parameterSchemaSpecToJsonSchema`，根节点
                // 是一个隐式开放属性表、只产出 `{ type, properties, required? }`，没有 oneOf 槽位。
                // 宿主若把 DSL 扩展出根级 oneOf，这句话就**过时**了（届时应该改这里的实现，
                // 而不是继续引用这段注释）—— 所以不要把它读成「schema 永远表达不了」。
                // 眼下的约束由 execute 的 resolveTargets 强制，因此把后果写进文案：
                // 两个都不给不是「用默认值」，而是被拒绝。
                description: 'The URL to download. Provide either url (one file) or targets (a batch), not both. Passing both, or neither, is rejected before any request is made.',
            },
            targets: {
                type: 'array',
                description: 'A batch of files to download in one call. Give either url (one file) or targets (a batch), not both: passing both, or neither, is rejected before any request is made. Every entry shares the other parameters (mirror / userAgent / referer / headers / maxBandwidth), and each entry gets its own output path, verification and progress record. Items run concurrently up to the plugin concurrency limit. A failing entry does not abort the batch: the result reports every entry individually. Maximum 50 entries per call (the progress API reads at most 50 tasks).',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        url: {
                            type: 'string',
                            required: true,
                            description: 'The URL to download for this entry',
                        },
                        output: {
                            type: 'string',
                            description: 'Output file path for this entry (optional; derived from the URL otherwise)',
                        },
                        sha256: {
                            type: 'string',
                            description: "Optional expected SHA-256 for this entry's bytes",
                        },
                        checksum: {
                            type: 'string',
                            description: "Optional expected checksum for this entry's bytes: md5/sha1/sha256/sha512, e.g. \"sha512:<hex>\" or a bare hex digest (the algorithm is inferred from its length). Mutually exclusive with sha256.",
                        },
                        ifExists: {
                            type: 'string',
                            enum: ['overwrite', 'skip', 'rename'],
                            description: 'What to do when this entry\'s output file already exists. Defaults to the call-level ifExists (or "overwrite").',
                        },
                    },
                },
            },
            maxBandwidth: {
                type: 'string',
                description: 'Optional total bandwidth cap shared by every task in this call, e.g. "2M", "500K" or a plain byte count like "1500000" (K/M/G are 1024-based). With a batch the cap is split across the entries running concurrently, so the whole batch stays under it. Passed to aria2 as --max-overall-download-limit and to curl as --limit-rate. An invalid value is rejected before any request is made.',
            },
            timeoutMs: {
                type: 'integer',
                description: `Optional per-entry timeout in milliseconds (${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}; 30 minutes is the cap because this tool is a synchronous call). When an entry exceeds it, that entry is terminated and reported as failed — in a batch the other entries keep running, and entries that already succeeded are never re-labelled. Omit it to wait indefinitely. An out-of-range value is rejected before any request is made.`,
            },
            output: {
                type: 'string',
                description: 'Output file path (optional)',
            },
            mirror: {
                type: 'string',
                description: 'Optional mirror prefix prepended to the URL, e.g. "https://gh-proxy.com/" or "ghfast.top". Used to accelerate GitHub release downloads. Ignored for non-http(s) URLs. Pass the literal "auto" to let the plugin choose a built-in GitHub mirror that is proven to serve the same file (identical length, and identical ETag whenever the origin sends one); "auto" applies to GitHub hosts only and falls back to the original URL when no candidate can be confirmed.',
            },
            sha256: {
                type: 'string',
                description: 'Optional expected SHA-256 of the file, e.g. the checksum printed in the project\'s official documentation. Accepts bare hex, "sha256:<hex>", "SHA256(<hex>)" and SRI "sha256-<base64>". The downloaded bytes are hashed and compared; a mismatch fails the download. A byte-length check alone cannot detect a payload that is the right size but the wrong content.',
            },
            checksum: {
                type: 'string',
                description: 'Optional expected checksum of the file, for projects that publish MD5 / SHA-1 / SHA-512 instead of SHA-256. Accepts "md5:<hex>", "sha1:<hex>", "sha256:<hex>", "sha512:<hex>", or a bare hex digest whose algorithm is inferred from its length (32=md5, 40=sha1, 64=sha256, 128=sha512). Mutually exclusive with sha256. A mismatch fails the download and reports both digests.',
            },
            ifExists: {
                type: 'string',
                enum: ['overwrite', 'skip', 'rename'],
                description: 'What to do when the output file already exists: "overwrite" (default, replaces it), "skip" (download nothing, return skipped: true; an existing file is still checksum-verified when a checksum was given), or "rename" (save as "name (1).ext" without touching the existing file). Resume is disabled for rename, since continuing into a different filename is never correct.',
            },
            userAgent: {
                type: 'string',
                description: 'Optional User-Agent header. Used for both the size probe and the download, so the two never disagree.',
            },
            referer: {
                type: 'string',
                description: 'Optional Referer header. Used for both the size probe and the download.',
            },
            headers: {
                type: 'object',
                additionalProperties: true,
                description: 'Optional extra request headers as a "Name": "value" map, e.g. {"Authorization": "Bearer …"}. Merged with userAgent / referer, which win on conflicts. Headers the plugin manages itself (Range, Accept-Encoding, Host, …) are rejected.',
            },
        },
        output: {
            schema: {
                // 两种返回形态互斥：单条目（success/method/...）与批量（batch/results/...）。
                // 用 oneOf 而不是「一个大对象塞两种字段」：后者要么放过拼错的字段，要么让
                // 两种形态互相污染；而「单条目返回结构与 1.2.0 逐字段相同」这条硬约束，
                // 正好由「分支一不认 batch/results」保住。
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            success: { type: 'boolean' },
                            path: { type: 'string' },
                            method: { type: 'string' },
                            size: { type: 'number' },
                            fellback: { type: 'boolean' },
                            reason: { type: 'string' },
                            verifySkipped: { type: 'string' },
                            sha256: { type: 'string' },
                            checksum: { type: 'string' },
                            checksumAlgorithm: { type: 'string' },
                            skipped: { type: 'boolean' },
                            diskCheckSkipped: { type: 'string' },
                            requestedUrl: { type: 'string' },
                            mirrored: { type: 'boolean' },
                            mirror: { type: 'string' },
                            mirrorSkipped: { type: 'string' },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            batch: { type: 'string' },
                            succeeded: { type: 'integer' },
                            failed: { type: 'integer' },
                            cancelled: { type: 'integer' },
                            results: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        url: { type: 'string' },
                                        output: { type: 'string' },
                                        success: { type: 'boolean' },
                                        cancelled: { type: 'boolean' },
                                        error: { type: 'string' },
                                        method: { type: 'string' },
                                        path: { type: 'string' },
                                        size: { type: 'number' },
                                        fellback: { type: 'boolean' },
                                        reason: { type: 'string' },
                                        verifySkipped: { type: 'string' },
                                        sha256: { type: 'string' },
                                        checksum: { type: 'string' },
                                        checksumAlgorithm: { type: 'string' },
                                        skipped: { type: 'boolean' },
                                        diskCheckSkipped: { type: 'string' },
                                        requestedUrl: { type: 'string' },
                                        mirrored: { type: 'boolean' },
                                        mirror: { type: 'string' },
                                        mirrorSkipped: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                ],
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    // 分支一的文案逐字保留（1.2.0 回归项）；批量走另一条文案。
                    text: 'results' in value
                        ? renderBatch(value)
                        : value.skipped === true
                            ? `Download skipped (already exists): ${value.path}${verifiedNote(value)}${value.mirrorSkipped ? ` (${value.mirrorSkipped})` : ''}`
                            : `Download ${value.success ? 'succeeded' : 'failed'}${value.method ? ` via ${value.method}` : ''}${value.fellback && value.reason ? ` (fallback: ${value.reason})` : ''}${value.mirrored ? ' (via mirror)' : ''}${value.verifySkipped ? ` (${value.verifySkipped})` : ''}${verifiedNote(value)}${value.diskCheckSkipped ? ` (${value.diskCheckSkipped})` : ''}${value.mirrorSkipped ? ` (${value.mirrorSkipped})` : ''}`,
                },
            ],
        },
        async execute(args, exec) {
            // 0a. 带宽上限与单条目超时：非法值都在**发起任何请求之前**拒绝（同一套做法）。
            //     放到后面等于先下了几百 MB 再告诉调用方参数写错了。
            const maxBandwidthBytes = parseMaxBandwidth(args.maxBandwidth);
            const timeoutMs = parseTimeoutMs(args.timeoutMs);
            // 0b. url / targets 二选一；超批量上限也在这里拒绝（都不发请求）。
            const dispatch = resolveTargets(args);
            const header = exec.agent?.session?.header;
            const session = { id: header?.id, cwd: header?.cwd };
            const shared = {
                exec,
                session,
                mirror: args.mirror,
                userAgent: args.userAgent,
                referer: args.referer,
                headers: args.headers,
                timeoutMs,
            };
            // 1. 单条目：与 1.2.0 完全同一条路径（同一个 downloadOne，抛错照抛）
            if (dispatch.kind === 'single') {
                return downloadOne(dispatch.item, {
                    ...shared,
                    batchId: makeBatchId(),
                    maxBandwidthBytes,
                });
            }
            // 2. 批量：窗口按「批内总连接数有界」反推（推导与「为什么」见 batchWindow）；
            //    失败/取消逐条返回（D4=②）
            const limit = batchWindow(decideConcurrency(LARGE_FILE));
            // 实际并发位：条目比窗口少时按条目数算 —— 否则 2 条的批次也按窗口份分带宽，
            // 用户给的上限会被白白用掉不到四分之一。
            const workers = Math.min(limit, dispatch.targets.length);
            const batchId = makeBatchId();
            // 带宽上限是**一批内共享**的，因此按实际并发位均分：一批的合计吞吐不会超过
            // 用户给的那个数。这里不需要任何跨调用状态 —— smart_download 未声明
            // isConcurrencySafe，DSH 保证同一时刻只有一个调用在跑（exclusive）。
            const perItem = maxBandwidthBytes === undefined
                ? undefined
                : Math.max(1, Math.floor(maxBandwidthBytes / workers));
            const results = await runBatch(dispatch.targets, { ...shared, batchId, maxBandwidthBytes: perItem }, workers);
            return {
                batch: batchId,
                results,
                succeeded: results.filter((item) => item.success).length,
                failed: results.filter((item) => !item.success && item.cancelled !== true).length,
                cancelled: results.filter((item) => item.cancelled === true).length,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'download_status',
        description: 'Query the progress of downloads started by smart_download. Returns a read-only snapshot of recent tasks (id, percentage, status, speed, ETA) read from the plugin progress directories. Pass taskId to look up one task, or omit it to list the most recent ones.',
        parameters: {
            taskId: {
                type: 'string',
                description: 'Optional task id returned by an earlier download; omit to list recent tasks',
            },
            limit: {
                type: 'integer',
                description: `Maximum number of tasks to return (default ${DEFAULT_STATUS_LIMIT})`,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    taskDir: { type: 'string' },
                    downloadDir: { type: 'string' },
                    total: { type: 'integer' },
                    // 可选：只在真的有目录读不到时出现（见 status.ts 的字段注释）。
                    // 它的存在与否就是「读不到」与「没有任务」之间的区分信号。
                    scanFailedDirs: { type: 'array', items: { type: 'string' } },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                pct: { type: 'integer' },
                                msg: { type: 'string' },
                                status: { type: 'string' },
                                spd: { type: 'string' },
                                eta: { type: 'string' },
                                // 1.3.0：批次 ID。tasks 项是 additionalProperties:false，
                                // 少了这一行，任何带批次 ID 的任务都会让 tool 输出校验失败。
                                batch: { type: 'string' },
                                // 1.4.0：输出路径与产物指纹。同一处陷阱：tasks 项是
                                // additionalProperties:false，StatusSnapshot 里多出这三个字段
                                // 而 schema 没补，下载管理器要用的任务就会让 tool 输出校验失败。
                                outPath: { type: 'string' },
                                size: { type: 'number' },
                                fileMtimeMs: { type: 'number' },
                                updatedAt: { type: 'number' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    // 为什么把「读不到」的提示拼在文案后面而不是替换掉列表：这两种信息
                    // 可以同时成立 —— 一个目录读不到、另一个目录里仍有任务。替换掉列表
                    // 会让调用方以为「什么都没有」，而其实手上就有可用的任务快照。
                    text: (value.tasks.length === 0
                        ? NO_TASKS_TEXT
                        : value.tasks
                            .map((t) => `${t.name || t.id}: ${t.pct}% (${t.status})${t.spd ? ` ${t.spd}` : ''}${t.eta ? ` eta ${t.eta}` : ''}`)
                            .join('\n')) + scanDiagnostic(value),
                },
            ],
        },
        async execute(args, exec) {
            // 纯只读：不写文件、不联网。
            // 带上会话上下文，才能扫到本次会话写在 <cwd>/.dsh-progress/<id>/ 的轨道一；
            // 拿不到会话时退化为只扫轨道二（与 0.5.0 之前的行为一致）。
            const header = exec.agent?.session?.header;
            const session = { id: header?.id, cwd: header?.cwd };
            return readDownloadStatus(args.limit, args.taskId, session);
        },
    }));
}
/**
 * 下载单个条目（原 execute 主体，逐字保留其校验顺序与失败语义）。
 *
 * 为什么把这些行原样搬出来而不是在批量里另写一份：单条目路径的返回结构与文案
 * 必须与 1.2.0 逐字段相同，唯一能保证这点的办法就是**同一条代码路径**。批量只是
 * 在它外面加了一层「逐条收集结果」的编排。
 *
 * 失败时抛错（与单条目语义一致）；批量编排负责把抛错变成逐条结果。
 */
async function downloadOne(item, ctx) {
    // 0. 协议白名单：URL 可能来自模型读到的任意页面，必须先收紧到 http(s)。
    // 实测（0.4.1）file:// 会被 curl 接受并复制本地文件到目标路径。
    const checked = checkDownloadUrl(item.url);
    if (!checked.ok) {
        throw new Error(`拒绝下载：${checked.reason}`);
    }
    // 0b. 期望摘要：不合法就地拒绝。等到下载完才发现「没法校验」，
    // 等于白下几百 MB 之后才告诉调用方参数写错了。
    if (item.sha256 !== undefined && item.checksum !== undefined) {
        throw new Error('拒绝下载：sha256 与 checksum 只能二选一 —— 前者专用于 SHA-256，后者可指定任意受支持算法；' +
            '两个都给会让「该信哪个摘要」有两种答案');
    }
    let expectedSha256;
    if (item.sha256 !== undefined) {
        const normalized = normalizeSha256(item.sha256);
        if (!normalized) {
            throw new Error(`拒绝下载：sha256 不是合法的 SHA-256 摘要（${JSON.stringify(item.sha256)}）` +
                '；接受 64 位十六进制、sha256:<hex>、SHA256(<hex>) 或 SRI 的 sha256-<base64>');
        }
        expectedSha256 = normalized;
    }
    let expectedChecksum;
    if (item.checksum !== undefined) {
        const normalized = normalizeChecksum(item.checksum);
        if (!normalized) {
            throw new Error(`拒绝下载：checksum 不是合法的摘要（${JSON.stringify(item.checksum)}）` +
                '；接受裸十六进制（32=md5、40=sha1、64=sha256、128=sha512）、' +
                'md5:/sha1:/sha256:/sha512: 前缀，或 sha256-/sha512- 的 SRI 写法');
        }
        expectedChecksum = normalized;
    }
    // 0c. 同名文件策略：三个值之外一律拒绝，避免把拼错的值静默当成 overwrite。
    const ifExists = item.ifExists ?? 'overwrite';
    if (ifExists !== 'overwrite' && ifExists !== 'skip' && ifExists !== 'rename') {
        throw new Error(`拒绝下载：ifExists 必须是 overwrite / skip / rename 之一（收到 ${JSON.stringify(item.ifExists)}）`);
    }
    // 0d. 请求头：UA / Referer / 自定义合成一份，探测与下载共用同一份。
    // 两边不一致会让探测结论与真实下载错位（见 src/headers.ts 文件头）。
    const headerResult = buildRequestHeaders({
        userAgent: ctx.userAgent,
        referer: ctx.referer,
        headers: ctx.headers,
    });
    if (!headerResult.ok) {
        throw new Error(`拒绝下载：${headerResult.reason}`);
    }
    const requestHeaders = headerResult.headers;
    // 1. 镜像：显式前缀走拼接；`auto` 必须先拿到原始地址的指纹才能挑候选，
    //    因此自动模式的解析推迟到探测之后（见下方 2b）。
    const autoMirrorRequested = isAutoMirror(ctx.mirror);
    let requestedUrl = autoMirrorRequested ? item.url : applyMirror(item.url, ctx.mirror);
    let mirrored = requestedUrl !== item.url;
    let mirrorPrefix;
    let mirrorSkipped;
    // 输出文件名始终按原始 URL 推导，避免把镜像域名带进文件名。
    // 探测前只能按 URL 猜一个临时名；真实文件名可能只在 Content-Disposition 里，
    // 因此探测完成后会重新确定最终路径（见下方 2c）。
    //
    // 1.4.0：这里就把路径**解析成绝对路径**，后续所有消费点（aria2 的 `-o`、
    // 建目录、续传指纹、校验、以及记录进进度文件的 outPath）共用同一个字符串。
    // 为什么必须在这里定死：子进程**没有**指定 cwd（见 downloader.ts 的 spawn），
    // 相对路径的含义取决于 Host 进程的 cwd —— 完成时再 resolve 一次，一旦 cwd
    // 变了就会指向另一个文件，而下载管理器会拿这个路径去删除。解析一次、复用，
    // 是这个风险唯一的收口点。`resolve` 对已经是绝对路径的输入是幂等的。
    const provisionalPath = path.resolve(item.output ?? deriveFilenameFromUrl(item.url));
    const taskId = makeTaskId();
    // 会话上下文（轨道一的落点）由**调用**构造一次并放在 ctx 里：每一批的条目
    // 共用同一份，条目之间不会出现「同一批写了两个会话目录」的分叉。
    const reporter = new ProgressReporter(taskId, provisionalPath, ctx.session, ctx.batchId, provisionalPath);
    // 单条目的超时信号：与整批信号合并（AbortSignal.any），因此超时只终止这一条，
    // 同批其它条目照常跑。为什么不用 Promise.race：子进程必须**真的**被结束
    // （runProcess 的 SIGTERM → SIGKILL 兜底），race 只会让调用方提前返回、把进程留在后台。
    const timeoutSignal = ctx.timeoutMs === undefined ? undefined : AbortSignal.timeout(ctx.timeoutMs);
    const signal = timeoutSignal ? AbortSignal.any([ctx.exec.signal, timeoutSignal]) : ctx.exec.signal;
    const timeoutMessage = ctx.timeoutMs === undefined ? '' : describeTimeout(ctx.timeoutMs);
    /**
     * 这一条被中止时的原因分类。
     *
     * 判定顺序是刻意的：两个信号同时成立时「用户按了取消」是更准确的原因（超时只是
     * 兜底），先判超时会让用户以为自己没按过取消。
     */
    const abortOutcome = () => ctx.exec.signal.aborted ? 'cancelled' : timeoutSignal?.aborted === true ? 'timeout' : 'failed';
    /**
     * 中止（取消 / 超时）的唯一收口：写**一次**终态记录，返回要抛出的错误。
     *
     * 为什么需要收口：探测、aria2、curl 三段都可能中止，外层兜底也会调它 —— 各写各的
     * 会把同一件事在两张轨道上记两遍。为什么超时抛专门的错误类型：runBatch 据此把这一条
     * 标成**失败**（超时不是用户取消，两者在面板上是两个状态）。
     */
    let abortRecorded;
    const finishAborted = (err) => {
        abortRecorded ??= (async () => {
            if (abortOutcome() === 'timeout') {
                reporter.fail(timeoutMessage);
                await reporter.awaitFlush();
                throw new DownloadTimeoutError(timeoutMessage);
            }
            reporter.cancel();
            await reporter.awaitFlush();
            throw err;
        })();
        return abortRecorded;
    };
    // 2. 探测目标 URL（自动镜像模式下，这一步探测的就是原始地址）
    reporter.report(0, '探测中…');
    let probe;
    try {
        probe = await probeUrl(requestedUrl, signal, { headers: requestHeaders });
    }
    catch (err) {
        // 探测阶段也可能被取消/超时：不兜住的话该任务会在两张轨道上永远停在 running
        // （面板要等 10 分钟才会忽略它），而它其实已经结束了。
        if (abortOutcome() !== 'failed')
            return await finishAborted(err);
        throw err;
    }
    // 2b. 自动镜像：候选必须被**证实与原地址同源**才采用 —— 长度完全一致，
    //     且原始地址给了 ETag 时候选也必须给出相等的 ETag。任何一条不满足
    //     就退回原始地址：宁可慢，也不接受一个无法证实的来源。
    //     三条「不启用」的路径与判定都收在 resolveAutoMirror 里，便于单测。
    if (autoMirrorRequested) {
        let resolution;
        try {
            resolution = await resolveAutoMirror(item.url, { contentLength: probe.contentLength, etag: probe.etag }, async (candidateUrl) => {
                const candidateProbe = await probeUrl(candidateUrl, signal, {
                    headers: requestHeaders,
                });
                return {
                    ok: candidateProbe.contentLength !== undefined,
                    contentLength: candidateProbe.contentLength,
                    etag: candidateProbe.etag,
                };
            });
        }
        catch (err) {
            // 候选镜像的探测同样可能被取消/超时打断（这里会连起好几个 5s 超时的请求）
            if (abortOutcome() !== 'failed')
                return await finishAborted(err);
            throw err;
        }
        requestedUrl = resolution.url;
        mirrored = resolution.mirrored;
        mirrorPrefix = resolution.mirror;
        mirrorSkipped = resolution.skipped;
        if (resolution.reason)
            reporter.report(0, resolution.reason);
    }
    // 探测可能拿不到文件大小（HEAD 失败 / 超时 / chunked 无 Content-Length）。
    // dsh-tools 会把含 undefined 的结果判为非法 JSON 并抛 ToolOutputError，
    // 因此 size 只在有值时出现（见下方各 return 的条件展开）。
    const sizeField = probe.contentLength === undefined ? {} : { size: probe.contentLength };
    // 2c. 最终落盘路径：探测之后才可能知道真实文件名（Content-Disposition）。
    //
    // 显式 output 永远优先；否则先看服务器给的文件名，再回落到 URL 推导。
    // Content-Disposition 完全由服务器控制，必须先净化成单个路径段 ——
    // 否则 `filename="../../x"` 会把文件写到输出目录之外。
    let outputPath = provisionalPath;
    if (item.output !== undefined) {
        outputPath = path.resolve(item.output);
    }
    else {
        const urlName = deriveFilenameFromUrl(item.url);
        const headerName = filenameFromContentDisposition(probe.contentDisposition);
        const safeHeaderName = headerName === undefined ? undefined : sanitizeFilename(headerName);
        const chosen = safeHeaderName && safeHeaderName !== FALLBACK_FILENAME
            ? safeHeaderName
            : urlName !== FALLBACK_FILENAME
                ? urlName
                : (safeHeaderName ?? urlName);
        outputPath = path.resolve(chosen);
    }
    // rename：从 1 开始找第一个不存在的候选名，绝不覆盖已有文件。
    // 同时禁用续传：半包属于另一个文件名，接着写只会拼出错误内容。
    if (ifExists === 'rename') {
        const dir = path.dirname(outputPath);
        const name = path.basename(outputPath);
        let index = 1;
        while (existsSync(outputPath)) {
            outputPath = path.join(dir, withConflictSuffix(name, index));
            index += 1;
        }
    }
    // 探测期间 reporter 用的是临时名；这里修正为最终名与最终绝对路径，
    // 否则面板 / download_status 会显示一个从未落盘的文件名。
    // label 与 1.4.x 一样保留完整路径（进度面板与既有测试都按它核对产物归属）。
    reporter.setTarget(outputPath, outputPath);
    // 完整性校验：下载工具退出码 0 只代表「它认为完成了」，不代表字节数对
    // （服务器提前断开、镜像返回 200 的错误页、磁盘写满…都不会有非零退出码）。
    // 校验失败一律抛错，并且**不**清除旁车指纹 —— 保留它，下次才有得比。
    //
    // 两层校验，各自独立：
    //   1. 落盘字节数 vs 远端声明长度（`verifySize`）—— 挡得住截断与多发，
    //      挡不住「等长但内容不同」；
    //   2. 调用方给的 SHA-256（`verifySha256`）—— 逐字节内容证明，且不依赖
    //      任何远端信息，因此第 1 层「跳过」时它依然能给出确定结论。
    //
    // 返回 `verifySkipped` 是「没有做字节数校验」的说明文案（没有跳过时为
    // 空串）：0.9.0 之前跳过与通过共用 `{ kind: 'ok' }`，调用方无从区分，
    // 于是「压根没测」的下载和「测过且一致」的下载长得一模一样。
    const assertIntegrity = async (completionPrefix = '下载完成') => {
        const outcome = verifySize(localFileSize(outputPath), probe.contentLength, probe.contentEncoding);
        if (outcome.kind === 'mismatch') {
            const message = describeMismatch(outcome);
            reporter.fail(message);
            await reporter.awaitFlush();
            throw new IntegrityError(message);
        }
        // 正向记录：跳过不是静默。终态文案必须写明「没做字节数校验」，
        // 否则它在进度面板与 download_status 里会与「校验通过」长得一样。
        const note = outcome.kind === 'skipped' ? describeSkip(outcome) : '';
        if (expectedSha256 !== undefined) {
            const hashOutcome = verifySha256(expectedSha256, await sha256File(outputPath));
            if (hashOutcome.kind !== 'ok') {
                // 文案映射收在 hash.ts 里（见 describeHashFailure 的注释）：
                // 这里不再有自己的分支，两条失败路径都由那个纯函数覆盖。
                const message = describeHashFailure(hashOutcome);
                reporter.fail(message);
                await reporter.awaitFlush();
                throw new IntegrityError(message);
            }
            // 内容已逐字节核对：终态写明「已校验」，并且**不**再报「未做字节数
            // 校验」—— 长度那层即便跳过，内容也已经验过了，再报只会误导。
            reporter.done(`${completionPrefix}（${HASH_VERIFIED_MESSAGE}）`);
            await reporter.awaitFlush();
            return { verifySkipped: '', sha256: hashOutcome.digest };
        }
        if (expectedChecksum !== undefined) {
            const actual = await hashFile(outputPath, expectedChecksum.algorithm);
            const hashOutcome = verifyChecksum(expectedChecksum, actual);
            if (hashOutcome.kind !== 'ok') {
                const message = describeHashFailure(hashOutcome);
                reporter.fail(message);
                await reporter.awaitFlush();
                throw new IntegrityError(message);
            }
            reporter.done(`${completionPrefix}（${checksumVerifiedMessage(expectedChecksum)}）`);
            await reporter.awaitFlush();
            return {
                verifySkipped: '',
                checksum: hashOutcome.digest,
                checksumAlgorithm: expectedChecksum.algorithm,
            };
        }
        if (note) {
            reporter.done(`${completionPrefix}（${note}）`);
            await reporter.awaitFlush();
        }
        return { verifySkipped: note };
    };
    // 三个成功出口共用一份返回构造：字段顺序与条件展开只写一次，
    // 避免「某条路径忘了带 sha256 / mirrorSkipped」这类静默缺失。
    const successResult = (method, fellback, reason, integrity) => ({
        requestedUrl,
        mirrored,
        ...(mirrorPrefix ? { mirror: mirrorPrefix } : {}),
        ...(mirrorSkipped ? { mirrorSkipped } : {}),
        success: true,
        path: outputPath,
        method,
        ...sizeField,
        fellback,
        reason,
        ...(integrity.verifySkipped ? { verifySkipped: integrity.verifySkipped } : {}),
        ...(integrity.sha256 ? { sha256: integrity.sha256 } : {}),
        ...(integrity.checksum ? { checksum: integrity.checksum } : {}),
        ...(integrity.checksumAlgorithm
            ? { checksumAlgorithm: integrity.checksumAlgorithm }
            : {}),
        ...(diskCheckSkipped ? { diskCheckSkipped } : {}),
    });
    // 3. ifExists=skip：目标已存在时不再发下载请求。
    //
    // 有摘要时仍然校验已有文件 —— 「跳过下载」不等于「放弃验证」。校验失败
    // 必须抛错并保留原文件，不能把一个坏文件报成 skipped 成功。
    if (ifExists === 'skip' && existsSync(outputPath)) {
        const integrity = expectedSha256 !== undefined || expectedChecksum !== undefined
            ? await assertIntegrity('文件已存在（已跳过下载）')
            : { verifySkipped: '' };
        if (expectedSha256 === undefined && expectedChecksum === undefined) {
            reporter.done('下载跳过（文件已存在）');
            await reporter.awaitFlush();
        }
        return {
            requestedUrl,
            mirrored,
            ...(mirrorPrefix ? { mirror: mirrorPrefix } : {}),
            ...(mirrorSkipped ? { mirrorSkipped } : {}),
            success: true,
            path: outputPath,
            ...sizeField,
            fellback: false,
            skipped: true,
            ...(integrity.verifySkipped ? { verifySkipped: integrity.verifySkipped } : {}),
            ...(integrity.sha256 ? { sha256: integrity.sha256 } : {}),
            ...(integrity.checksum ? { checksum: integrity.checksum } : {}),
            ...(integrity.checksumAlgorithm
                ? { checksumAlgorithm: integrity.checksumAlgorithm }
                : {}),
        };
    }
    // 4. 磁盘空间预检：大小已知且响应未被压缩时才有意义（压缩后长度与落盘
    // 字节数不可比）。statfs 不可用只记录原因，不阻断下载。
    let diskCheckSkipped;
    if (probe.contentLength !== undefined && normalizeContentEncoding(probe.contentEncoding) === undefined) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        const disk = await checkDiskSpace(path.dirname(outputPath), probe.contentLength);
        if (disk.checked && !disk.ok) {
            const message = describeInsufficientSpace(disk.free, disk.required);
            reporter.fail(message);
            await reporter.awaitFlush();
            throw new Error(message);
        }
        if (!disk.checked)
            diskCheckSkipped = disk.reason;
    }
    // 是否启用断点续传（0.6.0 起前置一层安全校验）。
    // 仅凭「服务器支持 Range」就续传是不够的：curl -C - 与 aria2 -c 都只看
    // 本地文件长度，实测在「远端变小」「等长但内容变了」两种场景下都是退出码
    // 0 而文件是错的。planResume() 会比对远端长度与 ETag / Last-Modified，
    // 无法证实同源时删掉本地半包全量重下（详见 src/resume.ts）。
    const resumePlan = planResume(outputPath, probe, probe.supportsMultiThread && ifExists !== 'rename');
    const resume = resumePlan.resume;
    if (resumePlan.discarded) {
        reporter.report(0, resumePlan.reason);
    }
    // 记下本次远端资源的指纹：此后留下的任何半包都对应这个指纹，
    // 下次续传时才有得比（否则只能靠长度，挡不住「等长但内容变了」）。
    // 下载失败时刻意保留，成功完成时才清除。
    if (probe.contentLength !== undefined)
        writeMarker(outputPath, probe);
    // 3. 决策：按文件大小与 aria2 可用性选择方式 / 并发
    const aria2Path = getAria2Path();
    // 第 4 个入参是**历史吞吐缓存**：P1-2 的读侧。必须在这里传进去 —— t24 之前漏了它，
    // 于是写入侧写了、读侧实现了，却从来没有人喂过数据，抬档在真实调用里一次都没发生过
    // （对外宣称的 P1「按历史吞吐抬档」随之完全失效）。
    // 键用 `requestedUrl`（镜像已解析后的地址）：缓存按主机 + 端口分桶，而写入侧
    // （recordObservedThroughput）用的也是同一个地址 —— 读写两边必须同键，否则永远命中不了。
    const decision = decide(probe, aria2Path !== null, {}, { url: requestedUrl });
    // 4. aria2 路径
    if (decision.method === 'aria2' && aria2Path) {
        reporter.report(0, `启动 aria2（${decision.concurrency} 连接）…`);
        try {
            const observation = await downloadWithAria2(aria2Path, requestedUrl, outputPath, decision.concurrency, signal, reporter, 
            // `resume` 必须显式传（1.2.0 修正）：此前这里漏传、走的是默认值
            // true，等于 `planResume()` 的结论对 aria2 完全不起作用。它至今
            // 没暴露成缺陷，只是因为「判定不能续传时必然先删掉本地半包」，
            // 于是 `-c` 恰好落在一个不存在的文件上 —— 这是巧合，不是设计。
            resume, requestHeaders, ctx.maxBandwidthBytes);
            reporter.done();
            // 进度写盘已异步化（src/progress.ts），终态记录必须落盘后再返回，
            // 否则 download_status / 轨道一读取方会看到上一次的中间状态。
            await reporter.awaitFlush();
            const integrity = await assertIntegrity();
            clearMarker(outputPath);
            // 观测值写进吞吐缓存（P1-2 写入侧）：**放在完整性校验通过之后**。
            // 校验失败说明这次的字节不可信（服务器给了错误页 / 连接被截断），那种速度不代表
            // 这台主机的能力 —— 进中位数就是污染。
            recordObservedThroughput(requestedUrl, observation);
            return successResult('aria2', false, decision.reason, integrity);
        }
        catch (err) {
            const aria2Message = err instanceof Error ? err.message : String(err);
            // 取消与失败必须分开上报（1.0.0 修正）：二者在面板与
            // download_status 里是两个不同状态，混成一个会让用户以为「下载坏了」，
            // 而实际上是他自己按了取消。另外 signal 已经 abort 时再回退 curl
            // 只会立刻再失败一次，白白多跑一趟子进程；**超时同理** —— 回退等于把
            // 同一份等待再花一遍，因此超时也走这条「不回退」的路，只是终态记成失败。
            if (abortOutcome() !== 'failed')
                return await finishAborted(err);
            // 完整性校验失败**不**回退 curl（1.2.0 修正，见 IntegrityError）：
            // 产物已经落盘且内容不对，换一个下载器重下同一个地址不会改变结果。
            if (err instanceof IntegrityError)
                throw err;
            // aria2 失败，降级到 curl
            reporter.report(0, 'aria2 失败，回退 curl…');
            try {
                await downloadWithCurl(requestedUrl, outputPath, ctx.exec.signal, reporter, resume, requestHeaders, ctx.maxBandwidthBytes);
                reporter.done('下载完成（curl 回退）');
                await reporter.awaitFlush();
                const integrity = await assertIntegrity();
                clearMarker(outputPath);
                return successResult('curl', true, `aria2 失败: ${aria2Message}`, integrity);
            }
            catch (curlErr) {
                // 失败文案必须是**真正**抛出的那个错误：curl 也失败时，用户要看到
                // 的是 curl 的失败原因；aria2 的原因已经在上面作为回退理由记录了。
                // 0.9.0 之前这里传的是 aria2Message，进度里写着 aria2 的错，抛出的
                // 却是 curlErr —— 排查时会对不上。
                const curlMessage = curlErr instanceof Error ? curlErr.message : String(curlErr);
                // 取消 → cancelled、超时 → failed（超时不是用户取消）；两者都不再回退。
                if (abortOutcome() !== 'failed')
                    return await finishAborted(curlErr);
                reporter.fail(curlMessage);
                await reporter.awaitFlush();
                throw curlErr;
            }
        }
    }
    // 5. 决策为 curl（不支持 Range / 文件小 / aria2 缺失）
    reporter.report(0, `使用 curl：${decision.reason}`);
    try {
        await downloadWithCurl(requestedUrl, outputPath, signal, reporter, resume, requestHeaders, ctx.maxBandwidthBytes);
        reporter.done();
        await reporter.awaitFlush();
        const integrity = await assertIntegrity();
        clearMarker(outputPath);
        return successResult('curl', decision.fellback, decision.reason, integrity);
    }
    catch (err) {
        // 取消 → cancelled、超时 → failed（超时不是用户取消，见 finishAborted）
        if (abortOutcome() !== 'failed')
            return await finishAborted(err);
        reporter.fail(err instanceof Error ? err.message : String(err));
        await reporter.awaitFlush();
        throw err;
    }
}
/**
 * 批内滑动窗口宽度：按「批内总连接数有界」反推。
 *
 * 为什么不再是「单条目最高档」：单文件上限压在 8 的理由是「避免触发服务器按 IP 限
 * 并发」（src/decision.ts 的注释），而 8 条 × 每条 8 连接 = 峰值 64 连接，正好违背
 * 那个既定取舍。
 *
 * 为什么是「反推」而不是写死一个 2：窗口与「一条会占几个连接」是耦合的 ——
 * decision.ts 的档位阶梯一旦调整，写死的窗口会静默失真（既省不下连接、又不够并发）。
 * 因此预算与档位都从 decideConcurrency() 来：
 *
 *   批内连接预算 = 单条目最高档 × 2
 *
 * 为什么是两倍（而不是一倍或四倍）：批次里的各条目往往喂不满自己的分片上限 ——
 * 分片数要够多、服务器要够快；两倍是愿意为「批量比单文件快」多冒的连接风险上限。
 *
 *   窗口 = 预算 ÷ 单条目可能占用的连接数
 *
 * 代入当前阶梯（小文件 4 / 大文件 8）：每条 8 连接时窗口 2、每条 4 连接时窗口 4，
 * 两种情况峰值都是 16。批量在开工前并不知道各条目的大小（那要逐条探测），因此统一
 * 按最高档保守计算 —— 当前实际窗口恒为 2。单条目内部开 4 还是 8 仍由 decide() 按
 * 实际大小决定，与本窗口互不影响。
 *
 * @param perItemTier 单条目可能占用的连接数（当前传最高档，见上）
 */
function batchWindow(perItemTier) {
    const budget = decideConcurrency(LARGE_FILE) * 2;
    return Math.max(1, Math.floor(budget / perItemTier));
}
/** 批量上限：与进度读取端的 MAX_STATUS_LIMIT 对齐，理由见 resolveTargets。 */
const MAX_BATCH_TARGETS = MAX_STATUS_LIMIT;
/** url 与 targets 同时给出时的拒绝文案（固定文案，便于断言）。 */
const BOTH_URL_AND_TARGETS = '拒绝下载：url 与 targets 只能二选一 —— url 下载单个文件，targets 一次下载一批；两个都给会让「到底下了什么」有两种答案';
/** 两个都没给时的拒绝文案。 */
const NEITHER_URL_NOR_TARGETS = '拒绝下载：必须提供 url（下载单个文件）或 targets（一次下载一批）';
/** 批量被整批取消时，未完成条目的固定原因文案。 */
const BATCH_CANCELLED = '已取消：整批调用被取消，该条目未完成（已完成条目的结果不受影响）';
/**
 * 归一化本次调用的目标：单条目返回 { kind:'single' }，批量返回 { kind:'batch' }。
 *
 * 三条拒绝路径都在**发起任何请求之前**：同时给 url 与 targets、两个都不给、超过
 * 批量上限。为什么超限要显式拒绝而不是截断：download_status 一次最多只读 50 条
 * （MAX_STATUS_LIMIT），静默丢掉尾巴会让「下过了但查不到」变成无从解释的现象；
 * 分批同样是明确的选择，但由调用方决定分几批更合适。
 */
function resolveTargets(args) {
    const hasUrl = args.url !== undefined;
    const hasTargets = args.targets !== undefined;
    if (hasUrl && hasTargets)
        throw new Error(BOTH_URL_AND_TARGETS);
    if (!hasUrl && !hasTargets)
        throw new Error(NEITHER_URL_NOR_TARGETS);
    if (!hasTargets) {
        return {
            kind: 'single',
            item: {
                url: args.url,
                output: args.output,
                sha256: args.sha256,
                checksum: args.checksum,
                ifExists: args.ifExists,
            },
        };
    }
    if (args.checksum !== undefined) {
        throw new Error('拒绝下载：checksum 是单条目参数，不能与 targets 一起给；' +
            '请把摘要写进对应条目（targets[i].checksum），避免「这一批共用哪个摘要」的歧义');
    }
    const targets = args.targets;
    if (targets.length === 0) {
        throw new Error('拒绝下载：targets 是空数组 —— 要么给出至少一个条目，要么改用 url 下载单个文件');
    }
    if (targets.length > MAX_BATCH_TARGETS) {
        throw new Error(`拒绝下载：targets 有 ${targets.length} 条，超过单批上限 ${MAX_BATCH_TARGETS} 条` +
            '（进度读取端一次最多读这么多，再多就会「下过了但查不到」）。请拆成多批调用');
    }
    return {
        kind: 'batch',
        targets: targets.map((target) => ({
            ...target,
            ifExists: target.ifExists ?? args.ifExists,
        })),
    };
}
/**
 * 解析带宽上限（字节/秒）。
 *
 * 接受裸字节数或 K / M / G 后缀（1024 进制），大小写不敏感。为什么不直接把
 * "2M" 交给 aria2 / curl：它们对非法值是**静默忽略**（命令行不报错、只是不限速），
 * 用户会以为限了速。因此这里严格校验，非法值在发起任何请求之前抛错。
 *
 * @param raw 调用方给的值（可能什么都不是）
 * @returns 字节/秒；未提供时返回 undefined（表示不限速）
 */
function parseMaxBandwidth(raw) {
    if (raw === undefined)
        return undefined;
    const text = raw.trim();
    const match = /^(\d+)([KMGkmg]?)$/.exec(text);
    if (!match) {
        throw new Error(`拒绝下载：maxBandwidth 不是合法的带宽值（${JSON.stringify(raw)}）` +
            '；接受正整数加可选单位后缀（K/M/G，1024 进制），例如 "2M"、"500K"、"1500000"');
    }
    const base = Number(match[1]);
    const unit = (match[2] ?? '').toUpperCase();
    const factor = unit === 'K' ? 1024 : unit === 'M' ? 1024 * 1024 : unit === 'G' ? 1024 ** 3 : 1;
    const bytes = base * factor;
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(`拒绝下载：maxBandwidth 必须大于 0（${JSON.stringify(raw)}）`);
    }
    return bytes;
}
/**
 * 单条目超时的下限：一秒以下的超时只会把正常下载误杀（探测 + 建连都不止这个量级）。
 */
const MIN_TIMEOUT_MS = 1_000;
/**
 * 单条目超时的上限（保守上限）。
 *
 * 为什么定在 30 分钟：路线 A（D1）是同步调用，一个卡死的条目会占住一个批内并发位、
 * 并让整批调用一直不返回。30 分钟足够覆盖常见的大文件（1GB @ 1MB/s ≈ 17 分钟），
 * 而更长的等待说明用户需要「先返回、后台继续」的形态 —— 那个形态 D1 明确不做，
 * 所以宁可让它在这里失败，也不要挂住整个会话。
 */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * 超时的固定文案。
 *
 * 做成函数（而不是就地拼串）：同一句话会出现在两张进度轨道与逐条结果里，措辞一旦
 * 各写一份就会漂移，而它正是调用方判断「这条为什么没成功、要不要重跑」的依据。
 */
function describeTimeout(timeoutMs) {
    return `下载超时：${timeoutMs}ms 内没有完成（已终止这一条；半包与旁车指纹保留，重跑会先核对同源再续传）`;
}
/**
 * 超时专用的错误类型。
 *
 * 为什么不能靠文案区分：runBatch 要据此把这一条标成**失败**（超时不是用户取消，
 * 两者在面板上是两个状态），一旦改成匹配文案，某次措辞调整就会让它静默退化成「取消」。
 */
class DownloadTimeoutError extends Error {
}
/**
 * 解析单条目超时（毫秒）。
 *
 * 与 maxBandwidth 同一套做法：非法值在**发起任何请求之前**抛错 —— aria2 / curl 对
 * 非法参数是静默忽略的，交给它们等于「用户以为设了超时，其实没有」。
 * 为什么是闭区间而不是「大于 0 就行」：上限来自路线 A 的既有取舍（见 MAX_TIMEOUT_MS），
 * 下限挡住「把正常下载误杀」。
 *
 * @param raw 调用方给的值（可能什么都不是）
 * @returns 毫秒数；未提供时返回 undefined（表示不设超时）
 */
function parseTimeoutMs(raw) {
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
        throw new Error(`拒绝下载：timeoutMs 必须是 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 之间的整数毫秒（收到 ${JSON.stringify(raw)}）` +
            '；缺省表示不设超时（单个条目可能一直挂着，而路线 A 是同步调用，建议批量时显式传它）');
    }
    return value;
}
/**
 * 把一次 aria2 观测写进吞吐缓存（P1-2 的**写入侧**；读侧见 src/decision.ts 的 `decide`）。
 *
 * 什么时候写 —— 判定规则，逐条都有理由：
 *   - **只有下载成功**：调用点在完整性校验通过之后，失败 / 取消 / 超时的条目走不到这里
 *     （它们的字节没下完，那个「速度」不代表这台主机的能力，进中位数就是污染）；
 *   - **只有 aria2**：`cn`（实际有效连接数）是 aria2 摘要独有的字段，curl 路径拿不到它；
 *     curl 的进度解析也只给出百分比、没有字节速率 —— 硬要写就只能编一个数字，那不是观测；
 *   - **只有真的观测到速度**：`observation === undefined` 表示一次摘要都没解析出速度
 *     （下载太快、输出被改），没有数字可写。
 *
 * 为什么写失败不用在这里处理：`recordThroughput()` 内部吞掉所有异常（与 `writeMarker()`
 * 同构）—— 缓存是优化而不是功能，目录只读 / 磁盘满 / 记录损坏都不该让成功的下载变成失败。
 *
 * 这是 1.3.0 起**唯一**的写入点：t20 交付时缓存零调用点，本项把闭环补上。
 */
function recordObservedThroughput(url, observation) {
    if (observation === undefined)
        return;
    recordThroughput({
        url,
        throughput: observation.throughput,
        concurrency: observation.concurrency,
        cn: observation.cn,
    });
}
/**
 * 该条目最终会落到哪个路径（失败时也要答得出来，因此对非法 URL 兜底成空串）。
 *
 * 1.4.0：与单条目路径同样解析成**绝对路径**。理由不是风格统一，而是同一份
 * 「相对路径的含义取决于进程 cwd」的坑：批量结果里报相对路径、而实际落盘用的是
 * 绝对路径，调用方复制 `output` 去删除/打开时就会指到别的地方。
 * 兜底空串保持空串（`path.resolve('')` 会变成 cwd，那是个危险的“看起来有值”）。
 */
function targetOutputPath(target) {
    try {
        const raw = target.output ?? deriveFilenameFromUrl(target.url);
        return raw === '' ? '' : path.resolve(raw);
    }
    catch {
        return '';
    }
}
/** 把一次成功结果压成逐条结果。 */
function toItemResult(target, value) {
    return {
        url: target.url,
        // 最终路径可能来自 Content-Disposition / rename，不能再用入参重新推导，
        // 否则批量结果的 output 会指向一个从未落盘的文件。
        output: value.path,
        success: true,
        ...(value.method ? { method: value.method } : {}),
        path: value.path,
        ...(value.size !== undefined ? { size: value.size } : {}),
        ...(value.fellback ? { fellback: value.fellback } : {}),
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.verifySkipped ? { verifySkipped: value.verifySkipped } : {}),
        ...(value.sha256 ? { sha256: value.sha256 } : {}),
        ...(value.checksum ? { checksum: value.checksum } : {}),
        ...(value.checksumAlgorithm ? { checksumAlgorithm: value.checksumAlgorithm } : {}),
        ...(value.skipped ? { skipped: value.skipped } : {}),
        ...(value.diskCheckSkipped ? { diskCheckSkipped: value.diskCheckSkipped } : {}),
        ...(value.requestedUrl ? { requestedUrl: value.requestedUrl } : {}),
        ...(value.mirrored ? { mirrored: value.mirrored } : {}),
        ...(value.mirror ? { mirror: value.mirror } : {}),
        ...(value.mirrorSkipped ? { mirrorSkipped: value.mirrorSkipped } : {}),
    };
}
/** 把一次失败压成逐条结果（原因逐条可见，这是 D4=② 的全部意义）。 */
function toFailedItem(target, message, cancelled) {
    return {
        url: target.url,
        output: targetOutputPath(target),
        success: false,
        ...(cancelled ? { cancelled: true } : {}),
        error: message,
    };
}
/**
 * 未开工的条目被整批取消时补一条取消记录。
 *
 * 为什么要为「还没开始」的条目也写进度：不写的话它在两条轨道上都不存在，面板与
 * download_status 只能看到「这一批里有 3 条，另外 2 条去哪了」—— 取消的条目恰恰是
 * 最需要被看见的（与 1.0.0 把取消和失败分开上报是同一条理由）。
 */
async function cancelTarget(target, ctx) {
    const output = targetOutputPath(target);
    // 未开工的条目也要能定位到产物：这里同样把路径解析成绝对路径再交给 reporter
    // （它只接受绝对路径，相对路径会被忽略）。`output` 可能是空串（URL 非法），
    // 那种情况下不传，记录里就不会出现 outPath —— 管理端点据此只允许「删除记录」。
    const reporter = new ProgressReporter(makeTaskId(), output, ctx.session, ctx.batchId, output === '' ? undefined : path.resolve(output));
    reporter.cancel();
    await reporter.awaitFlush();
    return toFailedItem(target, BATCH_CANCELLED, true);
}
/**
 * 批量编排：滑动窗口并发，逐条收集结果。
 *
 * 为什么是滑动窗口而不是「固定分成 N 组」：组里最慢的一条会拖住整组，而批量里各
 * 条目耗时天然差很多（小文件与大文件混在一起）。窗口让空闲的并发位立刻接上下一条。
 *
 * 失败不进 throw：除「入参不合法」（在 execute 里已经抛过）之外，任何单条失败都
 * 只影响它自己那一行结果。已完成条目的结果永远不会被改成失败。
 */
async function runBatch(targets, ctx, limit) {
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= targets.length)
                return;
            const target = targets[index];
            // 整批已取消：不再开工，但必须留下「这条被取消」的记录（见 cancelTarget）
            if (ctx.exec.signal.aborted) {
                results[index] = await cancelTarget(target, ctx);
                continue;
            }
            try {
                results[index] = toItemResult(target, await downloadOne(target, ctx));
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // 与单条目路径的中止判定同语义：signal 已 abort 时这条是「取消」而不是
                // 「失败」，不能混成一个状态。**超时例外**：它只终止这一条、整批信号并没有
                // abort，因此必须记成失败（用户没有按取消）。
                const cancelled = err instanceof DownloadTimeoutError ? false : ctx.exec.signal.aborted;
                results[index] = toFailedItem(target, message, cancelled);
            }
        }
    };
    const workers = Math.max(1, Math.min(limit, targets.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}
