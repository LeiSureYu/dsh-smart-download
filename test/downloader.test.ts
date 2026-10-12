/**
 * downloader.ts 测试：
 * - 参数拼接（aria2 / curl）；
 * - 平台 → aria2 子包映射（Windows 用 .exe，Linux 无后缀；未支持平台回退 null）；
 * - getAria2Path 在缺少二进制时返回 null；
 * - runProcess 的成功、非零退出（含 stderr）、AbortSignal 透传与强制结束。
 * 通过把 Node 自身作为子进程来验证，不依赖 aria2 / curl / 网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { Socket } from 'node:net'
import {
  ARIA2_TARGETS,
  aria2TargetFor,
  buildAria2Args,
  buildCurlArgs,
  downloadWithAria2,
  downloadWithCurl,
  getAria2Path,
  runProcess,
  summarySpeedBytes,
} from '../src/downloader.js'

/* ------------------------------ 参数拼接 ------------------------------ */

test('buildAria2Args 纯文件名 -> 仅使用 -o（默认 8 连接 + 续传 + 覆盖 + 摘要开关）', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip')
  assert.deepEqual(args, [
    '-x', '8',
    '-s', '8',
    '-k', '1M',
    '-c',
    '--allow-overwrite=true',
    '--file-allocation=none',
    '--console-log-level=warn',
    '--summary-interval=1',
    '--show-console-readout=false',
    '-o', 'a.zip',
    'https://example.com/a.zip',
  ])
})

test('buildAria2Args 总是带 -c（断点续传）', () => {
  // aria2 -c 无条件安全：不支持 Range 时 aria2 会自行全量重下，不会以失败告终
  for (const concurrency of [4, 8]) {
    const args = buildAria2Args('https://example.com/a.zip', 'a.zip', concurrency)
    assert.ok(args.includes('-c'), `concurrency=${concurrency} 应包含 -c`)
  }
})

test('buildAria2Args concurrency 参数 -> -x/-s 跟随', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip', 4)
  assert.equal(args[args.indexOf('-x') + 1], '4')
  assert.equal(args[args.indexOf('-s') + 1], '4')
})

test('buildAria2Args resume=false -> 不含 -c，其余开关与 -o 位置不变', () => {
  // 0.6.0 起 aria2 路径默认 resume=true，但 downloadWithAria2 显式传 false 时
  // 必须真的不带 -c：全量重下（例如续传指纹对不上）走的正是这条路。
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip', 8, false)
  assert.equal(args.includes('-c'), false, 'resume=false 时不得出现 -c')
  // -o 必须紧跟文件名，url 必须是最后一个参数（历史踩过「续传开关插错位置」的坑）
  assert.equal(args[args.indexOf('-o') + 1], 'a.zip')
  assert.equal(args[args.length - 1], 'https://example.com/a.zip')
  // 与 resume=true 唯一的差异就是有没有 -c
  const withResume = buildAria2Args('https://example.com/a.zip', 'a.zip', 8, true)
  assert.deepEqual(
    withResume.filter((a) => a !== '-c'),
    args,
    '除 -c 外，两种 resume 的参数必须完全一致',
  )
})

test('buildAria2Args 含目录 -> 拆分为 -d 目录 与 -o 文件名', () => {
  // 用 path.join 构造平台原生路径：Windows 是 out\a.zip，Linux/macOS 是 out/a.zip。
  // 直接硬编码 'out\\a.zip' 在 POSIX 上会被 dirname 判为 '.'，测试会失败。
  const args = buildAria2Args('https://example.com/a.zip', path.join('out', 'a.zip'))
  const dirIndex = args.indexOf('-d')
  assert.ok(dirIndex !== -1, '应包含 -d')
  assert.equal(args[dirIndex + 1], path.resolve('out'))
  const outIndex = args.indexOf('-o')
  assert.equal(args[outIndex + 1], 'a.zip')
  assert.equal(args[args.length - 1], 'https://example.com/a.zip')
})

test('buildCurlArgs 默认不续传：progress-bar，无 silent，无 -C -', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip')
  assert.deepEqual(args, [
    '--progress-bar',
    '-L',
    '-o', 'b.zip',
    '--fail',
    '--show-error',
    'https://example.com/b.zip',
  ])
})

test('buildCurlArgs resume=true -> 在 -L 之后插入 -C -', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', true)
  assert.deepEqual(args, [
    '--progress-bar',
    '-L',
    '-C', '-',
    '-o', 'b.zip',
    '--fail',
    '--show-error',
    'https://example.com/b.zip',
  ])
})

test('buildCurlArgs resume=false -> 明确不含 -C', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', false)
  assert.equal(args.includes('-C'), false)
  // -o 与输出路径必须紧邻，续传开关不能插到中间
  assert.equal(args[args.indexOf('-o') + 1], 'b.zip')
})

/* ------------------------------ 自定义请求头 ------------------------------ */

test('buildCurlArgs 带请求头 -> 每个头一条 -H，URL 仍排在最后', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', false, {
    'User-Agent': 'ua/1',
    Referer: 'https://r.example/',
  })
  assert.deepEqual(args, [
    '--progress-bar',
    '-L',
    '-o', 'b.zip',
    '--fail',
    '--show-error',
    '-H', 'User-Agent: ua/1',
    '-H', 'Referer: https://r.example/',
    'https://example.com/b.zip',
  ])
  assert.equal(args[args.length - 1], 'https://example.com/b.zip', 'URL 必须是最后一个参数')
})

test('buildCurlArgs 不带请求头 -> 一条 -H / -A 都不产出（与 1.1.x 逐字一致）', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', false)
  assert.equal(args.includes('-H'), false)
  assert.equal(args.includes('-A'), false, '统一用 -H，不混用 -A 以免优先级随 curl 版本变化')
})

test('buildAria2Args 带请求头 -> 每个头一条 --header，且 -o 与文件名仍紧邻', () => {
  const args = buildAria2Args('https://example.com/b.zip', 'b.zip', 4, true, {
    'User-Agent': 'ua/1',
  })
  assert.ok(args.includes('--header=User-Agent: ua/1'), args.join(' '))
  assert.equal(args[args.indexOf('-o') + 1], 'b.zip')
  assert.equal(args[args.length - 1], 'https://example.com/b.zip', 'URL 必须是最后一个参数')
})

test('buildAria2Args 不带请求头 -> 一条 --header 都不产出', () => {
  const args = buildAria2Args('https://example.com/b.zip', 'b.zip', 4, true)
  assert.equal(args.some((a) => a.startsWith('--header')), false)
})

test('ARIA2_TARGETS 覆盖全部受支持平台，且子包名 / 二进制名正确', () => {
  assert.deepEqual(Object.keys(ARIA2_TARGETS).sort(), [
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ])
  assert.equal(ARIA2_TARGETS['win32-x64']?.pkg, '@leisureyu/dsh-aria2-win32-x64')
  assert.equal(ARIA2_TARGETS['win32-x64']?.bin, 'bin/aria2c.exe')
  assert.equal(ARIA2_TARGETS['win32-arm64']?.pkg, '@leisureyu/dsh-aria2-win32-arm64')
  assert.equal(ARIA2_TARGETS['win32-arm64']?.bin, 'bin/aria2c.exe')
  assert.equal(ARIA2_TARGETS['linux-x64']?.pkg, '@leisureyu/dsh-aria2-linux-x64')
  assert.equal(ARIA2_TARGETS['linux-x64']?.bin, 'bin/aria2c')
  assert.equal(ARIA2_TARGETS['linux-arm64']?.pkg, '@leisureyu/dsh-aria2-linux-arm64')
  assert.equal(ARIA2_TARGETS['linux-arm64']?.bin, 'bin/aria2c')
})

test('aria2TargetFor：Windows 用 .exe，Linux 用无后缀二进制', () => {
  assert.equal(aria2TargetFor('win32', 'x64')?.bin, 'bin/aria2c.exe')
  assert.equal(aria2TargetFor('win32', 'arm64')?.bin, 'bin/aria2c.exe')
  assert.equal(aria2TargetFor('linux', 'x64')?.bin, 'bin/aria2c')
  assert.equal(aria2TargetFor('linux', 'arm64')?.bin, 'bin/aria2c')
})

test('aria2TargetFor：未支持平台返回 null（回退 curl）', () => {
  assert.equal(aria2TargetFor('darwin', 'x64'), null)
  assert.equal(aria2TargetFor('darwin', 'arm64'), null)
  assert.equal(aria2TargetFor('linux', 'ia32'), null)
  assert.equal(aria2TargetFor('freebsd', 'x64'), null)
})

test('getAria2Path 返回子包二进制路径或 null', () => {
  const result = getAria2Path()
  const target = aria2TargetFor(process.platform, process.arch)
  // 两种合法状态：找到二进制（返回路径）或未找到（返回 null）
  // 子包发布后，pnpm install 会把它装到 node_modules，因此这里不能再假设一定为 null
  if (target) {
    assert.ok(
      result === null || result.endsWith(target.bin.replace('/', path.sep)) ||
        result.includes(target.bin.split('/').pop() as string),
      `预期为 null 或指向 ${target.bin} 的路径，实际: ${result}`,
    )
  } else {
    assert.equal(result, null, `不支持的平台应返回 null，实际: ${result}`)
  }
})

/* ------------------------------ runProcess ------------------------------ */

test('runProcess: 子进程正常退出 -> resolve', async () => {
  await assert.doesNotReject(
    runProcess(process.execPath, ['-e', 'process.exit(0)']),
  )
})

test('runProcess: 非零退出 -> reject 且错误包含退出码与 stderr', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /退出码 3/)
      assert.match(err.message, /boom/)
      return true
    },
  )
})

test('runProcess: 预先 abort 的信号 -> reject 为取消，且只出现可执行文件名', async () => {
  const controller = new AbortController()
  controller.abort()
  // 用 process.execPath（绝对路径，且带 .exe）走 close 分支：文案里必须是 'node'
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 200)'], controller.signal),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, '下载已取消：node 被 AbortSignal 终止')
      assert.doesNotMatch(err.message, /node_modules/i, '不得出现 node_modules')
      assert.doesNotMatch(err.message, /[A-Za-z]:[\\/]/, '不得出现盘符路径')
      assert.doesNotMatch(err.message, /[\\/]/, '不得出现路径分隔符')
      return true
    },
  )
})

/* ---------------- P0V-01：真实 aria2 / curl 的取消文案都不得泄漏绝对路径 ---------------- */

/** 取消文案的统一不变量：只有可执行文件名，没有任何绝对路径痕迹。 */
function assertNoAbsolutePath(message: string): void {
  assert.doesNotMatch(message, /node_modules/i, '文案里不得出现 node_modules')
  assert.doesNotMatch(message, /[A-Za-z]:[\\/]/, '文案里不得出现盘符路径')
  assert.doesNotMatch(message, /[\\/]/, '文案里不得出现任何路径分隔符')
}

test('取消文案（aria2 路径）：随包 aria2 的绝对路径收敛成 aria2c', async (t) => {
  const aria2Path = getAria2Path()
  if (aria2Path === null) {
    // 与 execute.test.ts 的既有做法一致：没有子包就跳过（本机装了子包，不会触发）
    t.skip('本机无 aria2 子包，跳过 aria2 取消文案用例')
    return
  }
  // 前提断言：随包 aria2 确实是带分隔符的绝对路径、且真的落在 node_modules 下 ——
  // 否则「文案里不出现 node_modules」这条断言会因为命令本身干净而空转
  assert.match(aria2Path, /[\\/]/, '前提：随包 aria2 的路径是带分隔符的绝对路径')
  assert.match(aria2Path, /node_modules/i, '前提：该路径确实在 node_modules 下（否则测不到泄漏）')

  const server = await startThrottledServer(4 * 1024 * 1024, { chunk: 32 * 1024, delayMs: 50 })
  const out = path.join(os.tmpdir(), `dsh-cancel-aria2-${Date.now()}.bin`)
  try {
    const controller = new AbortController()
    const running = downloadWithAria2(aria2Path, server.url, out, 4, controller.signal, undefined, false)
    // 让 aria2 真正跑起来再取消：取消文案来自「运行中被 abort」那条分支
    await delay(400)
    controller.abort()
    await assert.rejects(running, (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, '下载已取消：aria2c 被 AbortSignal 终止')
      assertNoAbsolutePath(err.message)
      return true
    })
  } finally {
    await server.close()
    rmSync(out, { force: true })
    rmSync(`${out}.aria2`, { force: true })
  }
})

test('取消文案（curl 路径）：只出现 curl', async () => {
  const server = await startThrottledServer(4 * 1024 * 1024, { chunk: 32 * 1024, delayMs: 50 })
  const out = path.join(os.tmpdir(), `dsh-cancel-curl-${Date.now()}.bin`)
  try {
    const controller = new AbortController()
    const running = downloadWithCurl(server.url, out, controller.signal, undefined, false)
    await delay(400)
    controller.abort()
    await assert.rejects(running, (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, '下载已取消：curl 被 AbortSignal 终止')
      assertNoAbsolutePath(err.message)
      return true
    })
  } finally {
    await server.close()
    rmSync(out, { force: true })
  }
})

test('runProcess: 运行中 abort -> 子进程被强制结束', async () => {
  const pidFile = path.join(
    os.tmpdir(),
    `dsh-smart-dl-pid-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  )
  // 子进程：先把自己的 PID 写入文件，然后常驻
  const hangScript =
    "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 200)"

  try {
    const controller = new AbortController()
    const running = runProcess(
      process.execPath,
      ['-e', hangScript, pidFile],
      controller.signal,
    )

    // 等待 PID 文件出现
    const pid = await waitForPidFile(pidFile, 2000)
    assert.ok(pid > 0, '应读取到子进程 PID')

    // 触发取消
    controller.abort()
    await assert.rejects(running, /取消|终止/)

    // 轮询确认子进程已不存在
    const dead = await waitForProcessExit(pid, 2000)
    assert.ok(dead, 'AbortSignal 触发后子进程应被结束')
  } finally {
    rmSync(pidFile, { force: true })
  }
})

/* ------------------------------ 进度透传（真实 curl / aria2 + 本地限速服务） ------------------------------ */

/**
 * 起一个限速的本地 HTTP 服务，用于让 curl / aria2 产生真实的进度回调。
 *
 * 为什么要限速：不做任何延迟时 4MB 文件几十毫秒就下完，aria2 的
 * --summary-interval=1 一次摘要都来不及吐（实测 0 条 report），测试会变成
 * 「因为太快所以没进度」的假绿。这里按分片 sleep，保证下载跨越多个摘要周期。
 * stall 参数在中途额外插入一段较长的停顿，制造明显的速度落差。
 */
/**
 * 给 http.Server 附加连接跟踪，返回一个「先断开所有 socket 再 close」的收尾函数。
 * node:test 会等事件循环排空，遗留的 keep-alive socket 会让整个进程挂住不退。
 */
function trackSockets(server: http.Server): () => Promise<void> {
  const sockets = new Set<Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    })
}

function startThrottledServer(
  size: number,
  opts: { chunk?: number; delayMs?: number; stallAt?: number; stallMs?: number } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const chunk = opts.chunk ?? 32 * 1024
  const delayMs = opts.delayMs ?? 20
  const stallAt = opts.stallAt ?? -1
  const stallMs = opts.stallMs ?? 0
  const body = Buffer.alloc(size)
  // 填成非零，避免某些实现把全零文件当作稀疏文件走捷径
  for (let i = 0; i < size; i++) body[i] = (i * 31 + 7) & 0xff

  const server = http.createServer((req, res) => {
    const range = req.headers.range
    let start = 0
    let end = size - 1
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      start = m && m[1] ? Number(m[1]) : 0
      end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      })
    } else {
      res.writeHead(200, {
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      })
    }
    let off = start
    const tick = (): void => {
      if (off > end) {
        res.end()
        return
      }
      const next = Math.min(off + chunk, end + 1)
      res.write(body.subarray(off, next))
      const crossedStall = stallAt > 0 && off <= stallAt && next > stallAt
      off = next
      setTimeout(tick, crossedStall ? stallMs : delayMs)
    }
    tick()
  })

  // 跟踪连接：node:test 会等事件循环排空，挂起的 keep-alive socket 必须主动断开
  const close = trackSockets(server)

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}/f.bin`,
        close,
      })
    })
  })
}

/** 记录 reporter 收到的每一条进度（只实现下载路径用到的方法） */
class RecordingReporter {
  readonly items: Array<{ pct: number; msg: string; spd?: string; eta?: string }> = []
  report(pct: number, msg: string, spd?: string, eta?: string): void {
    this.items.push({ pct, msg, spd, eta })
  }
  done(): void {}
  fail(): void {}
  cancel(): void {}
}

test('downloadWithCurl: reporter 收到真实进度（文案固定、百分比单调到 100、无速度/ETA）', async () => {
  // curl --progress-bar 在管道（非 tty）下仍会输出百分比行（实测 8.13.0），
  // 因此这里用真实 curl 跑，而不是假命令 —— Windows 上伪造 .cmd/.js shim 会
  // 让 spawn 同步抛 EFTYPE，根本进不到参数解析。
  const size = 512 * 1024
  const { url, close } = await startThrottledServer(size, {
    chunk: 32 * 1024,
    delayMs: 25,
    stallAt: 256 * 1024,
    stallMs: 1200,
  })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-curl-rep-'))
  const out = path.join(dir, 'f.bin')
  const reporter = new RecordingReporter()
  try {
    await downloadWithCurl(url, out, undefined, reporter as never)
    assert.equal(statSync(out).size, size, '文件必须完整落盘')
    assert.ok(reporter.items.length >= 2, `应至少收到 2 条进度，实际 ${reporter.items.length}`)
    for (const item of reporter.items) {
      assert.equal(item.msg, '下载中（curl）')
      assert.ok(item.pct >= 0 && item.pct <= 100, `百分比应在 0-100，实际 ${item.pct}`)
      // curl 路径不带速度 / ETA（不瞎编字段）
      assert.equal(item.spd, undefined)
      assert.equal(item.eta, undefined)
    }
    const pcts = reporter.items.map((i) => i.pct)
    for (let i = 1; i < pcts.length; i++) {
      assert.ok(pcts[i] >= pcts[i - 1], `百分比不得回退：${pcts.join(',')}`)
    }
    assert.equal(pcts[pcts.length - 1], 100, '最后一条进度应是 100%')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await close()
  }
})

test('downloadWithCurl: 非进度错误行不产生假 report（404 -> 抛错且 0 条进度）', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const closeServer = trackSockets(server)
  const port = (server.address() as { port: number }).port
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-curl-404-'))
  const out = path.join(dir, 'f.bin')
  const reporter = new RecordingReporter()
  try {
    await assert.rejects(downloadWithCurl(`http://127.0.0.1:${port}/missing`, out, undefined, reporter as never))
    assert.equal(reporter.items.length, 0, 'HTTP 错误行不得被当成进度')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await closeServer()
  }
})

test('downloadWithAria2: reporter 收到真实摘要（文案固定、百分比 0-100、速度非空）', async (t) => {
  const aria2Path = getAria2Path()
  if (!aria2Path) {
    t.skip('本平台未安装随包 aria2，回退 curl')
    return
  }
  // 4MB / 4 连接 / 每片 40ms -> 约 2.5s，必然跨过至少一次 1s 摘要周期。
  const size = 4 * 1024 * 1024
  const { url, close } = await startThrottledServer(size, {
    chunk: 32 * 1024,
    delayMs: 40,
    stallAt: 2 * 1024 * 1024,
    stallMs: 800,
  })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-a2-rep-'))
  const out = path.join(dir, 'f.bin')
  const reporter = new RecordingReporter()
  try {
    await downloadWithAria2(aria2Path, url, out, 4, undefined, reporter as never)
    assert.equal(statSync(out).size, size, '文件必须完整落盘')
    assert.ok(reporter.items.length >= 1, `应至少收到 1 条摘要进度，实际 ${reporter.items.length}`)
    for (const item of reporter.items) {
      assert.equal(item.msg, '下载中（aria2）')
      assert.ok(item.pct >= 0 && item.pct <= 100, `百分比应在 0-100，实际 ${item.pct}`)
      // 速度必须解析出来且是「单位/s」形式；ETA 可选（临近完成 aria2 会省略）
      assert.ok(typeof item.spd === 'string' && item.spd.length > 0, '速度不得为空')
      assert.match(item.spd as string, /\/s$/, `速度应归一化为「/s」结尾，实际 ${item.spd}`)
      if (item.eta !== undefined) assert.ok(typeof item.eta === 'string' && item.eta.length > 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await close()
  }
})

test('summarySpeedBytes: MiB/KiB 按 1024 进制、KB/MB 按 1000 进制、解析不出来返回 undefined', () => {
  assert.equal(summarySpeedBytes('10MiB/s'), 10 * 1024 * 1024)
  assert.equal(summarySpeedBytes('115.7KiB/s'), 115.7 * 1024)
  assert.equal(summarySpeedBytes('1.5GiB/s'), 1.5 * 1024 ** 3)
  assert.equal(summarySpeedBytes('500B/s'), 500)
  // 不带 i 的是十进制：aria2 实测吐 MiB，但 progress-parse 的正则也接受这种写法
  assert.equal(summarySpeedBytes('2KB/s'), 2000)
  assert.equal(summarySpeedBytes('3MB/s'), 3_000_000)
  // 0 如实返回 0（要不要跳过由调用方决定：见 downloadWithAria2 里只在 > 0 时留观测）
  assert.equal(summarySpeedBytes('0B/s'), 0)
  // 数字与单位之间的空格照收：上游正则在字段里本来就允许 `\s*`，这里不该比它更严
  assert.equal(summarySpeedBytes('10 MiB/s'), 10 * 1024 * 1024)
  for (const bad of ['10MiB', 'fast', '', '10XB/s', 'MiB/s']) {
    assert.equal(summarySpeedBytes(bad), undefined, `${JSON.stringify(bad)} 应解析失败而不是猜一个数`)
  }
})

test('downloadWithAria2 返回观测值：吞吐换算成字节/秒、并发是本次档位、cn 来自摘要', async (t) => {
  const aria2Path = getAria2Path()
  if (!aria2Path) {
    t.skip('本平台未安装随包 aria2，回退 curl')
    return
  }
  // 与上面那条进度用例同样的限速参数：必须跨过至少一次 1s 摘要周期，才会有观测值可返回
  const size = 4 * 1024 * 1024
  const { url, close } = await startThrottledServer(size, {
    chunk: 32 * 1024,
    delayMs: 40,
    stallAt: 2 * 1024 * 1024,
    stallMs: 800,
  })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-a2-obs-'))
  const out = path.join(dir, 'f.bin')
  try {
    const observation = await downloadWithAria2(aria2Path, url, out, 4)
    assert.ok(observation, '限速下载必须至少解析出一条带速度的摘要（否则 P1-2 拿不到观测值）')
    assert.equal(observation.concurrency, 4, '并发数必须是本次请求的 -x/-s 档位')
    assert.ok(
      Number.isInteger(observation.cn) && observation.cn >= 1,
      `实际有效连接数（CN）必须 ≥ 1，实际 ${observation.cn}`,
    )
    assert.ok(observation.cn <= 4, `实际连接数不该超过请求的档位，实际 ${observation.cn}`)
    // 单位换算的方向：每连接 32KB/40ms ≈ 0.8MB/s，量级应在 MB/s 附近 ——
    // 换算反了（或把KiB当MiB）会落在这个区间之外
    assert.ok(
      observation.throughput > 100 * 1024,
      `吞吐应大于 100KiB/s，实际 ${observation.throughput}`,
    )
    assert.ok(
      observation.throughput < 100 * 1024 * 1024,
      `吞吐不该是离谱值，实际 ${observation.throughput}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await close()
  }
})

test('downloadWithAria2: 404 时抛错且 reporter 收到 0 条（错误摘要行不得误报进度）', async (t) => {
  const aria2Path = getAria2Path()
  if (!aria2Path) {
    t.skip('本平台未安装随包 aria2，回退 curl')
    return
  }
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('<html>404</html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const closeServer = trackSockets(server)
  const port = (server.address() as { port: number }).port
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-a2-404-'))
  const out = path.join(dir, 'f.bin')
  const reporter = new RecordingReporter()
  try {
    await assert.rejects(
      downloadWithAria2(aria2Path, `http://127.0.0.1:${port}/missing`, out, 4, undefined, reporter as never),
      /退出码/,
    )
    assert.equal(reporter.items.length, 0, 'aria2 的 ERROR / Exception 行不得被当成进度')
    assert.equal(existsSync(out), false, '404 不应产出文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await closeServer()
  }
})

/* ------------------------------ 断点续传：真实行为验证 ------------------------------ */

/**
 * 起一个支持 Range 的本地服务器。
 * 注意：必须尊重 Range 的结束位置，否则 aria2 会报 "Invalid range header"（实测 exit 8）。
 */
async function startRangeServer(size: number, body: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      const start = m && m[1] ? Number(m[1]) : 0
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      })
      res.end(body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const close = trackSockets(server)
  return { url: `http://127.0.0.1:${port}/f.bin`, close }
}

test('curl 断点续传：已有半截文件 -> 续传后内容完整正确', async () => {
  const body = Buffer.from('x'.repeat(4096))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    // 预置一个 1000 字节的“半成品”
    writeFileSync(out, body.subarray(0, 1000))
    assert.equal(statSync(out).size, 1000)

    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.equal(statSync(out).size, body.length, '应续传到完整长度')
    assert.ok(readFileSync(out).equals(body), '续传后内容必须与源文件逐字节一致')
  } finally {
    rmSync(out, { force: true })
    close()
  }
})

test('curl 断点续传：文件不存在时从头下载，不报错', async () => {
  const body = Buffer.from('y'.repeat(2048))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.ok(readFileSync(out).equals(body))
  } finally {
    rmSync(out, { force: true })
    close()
  }
})

test('curl 断点续传：已下载完整时重跑仍然成功且内容不变', async () => {
  const body = Buffer.from('z'.repeat(2048))
  const { url, close } = await startRangeServer(body.length, body)
  const out = path.join(os.tmpdir(), `dsh-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
  try {
    writeFileSync(out, body)
    await downloadWithCurl(url, out, undefined, undefined, true)
    assert.ok(readFileSync(out).equals(body), '不应被截断或重复追加')
  } finally {
    rmSync(out, { force: true })
    close()
  }
})

/* ------------------------------ 辅助函数 ------------------------------ */

/** 轮询等待 PID 文件出现并返回解析出的 PID */
async function waitForPidFile(file: string, timeoutMs: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const raw = (await readFile(file, 'utf8')).trim()
      const pid = Number(raw)
      if (Number.isFinite(pid)) return pid
    }
    await delay(20)
  }
  throw new Error('等待子进程 PID 文件超时')
}

/** 轮询等待指定 PID 的进程退出；已退出返回 true */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await delay(20)
  }
  return !isProcessAlive(pid)
}

/** 通过 process.kill(pid, 0) 探测进程是否存活（Windows 同样适用） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH 表示进程不存在；EPERM 表示存在但无权限（仍视为存活）
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* ---------------- 1.3.0：总带宽上限（一批内共享，见 src/index.ts） ---------------- */

test('buildAria2Args 带宽上限 -> 追加 --max-overall-download-limit=<字节数>', () => {
  const args = buildAria2Args('https://example.com/a.zip', 'a.zip', 8, true, undefined, 262144)
  const at = args.indexOf('--max-overall-download-limit=262144')
  assert.ok(at >= 0, '必须出现 --max-overall-download-limit=<字节数>')
  // 位置：在 -o 之前（选项区），且不得影响 -o 与 URL 的关系
  assert.ok(at < args.indexOf('-o'), '限速开关属于选项区，必须排在 -o 之前')
  assert.equal(args[args.indexOf('-o') + 1], 'a.zip')
  assert.equal(args[args.length - 1], 'https://example.com/a.zip')
})

test('buildAria2Args 不带带宽上限 -> 命令行与 1.2.0 逐字节相同（回归项）', () => {
  const withoutLimit = buildAria2Args('https://example.com/a.zip', 'a.zip', 8, true, undefined, undefined)
  const baseline = buildAria2Args('https://example.com/a.zip', 'a.zip', 8, true)
  assert.deepEqual(withoutLimit, baseline, '不传限速时不得多出任何参数')
  assert.equal(
    withoutLimit.some((a) => a.startsWith('--max-overall-download-limit')),
    false,
    '不得凭空出现限速开关',
  )
})

test('buildCurlArgs 带宽上限 -> 追加 --limit-rate <字节数>', () => {
  const args = buildCurlArgs('https://example.com/b.zip', 'b.zip', false, undefined, 131072)
  const at = args.indexOf('--limit-rate')
  assert.ok(at >= 0, '必须出现 --limit-rate')
  assert.equal(args[at + 1], '131072', '限速值必须紧跟开关（curl 的语法是空格分隔）')
  assert.equal(args[args.length - 1], 'https://example.com/b.zip', 'URL 仍必须排在最后')
})

test('buildCurlArgs 不带带宽上限 -> 命令行与 1.2.0 逐字节相同（回归项）', () => {
  const withoutLimit = buildCurlArgs('https://example.com/b.zip', 'b.zip', false, undefined, undefined)
  const baseline = buildCurlArgs('https://example.com/b.zip', 'b.zip', false)
  assert.deepEqual(withoutLimit, baseline)
  assert.equal(withoutLimit.includes('--limit-rate'), false, '不得凭空出现限速开关')
})
