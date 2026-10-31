/**
 * stdin 调用形态测试（1.7.0）：自定义请求头经 stdin 喂给 curl / aria2。
 *
 * 为什么必须有这一层：`-H 'Authorization: …'` 会把凭证放进**进程命令行**，
 * 同机的任何进程都能读走。改为 stdin 后命令行必须干净 —— 而没有自定义头时，
 * 命令行又必须与 1.6.0 **逐字节相同**（既有回归项）。两条正向契约：
 * - 无头：buildXxxInvocation 的 argv === buildXxxArgs 的 argv（逐字节）；
 * - 有头：argv 里**不出现**任何头名/头值，配置经 stdin 传入且转义正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAria2Args,
  buildAria2Invocation,
  buildCurlArgs,
  buildCurlInvocation,
} from '../src/downloader.js'
import { headersToCurlConfig } from '../src/headers.js'

const URL_EXAMPLE = 'https://example.com/releases/tool.zip'
const OUT_WIN = 'C:\\downloads\\tool.zip'
const OUT_POSIX = '/tmp/downloads/tool.zip'
const HEADERS = {
  Authorization: 'Bearer secret-token',
  'User-Agent': 'Custom/1.0',
}

test('curl 无自定义头：invocation 的 argv 与 buildCurlArgs 逐字节相同，且没有 stdin', () => {
  const plain = buildCurlArgs(URL_EXAMPLE, OUT_WIN, true, undefined, 1024)
  const invocation = buildCurlInvocation(URL_EXAMPLE, OUT_WIN, true, undefined, 1024)
  assert.deepEqual(invocation.args, plain)
  assert.equal(invocation.stdin, undefined, '无头时必须不写 stdin（行为与 1.6.0 完全一致）')
})

test('aria2 无自定义头：invocation 的 argv 与 buildAria2Args 逐字节相同，且没有 stdin', () => {
  const plain = buildAria2Args(URL_EXAMPLE, OUT_POSIX, 8, true, undefined, undefined)
  const invocation = buildAria2Invocation(URL_EXAMPLE, OUT_POSIX, 8, true, undefined, undefined)
  assert.deepEqual(invocation.args, plain)
  assert.equal(invocation.stdin, undefined)
})

test('curl 有自定义头：argv 不含任何头名/头值，含 -K -，配置走 stdin', () => {
  const { args, stdin } = buildCurlInvocation(URL_EXAMPLE, OUT_WIN, false, HEADERS)
  const argvText = args.join(' ')
  assert.ok(!argvText.includes('secret-token'), 'argv 不得出现头值（凭证）')
  assert.ok(!argvText.includes('Authorization'), 'argv 不得出现头名')
  assert.ok(!argvText.includes('-H'), 'argv 不得再用 -H')
  assert.ok(!argvText.includes('--header'), 'argv 不得再用 --header')
  assert.deepEqual(
    args.filter((a) => a === '-K' || a === '-'),
    ['-K', '-'],
    'curl stdin 形态必须带 -K -',
  )
  assert.equal(args[args.length - 1], URL_EXAMPLE, 'URL 不含机密，保留在 argv 末尾')
  assert.equal(
    stdin,
    'header = "Authorization: Bearer secret-token"\n' +
      'header = "User-Agent: Custom/1.0"\n',
    'stdin 配置必须逐条一行（header = "Name: value"）',
  )
})

test('curl 配置转义：值里的反斜杠与双引号都被转义（单行结构不被破坏）', () => {
  const escaped = headersToCurlConfig({
    'X-Test': 'back\\slash and "quote"',
  })
  assert.equal(escaped, 'header = "X-Test: back\\\\slash and \\"quote\\""\n')
  // 转义后不含任何裸双引号边界冲突：每行恰好以 " 开始、"; 结束
  for (const line of escaped.split('\n').filter((l) => l !== '')) {
    assert.match(line, /^header = ".*"$/, '每行必须是 header = "…" 形式')
  }
})

test('aria2 有自定义头：argv 不含头、不含 URL 与 -o，URI 与头经 --input-file=- 走 stdin', () => {
  const { args, stdin } = buildAria2Invocation(URL_EXAMPLE, OUT_POSIX, 8, true, HEADERS)
  const argvText = args.join(' ')
  assert.ok(!argvText.includes('secret-token'), 'argv 不得出现头值（凭证）')
  assert.ok(!argvText.includes('Authorization'), 'argv 不得出现头名')
  assert.ok(!argvText.includes('example.com'), 'URI 必须搬进 stdin（input file 条目才能挂 per-download 头）')
  assert.ok(!args.includes('-o'), '-o 搬进 input file 的 out=（精确元素判断，子串会撞上 allow-overwrite）')
  assert.ok(args.includes('--input-file=-'), 'stdin 形态必须带 --input-file=-')
  assert.ok(args.includes('-d'), '目录仍走 argv 的 -d（非机密）')
  assert.equal(
    stdin,
    `${URL_EXAMPLE}\n` +
      '  out=tool.zip\n' +
      '  header=Authorization: Bearer secret-token\n' +
      '  header=User-Agent: Custom/1.0\n',
    'input file：URI 顶格，out 与每条 header 以空白开头（aria2 协议）',
  )
})

test('aria2 input file：out 按当前平台取 basename，目录不混进 out', () => {
  // dirname/basename 是平台相关的：win32 认反斜杠，posix 只认斜杠。对 POSIX
  // 而言 'C:\\downloads\\tool.zip' 是一个（怪但完全合法的）文件名 —— 产物行为
  // 与 path.basename 一致即为正确，因此两个平台各自断言（ubuntu 实测教训）。
  const { stdin } = buildAria2Invocation(URL_EXAMPLE, OUT_WIN, 8, false, HEADERS)
  if (process.platform === 'win32') {
    assert.ok(stdin!.includes('  out=tool.zip\n'), 'out 必须是纯文件名（aria2 的 out 相对于 -d）')
    assert.ok(!stdin!.includes('\\'), 'Windows 目录分隔符不得进 input file')
  } else {
    // POSIX：路径里没有斜杠，整串按一个文件名落盘
    assert.ok(stdin!.includes('  out=' + OUT_WIN + '\n'), 'POSIX 上整串都是一个文件名')
  }
})

test('aria2 stdin 形态仍保留代理与带宽开关（与 argv 形态同一组共用开关）', () => {
  const { args } = buildAria2Invocation(URL_EXAMPLE, OUT_POSIX, 8, true, HEADERS, 65536, 'http://proxy:1')
  assert.ok(args.some((a) => a === '--max-overall-download-limit=65536'))
  assert.ok(args.some((a) => a === '--all-proxy=http://proxy:1'))
  const curl = buildCurlInvocation(URL_EXAMPLE, OUT_POSIX, true, HEADERS, 65536, 'http://proxy:1')
  assert.ok(curl.args.some((a) => a === '--limit-rate'))
  assert.ok(curl.args.some((a) => a === 'http://proxy:1'), 'curl 的 -x 后紧跟代理地址')
})

test('头表为空对象：按「没有自定义头」处理，argv 走旧形态', () => {
  const { args, stdin } = buildCurlInvocation(URL_EXAMPLE, OUT_WIN, false, {})
  assert.deepEqual(args, buildCurlArgs(URL_EXAMPLE, OUT_WIN, false, {}))
  assert.equal(stdin, undefined)
})
