/**
 * tasks.ts 测试：进程内运行注册表与重试元数据校验。
 *
 * 这两件事都是 1.6.0 面板取消 / 重试的地基：
 * - 注册表决定「这条任务现在还能不能叫停」，错一次就是点了没反应；
 * - `parseRetryRequest` 决定「磁盘上那份 JSON 能不能拿去重发请求」，它是
 *   唯一一道把外部 JSON 收窄成安全请求的闸门。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  cancelRunningTask,
  getRetryHandler,
  isKnownTask,
  isRunning,
  parseRetryRequest,
  registerRunningTask,
  resetTaskRegistry,
  runningTaskIds,
  setRetryHandler,
  unregisterRunningTask,
} from '../src/tasks.js'

test('任务注册表：登记后可查、可取消；注销后不再运行但仍是已知 id', () => {
  resetTaskRegistry()
  const controller = new AbortController()
  assert.equal(registerRunningTask('t-reg', controller), true)
  assert.equal(isRunning('t-reg'), true)
  assert.equal(isKnownTask('t-reg'), true)
  assert.deepEqual(runningTaskIds(), ['t-reg'])

  assert.equal(cancelRunningTask('t-reg'), 'cancelled')
  assert.equal(controller.signal.aborted, true, '取消必须真的 abort controller')
  // 重复取消是幂等的：controller 仍被 abort，结果仍是 cancelled
  assert.equal(cancelRunningTask('t-reg'), 'cancelled')

  unregisterRunningTask('t-reg')
  assert.equal(isRunning('t-reg'), false)
  assert.equal(isKnownTask('t-reg'), true, '注销只表示跑完了，id 仍应可区分「没在跑」')
  assert.equal(cancelRunningTask('t-reg'), 'not-running')
  // 幂等：重复注销不抛错
  unregisterRunningTask('t-reg')
  resetTaskRegistry()
})

test('任务注册表：未知 id 取消返回 not-running；空 id 不登记', () => {
  resetTaskRegistry()
  assert.equal(cancelRunningTask('never-seen'), 'not-running')
  assert.equal(registerRunningTask('', new AbortController()), false)
  resetTaskRegistry()
})

test('任务注册表：reset 会 abort 所有在跑的 controller 并清空已知 id', () => {
  resetTaskRegistry()
  const a = new AbortController()
  const b = new AbortController()
  registerRunningTask('t-a', a)
  registerRunningTask('t-b', b)
  resetTaskRegistry()
  assert.equal(a.signal.aborted, true)
  assert.equal(b.signal.aborted, true)
  assert.deepEqual(runningTaskIds(), [])
  assert.equal(isKnownTask('t-a'), false)
})

test('重试处理器：可安装、可读取、可清除', () => {
  resetTaskRegistry()
  assert.equal(getRetryHandler(), null)
  const handler = () => ({ started: true, taskId: 'x' })
  setRetryHandler(handler)
  assert.equal(getRetryHandler(), handler)
  setRetryHandler(null)
  assert.equal(getRetryHandler(), null)
})

test('parseRetryRequest：合法字段原样保留，额外字段（含 headers）一律丢弃', () => {
  // 绝对路径必须按当前平台拼：`C:\...` 在 Linux 上不是绝对路径，
  // 用它写死会让这条用例在 CI 的 ubuntu runner 上假红。
  const absoluteOutput = path.resolve('a.bin')
  const parsed = parseRetryRequest({
    url: '  https://example.com/a.bin  ',
    output: absoluteOutput,
    sha256: 'a'.repeat(64),
    ifExists: 'rename',
    mirror: 'auto',
    maxBandwidthBytes: 1024,
    timeoutMs: 30_000,
    batchId: 'b-1',
    headers: { authorization: 'Bearer secret' },
    cookie: 'session=secret',
  })
  assert.deepEqual(parsed, {
    url: 'https://example.com/a.bin',
    output: absoluteOutput,
    sha256: 'a'.repeat(64),
    ifExists: 'rename',
    mirror: 'auto',
    maxBandwidthBytes: 1024,
    timeoutMs: 30_000,
    batchId: 'b-1',
  })
  assert.equal(Object.hasOwn(parsed as object, 'headers'), false, '请求头绝不能进入重试元数据')
})

test('parseRetryRequest：相对 output 不覆盖绝对 outPath；没有绝对路径时省略 output', () => {
  const absoluteOutPath = path.resolve('a.bin')
  const withOutPath = parseRetryRequest(
    { url: 'https://example.com/a.bin', output: 'relative/a.bin' },
    absoluteOutPath,
  )
  assert.equal(withOutPath?.output, absoluteOutPath)

  const withoutAny = parseRetryRequest({ url: 'https://example.com/a.bin', output: 'a.bin' })
  assert.equal(withoutAny?.output, undefined)
  assert.equal(Object.hasOwn(withoutAny as object, 'output'), false)
})

test('parseRetryRequest：URL 缺失 / 非对象 / sha256 与 checksum 并存 -> undefined', () => {
  assert.equal(parseRetryRequest(null), undefined)
  assert.equal(parseRetryRequest('https://example.com/a.bin'), undefined)
  assert.equal(parseRetryRequest({}), undefined)
  assert.equal(parseRetryRequest({ url: '   ' }), undefined)
  assert.equal(
    parseRetryRequest({
      url: 'https://example.com/a.bin',
      sha256: 'a'.repeat(64),
      checksum: 'b'.repeat(32),
    }),
    undefined,
    '两个摘要同时存在时必须拒绝，而不是替用户选一个',
  )
})

test('parseRetryRequest：非法 ifExists / 非正整数字段被丢弃，不污染结果', () => {
  const parsed = parseRetryRequest({
    url: 'https://example.com/a.bin',
    ifExists: 'destroy',
    maxBandwidthBytes: -1,
    mirror: '   ',
    batchId: '',
  })
  assert.deepEqual(parsed, { url: 'https://example.com/a.bin' })
})

test('parseRetryRequest：timeoutMs 必须落在 1000..1800000，越界整条拒绝', () => {
  const base = { url: 'https://example.com/a.bin' }
  assert.equal(parseRetryRequest({ ...base, timeoutMs: 999 }), undefined, '低于下限必须拒绝')
  assert.equal(parseRetryRequest({ ...base, timeoutMs: 0 }), undefined)
  assert.equal(parseRetryRequest({ ...base, timeoutMs: 1_800_001 }), undefined, '高于上限必须拒绝')
  assert.equal(parseRetryRequest({ ...base, timeoutMs: 1_000 })?.timeoutMs, 1_000)
  assert.equal(parseRetryRequest({ ...base, timeoutMs: 1_800_000 })?.timeoutMs, 1_800_000)
  assert.equal(
    parseRetryRequest({ ...base, timeoutMs: '30000' }),
    undefined,
    '字符串不是合法数字，不能悄悄转换',
  )
})
