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

test('decideConcurrency: < 8MB -> 4（0.7.0 实测：2MB 文件 x=2 就到顶，再高反而略降）', () => {
  assert.equal(decideConcurrency(2 * MB), 4)
  assert.equal(decideConcurrency(7 * MB), 4)
})

test('decideConcurrency: >= 8MB -> 8（0.7.0 实测：8MB 下 x=8 比 x=4 快近一倍）', () => {
  assert.equal(decideConcurrency(LARGE_FILE), 8)
  assert.equal(decideConcurrency(49 * MB), 8)
  assert.equal(decideConcurrency(200 * MB), 8)
})

test('LARGE_FILE 阈值已从 50MB 下调为 8MB（0.7.0 实测依据）', () => {
  // 正向断言：钉住实测结论，防止有人无意改回 50MB 让 8~50MB 掉回 4 连接
  assert.equal(LARGE_FILE, 8 * 1024 * 1024)
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

test('decide: aria2 不可用时的理由带当前平台（env 可注入，平台依赖已纯函数化）', () => {
  // 0.6.0 之前 decide() 直接读 process.platform，测试跑在哪个平台就只能断言
  // 哪个平台；现在通过 env 注入，可以覆盖任意平台组合。
  const d = decide(probe({ contentLength: 100 * MB }), false, {
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /darwin-arm64/)
})

test('decide: 不传 env 时仍回落真实 process.platform / process.arch（行为不变）', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false)
  assert.match(d.reason, new RegExp(`${process.platform}-${process.arch}`))
})

test('decide: env 只给一个字段时，另一个仍取真实环境', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false, { platform: 'linux' })
  assert.match(d.reason, new RegExp(`linux-${process.arch}`))
})

/* ------------------------------ decide: aria2 分支 ------------------------------ */

test('decide: 1MB~8MB + aria2 可用 -> aria2 4 连接', () => {
  const d = decide(probe({ contentLength: 2 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 4)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /4 连接/)
})

test('decide: 8MB~50MB + aria2 可用 -> aria2 8 连接（0.7.0 修正：此前被压在 4）', () => {
  const d = decide(probe({ contentLength: 10 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /8 连接/)
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

test('decide: 刚好等于 8MB 阈值 -> aria2 8 连接（边界）', () => {
  const d = decide(probe({ contentLength: LARGE_FILE }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
})
