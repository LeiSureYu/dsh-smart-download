/**
 * decision.ts 单测：覆盖决策树的所有分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decide,
  decideConcurrency,
  LARGE_FILE,
  SIZE_THRESHOLD,
} from '../src/decision.js'
import type { ProbeResult } from '../src/types.js'

const MB = 1024 * 1024

/** 构造一个默认“支持多线程”的探测结果，按需覆盖字段 */
function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return { supportsMultiThread: true, ...overrides }
}

/* ------------------------------ decideConcurrency ------------------------------ */

test('decideConcurrency: < 50MB -> 4', () => {
  assert.equal(decideConcurrency(2 * MB), 4)
  assert.equal(decideConcurrency(49 * MB), 4)
})

test('decideConcurrency: >= 50MB -> 8', () => {
  assert.equal(decideConcurrency(LARGE_FILE), 8)
  assert.equal(decideConcurrency(200 * MB), 8)
})

/* ------------------------------ decide: 回退分支 ------------------------------ */

test('decide: 不支持多线程 -> curl，reason 透传', () => {
  const d = decide({ supportsMultiThread: false, reason: '服务器不支持 Range' }, true)
  assert.equal(d.method, 'curl')
  assert.equal(d.concurrency, 1)
  assert.equal(d.fellback, true)
  assert.equal(d.reason, '服务器不支持 Range')
})

test('decide: 探测失败无 reason -> curl，带默认理由', () => {
  const d = decide({ supportsMultiThread: false }, true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /探测判定/)
})

test('decide: 无 contentLength -> curl', () => {
  const d = decide(probe({ contentLength: undefined }), true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /无法获取文件大小/)
})

test('decide: 文件 < 1MB -> curl，理由含 KB', () => {
  const d = decide(probe({ contentLength: 500 * 1024 }), true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /500KB/)
})

test('decide: aria2 不可用 -> curl', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /aria2/)
})

/* ------------------------------ decide: aria2 分支 ------------------------------ */

test('decide: 1MB~50MB + aria2 可用 -> aria2 4 连接', () => {
  const d = decide(probe({ contentLength: 10 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 4)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /4 连接/)
})

test('decide: >= 50MB + aria2 可用 -> aria2 8 连接', () => {
  const d = decide(probe({ contentLength: 200 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /8 连接/)
})

test('decide: 刚好等于 1MB 阈值 -> aria2 4 连接（边界）', () => {
  const d = decide(probe({ contentLength: SIZE_THRESHOLD }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 4)
})

test('decide: 刚好等于 50MB 阈值 -> aria2 8 连接（边界）', () => {
  const d = decide(probe({ contentLength: LARGE_FILE }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
})
