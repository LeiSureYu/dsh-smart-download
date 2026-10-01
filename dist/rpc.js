import { DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT, readDownloadStatus } from './status.js';
/** 共享 API 载体的路径前缀（与 @deepseek-ai/dsh-client-connection 的 API_PATH 一致）。 */
const API_PATH = '/api';
/** 本插件拥有的端点名；客户端以 `rpc.call('/api', 'smartdl.status', ...)` 调用。 */
const STATUS_ENDPOINT = 'smartdl.status';
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
 * 从请求体里解析查询参数（非法值一律回落到安全默认）。
 *
 * 客户端会把当前会话的 `{ id, cwd }` 一起传上来，因为轨道一的目录是
 * `<cwd>/.dsh-progress/<id>/`，而 Host 侧单靠 RPC 无法知道是哪个会话发起的。
 * 校验交给 `resolveTaskProgressDir`（它按 dsh-task-progress 的目录名规则校验），
 * 这里只做「形状对不对」的粗筛，避免把任意字符串当路径用。
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
    const rawSession = body.session;
    if (rawSession === null || typeof rawSession !== 'object')
        return { limit };
    const candidate = rawSession;
    const id = typeof candidate.id === 'string' ? candidate.id : undefined;
    const cwd = typeof candidate.cwd === 'string' ? candidate.cwd : undefined;
    if (id === undefined && cwd === undefined)
        return { limit };
    return { limit, session: { id, cwd } };
}
/**
 * 注册 `/api/smartdl.status` 精确 Fetch 路由。
 *
 * 通过 `ctx.inject(['connection'], ...)` 挂载：只有当 profile 真的提供了
 * connection 服务（web profile）时才注册，纯 CLI profile 下静默跳过，
 * 不会因为缺少 connection 而让整个插件加载失败。
 *
 * @param ctx 插件上下文
 */
export function registerStatusRpc(ctx) {
    ctx.inject(['connection'], (child) => {
        const connection = child.get('connection');
        if (!connection || typeof connection.fetch?.register !== 'function')
            return;
        child.effect(() => connection.fetch.register({
            path: `${API_PATH}/${STATUS_ENDPOINT}`,
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
                if (envelope.method !== STATUS_ENDPOINT) {
                    return envelopeResponse(envelope.rpcId, fail(`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(STATUS_ENDPOINT)}`));
                }
                try {
                    const query = readPayload(envelope.payload);
                    return envelopeResponse(envelope.rpcId, ok(readDownloadStatus(query.limit, undefined, query.session)));
                }
                catch (err) {
                    return envelopeResponse(envelope.rpcId, fail(err instanceof Error ? err.message : String(err)));
                }
            },
        }), `dsh-smart-dl: ${API_PATH}/${STATUS_ENDPOINT} Fetch route`);
    });
}
