/**
 * progress.ts 单测：
 * - 双轨写入（JSONL 与 JSON）；
 * - pct 去重；
 * - 目录不可写时静默容错；
 * - done / fail 终态能穿透去重。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProgressReporter } from '../src/progress.js'

let tmpRoot = ''
let taskDir = ''
let dlDir = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'progress-test-'))
  taskDir = path.join(tmpRoot, 'task-progress')
  dlDir = path.join(tmpRoot, 'download-progress')
  process.env.DSH_PROGRESS_DIR = taskDir
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = dlDir
})

afterEach(() => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 读取 JSONL 所有记录 */
function readJsonl(file: string): Array<Record<string, unknown>> {
  const raw = readFileSync(file, 'utf-8').trim()
  if (!raw) return []
  return raw.split('\n').map((line) => JSON.parse(line))
}

test('report 写入两条轨道', () => {
  const r = new ProgressReporter('task-1')
  r.report(42, '下载中', '5MB/s', '10s')

  const jsonl = path.join(taskDir, 'task-1.jsonl')
  const json = path.join(dlDir, 'task-1.json')

  assert.ok(existsSync(jsonl), 'JSONL 应存在')
  assert.ok(existsSync(json), 'JSON 应存在')

  const lines = readJsonl(jsonl)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].pct, 42)
  assert.equal(lines[0].msg, '下载中')
  assert.equal(lines[0].spd, '5MB/s')
  assert.equal(lines[0].eta, '10s')
  assert.equal(lines[0].v, 1)

  const task = JSON.parse(readFileSync(json, 'utf-8'))
  assert.equal(task.progress, 0.42)
  assert.equal(task.status, 'running')
  assert.equal(task.speed, '5MB/s')
})

test('pct 未变化时去重，不重复写入', () => {
  const r = new ProgressReporter('task-2')
  r.report(30, '下载中')
  r.report(30, '下载中')
  r.report(30, '下载中')

  const lines = readJsonl(path.join(taskDir, 'task-2.jsonl'))
  assert.equal(lines.length, 1)
})

test('pct 变化时正常追加', () => {
  const r = new ProgressReporter('task-3')
  r.report(10, '下载中')
  r.report(20, '下载中')
  r.report(30, '下载中')

  const lines = readJsonl(path.join(taskDir, 'task-3.jsonl'))
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => l.pct), [10, 20, 30])
})

test('done 穿透去重并标记 completed', () => {
  const r = new ProgressReporter('task-4')
  r.report(100, '下载完成') // 第一次到 100
  r.report(100, '下载完成') // 终态，应穿透去重

  const lines = readJsonl(path.join(taskDir, 'task-4.jsonl'))
  assert.equal(lines.length, 2)

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-4.json'), 'utf-8'))
  assert.equal(task.status, 'completed')
  assert.equal(task.progress, 1)
})

test('fail 保留最后 pct 并写入失败消息', () => {
  const r = new ProgressReporter('task-5')
  r.report(50, '下载中')
  r.fail('连接超时')

  const lines = readJsonl(path.join(taskDir, 'task-5.jsonl'))
  const last = lines[lines.length - 1]
  assert.equal(last.pct, 50)
  assert.match(String(last.msg), /失败.*连接超时/)
})

test('目录不可写时不抛异常', () => {
  // 用一个普通文件占位，再在其“下”建目录，mkdir 必然失败（ENOTDIR）
  const blocker = path.join(tmpRoot, 'blocker-file')
  writeFileSync(blocker, 'x')
  process.env.DSH_PROGRESS_DIR = path.join(blocker, 'nope')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(blocker, 'nope2')

  assert.doesNotThrow(() => {
    const r = new ProgressReporter('task-6')
    r.report(50, '下载中')
    r.done()
    r.fail('x')
  })
})

test('cleanup 删除进度文件', () => {
  const r = new ProgressReporter('task-7')
  r.report(50, '下载中')
  r.cleanup()

  assert.ok(!existsSync(path.join(taskDir, 'task-7.jsonl')))
  assert.ok(!existsSync(path.join(dlDir, 'task-7.json')))
})

test('cleanup 对不存在的文件不抛异常', () => {
  const r = new ProgressReporter('task-8')
  assert.doesNotThrow(() => r.cleanup())
})
