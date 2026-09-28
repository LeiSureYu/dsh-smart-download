/**
 * resume.ts 单测：续传安全策略。
 *
 * 这些用例对应 0.6.0 实测坐实的三类静默损坏（脚本 `work/_fix/probe-resume.mjs`，
 * 真实 curl 8.13.0 / aria2 1.37.0 @ 127.0.0.1）：
 *   - 远端变小（400B→200B）：curl/aria2 都 exit 0 但文件仍是 400B；
 *   - 等长但内容变了（400B→400B 异）：两者都 exit 0 且保留旧内容；
 *   - 本地比远端还长：aria2 -c 不截断，仍留超长错误文件。
 * 因此 planResume() 必须在这些场景下选择「删掉重下」而不是续传。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearMarker,
  localFileSize,
  normalizeEtag,
  planResume,
  writeMarker,
} from '../src/resume.js'
import type { ProbeResult } from '../src/types.js'

let tmpRoot = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'resume-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 构造探测结果 */
function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return { supportsMultiThread: true, ...overrides }
}

/** 在临时目录里造一个指定大小的本地半包 */
function makeLocal(size: number, name = 'f.bin'): string {
  const p = path.join(tmpRoot, name)
  writeFileSync(p, Buffer.alloc(size, 0x41))
  return p
}

/** 手工写一个旁车指纹（模拟上一次下载留下的记录） */
function putMarker(outputPath: string, marker: Record<string, unknown>): void {
  writeFileSync(`${outputPath}.part.json`, JSON.stringify(marker), 'utf-8')
}

/* ------------------------------ normalizeEtag ------------------------------ */

test('normalizeEtag: 去掉弱校验前缀 W/', () => {
  assert.equal(normalizeEtag('W/"abc"'), '"abc"')
  assert.equal(normalizeEtag('w/"abc"'), '"abc"')
})

test('normalizeEtag: 去掉 -gzip 后缀（同一资源经压缩后 ETag 可能带此后缀）', () => {
  assert.equal(normalizeEtag('"abc"-gzip'), '"abc"')
  assert.equal(normalizeEtag('W/"abc"-gzip'), '"abc"')
})

test('normalizeEtag: 普通 / 带空白的 ETag 不变（只 trim）', () => {
  assert.equal(normalizeEtag('"abc"'), '"abc"')
  assert.equal(normalizeEtag('  "abc"  '), '"abc"')
})

/* ------------------------------ localFileSize ------------------------------ */

test('localFileSize: 文件不存在 -> null', () => {
  assert.equal(localFileSize(path.join(tmpRoot, 'nope.bin')), null)
})

test('localFileSize: 路径是目录 -> null（目录不应被续传拼接）', () => {
  const dir = path.join(tmpRoot, 'adir')
  mkdirSync(dir)
  assert.equal(localFileSize(dir), null)
})

test('localFileSize: 普通文件 -> 字节数', () => {
  assert.equal(localFileSize(makeLocal(1234)), 1234)
  assert.equal(localFileSize(makeLocal(0, 'empty.bin')), 0)
})

/* ------------------------------ 旁车指纹往返 ------------------------------ */

test('writeMarker / clearMarker：写出 .part.json 并能删掉', () => {
  const p = makeLocal(10)
  writeMarker(p, probe({ contentLength: 1000, etag: '"v1000"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' }))
  const markerPath = `${p}.part.json`
  assert.equal(existsSync(markerPath), true)
  const rec = JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>
  assert.equal(rec.v, 1)
  assert.equal(rec.length, 1000)
  assert.equal(rec.etag, '"v1000"')
  assert.equal(typeof rec.lastModified, 'string')

  clearMarker(p)
  assert.equal(existsSync(markerPath), false)
})

test('writeMarker: contentLength 未知时不写旁车（没有可比对的基准）', () => {
  const p = makeLocal(10)
  writeMarker(p, probe({ contentLength: undefined }))
  assert.equal(existsSync(`${p}.part.json`), false)
})

test('clearMarker: 旁车不存在时不抛异常', () => {
  assert.doesNotThrow(() => clearMarker(path.join(tmpRoot, 'never.bin')))
})

test('旁车损坏或非 v:1 -> 当没有指纹处理，退化为按长度续传', () => {
  const p = makeLocal(400)
  putMarker(p, { notJson: true })
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, true)

  putMarker(p, { v: 99, length: 1000 })
  const plan2 = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan2.resume, true)
})

/* ------------------------------ planResume ------------------------------ */

test('planResume: 无本地文件 -> 不续传、不删任何东西', () => {
  const p = path.join(tmpRoot, 'absent.bin')
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, false)
  assert.match(plan.reason, /从头下载/)
})

test('planResume: 本地 0 字节 -> 视同无半包，不续传', () => {
  const p = makeLocal(0, 'zero.bin')
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, false)
})

test('planResume: 服务器不支持 Range -> 删掉半包全量重下（curl -C - 会 exit 33）', () => {
  const p = makeLocal(400)
  const plan = planResume(p, probe({ contentLength: 1000 }), false)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.match(plan.reason, /不支持 Range/)
})

test('planResume: 远端长度未知 -> 删掉半包全量重下', () => {
  const p = makeLocal(400)
  const plan = planResume(p, probe({ contentLength: undefined }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.match(plan.reason, /无法获取远端文件大小/)
})

test('planResume: 本地比远端还长 -> 删掉（aria2 -c 实测不截断）', () => {
  const p = makeLocal(1500)
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.match(plan.reason, /1500/)
  assert.match(plan.reason, /1000/)
})

test('planResume: ETag 变化 -> 删掉（唯一能挡住「等长但内容变了」的手段）', () => {
  const p = makeLocal(400)
  putMarker(p, { v: 1, length: 1000, etag: '"v1000"' })
  const plan = planResume(p, probe({ contentLength: 1000, etag: '"v1000b"' }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.match(plan.reason, /ETag 变化/)
})

test('planResume: ETag 仅弱校验 / -gzip 差异 -> 视为同源，仍续传', () => {
  const p = makeLocal(400)
  putMarker(p, { v: 1, length: 1000, etag: '"v1000"' })
  const plan = planResume(p, probe({ contentLength: 1000, etag: 'W/"v1000"-gzip' }), true)
  assert.equal(plan.resume, true)
  assert.equal(plan.discarded, false)
})

test('planResume: Last-Modified 变化 -> 删掉', () => {
  const p = makeLocal(400)
  putMarker(p, { v: 1, length: 1000, lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' })
  const plan = planResume(
    p,
    probe({ contentLength: 1000, lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT' }),
    true,
  )
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.match(plan.reason, /Last-Modified 变化/)
})

test('planResume: 旁车长度与本次远端长度不一致 -> 删掉（远端变大或变小）', () => {
  // 本地必须小于远端，否则会先命中「本地比远端还长」分支；
  // 这里模拟的是「上次记的远端是 1000B，这次服务端变成了 2000B」
  // —— 单看长度本地 400 < 2000 是"合法"续传，只有旁车能识破。
  const p = makeLocal(400)
  putMarker(p, { v: 1, length: 1000 })
  const plan = planResume(p, probe({ contentLength: 2000 }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.match(plan.reason, /远端大小变化/)
})

test('planResume: 远端变小且本地更长 -> 由长度比对先行拦下（curl/aria2 实测静默损坏）', () => {
  const p = makeLocal(400)
  const plan = planResume(p, probe({ contentLength: 200 }), true)
  assert.equal(plan.resume, false)
  assert.equal(plan.discarded, true)
  assert.match(plan.reason, /400/)
  assert.match(plan.reason, /200/)
})

test('planResume: 全部一致 -> 续传，reason 带本地/远端字节数', () => {
  const p = makeLocal(400)
  putMarker(p, { v: 1, length: 1000, etag: '"v1000"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' })
  const plan = planResume(
    p,
    probe({
      contentLength: 1000,
      etag: '"v1000"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    }),
    true,
  )
  assert.equal(plan.resume, true)
  assert.equal(plan.discarded, false)
  assert.equal(existsSync(p), true)
  assert.match(plan.reason, /从 400\/1000 字节处续传/)
})

test('planResume: 无旁车但长度可比对 -> 按长度续传（挡住「远端变小」）', () => {
  const p = makeLocal(400)
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, true)
  assert.equal(plan.discarded, false)
})

test('planResume: 本地已等于远端长度 -> 仍返回续传（由下载器判定是否已完整）', () => {
  const p = makeLocal(1000)
  putMarker(p, { v: 1, length: 1000 })
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.resume, true)
  assert.match(plan.reason, /1000\/1000/)
})

test('planResume: 删文件时连带清掉 aria2 控制文件 .aria2', () => {
  const p = makeLocal(1500)
  const ctrl = `${p}.aria2`
  writeFileSync(ctrl, 'x')
  putMarker(p, { v: 1, length: 1000 })
  const plan = planResume(p, probe({ contentLength: 1000 }), true)
  assert.equal(plan.discarded, true)
  assert.equal(existsSync(p), false)
  assert.equal(existsSync(ctrl), false)
  assert.equal(existsSync(`${p}.part.json`), false)
})
