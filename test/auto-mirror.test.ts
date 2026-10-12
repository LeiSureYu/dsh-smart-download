/**
 * auto-mirror.ts 测试：从候选表里挑「被证实与原地址同源」的镜像。
 *
 * 遵循本仓库的「正向信号」契约。这一层的静默失败形态最危险 —— 选错镜像
 * 意味着把「下载到什么」交给第三方，而下载会**成功返回**。因此每条拒绝
 * 路径都要断言它确实返回 null（退回原始地址），而不是断言不抛错。
 *
 * 网络由探测桩注入，本文件不发任何真实请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_MIRROR_SKIP_NO_CANDIDATE,
  AUTO_MIRROR_SKIP_NO_LENGTH,
  AUTO_MIRROR_SKIP_NOT_GITHUB,
  MIRRORS_ENV,
  pickMirrorServingSameFile,
  resolveAutoMirror,
  resolveMirrorPrefixes,
} from '../src/auto-mirror.js'
import type { MirrorProbeOutcome } from '../src/auto-mirror.js'
import { RECOMMENDED_MIRRORS } from '../src/mirror.js'

const URL = 'https://github.com/owner/repo/releases/download/v1/a.zip'
const SIZE = 5 * 1024 * 1024
const ETAG = '"abc123"'

const M1 = 'https://m1.example/'
const M2 = 'https://m2.example/'
const M3 = 'https://m3.example/'
const PREFIXES = [M1, M2, M3]

/** 按地址回答的探测桩；未列出的地址一律「不可达」，并记录所有被探测的地址 */
function probeStub(answers: Record<string, MirrorProbeOutcome>, seen: string[] = []) {
  return async (url: string): Promise<MirrorProbeOutcome> => {
    seen.push(url)
    return answers[url] ?? { ok: false }
  }
}

/* ------------------------------ 采用路径 ------------------------------ */

test('pickMirrorServingSameFile: 长度与 ETag 都一致 -> 采用，并给出判定依据', async () => {
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG } }, seen),
    PREFIXES,
  )
  assert.ok(picked, '同源镜像必须被采用')
  assert.equal(picked.candidate.mirror, M1)
  assert.equal(picked.candidate.url, `${M1}${URL}`, '实际地址必须是前缀 + 完整原始 URL')
  assert.match(picked.reason, /同一文件/)
  assert.match(picked.reason, new RegExp(String(SIZE)))
  assert.match(picked.reason, /ETag 一致/)
})

test('pickMirrorServingSameFile: 多个候选都合格 -> 取候选表里靠前的那个（顺序可预期）', async () => {
  const answers: Record<string, MirrorProbeOutcome> = {
    [`${M1}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG },
    [`${M2}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG },
    [`${M3}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG },
  }
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub(answers, seen),
    PREFIXES,
  )
  assert.equal(picked?.candidate.mirror, M1)
  assert.equal(seen.length, 3, '所有候选并行探测，不做串行短路')
})

test('pickMirrorServingSameFile: 候选表靠前的不合格时，顺延到后面合格的', async () => {
  const answers: Record<string, MirrorProbeOutcome> = {
    [`${M1}${URL}`]: { ok: false },
    [`${M2}${URL}`]: { ok: true, contentLength: SIZE + 1, etag: ETAG },
    [`${M3}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG },
  }
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub(answers),
    PREFIXES,
  )
  assert.equal(picked?.candidate.mirror, M3)
})

test('pickMirrorServingSameFile: 原始地址没有 ETag 时按长度判定（本模块最弱的路径）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE } }),
    PREFIXES,
  )
  assert.equal(picked?.candidate.mirror, M1)
  assert.doesNotMatch(picked?.reason ?? '', /ETag/, '没有 ETag 时不应声称 ETag 一致')
})

test('pickMirrorServingSameFile: ETag 归一化后相等即算一致（W/ 弱校验前缀被忽略）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE, etag: `W/${ETAG}` } }),
    PREFIXES,
  )
  assert.equal(picked?.candidate.mirror, M1, 'W/ 弱校验前缀不应影响同源判定')
})

test('pickMirrorServingSameFile: 带引号的 -gzip 后缀不被归一化（如实断言既有语义）', async () => {
  // normalizeEtag 只裁掉「结尾正好是 -gzip」的形式，而带引号的 ETag 结尾是
  // `gzip"`，因此裁不掉。这不是本模块的判定，是 resume.ts 里既有的归一化规则；
  // 这里如实断言现状，避免把错误预期写进用例 —— 真要支持 `"x-gzip"` 应当改
  // normalizeEtag 并同步它的既有用例，而不是在这里放宽。
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE, etag: '"abc123-gzip"' } }),
    PREFIXES,
  )
  assert.equal(picked, null)
})

/* ------------------------------ 拒绝路径 ------------------------------ */

test('pickMirrorServingSameFile: 原始长度未知 -> 直接放弃，且一次请求都不发', async () => {
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    URL,
    {},
    probeStub({}, seen),
    PREFIXES,
  )
  assert.equal(picked, null)
  assert.equal(seen.length, 0, '没有比对基准时不该去打扰任何镜像')
})

test('pickMirrorServingSameFile: 长度不一致 -> 拒绝（镜像返回了另一个文件）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE + 1, etag: ETAG } }),
    PREFIXES,
  )
  assert.equal(picked, null)
})

test('pickMirrorServingSameFile: 原始有 ETag 而候选没有 -> 拒绝（无法证实同源）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE } }),
    PREFIXES,
  )
  assert.equal(picked, null, '剥掉 ETag 的镜像一律不采用，宁可退回原始地址')
})

test('pickMirrorServingSameFile: ETag 不同 -> 拒绝（等长但内容变了）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE, etag: '"other"' } }),
    PREFIXES,
  )
  assert.equal(picked, null)
})

test('pickMirrorServingSameFile: 候选不可达 / 探测抛异常 -> 当作不可达，不冒泡', async () => {
  const probe = async (url: string): Promise<MirrorProbeOutcome> => {
    if (url.startsWith(M1)) throw new Error('ECONNRESET')
    if (url.startsWith(M2)) return { ok: false }
    return { ok: true, contentLength: SIZE, etag: ETAG }
  }
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probe,
    PREFIXES,
  )
  assert.equal(picked?.candidate.mirror, M3, '一个候选抛异常不能影响其余候选')
})

test('pickMirrorServingSameFile: 全部候选不合格 -> null（调用方据此退回原始地址）', async () => {
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({}),
    PREFIXES,
  )
  assert.equal(picked, null)
})

test('pickMirrorServingSameFile: 非 http(s) 目标地址 -> 没有候选，直接 null', async () => {
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    'file:///C:/a.zip',
    { contentLength: SIZE },
    probeStub({}, seen),
    PREFIXES,
  )
  assert.equal(picked, null)
  assert.equal(seen.length, 0)
})

test('pickMirrorServingSameFile: 非 http(s) 的候选前缀被跳过（与 applyMirror 同一套判定）', async () => {
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE },
    probeStub({}, seen),
    ['file:///C:/evil?x=', M2],
  )
  assert.equal(picked, null)
  assert.deepEqual(seen, [`${M2}${URL}`], '只有合法的 http(s) 前缀会被探测')
})

test('pickMirrorServingSameFile: 缺省用内置候选表（RECOMMENDED_MIRRORS）', async () => {
  const seen: string[] = []
  const picked = await pickMirrorServingSameFile(
    URL,
    { contentLength: SIZE },
    probeStub({}, seen),
  )
  assert.equal(picked, null)
  assert.ok(seen.length >= 3, `应探测内置候选表，实际探测了 ${seen.length} 个`)
  for (const url of seen) assert.ok(url.startsWith('https://'), url)
})

/* ------------------------------ resolveAutoMirror（对外入口） ------------------------------ */

test('resolveAutoMirror: 非 GitHub 地址 -> 不启用，且一次请求都不发', async () => {
  const seen: string[] = []
  const resolution = await resolveAutoMirror(
    'https://example.com/a.zip',
    { contentLength: SIZE, etag: ETAG },
    probeStub({}, seen),
    PREFIXES,
  )
  assert.deepEqual(resolution, {
    url: 'https://example.com/a.zip',
    mirrored: false,
    skipped: AUTO_MIRROR_SKIP_NOT_GITHUB,
  })
  assert.equal(seen.length, 0)
})

test('resolveAutoMirror: GitHub 地址但拿不到原始长度 -> 不启用，且一次请求都不发', async () => {
  const seen: string[] = []
  const resolution = await resolveAutoMirror(URL, {}, probeStub({}, seen), PREFIXES)
  assert.deepEqual(resolution, { url: URL, mirrored: false, skipped: AUTO_MIRROR_SKIP_NO_LENGTH })
  assert.equal(seen.length, 0, '没有比对基准时不该去打扰任何镜像')
})

test('resolveAutoMirror: 有候选被证实同源 -> 启用，地址换成镜像地址并带回依据', async () => {
  const resolution = await resolveAutoMirror(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M2}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG } }),
    PREFIXES,
  )
  assert.equal(resolution.mirrored, true)
  assert.equal(resolution.mirror, M2)
  assert.equal(resolution.url, `${M2}${URL}`)
  assert.equal(resolution.skipped, undefined, '启用时不得同时给出去启用说明')
  assert.match(resolution.reason ?? '', /同一文件/)
})

test('resolveAutoMirror: 候选全不合格 -> 退回原始地址，并说明原因', async () => {
  const resolution = await resolveAutoMirror(
    URL,
    { contentLength: SIZE, etag: ETAG },
    probeStub({ [`${M1}${URL}`]: { ok: true, contentLength: SIZE + 1 } }),
    PREFIXES,
  )
  assert.deepEqual(resolution, {
    url: URL,
    mirrored: false,
    skipped: AUTO_MIRROR_SKIP_NO_CANDIDATE,
  })
})

test('三条「不启用」说明是常量，不是就地拼串（改动会被用例拦下）', () => {
  assert.equal(AUTO_MIRROR_SKIP_NOT_GITHUB, '未使用自动镜像：只有 GitHub 地址支持')
  assert.equal(
    AUTO_MIRROR_SKIP_NO_LENGTH,
    '未使用自动镜像：无法从原始地址取得文件长度，无从证实镜像返回的是同一个文件',
  )
  assert.equal(
    AUTO_MIRROR_SKIP_NO_CANDIDATE,
    '未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致',
  )
})

/* ------------------------------ 候选表覆盖（DSH_SMARTDL_MIRRORS） ------------------------------ */

/** 在临时设置环境变量的作用域里跑一段断言，结束后必定还原 */
async function withMirrorsEnv(value: string | undefined, fn: () => void | Promise<void>) {
  const saved = process.env[MIRRORS_ENV]
  try {
    if (value === undefined) delete process.env[MIRRORS_ENV]
    else process.env[MIRRORS_ENV] = value
    await fn()
  } finally {
    if (saved === undefined) delete process.env[MIRRORS_ENV]
    else process.env[MIRRORS_ENV] = saved
  }
}

test('resolveMirrorPrefixes: 未设置 / 空 / 纯空白 / 只有逗号 -> 用内置候选表', async () => {
  for (const value of [undefined, '', '   ', ',,', ' , ']) {
    await withMirrorsEnv(value, () => {
      assert.deepEqual(resolveMirrorPrefixes(), [...RECOMMENDED_MIRRORS], `value=${String(value)}`)
    })
  }
})

test('resolveMirrorPrefixes: 逗号分隔，顺序即优先级，空白被裁掉', async () => {
  await withMirrorsEnv(' https://my-mirror.example/ , http://10.0.0.9:8080 ', () => {
    assert.deepEqual(resolveMirrorPrefixes(), [
      'https://my-mirror.example/',
      'http://10.0.0.9:8080',
    ])
  })
})

test('resolveMirrorPrefixes: 每次调用都重新读环境变量（不在模块加载时固化）', async () => {
  await withMirrorsEnv('https://a.example/', () => {
    assert.deepEqual(resolveMirrorPrefixes(), ['https://a.example/'])
  })
  assert.deepEqual(resolveMirrorPrefixes(), [...RECOMMENDED_MIRRORS], '还原后应回到内置表')
})

test('resolveAutoMirror: 候选表来自环境变量（企业内网 / 自建代理的入口）', async () => {
  const MINE = 'https://my-mirror.example/'
  await withMirrorsEnv(MINE, async () => {
    const seen: string[] = []
    const resolution = await resolveAutoMirror(
      URL,
      { contentLength: SIZE, etag: ETAG },
      probeStub({ [`${MINE}${URL}`]: { ok: true, contentLength: SIZE, etag: ETAG } }, seen),
    )
    assert.equal(resolution.mirrored, true)
    assert.equal(resolution.mirror, MINE)
    assert.deepEqual(seen, [`${MINE}${URL}`], '只应探测环境变量给出的候选')
  })
})

test('pickMirrorServingSameFile: 缺省候选表同样读环境变量', async () => {
  const MINE = 'https://my-mirror.example/'
  await withMirrorsEnv(MINE, async () => {
    const seen: string[] = []
    await pickMirrorServingSameFile(
      URL,
      { contentLength: SIZE },
      probeStub({}, seen),
    )
    assert.deepEqual(seen, [`${MINE}${URL}`])
  })
})
