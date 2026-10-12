import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT, readDownloadStatus } from './status.js';
import { cleanupHistory, readCleanupQuery } from './cleanup.js';
import { isSafeTaskId, removeTaskRecords, resolveDownloadProgressDir, resolveTaskProgressDir, } from './progress.js';
/** 共享 API 载体的路径前缀（与 @deepseek-ai/dsh-client-connection 的 API_PATH 一致）。 */
const API_PATH = '/api';
/** status 端点名（只读）；客户端以 `rpc.call('/api', 'smartdl.status', ...)` 调用。 */
const STATUS_ENDPOINT = 'smartdl.status';
/**
 * 清理端点名（D7-② 的清理入口）；与 STATUS_ENDPOINT 同挂一个路由，
 * 按请求里的 `method` 字段分派。
 *
 * 为什么不新开一条路由：`connection.fetch.register` 是**精确路径**注册，
 * 一条路由一个路径，再拆一条就得把信封校验整套抄第二遍；而这两个 method
 * 本来就是同一个 RPC 面的两个方向（读快照 / 删历史），共用信封与错误语义
 * 才是对的。
 *
 * （1.4.0 更正：这段注释此前写成「同挂一个路由、按 method 分派」，但实现从来就是
 * **一条端点一条精确路由** —— `registerApiRoute` 把路径拼成 `/api/<端点名>`；
 * 两个端点真正共享的是**信封校验与错误语义**（复用同一个 `registerApiRoute`），
 * 不是路径。加第三个端点时若不更正，读到这里的人会以为还要改一张分派表。）
 */
const CLEANUP_ENDPOINT = 'smartdl.cleanup';
/**
 * 管理端点名（1.4.0）：下载管理器的服务端入口，按 `op` 分派三个操作。
 *
 * 与 cleanup 的区别是**粒度**：cleanup 按保留窗口批量清进度文件，manage 处理
 * 「用户显式点的那一条任务」（查状态 / 只删记录 / 连产物一起删）。两者不合并：
 * 时间窗口语义与单条确认语义混在一起，迟早出现「随手清一下却删掉了刚下的文件」。
 */
const MANAGE_ENDPOINT = 'smartdl.manage';
function ok(value) {
    return { ok: true, value };
}
function fail(message) {
    return { ok: false, error: { code: 'internal', message, details: {} } };
}
/** 把一次 RPC 结果序列化成 server-response 信封。 */
function envelopeResponse(rpcId, result) {
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
        status: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}
/**
 * 从 payload 里解析会话上下文（两个端点**共用**这一份形状规则）。
 *
 * 为什么抽成函数：status 与 cleanup 都需要它来定位轨道一目录，各写一份必然分叉
 * ——而分叉的表现是「status 能定位到轨道一、cleanup 却报轨道一未参与」，这种
 * 不一致比完全不管会话更难排查。
 *
 * 这里只做「形状对不对」的粗筛（字符串 / 至少给一个字段），目录名规则仍由
 * `resolveTaskProgressDir` 校验，避免把任意字符串当路径用。
 *
 * @param raw payload 里的 session 字段（可能什么都不是）
 * @returns 形状合法时返回会话；否则 undefined（端点据此报告轨道一未参与）
 */
function readSession(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const candidate = raw;
    const id = typeof candidate.id === 'string' ? candidate.id : undefined;
    const cwd = typeof candidate.cwd === 'string' ? candidate.cwd : undefined;
    if (id === undefined && cwd === undefined)
        return undefined;
    return { id, cwd };
}
/**
 * 从请求体里解析查询参数（非法值一律回落到安全默认）。
 *
 * 客户端会把当前会话的 `{ id, cwd }` 一起传上来，因为轨道一的目录是
 * `<cwd>/.dsh-progress/<id>/`，而 Host 侧单靠 RPC 无法知道是哪个会话发起的。
 */
function readPayload(payload) {
    if (payload === null || typeof payload !== 'object') {
        return { limit: DEFAULT_STATUS_LIMIT };
    }
    const body = payload;
    const n = Number(body.limit);
    const limit = Number.isFinite(n) && n > 0
        ? Math.min(MAX_STATUS_LIMIT, Math.floor(n))
        : DEFAULT_STATUS_LIMIT;
    const session = readSession(body.session);
    return session === undefined ? { limit } : { limit, session };
}
/**
 * 从请求体里解析清理参数与会话。
 *
 * 会话与 status 共用 {@link readSession}：轨道一**只能**靠调用方传上来的会话定位，
 * 不解析它就等于清理永远碰不到轨道一（而调用方看不出少了什么）。
 * 清理参数自身的校验（非法值直接拒绝）在 `readCleanupQuery` 里，那里会抛错，
 * 由路由层转成 `ok:false` + 可操作文案。
 */
function readCleanupPayload(payload) {
    const query = readCleanupQuery(payload);
    const raw = payload !== null && typeof payload === 'object' ? payload.session : undefined;
    const session = readSession(raw);
    return session === undefined ? { query } : { query, session };
}
/** 取 child 上的 connection，形状不对时返回 undefined（纯 CLI profile 的正常路径）。 */
function connectionOf(child) {
    const candidate = child.get('connection');
    if (!candidate || typeof candidate.fetch?.register !== 'function')
        return undefined;
    return candidate;
}
/**
 * 在共享 `/api` 载体上注册一个精确 Fetch 路由。
 *
 * 信封校验（方法 / content-type / client-request 形状 / method 与端点一致）
 * 全部收在这里：本来只有 status 一个端点时它是内联的，加第二个端点（cleanup）
 * 时如果各写各的，两个端点迟早对「什么算非法请求」给出不同答案 —— 而客户端
 * 只认信封，这种分叉只会表现为「某个端点莫名不工作」。
 *
 * @param child 已注入 connection 的子上下文
 * @param endpoint 端点 / method 名（如 `smartdl.status`）
 * @param handle 业务处理函数
 */
function registerApiRoute(child, endpoint, handle) {
    const start = () => {
        // 在这里取 connection（而不是调用 registerApiRoute 之前）：effect 回调执行时
        // 服务一定已就位，注册时机与 cordis 的依赖注入时序不会互相打架。
        const connection = connectionOf(child);
        if (!connection)
            return () => Promise.resolve();
        return connection.fetch.register({
            path: `${API_PATH}/${endpoint}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
                if (request.method !== 'POST') {
                    return new Response('not found', { status: 404 });
                }
                const contentType = request.headers
                    .get('content-type')
                    ?.split(';', 1)[0]
                    ?.trim()
                    .toLowerCase();
                if (contentType !== 'application/json') {
                    return new Response('content type must be application/json', { status: 415 });
                }
                let body;
                try {
                    body = await request.json();
                }
                catch {
                    return new Response('body is not JSON', { status: 400 });
                }
                const envelope = body;
                if (envelope === null ||
                    typeof envelope !== 'object' ||
                    envelope.type !== 'client-request' ||
                    typeof envelope.rpcId !== 'string' ||
                    envelope.rpcId === '' ||
                    typeof envelope.method !== 'string') {
                    return envelopeResponse('invalid-request', fail('invalid client-request message'));
                }
                if (envelope.method !== endpoint) {
                    return envelopeResponse(envelope.rpcId, fail(`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`));
                }
                try {
                    return envelopeResponse(envelope.rpcId, await handle(envelope.payload, request));
                }
                catch (err) {
                    return envelopeResponse(envelope.rpcId, fail(err instanceof Error ? err.message : String(err)));
                }
            },
        });
    };
    child.effect(start, `dsh-smart-dl: ${API_PATH}/${endpoint} Fetch route`);
}
/** 固定文案做成常量：客户端与测试都按同一份措辞断言，散落的字面量迟早对不上。 */
export const MANAGE_BAD_PAYLOAD = '拒绝管理请求：body 必须是对象，且带 op（inspect / forget / delete）与 taskId';
export const MANAGE_CONFIRM_REQUIRED = '拒绝删除本地文件：需要 confirm:true；只想删记录请用 op:"forget"';
/**
 * 不可逆性必须明写（1.4.0）：删除不进回收站。
 *
 * 为什么：本插件是 Node 侧宿主代码，运行时里没有可用的回收站服务（Electron 的
 * `shell.trashItem` 不在我们的能力面里），所以 `unlink` 就是**永久删除**。
 * 这句话同时出现在这里、返回结果的 reason 文案里与 docs/SECURITY.md。
 */
export const MANAGE_DELETE_IRREVERSIBLE = '删除本地文件是永久删除（不进回收站）：删了就没了';
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
export function readManagePayload(payload) {
    if (payload === null || typeof payload !== 'object')
        return { error: MANAGE_BAD_PAYLOAD };
    const body = payload;
    const op = body.op;
    if (op !== 'inspect' && op !== 'forget' && op !== 'delete' && op !== 'reveal') {
        return { error: `${MANAGE_BAD_PAYLOAD}（op 必须是 inspect / forget / delete / reveal）` };
    }
    // **R2 落点**：taskId 会被拼进文件名，必须过白名单；带分隔符 / `..` / 驱动器号
    // 的 id 能让 path.join 指到记录目录之外，而删除是不可逆的。
    if (!isSafeTaskId(body.taskId)) {
        return {
            error: `${MANAGE_BAD_PAYLOAD}（taskId 只允许 [A-Za-z0-9._-]、字母数字开头、最长 64 字符）`,
        };
    }
    const session = readSession(body.session);
    return {
        request: {
            op,
            taskId: body.taskId,
            confirm: body.confirm === true,
            ...(session === undefined ? {} : { session }),
        },
    };
}
/** `path.relative` 判定「child 是否在 parent 之内」（含相等）。 */
function isUnder(parent, child) {
    const rel = path.relative(parent, child);
    if (rel === '')
        return true;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}
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
export function checkManagedTarget(outPath, recordedSize, session) {
    if (outPath === '')
        return { kind: 'no-path' };
    if (outPath.includes('\u0000'))
        return { kind: 'bad-path', why: '路径里含 NUL' };
    if (!path.isAbsolute(outPath))
        return { kind: 'bad-path', why: '不是绝对路径' };
    if (path.normalize(outPath) !== outPath)
        return { kind: 'bad-path', why: '路径未归一化（含 . / ..）' };
    // R9：本插件自己的记录目录（轨道一 + 轨道二）内的任何东西都不该从这个入口删。
    const ownDirs = [resolveDownloadProgressDir(), resolveTaskProgressDir(session)];
    for (const dir of ownDirs) {
        if (dir !== null && isUnder(dir, outPath)) {
            return { kind: 'bad-path', why: '目标是本插件的进度记录目录' };
        }
    }
    let st;
    try {
        // R5：lstat，不跟进符号链接
        st = fs.lstatSync(outPath);
    }
    catch {
        return { kind: 'missing' };
    }
    if (st.isSymbolicLink())
        return { kind: 'link' };
    if (st.isDirectory())
        return { kind: 'dir' };
    if (!st.isFile())
        return { kind: 'other' };
    // R6：只有记录了尺寸（>0）时才核对；不一致就是「这不是当初那一个」
    if (recordedSize > 0 && recordedSize !== st.size)
        return { kind: 'changed', fileSize: st.size };
    return { kind: 'present', fileSize: st.size };
}
/** 把磁盘判定映射成契约里的 `presence`。 */
function presenceOf(check, found) {
    if (!found)
        return 'unknown';
    switch (check.kind) {
        case 'no-path':
            return 'unknown';
        case 'missing':
            return 'missing';
        case 'changed':
            return 'changed';
        case 'present':
            return 'present';
        default:
            // bad-path / dir / link / other：都存在但我们不会去动它
            return 'blocked';
    }
}
/** 按 taskId 读记录（合并两条轨道），返回 TaskStatus 或 undefined。 */
function findTask(taskId, session) {
    // limit 传 1：已经按 taskId 过滤过，过滤发生在截断之前（见 readDownloadStatus）
    return readDownloadStatus(1, taskId, session).tasks[0];
}
/**
 * `op:'inspect'`：报告这条任务的产物当前是什么样子。
 *
 * 纯只读（`lstat`），不做任何修改；没有记录时如实报 `found:false` ——
 * 「没有这条记录」与「记录里没有路径」在 UI 上是两种文案，不能混。
 */
export function inspectManagedTask(taskId, session) {
    const task = findTask(taskId, session);
    if (!task) {
        return { found: false, presence: 'unknown', outPath: '', state: '' };
    }
    const check = checkManagedTarget(task.outPath, task.size, session);
    return {
        found: true,
        presence: presenceOf(check, true),
        outPath: task.outPath,
        ...(task.size > 0 ? { size: task.size } : {}),
        ...(check.kind === 'present' || check.kind === 'changed' ? { fileSize: check.fileSize } : {}),
        ...(task.fileMtimeMs > 0 ? { fileMtimeMs: task.fileMtimeMs } : {}),
        state: task.status,
    };
}
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
export function revealCommand(target) {
    const override = process.env.DSH_SMARTDL_REVEAL_CMD;
    if (typeof override === 'string' && override.trim() !== '') {
        return { command: override.trim(), args: [target] };
    }
    if (process.platform === 'win32') {
        // `/select,` 后**不加空格**（Explorer 的命令行约定）
        return { command: 'explorer.exe', args: [`/select,${target}`] };
    }
    if (process.platform === 'darwin') {
        return { command: 'open', args: ['-R', target] };
    }
    // Linux 没有统一的「选中文件」参数：退化为打开所在目录
    return { command: 'xdg-open', args: [path.dirname(target)] };
}
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
export function openWithCommand(command, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { detached: true, stdio: 'ignore' });
        }
        catch {
            resolve(false);
            return;
        }
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
            // detached + unref：文件管理器不跟着宿主进程一起被回收
            child.unref();
            resolve(true);
        });
    });
}
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
export async function revealManagedTask(taskId, session) {
    const task = findTask(taskId, session);
    if (!task) {
        return { found: false, presence: 'unknown', revealed: false, reason: 'no-path' };
    }
    const check = checkManagedTarget(task.outPath, task.size, session);
    // 与删除同一条红线：只有「文件确实还在原位」才对它做动作。
    if (check.kind !== 'present') {
        return {
            found: true,
            presence: presenceOf(check, true),
            revealed: false,
            reason: check.kind === 'changed' ? 'changed' : 'gone',
        };
    }
    const target = task.outPath;
    const plan = revealCommand(target);
    const opened = await openWithCommand(plan.command, plan.args);
    return opened
        ? { found: true, presence: 'present', outPath: target, revealed: true }
        : {
            found: true,
            presence: 'present',
            revealed: false,
            // 契约里没有「打开器不存在」这一项：按既有约定归到 busy，
            // 真实原因放进 errorCode（ENOENT = 命令不在 PATH 上）
            reason: 'busy',
            errorCode: 'ENOENT',
        };
}
/**
 * `op:'forget'`：只删本插件的两条进度记录（不碰任何产物）。
 *
 * 与产物删除的区别：这一步只删**我们自己写的文件**，路径由 taskId + 目录规则
 * 推导（R2 + `taskRecordFiles` 的 lstat 校验），不接受调用方给路径。
 */
export function forgetManagedTask(taskId, session) {
    return removeTaskRecords(taskId, session);
}
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
export function deleteManagedTask(taskId, session) {
    const task = findTask(taskId, session);
    const irreversible = MANAGE_DELETE_IRREVERSIBLE;
    // 没有记录：没有可删的产物，也没有可删的记录文件（幂等）
    if (!task) {
        return { fileDeleted: false, reason: 'no-path', recordRemoved: [], irreversible };
    }
    // **R8**：任务还在跑。此时删产物会让正在写的 aria2 进入诡异状态，也不符合
    // 用户此刻的本意（他多半想取消，而不是删除）。记录同样保留。
    if (task.status === 'running') {
        return { fileDeleted: false, reason: 'running', recordRemoved: [], irreversible };
    }
    const check = checkManagedTarget(task.outPath, task.size, session);
    if (check.kind === 'no-path') {
        return {
            fileDeleted: false,
            reason: 'no-path',
            recordRemoved: forgetManagedTask(taskId, session),
            irreversible,
        };
    }
    if (check.kind === 'missing') {
        return {
            fileDeleted: false,
            reason: 'gone',
            recordRemoved: forgetManagedTask(taskId, session),
            irreversible,
        };
    }
    if (check.kind === 'bad-path') {
        // R3/R4/R9：路径不合规 —— 产物不删（记录也保留，让人能看到这条记录为什么删不掉）
        return { fileDeleted: false, reason: 'denied', errorCode: 'BAD_PATH', recordRemoved: [], irreversible };
    }
    if (check.kind === 'dir') {
        return { fileDeleted: false, reason: 'is-dir', recordRemoved: [], irreversible };
    }
    if (check.kind === 'link') {
        return { fileDeleted: false, reason: 'is-link', recordRemoved: [], irreversible };
    }
    if (check.kind === 'other') {
        // 既不是普通文件也不是目录/链接（设备、FIFO…）：同样按「本地策略拒绝」回报
        return { fileDeleted: false, reason: 'denied', errorCode: 'NOT_A_FILE', recordRemoved: [], irreversible };
    }
    if (check.kind === 'changed') {
        // R6：文件被换过（尺寸不符）。删错东西的代价远大于「让用户手动处理」。
        return { fileDeleted: false, reason: 'changed', recordRemoved: [], irreversible };
    }
    // 到这里是 present：唯一真的会 unlink 的分支
    try {
        fs.unlinkSync(task.outPath);
    }
    catch (err) {
        const code = err.code ?? '';
        return {
            fileDeleted: false,
            reason: reasonFromErrno(code),
            ...(code === '' ? {} : { errorCode: code }),
            recordRemoved: [],
            irreversible,
        };
    }
    return {
        fileDeleted: true,
        recordRemoved: forgetManagedTask(taskId, session),
        irreversible,
    };
}
/**
 * 把 `unlink` 的 errno 映射成契约里的 `reason`。
 *
 * 映射刻意保守：只有明确是「本来就没有」才报 `gone`（用户侧文案是「文件已不在」），
 * 权限类报 `denied`，占用类报 `busy`，目录报 `is-dir`，链接报 `is-link`，
 * **其余一律 `busy` 并把原始 code 放进 `errorCode`** —— 绝不把不明失败报成成功，
 * 也不编一个契约里不存在的 reason。
 */
function reasonFromErrno(code) {
    switch (code) {
        case 'ENOENT':
            return 'gone';
        case 'EACCES':
        case 'EPERM':
            return 'denied';
        case 'EISDIR':
            return 'is-dir';
        case 'ELOOP':
            return 'is-link';
        default:
            // EBUSY / ENOTEMPTY / EROFS / ENOSPC / 未知 …都归到 busy
            return 'busy';
    }
}
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
export function registerStatusRpc(ctx) {
    ctx.inject(['connection'], (child) => {
        if (!connectionOf(child))
            return;
        registerApiRoute(child, STATUS_ENDPOINT, (payload) => {
            const query = readPayload(payload);
            return ok(readDownloadStatus(query.limit, undefined, query.session));
        });
        registerApiRoute(child, CLEANUP_ENDPOINT, (payload) => {
            // 会话要一起解析并传下去：轨道一的目录是 <cwd>/.dsh-progress/<id>/，
            // 不传会话时清理只能扫到轨道二 —— 结果里会用 taskDirSkipped 明确报告这一点。
            const { query, session } = readCleanupPayload(payload);
            // 逐文件的删 / 留都在 value 里如实报告：清理不可逆，调用方必须能核对
            // 「它到底删了什么、留下了什么」，而不是只看到一个「成功」。
            return ok(cleanupHistory(query, session));
        });
        registerApiRoute(child, MANAGE_ENDPOINT, async (payload) => {
            const parsed = readManagePayload(payload);
            // 校验失败一律 ok:false（而不是默默按默认值执行）：这是**不可逆**操作面，
            // 调用方必须知道自己的请求没有被当成别的东西执行。
            if ('error' in parsed)
                return fail(parsed.error);
            const { op, taskId, confirm, session } = parsed.request;
            if (op === 'inspect')
                return ok(inspectManagedTask(taskId, session));
            // op === 'reveal'：打开系统文件管理器定位产物。**不需要 confirm** —— 它不
            // 修改任何东西，且路径只能来自本插件自己的记录（调用方给不了路径）。
            if (op === 'reveal')
                return ok(await revealManagedTask(taskId, session));
            if (op === 'forget') {
                return ok({ recordRemoved: forgetManagedTask(taskId, session) });
            }
            // op === 'delete'：没有 confirm:true 就整个拒绝。
            // 契约里 `reason` 的取值集合没有「未确认」这一项，所以这里不能悄悄降级成
            // 「只删记录」—— 那会让客户端在 fileDeleted 处理不当时以为产物也删了。
            // （要只删记录，客户端用 op:'forget'：语义显式，返回形状也不同。）
            if (!confirm)
                return fail(MANAGE_CONFIRM_REQUIRED);
            return ok(deleteManagedTask(taskId, session));
        });
    });
}
