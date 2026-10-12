/**
 * status.ts 测试：download_status 的只读快照。
 *
 * 静默失败形态：目录不可读 / 内容损坏时“悄悄返回空列表”。
 * 因此正向契约是——**只要目录里有合法任务文件，就必须真的扫出来并解析出字段**，
 * 而不只是“调用不抛错”。同时验证损坏与缺失场景不会把整个调用拖垮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_STATUS_LIMIT,
  MAX_STATUS_LIMIT,
  readDownloadStatus,
} from '../src/status.js'

/** 建一个临时目录，注册清理 */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-status-'))
  return dir
}

/** 用环境变量把两条轨道都指向临时目录后执行 fn */
function withDirs(fn: (dirs: { taskDir: string; downloadDir: string }) => void): void {
  const taskDir = tempDir()
  const downloadDir = tempDir()
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_PROGRESS_DIR = taskDir
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    fn({ taskDir, downloadDir })
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(taskDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
}

/** 写一条轨道一的 JSONL（append-only，取最后一行） */
function writeJsonl(dir: string, id: string, records: unknown[]): void {
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  )
}

/** 写一条轨道二的 JSON（整体覆盖写） */
function writeJson(dir: string, id: string, value: unknown): void {
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(value, null, 2), 'utf-8')
}

test('空目录 -> 成功返回且 tasks 为空数组（不抛错）', () => {
  withDirs(() => {
    const snap = readDownloadStatus()
    assert.equal(snap.ok, true)
    assert.deepEqual(snap.tasks, [])
    assert.equal(snap.total, 0)
  })
})

test('轨道一 JSONL：扫出任务并解析最后一条记录', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-abc', [
      { v: 1, task: 'dl-abc', pct: 10, msg: '下载中（aria2）' },
      { v: 1, task: 'dl-abc', pct: 42, msg: '下载中（aria2）', spd: '8.2MB/s', eta: '4m51s' },
    ])
    const snap = readDownloadStatus()
    assert.equal(snap.total, 1)
    const task = snap.tasks[0]
    assert.ok(task)
    assert.equal(task.id, 'dl-abc')
    assert.equal(task.pct, 42, '应取最后一行')
    assert.equal(task.spd, '8.2MB/s')
    assert.equal(task.eta, '4m51s')
    assert.equal(task.status, 'running')
  })
})

test('轨道一 JSONL：末尾有半截损坏行时回退到上一行有效记录', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-x', [
      { v: 1, task: 'dl-x', pct: 77, msg: '下载中（curl）' },
    ])
    // 追加一行写坏的 JSON，模拟进程被中断
    const file = path.join(taskDir, 'dl-x.jsonl')
    writeFileSync(file, '{"v":1,"task":"dl-x","pct":99,"ms', { flag: 'a' })
    const snap = readDownloadStatus()
    assert.equal(snap.tasks[0]?.pct, 77)
  })
})

test('轨道二 JSON：解析 progress/status/updatedAt', () => {
  withDirs(({ downloadDir }) => {
    writeJson(downloadDir, 'dl-json', {
      id: 'dl-json',
      name: 'a.zip',
      status: 'completed',
      progress: 1,
      speed: '3.1MB/s',
      updatedAt: 1_700_000_000_000,
    })
    const snap = readDownloadStatus()
    const task = snap.tasks[0]
    assert.ok(task)
    assert.equal(task.id, 'dl-json')
    assert.equal(task.pct, 100)
    assert.equal(task.status, 'completed')
    assert.equal(task.spd, '3.1MB/s')
    assert.equal(task.updatedAt, 1_700_000_000_000)
  })
})

/* ---------------- 1.3.0：批次 ID（P0-5 的读取端） ---------------- */

test('批次 ID：两条轨道都能读出（P0-5 贯通四层）', () => {
  withDirs(({ taskDir, downloadDir }) => {
    writeJsonl(taskDir, 'dl-batch-1', [
      { v: 1, task: 'dl-batch-1', pct: 100, msg: '下载完成', state: 'done', batch: 'b-777' },
    ])
    writeJson(downloadDir, 'dl-batch-2', {
      id: 'dl-batch-2',
      name: 'x.zip',
      status: 'completed',
      progress: 1,
      batch: 'b-888',
    })
    const snap = readDownloadStatus()
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    assert.equal(byId.get('dl-batch-1')?.batch, 'b-777', '轨道一的批次必须被读出')
    assert.equal(byId.get('dl-batch-2')?.batch, 'b-888', '轨道二的批次必须被读出')
  })
})

test('批次 ID：老进度文件缺该字段 -> 空串，且 status/pct/msg 解析结果不变（硬回归项）', () => {
  withDirs(({ taskDir, downloadDir }) => {
    // 1.2.0 及更早写下的记录：没有 batch 字段，其它字段照旧
    writeJsonl(taskDir, 'dl-old', [{ v: 1, task: 'dl-old', pct: 30, msg: '失败: 连接超时' }])
    writeJson(downloadDir, 'dl-old-json', {
      id: 'dl-old-json',
      name: 'old.zip',
      status: 'failed',
      progress: 0.3,
    })
    const snap = readDownloadStatus()
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))

    const fromJsonl = byId.get('dl-old')
    assert.ok(fromJsonl)
    assert.equal(fromJsonl.batch, '', '缺字段必须是空串（schema 要求 string）')
    // 解析结果一个字都不能变
    assert.equal(fromJsonl.pct, 30)
    assert.equal(fromJsonl.msg, '失败: 连接超时')
    assert.equal(fromJsonl.status, 'failed')

    const fromJson = byId.get('dl-old-json')
    assert.ok(fromJson)
    assert.equal(fromJson.batch, '')
    assert.equal(fromJson.pct, 30)
    assert.equal(fromJson.status, 'failed')
    assert.equal(fromJson.name, 'old.zip')
  })
})

test('批次 ID：一条轨道缺该字段时，合并结果保留另一条轨道写下的值', () => {
  withDirs(({ taskDir, downloadDir }) => {
    // 轨道二（较新）写了批次；轨道一（老写入端）没有 —— 合并后不得把批次丢掉
    writeJson(downloadDir, 'dl-merge', {
      id: 'dl-merge',
      name: 'm.zip',
      status: 'running',
      progress: 0.5,
      batch: 'b-merge',
    })
    writeJsonl(taskDir, 'dl-merge', [
      { v: 1, task: 'dl-merge', pct: 50, msg: '下载中（aria2）' },
    ])
    const snap = readDownloadStatus()
    const task = snap.tasks[0]
    assert.ok(task)
    assert.equal(task.batch, 'b-merge', '轨道一没有批次时应保留轨道二的')
    assert.equal(task.msg, '下载中（aria2）', '其余字段仍由轨道一覆盖')
  })
})

test('同一任务两条轨道都有 -> 合并，JSONL 的 msg/速度补充上去', () => {
  withDirs(({ taskDir, downloadDir }) => {
    writeJson(downloadDir, 'dl-both', {
      id: 'dl-both',
      name: 'dl-both',
      status: 'running',
      progress: 0.5,
      updatedAt: 1000,
    })
    writeJsonl(taskDir, 'dl-both', [
      { v: 1, task: 'dl-both', pct: 50, msg: '下载中（aria2）', spd: '1.0MB/s' },
    ])
    const snap = readDownloadStatus()
    assert.equal(snap.total, 1, '同一任务不应重复计数')
    const task = snap.tasks[0]
    assert.ok(task)
    assert.equal(task.msg, '下载中（aria2）')
    assert.equal(task.spd, '1.0MB/s')
    assert.equal(task.status, 'running')
  })
})

test('status 推断：失败文案 -> failed，完成文案/100% -> completed', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-fail', [{ v: 1, task: 'dl-fail', pct: 30, msg: '失败: 连接超时' }])
    writeJsonl(taskDir, 'dl-ok', [{ v: 1, task: 'dl-ok', pct: 100, msg: '下载完成' }])
    const snap = readDownloadStatus()
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    assert.equal(byId.get('dl-fail')?.status, 'failed')
    assert.equal(byId.get('dl-ok')?.status, 'completed')
  })
})

test('taskId 过滤：只返回指定任务', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-a', [{ v: 1, task: 'dl-a', pct: 10, msg: '下载中' }])
    writeJsonl(taskDir, 'dl-b', [{ v: 1, task: 'dl-b', pct: 20, msg: '下载中' }])
    const snap = readDownloadStatus(10, 'dl-b')
    assert.equal(snap.total, 1)
    assert.equal(snap.tasks[0]?.id, 'dl-b')
  })
})

test('limit 截断：total 报真实总数，tasks 被截断', () => {
  withDirs(({ taskDir }) => {
    for (let i = 0; i < 5; i++) {
      writeJsonl(taskDir, `dl-${i}`, [
        { v: 1, task: `dl-${i}`, pct: i, msg: '下载中', updatedAt: i },
      ])
    }
    const snap = readDownloadStatus(2)
    assert.equal(snap.total, 5, 'total 应是未截断的总数')
    assert.equal(snap.tasks.length, 2)
  })
})

test('非法 limit（0 / 负数 / NaN）-> 退回默认值，不返回空', () => {
  withDirs(({ taskDir }) => {
    for (let i = 0; i < DEFAULT_STATUS_LIMIT + 2; i++) {
      writeJsonl(taskDir, `dl-${i}`, [{ v: 1, task: `dl-${i}`, pct: i, msg: '下载中' }])
    }
    for (const bad of [0, -1, Number.NaN]) {
      const snap = readDownloadStatus(bad)
      assert.equal(snap.tasks.length, DEFAULT_STATUS_LIMIT, `limit=${bad} 应退回默认`)
      assert.equal(snap.total, DEFAULT_STATUS_LIMIT + 2)
    }
  })
})

test('limit 超过上限被夹到 MAX_STATUS_LIMIT（工具与 RPC 共用同一常量）', () => {
  withDirs(({ taskDir }) => {
    for (let i = 0; i < MAX_STATUS_LIMIT + 3; i++) {
      writeJsonl(taskDir, `dl-${i}`, [{ v: 1, task: `dl-${i}`, pct: i, msg: '下载中' }])
    }
    const snap = readDownloadStatus(MAX_STATUS_LIMIT + 100)
    // 正向断言：夹到具体值，且 total 仍是真实总数
    assert.equal(snap.tasks.length, MAX_STATUS_LIMIT)
    assert.equal(snap.total, MAX_STATUS_LIMIT + 3)
  })
})

test('字符串字段永不返回 undefined（schema 要求 string）', () => {
  withDirs(({ downloadDir }) => {
    // 故意只写 id，其余字段全部缺失
    writeJson(downloadDir, 'dl-min', { id: 'dl-min' })
    const snap = readDownloadStatus()
    const task = snap.tasks[0]
    assert.ok(task)
    for (const key of ['msg', 'spd', 'eta'] as const) {
      assert.equal(typeof task[key], 'string', `${key} 必须是 string`)
    }
    assert.equal(task.status, 'running', '未知 status 退化为 running')
  })
})

/* ---------------- 1.3.0：区分「读不到」与「没有任务」 ---------------- */

test('目录不存在 -> 读失败被显式记录（不再与「没有任务」同形）', () => {
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-a')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-b')
  try {
    const snap = readDownloadStatus()
    // 两个目录都读不到 -> 空列表是「无信息」的，必须判为失败
    assert.equal(snap.ok, false, '两个目录都读不到时 ok 必须为 false')
    assert.deepEqual(snap.tasks, [])
    // 正向断言：必须报出**具体是哪些目录**读不到，而不是只给一个 false
    assert.deepEqual(
      snap.scanFailedDirs?.slice().sort(),
      [path.join(tmpdir(), 'dsh-no-such-dir-a'), path.join(tmpdir(), 'dsh-no-such-dir-b')].sort(),
      '必须列出两个读失败的目录路径',
    )
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
  }
})

test('只有一个目录读不到 -> ok 仍为 true，但 scanFailedDirs 报出那一个', () => {
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  const downloadDir = tempDir()
  process.env.DSH_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-c')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    writeJson(downloadDir, 'dl-half', { id: 'dl-half', status: 'running', progress: 0.5 })
    const snap = readDownloadStatus()
    // 关键：一个目录读得到时，结论仍然可信 —— 不能因为另一半失败就把整体判失败
    assert.equal(snap.ok, true, '仍有一个目录被成功扫描时不得判整体失败')
    assert.equal(snap.total, 1, '可读目录里的任务必须照常返回')
    assert.deepEqual(snap.scanFailedDirs, [path.join(tmpdir(), 'dsh-no-such-dir-c')])
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('回归：目录读得到但确实为空 -> 返回结构与 1.2.0 逐字段相同（无 scanFailedDirs 键）', () => {
  withDirs(() => {
    const snap = readDownloadStatus()
    assert.equal(snap.ok, true, '干净的空目录是正常状态，不得判失败')
    assert.deepEqual(snap.tasks, [])
    // 关键回归断言：正常路径上这个键必须**整个不出现**，否则老读取端会看到
    // 一个多余字段，而「有键」正是「读不到」的信号本身
    assert.equal(Object.hasOwn(snap, 'scanFailedDirs'), false, '正常路径不得出现 scanFailedDirs')
    assert.deepEqual(
      Object.keys(snap).sort(),
      ['downloadDir', 'ok', 'taskDir', 'tasks', 'total'],
      '正常路径的字段集合必须与 1.2.0 一致',
    )
  })
})

test('无会话上下文时 taskDir 为 null -> 不构成扫描失败（正常的单轨模式）', () => {
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  const downloadDir = tempDir()
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    const snap = readDownloadStatus()
    // 轨道一压根不参与扫描（定位不到），不该被算成「读失败」
    assert.equal(snap.ok, true, '没有会话上下文是正常状态，不是故障')
    assert.equal(Object.hasOwn(snap, 'scanFailedDirs'), false)
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('扫描失败时仍返回 string 字段（schema 要求 string，不得因失败漏字段）', () => {
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-d')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-e')
  try {
    const snap = readDownloadStatus()
    assert.equal(typeof snap.taskDir, 'string')
    assert.equal(typeof snap.downloadDir, 'string')
    assert.equal(typeof snap.ok, 'boolean')
    assert.equal(snap.total, 0)
    assert.ok(Array.isArray(snap.scanFailedDirs))
    for (const dir of snap.scanFailedDirs ?? []) {
      assert.equal(typeof dir, 'string', 'scanFailedDirs 的元素必须是 string')
    }
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
  }
})

test('向后兼容：老读取端只取已知字段时忽略 scanFailedDirs 不报错', () => {
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-f')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpdir(), 'dsh-no-such-dir-g')
  try {
    const snap = readDownloadStatus()
    // 模拟一个只认识 1.2.0 字段的读取端：解构已知字段 + 走一遍 JSON 往返
    const legacyView = (({ ok, taskDir, downloadDir, total, tasks }) => ({
      ok,
      taskDir,
      downloadDir,
      total,
      tasks,
    }))(snap)
    assert.deepEqual(legacyView, {
      ok: false,
      taskDir: path.join(tmpdir(), 'dsh-no-such-dir-f'),
      downloadDir: path.join(tmpdir(), 'dsh-no-such-dir-g'),
      total: 0,
      tasks: [],
    })
    assert.equal(
      JSON.parse(JSON.stringify(snap)).ok,
      false,
      '新字段必须能通过 JSON 往返（不得含 undefined）',
    )
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
  }
})

test('目录里混有损坏 JSON / 无关文件 -> 跳过坏项，好项照常返回', () => {
  withDirs(({ downloadDir, taskDir }) => {
    writeJson(downloadDir, 'dl-bad', { id: 'dl-bad' })
    writeFileSync(path.join(downloadDir, 'dl-bad.json'), '{ not json', 'utf-8')
    writeJson(downloadDir, 'dl-good', { id: 'dl-good', status: 'completed', progress: 1 })
    writeFileSync(path.join(downloadDir, 'notes.txt'), 'ignore me', 'utf-8')
    mkdirSync(path.join(downloadDir, 'subdir.json'), { recursive: true })
    writeJsonl(taskDir, 'dl-empty', [{ v: 1, task: 'dl-empty', pct: 5, msg: '下载中' }])

    const snap = readDownloadStatus()
    const ids = snap.tasks.map((t) => t.id).sort()
    assert.deepEqual(ids, ['dl-empty', 'dl-good'])
  })
})

test('返回结构的 taskDir / downloadDir 指向实际扫描的目录', () => {
  withDirs(({ taskDir, downloadDir }) => {
    const snap = readDownloadStatus()
    assert.equal(snap.taskDir, taskDir)
    assert.equal(snap.downloadDir, downloadDir)
  })
})

test('name 字段：JSONL 的 name 与 msg 各自独立', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-named', [
      { v: 1, task: 'dl-named', pct: 12, msg: '下载中（aria2）', name: 'debian.iso' },
    ])
    const task = readDownloadStatus().tasks[0]
    assert.ok(task)
    assert.equal(task.name, 'debian.iso')
    assert.equal(task.msg, '下载中（aria2）')
  })
})

test('name 字段：JSON 轨道的 name 解析为任务名', () => {
  withDirs(({ downloadDir }) => {
    writeJson(downloadDir, 'dl-jname', {
      id: 'dl-jname',
      name: 'fedora.iso',
      status: 'running',
      progress: 0.3,
      updatedAt: 1000,
    })
    const task = readDownloadStatus().tasks[0]
    assert.ok(task)
    assert.equal(task.name, 'fedora.iso')
  })
})

test('name 字段：老版本进度文件缺 name 时返回空串，且不吞掉另一轨道的 name', () => {
  withDirs(({ taskDir, downloadDir }) => {
    // 只有 JSONL、且是旧格式（无 name）
    writeJsonl(taskDir, 'dl-old', [{ v: 1, task: 'dl-old', pct: 5, msg: '下载中' }])
    assert.equal(readDownloadStatus().tasks[0]?.name, '', '缺 name 时必须是空串而不是 undefined')

    // 两条轨道都有：JSONL 缺 name，应保留 JSON 轨道的 name
    writeJson(downloadDir, 'dl-mix', {
      id: 'dl-mix',
      name: 'mixed.iso',
      status: 'running',
      progress: 0.4,
      updatedAt: 2000,
    })
    writeJsonl(taskDir, 'dl-mix', [{ v: 1, task: 'dl-mix', pct: 40, msg: '下载中（curl）' }])
    const mixed = readDownloadStatus().tasks.find((t) => t.id === 'dl-mix')
    assert.ok(mixed)
    assert.equal(mixed.name, 'mixed.iso', 'JSONL 缺 name 时不应把 JSON 的 name 覆盖成空')
    assert.equal(mixed.msg, '下载中（curl）')
  })
})

/* ---------------- 0.5.0：state 字段优先于文案推断 ---------------- */

test('state 优先于文案：state=running 即使文案写「完成」也是 running', () => {
  withDirs(({ taskDir }) => {
    // 0.5.0 之前的面板 bug 正是这种记录：pct=100 + 「下载完成」但没有 state
    writeJsonl(taskDir, 'dl-running', [
      { v: 1, task: 'dl-running', state: 'running', pct: 100, msg: '下载完成' },
    ])
    const task = readDownloadStatus().tasks[0]
    assert.ok(task)
    assert.equal(task.status, 'running', 'state 存在时必须完全以 state 为准')
  })
})

test('state 优先于文案：state=done 即使 pct 很低、文案写「下载中」也是 completed', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-done', [
      { v: 1, task: 'dl-done', state: 'done', pct: 10, msg: '下载中' },
    ])
    assert.equal(readDownloadStatus().tasks[0]?.status, 'completed')
  })
})

test('state=cancelled 映射为 cancelled', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-cancel', [{ v: 1, task: 'dl-cancel', state: 'cancelled', pct: 42 }])
    assert.equal(readDownloadStatus().tasks[0]?.status, 'cancelled')
  })
})

test('state=failed 映射为 failed（不依赖文案）', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-stfail', [{ v: 1, task: 'dl-stfail', state: 'failed', pct: 3 }])
    assert.equal(readDownloadStatus().tasks[0]?.status, 'failed')
  })
})

test('老进度文件无 state 时回退到文案推断（向后兼容）', () => {
  withDirs(({ taskDir }) => {
    writeJsonl(taskDir, 'dl-legacy-done', [{ v: 1, task: 'dl-legacy-done', pct: 100, msg: '下载完成' }])
    writeJsonl(taskDir, 'dl-legacy-run', [{ v: 1, task: 'dl-legacy-run', pct: 20, msg: '下载中' }])
    const byId = new Map(readDownloadStatus().tasks.map((t) => [t.id, t.status]))
    assert.equal(byId.get('dl-legacy-done'), 'completed')
    assert.equal(byId.get('dl-legacy-run'), 'running')
  })
})

test('轨道二 status=cancelled 被识别（不再退化为 running）', () => {
  withDirs(({ downloadDir }) => {
    writeJson(downloadDir, 'dl-jcancel', {
      id: 'dl-jcancel',
      name: 'c.zip',
      status: 'cancelled',
      progress: 0.2,
      updatedAt: 3000,
    })
    assert.equal(readDownloadStatus().tasks[0]?.status, 'cancelled')
  })
})

/* ---------------- 0.5.0：按会话定位轨道一 ---------------- */

test('传 session 时扫描 <cwd>/.dsh-progress/<id>/', () => {
  const saved = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = tempDir()
  const cwd = tempDir()
  try {
    const sessionDir = path.join(cwd, '.dsh-progress', 'sess-xyz')
    mkdirSync(sessionDir, { recursive: true })
    writeJsonl(sessionDir, 'dl-sess', [
      { v: 1, task: 'dl-sess', state: 'done', pct: 100, msg: '下载完成', name: 's.iso' },
    ])

    const snap = readDownloadStatus(10, undefined, { id: 'sess-xyz', cwd })
    assert.equal(snap.taskDir, sessionDir, 'taskDir 应指向会话目录')
    assert.equal(snap.total, 1)
    assert.equal(snap.tasks[0]?.status, 'completed')
    assert.equal(snap.tasks[0]?.name, 's.iso')
  } finally {
    if (saved === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = saved
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('无 DSH_PROGRESS_DIR 且无 session 时 taskDir 为空串，轨道二仍可读', () => {
  const saved = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  const downloadDir = tempDir()
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    writeJson(downloadDir, 'dl-only2', {
      id: 'dl-only2',
      name: 'x.zip',
      status: 'running',
      progress: 0.1,
      updatedAt: 4000,
    })
    const snap = readDownloadStatus()
    assert.equal(snap.taskDir, '', 'schema 要求 string，无法定位时为 ""')
    assert.equal(snap.total, 1, '轨道二不依赖会话，仍应读到')
  } finally {
    if (saved === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = saved
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(downloadDir, { recursive: true, force: true })
  }
})
