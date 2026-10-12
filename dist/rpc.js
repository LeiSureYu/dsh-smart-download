import { DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT, readDownloadStatus } from './status.js';
import { cleanupHistory, readCleanupQuery } from './cleanup.js';
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
 */
const CLEANUP_ENDPOINT = 'smartdl.cleanup';
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
/**
 * 注册本插件的两个 HTTP 端点：`/api/smartdl.status`（读快照）与
 * `/api/smartdl.cleanup`（清历史）。
 *
 * 通过 `ctx.inject(['connection'], ...)` 挂载：只有当 profile 真的提供了
 * connection 服务（web profile）时才注册，纯 CLI profile 下静默跳过，
 * 不会因为缺少 connection 而让整个插件加载失败。
 *
 * 浏览器端目前只调用 status（面板保持只读）；cleanup 是 D7-② 拍板要加的
 * **清理入口** —— 从前 `ProgressReporter.cleanup()` 只有调用方在代码里显式
 * 调用才有效，这个端点把它变成可被外部（脚本、未来的面板按钮）触发的入口。
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
    });
}
