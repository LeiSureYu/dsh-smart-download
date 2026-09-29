/**
 * verify.ts 测试：落盘大小校验的纯函数。
 *
 * 这里每一条「跳过校验」的分支都必须有**正向断言**（说清它为什么可以跳过），
 * 否则「默认放行」就会退化成新的静默失败 —— 这正是本项目的红线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeMismatch, expectedFromProbe, normalizeContentEncoding, verifySize } from '../src/verify.js'
import type { ProbeResult } from '../src/types.js'

test('verifySize: 字节数一致 -> ok 且带回实际大小', () => {
  const r = verifySize(5000, 5000)
  assert.equal(r.kind, 'ok')
  assert.equal(r.kind === 'ok' ? r.actual : undefined, 5000)
})

test('verifySize: 字节数偏小 -> mismatch（退出码 0 但文件是坏的）', () => {
  const r = verifySize(4999, 5000)
  assert.equal(r.kind, 'mismatch')
  assert.equal(r.kind === 'mismatch' ? r.expected : undefined, 5000)
  assert.equal(r.kind === 'mismatch' ? r.actual : undefined, 4999)
})

test('verifySize: 字节数偏大 -> mismatch（续传错位 / 拼接了两次）', () => {
  const r = verifySize(10000, 5000)
  assert.equal(r.kind, 'mismatch')
})

test('verifySize: 0 字节文件 vs 非 0 声明 -> mismatch', () => {
  // 镜像站返回 200 + 空 body 就属于这一类
  const r = verifySize(0, 5000)
  assert.equal(r.kind, 'mismatch')
})

test('verifySize: 文件不存在（null）-> mismatch', () => {
  const r = verifySize(null, 5000)
  assert.equal(r.kind, 'mismatch')
  assert.equal(r.kind === 'mismatch' ? r.actual : undefined, null)
})

test('verifySize: 远端长度未知 -> 跳过（没有基准，不能乱判）', () => {
  const r = verifySize(1234, undefined)
  assert.equal(r.kind, 'ok')
  // 正向断言：跳过时不带 actual，调用方不会误以为校验过
  assert.equal(r.kind === 'ok' ? r.actual : undefined, undefined)
})

test('verifySize: 服务器无视 identity 仍返回压缩编码 -> 跳过（否则 100% 误报）', () => {
  // 0.7.0 实测：fetch 默认 accept-encoding 时 5000B 的 body 会报 41B，
  // 而 curl / aria2 落盘的是未压缩的 5000B。此时 41 ≠ 5000 是正常现象。
  for (const enc of ['gzip', 'br', 'deflate', 'GZIP']) {
    const r = verifySize(5000, 41, enc)
    assert.equal(r.kind, 'ok', `${enc} 应跳过校验`)
  }
})

test('verifySize: identity 视为未压缩 -> 照常校验', () => {
  assert.equal(verifySize(5000, 4096, 'identity').kind, 'mismatch')
  assert.equal(verifySize(4096, 4096, 'identity').kind, 'ok')
  // Node 24 undici 会发出 `identity, identity`（RFC 语义仍等于未压缩）
  assert.equal(verifySize(4096, 4096, 'identity, identity').kind, 'ok')
  assert.equal(verifySize(5000, 4096, 'identity, identity').kind, 'mismatch')
})

test('normalizeContentEncoding: 空 / identity / 大小写归一', () => {
  assert.equal(normalizeContentEncoding(undefined), undefined)
  assert.equal(normalizeContentEncoding(null), undefined)
  assert.equal(normalizeContentEncoding(''), undefined)
  assert.equal(normalizeContentEncoding('identity'), undefined)
  assert.equal(normalizeContentEncoding('IDENTITY'), undefined)
  assert.equal(normalizeContentEncoding('identity, identity'), undefined)
  assert.equal(normalizeContentEncoding('  '), undefined)
  assert.equal(normalizeContentEncoding('gzip'), 'gzip')
  assert.equal(normalizeContentEncoding('GZIP'), 'gzip')
  assert.equal(normalizeContentEncoding('gzip, identity'), 'gzip')
  assert.equal(normalizeContentEncoding('br'), 'br')
})

test('verifySize: 混合编码含真实压缩 -> 跳过', () => {
  assert.equal(verifySize(5000, 41, 'gzip, identity').kind, 'ok')
})

test('expectedFromProbe: 取出期望长度与编码', () => {
  const probe: ProbeResult = {
    supportsMultiThread: true,
    contentLength: 5000,
    contentEncoding: 'gzip',
  }
  assert.deepEqual(expectedFromProbe(probe), { expected: 5000, contentEncoding: 'gzip' })
})

test('describeMismatch: 文件缺失与字节数不等都有可读文案', () => {
  assert.match(describeMismatch({ kind: 'mismatch', expected: 5000, actual: null }), /文件不存在/)
  assert.match(describeMismatch({ kind: 'mismatch', expected: 5000, actual: 41 }), /41 字节/)
  assert.match(describeMismatch({ kind: 'mismatch', expected: 5000, actual: 41 }), /5000 字节/)
})
