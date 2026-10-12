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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ProgressReporter,
  removeTaskRecords,
  resolveDshHome,
  resolveDownloadProgressDir,
  resolveTaskProgressDir,
  taskRecordFiles,
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

/**
 * 写盘超时必须留下可观测的线索（1.0.0 修正）。
 *
 * 0.9.0 之前 `awaitFlush()` 的 2 秒上限超时后**静默**返回：磁盘异常时，
 * 「进度没写进去」在用户侧只表现为面板卡住，没有任何可排查的东西。现在会发
 * `process.emitWarning`（仍不阻断调用）。
 *
 * 用 `awaitFlush(30)` 把窗口压到 30ms 来测同类路径 —— 生产默认值 2s 不变，
 * 注入点只改等待时长，不改行为。
 */
test('awaitFlush 超时发出 process.emitWarning（不再静默）', async () => {
  const r = new ProgressReporter('task-timeout')
  // 构造一个「永远写不完」的待写队列：直接替换内部的 pendingWrite。
  // 命名以 _ 开头的私有字段在测试里显式可见，是为了让这条用例不依赖真实磁盘
  // 卡顿（那玩意儿没法在单测里稳定复现）。
  const internals = r as unknown as { pendingWrite: Promise<void> }
  internals.pendingWrite = new Promise<void>(() => {})

  const warnings: string[] = []
  const onWarning = (w: Error): void => {
    warnings.push(`${(w as Error & { code?: string }).code ?? ''}:${w.message}`)
  }
  process.on('warning', onWarning)
  try {
    await r.awaitFlush(30)
    // process.emitWarning 是异步派发的（下一个 tick 才到 'warning' 监听器），
    // 因此必须让出一次事件循环再断言，否则会假阴性。
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', onWarning)
  }

  assert.equal(warnings.length, 1, `应恰好发出 1 条 warning，实际 ${warnings.length}`)
  assert.match(warnings[0] ?? '', /DSH_SMARTDL_PROGRESS_FLUSH_TIMEOUT/)
  assert.match(warnings[0] ?? '', /task-timeout/)
})
/**
 * awaitFlush 的超时计时器必须带 unref（1.0.0 修正）。
 *
 * 0.9.0 之前用的是 `node:timers/promises` 的 `setTimeout` —— 它**不会** unref，
 * 实测把 Node 事件循环多留住整个超时时长（脚本末尾打印 `process exit after 2016 ms`）：
 * CLI 下每次下载结束都要多等约 2 秒才退出，DSH 宿主里同样白占一个 2 秒的计时器。
 * 这条用例把上面的实测钉死：awaitFlush 返回后不允许再残留 Timeout 句柄。
 */
test('awaitFlush 返回后不残留 Timeout 句柄（超时计时器已清理）', async () => {
  const r = new ProgressReporter('task-unref')
  r.report(50, '下载中')
  await r.awaitFlush() // 先让首轮写盘落地，后面的计数不受它影响

  const countTimeouts = (): number =>
    process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length
  const before = countTimeouts()
  await r.awaitFlush(60)
  const after = countTimeouts()
  assert.equal(after, before, `awaitFlush 返回后 Timeout 句柄数应回到 ${before}，实际 ${after}`)
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

/* ---------------- 1.3.0：批次 ID（P0-5 贯通两条轨道） ---------------- */

test('批次 ID：提供时两条轨道写入同一个值', async () => {
  const r = new ProgressReporter('task-batch-1', 'a.bin', undefined, 'b-abc123')
  r.report(10, '下载中')
  r.report(100, '下载完成', undefined, undefined, 'done')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-batch-1.jsonl'))
  assert.equal(lines.length, 2)
  // 每一条记录都要带批次 ID：读取端按最后一行判定状态，只写首条等于没写
  for (const line of lines) assert.equal(line.batch, 'b-abc123')

  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-batch-1.json'), 'utf-8')) as {
    batch?: string
  }
  assert.equal(task.batch, 'b-abc123', '轨道二也要能还原批次')
})

test('批次 ID：未提供时两条轨道都不出现该字段（与 1.2.0 逐字节相同）', async () => {
  const r = new ProgressReporter('task-batch-2', 'b.bin')
  r.report(50, '下载中')
  await r.awaitFlush()

  const lines = readJsonl(path.join(taskDir, 'task-batch-2.jsonl'))
  assert.equal(Object.hasOwn(lines[0]!, 'batch'), false, '轨道一不得凭空多出 batch 字段')
  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-batch-2.json'), 'utf-8')) as object
  assert.equal(Object.hasOwn(task, 'batch'), false, '轨道二不得凭空多出 batch 字段')
})

test('批次 ID：不同批次互不相同（单条目调用也要有唯一值）', async () => {
  // 单条目调用的批次 ID 由调用方生成后传进来，这里验证「不同的值确实被分别写入」，
  // 否则两台并发的单条目调用会在读取端被误判成同一批。
  const a = new ProgressReporter('task-batch-a', 'a.bin', undefined, 'b-one')
  const b = new ProgressReporter('task-batch-b', 'b.bin', undefined, 'b-two')
  a.report(1, '下载中')
  b.report(1, '下载中')
  await a.awaitFlush()
  await b.awaitFlush()

  assert.equal(readJsonl(path.join(taskDir, 'task-batch-a.jsonl'))[0]!.batch, 'b-one')
  assert.equal(readJsonl(path.join(taskDir, 'task-batch-b.jsonl'))[0]!.batch, 'b-two')
})

/* ------------------ 1.4.0：输出路径 / 尺寸 / mtime（两条轨道） ------------------ */

test('输出路径：每条记录都带 outPath，只有终态那条带 size/fileMtimeMs', async () => {
  const product = path.join(tmpRoot, 'out', 'big.bin')
  mkdirSync(path.dirname(product), { recursive: true })
  writeFileSync(product, 'x'.repeat(1234))

  const r = new ProgressReporter('task-out-1', 'big.bin', undefined, undefined, product)
  r.report(10, '下载中')
  await r.awaitFlush()
  // 进行中的那条：有路径，但没有尺寸/ mtime（尺寸是中间值，写下来会误导判据）
  const running = readJsonl(path.join(taskDir, 'task-out-1.jsonl'))[0]!
  assert.equal(running.outPath, product, '进行中也要能定位到产物')
  assert.equal(Object.hasOwn(running, 'size'), false, '进行中不得写尺寸')
  assert.equal(Object.hasOwn(running, 'fileMtimeMs'), false, '进行中不得写 mtime')

  r.done()
  await r.awaitFlush()
  const lines = readJsonl(path.join(taskDir, 'task-out-1.jsonl'))
  const terminal = lines[lines.length - 1]!
  assert.equal(terminal.state, 'done')
  assert.equal(terminal.outPath, product)
  assert.equal(terminal.size, 1234, '终态必须记下真实字节数')
  assert.ok(typeof terminal.fileMtimeMs === 'number' && terminal.fileMtimeMs > 0, '终态要记 mtime')

  // 轨道二同步带上同样的三个字段（任一轨道单独存活都能定位产物）
  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-out-1.json'), 'utf-8'))
  assert.equal(task.outPath, product)
  assert.equal(task.size, 1234)
  assert.equal(task.status, 'completed')
})

test('输出路径：不传 outPath 时两条轨道都不出现该字段（老行为逐字节不变）', async () => {
  const r = new ProgressReporter('task-out-2', 'f.bin')
  r.done()
  await r.awaitFlush()
  const line = readJsonl(path.join(taskDir, 'task-out-2.jsonl'))[0]!
  assert.equal(Object.hasOwn(line, 'outPath'), false, '轨道一不得凭空多出 outPath')
  assert.equal(Object.hasOwn(line, 'size'), false)
  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-out-2.json'), 'utf-8')) as object
  assert.equal(Object.hasOwn(task, 'outPath'), false, '轨道二不得凭空多出 outPath')
})

test('输出路径：相对路径被忽略（记下来也删不得，不如不记）', async () => {
  const r = new ProgressReporter('task-out-3', 'rel.bin', undefined, undefined, 'relative.bin')
  r.done()
  await r.awaitFlush()
  const line = readJsonl(path.join(taskDir, 'task-out-3.jsonl'))[0]!
  assert.equal(Object.hasOwn(line, 'outPath'), false, '相对路径不得写进记录')
  const task = JSON.parse(readFileSync(path.join(dlDir, 'task-out-3.json'), 'utf-8')) as object
  assert.equal(Object.hasOwn(task, 'outPath'), false)
})

test('输出路径：产物已经不在时不写 size（如实只留路径，管理端据此报 missing）', async () => {
  const missing = path.join(tmpRoot, 'never-existed.bin')
  const r = new ProgressReporter('task-out-4', 'm.bin', undefined, undefined, missing)
  r.done()
  await r.awaitFlush()
  const line = readJsonl(path.join(taskDir, 'task-out-4.jsonl'))[0]!
  assert.equal(line.outPath, missing, '路径照记')
  assert.equal(Object.hasOwn(line, 'size'), false, '拿不到尺寸就不要编一个')
})

test('taskRecordFiles / removeTaskRecords：只认普通文件，且 taskId 必须过白名单', async () => {
  const r = new ProgressReporter('task-rec-1', 'a.bin')
  r.done()
  await r.awaitFlush()

  const files = taskRecordFiles('task-rec-1')
  assert.deepEqual(
    files.slice().sort(),
    [path.join(taskDir, 'task-rec-1.jsonl'), path.join(dlDir, 'task-rec-1.json')].sort(),
    '两条轨道的记录都要被找到',
  )
  // 白名单：带分隔符 / .. 的 id 一律返回空（拼进文件名就是路径穿越）
  for (const bad of ['../evil', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(65)]) {
    assert.deepEqual(taskRecordFiles(bad), [], `非法 taskId ${JSON.stringify(bad)} 不得产生路径`)
    assert.deepEqual(removeTaskRecords(bad), [], `非法 taskId ${JSON.stringify(bad)} 不得删任何东西`)
  }
  assert.deepEqual(removeTaskRecords('task-rec-1').slice().sort(), files.slice().sort())
  assert.equal(existsSync(path.join(taskDir, 'task-rec-1.jsonl')), false, '记录必须被删掉')
  assert.equal(existsSync(path.join(dlDir, 'task-rec-1.json')), false)
  assert.deepEqual(taskRecordFiles('task-rec-1'), [], '删完之后不再有候选')
})

test('taskRecordFiles：目录（而不是文件）同名时不进候选（删不掉的目录不该被当作记录）', () => {
  mkdirSync(path.join(dlDir, 'task-dir.json'), { recursive: true })
  assert.deepEqual(taskRecordFiles('task-dir'), [], '目录不是记录文件')
})
