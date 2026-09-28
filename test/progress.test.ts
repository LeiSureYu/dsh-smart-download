/**
 * progress.ts 单测：
 * - 双轨写入（JSONL 与 JSON）；
 * - pct 去重；
 * - 目录不可写时静默容错；
 * - done / fail 终态能穿透去重。
 *
 * 0.6.0 起写盘改为异步（同 tick 合并 + fs.promises），因此凡是要断言磁盘内容的
 * 用例都必须先 `await reporter.awaitFlush()`，否则读到的是落盘前的状态。
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
import {
  ProgressReporter,
  resolveDshHome,
  resolveDownloadProgressDir,
  resolveTaskProgressDir,
} from '../src/progress.js'

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

test('report 写入两条轨道', async () => {
  const r = new ProgressReporter('task-1')
  r.report(42, '下载中', '5MB/s', '10s')
  await r.awaitFlush()

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

test('pct 未变化时去重，不重复写入', async () => {
  const r = new ProgressReporter('task-2')
  r.report(30, '下载中')
  r.report(30, '下载中')
  r.report(30, '下载中')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-2.jsonl'))
  assert.equal(lines.length, 1)
})

test('pct 变化时正常追加', async () => {
  const r = new ProgressReporter('task-3')
  r.report(10, '下载中')
  r.report(20, '下载中')
  r.report(30, '下载中')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-3.jsonl'))
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => l.pct), [10, 20, 30])
})

test('终态穿透去重：pct 相同但 state 变为 done 时仍落盘', async () => {
  const r = new ProgressReporter('task-4')
  r.report(100, '下载中') // 进度已到 100，但尚未宣告完成
  r.done() // 终态：state 由 running 变 done，必须穿透去重
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-4.jsonl'))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].state, 'running')
  assert.equal(lines[1].state, 'done')

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-4.json'), 'utf-8'))
  assert.equal(task.status, 'completed')
  assert.equal(task.progress, 1)
})

test('fail 保留最后 pct 并写入失败消息', async () => {
  const r = new ProgressReporter('task-5')
  r.report(50, '下载中')
  r.fail('连接超时')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-5.jsonl'))
  const last = lines[lines.length - 1]
  assert.equal(last.pct, 50)
  assert.match(String(last.msg), /失败.*连接超时/)
})

test('目录不可写时不抛异常', async () => {
  // 用一个普通文件占位，再在其“下”建目录，mkdir 必然失败（ENOTDIR）
  const blocker = path.join(tmpRoot, 'blocker-file')
  writeFileSync(blocker, 'x')
  process.env.DSH_PROGRESS_DIR = path.join(blocker, 'nope')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(blocker, 'nope2')

  const r = new ProgressReporter('task-6')
  r.report(50, '下载中')
  r.done()
  r.fail('x')
  // 异步写盘的异常必须被吞掉，不能变成 unhandled rejection
  await assert.doesNotReject(() => r.awaitFlush())
})

test('cleanup 删除进度文件', async () => {
  const r = new ProgressReporter('task-7')
  r.report(50, '下载中')
  await r.awaitFlush()
  r.cleanup()

  assert.ok(!existsSync(path.join(taskDir, 'task-7.jsonl')))
  assert.ok(!existsSync(path.join(dlDir, 'task-7.json')))
})

test('cleanup 对不存在的文件不抛异常', () => {
  const r = new ProgressReporter('task-8')
  assert.doesNotThrow(() => r.cleanup())
})

test('label 写入两条轨道，供 UI 展示文件名', async () => {
  const r = new ProgressReporter('task-9', 'ubuntu-24.04.iso')
  r.report(7, '下载中', '2MB/s', '1m')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-9.jsonl'))
  assert.equal(lines[0].name, 'ubuntu-24.04.iso')
  // name 与 msg 各司其职：msg 仍是状态文案，不能被文件名顶掉
  assert.equal(lines[0].msg, '下载中')

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-9.json'), 'utf-8'))
  assert.equal(task.name, 'ubuntu-24.04.iso')
})

test('未提供 label 时，JSON 轨道的 name 回退为任务 ID', async () => {
  const r = new ProgressReporter('task-10')
  r.report(7, '下载中')
  await r.awaitFlush()

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-10.json'), 'utf-8'))
  assert.equal(task.name, 'task-10')

  // JSONL 轨道没有 name 字段时不应凭空写一个 undefined
  const lines = readJsonl(path.join(taskDir, 'task-10.jsonl'))
  assert.equal('name' in lines[0], false)
})

/* ---------------- 0.5.0：state 字段与轨道一目录解析 ---------------- */

test('终态记录显式写入 state（done / failed / cancelled）', async () => {
  const r = new ProgressReporter('task-11')
  r.report(10, '下载中')
  r.done()
  r.fail('连接超时')
  r.cancel('用户取消')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-11.jsonl'))
  assert.deepEqual(
    lines.map((l) => l.state),
    ['running', 'done', 'failed', 'cancelled'],
  )

  // 轨道二的状态映射：done -> completed
  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-11.json'), 'utf-8'))
  assert.equal(task.status, 'cancelled', '最后一次写入的终态应生效')
})

test('cancel 写入 cancelled 状态（轨道二）', async () => {
  const r = new ProgressReporter('task-12')
  r.report(30, '下载中')
  r.cancel()
  await r.awaitFlush()

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-12.json'), 'utf-8'))
  assert.equal(task.status, 'cancelled')
  assert.equal(task.progress, 0.3, '取消应保留最后一次百分比')
})

test('去重按整条记录：pct 相同但速度变化时仍写入', async () => {
  const r = new ProgressReporter('task-13')
  r.report(30, '下载中', '1MB/s')
  r.report(30, '下载中', '2MB/s')
  r.report(30, '下载中', '2MB/s') // 与上一条完全相同 -> 跳过
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-13.jsonl'))
  assert.equal(lines.length, 2)
  assert.deepEqual(
    lines.map((l) => l.spd),
    ['1MB/s', '2MB/s'],
  )
})

test('resolveTaskProgressDir：DSH_PROGRESS_DIR 优先于会话', () => {
  const dir = resolveTaskProgressDir({ id: 'sess-1', cwd: 'C:\\whatever' })
  assert.equal(dir, taskDir)
})

test('resolveTaskProgressDir：无 env 时用 <cwd>/.dsh-progress/<id>', () => {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-cwd-'))
    try {
      const dir = resolveTaskProgressDir({ id: 'sess-abc', cwd })
      assert.equal(dir, path.join(cwd, '.dsh-progress', 'sess-abc'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
})

test('resolveTaskProgressDir：无会话或非法会话 ID 时返回 null', () => {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    assert.equal(resolveTaskProgressDir(), null, '无会话 -> null')
    assert.equal(resolveTaskProgressDir({ cwd: 'C:\\x' }), null, '缺 id -> null')
    assert.equal(resolveTaskProgressDir({ id: 'sess' }), null, '缺 cwd -> null')
    assert.equal(
      resolveTaskProgressDir({ id: '../escape', cwd: 'C:\\x' }),
      null,
      '含分隔符的 id -> null',
    )
    assert.equal(
      resolveTaskProgressDir({ id: '-leading', cwd: 'C:\\x' }),
      null,
      '以 - 开头的 id -> null',
    )
    assert.equal(
      resolveTaskProgressDir({ id: 'a'.repeat(81), cwd: 'C:\\x' }),
      null,
      '超长 id -> null',
    )
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
})

test('无会话且无 DSH_PROGRESS_DIR 时不写轨道一，但轨道二照写', async () => {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    const r = new ProgressReporter('task-14')
    r.report(50, '下载中')
    await r.awaitFlush()
    assert.ok(existsSync(path.join(dlDir, 'task-14.json')), '轨道二应照写')
    assert.ok(!existsSync(path.join(tmpRoot, 'task-14.jsonl')), '轨道一不应出现')
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
})

test('有会话时轨道一写入 <cwd>/.dsh-progress/<id>/<taskId>.jsonl', async () => {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-sess-'))
    try {
      const r = new ProgressReporter('task-15', 'a.zip', { id: 'sess-1', cwd })
      r.report(25, '下载中', '3MB/s')
      await r.awaitFlush()
      const file = path.join(cwd, '.dsh-progress', 'sess-1', 'task-15.jsonl')
      assert.ok(existsSync(file), '应写进会话进度目录')
      const lines = readJsonl(file)
      assert.equal(lines[0].pct, 25)
      assert.equal(lines[0].state, 'running')
      assert.equal(lines[0].name, 'a.zip')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
})

test('resolveDshHome：DSH_HOME 优先，空 / 纯空白视为未设置', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\custom-dsh-home'
    assert.equal(resolveDshHome(), path.resolve('C:\\custom-dsh-home'))

    process.env.DSH_HOME = ''
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'), '空串应回落默认')

    process.env.DSH_HOME = '   '
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'), '纯空白应回落默认')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('resolveDshHome：~ 与 ~/x 会被展开', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '~'
    assert.equal(resolveDshHome(), path.resolve(os.homedir()))

    process.env.DSH_HOME = '~/nested'
    assert.equal(resolveDshHome(), path.resolve(path.join(os.homedir(), 'nested')))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('resolveDownloadProgressDir：走 DSH_HOME 而不是 USERPROFILE/HOME', () => {
  const savedDsh = process.env.DSH_HOME
  const savedDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  try {
    process.env.DSH_HOME = 'C:\\custom-dsh-home'
    assert.equal(
      resolveDownloadProgressDir(),
      path.join(path.resolve('C:\\custom-dsh-home'), 'downloads', 'tasks'),
    )
  } finally {
    if (savedDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDsh
    if (savedDir !== undefined) process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDir
  }
})

test('resolveDownloadProgressDir：DSH_DOWNLOAD_PROGRESS_DIR 优先', () => {
  assert.equal(resolveDownloadProgressDir(), dlDir)
})
