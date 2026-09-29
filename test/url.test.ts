/**
 * url.ts 测试：协议白名单与文件名净化。
 *
 * 覆盖两个 0.4.1 实测过的真实缺陷：
 * - `file:///C:/Windows/win.ini` 会被放行到 curl 并复制本地文件；
 * - `http://host/..%2F..%2F..%2Fescaped.txt` 会推导出 `../../../escaped.txt`
 *   并写到工作目录之外。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_FILENAME,
  MAX_FILENAME_LENGTH,
  SUPPORTED_PROTOCOLS,
  checkDownloadUrl,
  deriveFilenameFromUrl,
  isSupportedProtocol,
  sanitizeFilename,
} from '../src/url.js'

/* ------------------------------ 协议白名单 ------------------------------ */

test('isSupportedProtocol: 只放行 http / https（大小写不敏感）', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOLS], ['http:', 'https:'])
  assert.equal(isSupportedProtocol('http:'), true)
  assert.equal(isSupportedProtocol('https:'), true)
  assert.equal(isSupportedProtocol('HTTPS:'), true)
  assert.equal(isSupportedProtocol('file:'), false)
  assert.equal(isSupportedProtocol('ftp:'), false)
  assert.equal(isSupportedProtocol('data:'), false)
})

test('checkDownloadUrl: 拒绝 file://（0.4.1 实测会被 curl 复制本地文件）', () => {
  const r = checkDownloadUrl('file:///C:/Windows/win.ini')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /file:/)
})

test('checkDownloadUrl: 拒绝 ftp / data / 相对路径', () => {
  for (const bad of ['ftp://host/a', 'data:text/plain,hi', 'not-a-url', '/etc/passwd']) {
    const r = checkDownloadUrl(bad)
    assert.equal(r.ok, false, `${bad} 应被拒绝`)
  }
})

test('checkDownloadUrl: 解析失败的 reason 明确指出「无法解析为 URL」并带原始串', () => {
  // 现有用例只断言 ok===false，这一条钉死走的是 catch 分支（而非协议白名单分支），
  // 否则协议不匹配也会给出 ok=false，两者无法区分。
  // ' http://x/a' 会被 WHATWG URL 自动 strip 前导空白后解析成功，不属于解析失败，
  // 因此这里只列真的会抛的类型。
  for (const bad of ['not-a-url', '/etc/passwd', '', '://x', 'http://']) {
    const r = checkDownloadUrl(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.match(
      r.ok === false ? r.reason : '',
      /无法解析为 URL/,
      `${JSON.stringify(bad)} 应走 URL 解析失败分支，实际 reason=${r.ok === false ? r.reason : '(ok)'}`,
    )
    assert.ok(
      r.ok === false && r.reason.includes(JSON.stringify(bad)),
      'reason 内应原样回显调用方传入的字符串',
    )
  }
})

test('checkDownloadUrl: 协议被拒时的 reason 列出允许清单', () => {
  const r = checkDownloadUrl('ftp://host/a.bin')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /不支持的协议 ftp:/)
  assert.match(r.ok === false ? r.reason : '', /http \/ https/)
})

test('checkDownloadUrl: 放行 http / https 并返回解析后的 URL', () => {
  const r = checkDownloadUrl('https://example.com/a.zip')
  assert.equal(r.ok, true)
  assert.equal(r.ok === true ? r.url.host : '', 'example.com')
})

/* ------------------------------ 文件名净化 ------------------------------ */

test('sanitizeFilename: 路径分隔符与 Windows 非法字符被替换', () => {
  assert.equal(sanitizeFilename('a/b'), 'a_b')
  assert.equal(sanitizeFilename('a\\b'), 'a_b')
  assert.equal(sanitizeFilename('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h')
})

test('sanitizeFilename: 控制字符被剥除', () => {
  assert.equal(sanitizeFilename('a\u0000b'), 'ab')
  assert.equal(sanitizeFilename('a\nb\tc'), 'abc')
})

test('sanitizeFilename: 纯点 / 纯空白 / 空串回退为 download', () => {
  for (const bad of ['', '.', '..', '...', '   ', ' . ']) {
    assert.equal(sanitizeFilename(bad), FALLBACK_FILENAME, `${JSON.stringify(bad)} 应回退`)
  }
})

test('sanitizeFilename: 首尾点与空白被剥除', () => {
  assert.equal(sanitizeFilename('.hidden.zip'), 'hidden.zip')
  assert.equal(sanitizeFilename('name.zip.'), 'name.zip')
  assert.equal(sanitizeFilename('  name.zip  '), 'name.zip')
})

test('sanitizeFilename: Windows 保留设备名加前缀', () => {
  assert.equal(sanitizeFilename('CON'), '_CON')
  assert.equal(sanitizeFilename('con.txt'), '_con.txt')
  assert.equal(sanitizeFilename('COM1'), '_COM1')
  assert.equal(sanitizeFilename('lpt9.bin'), '_lpt9.bin')
  // 不是保留名的相似名字不动
  assert.equal(sanitizeFilename('CONS'), 'CONS')
})

test('sanitizeFilename: 超长名字被截断且保留扩展名', () => {
  const long = `${'a'.repeat(400)}.zip`
  const out = sanitizeFilename(long)
  assert.ok(out.length <= MAX_FILENAME_LENGTH, `长度应 <= ${MAX_FILENAME_LENGTH}，实际 ${out.length}`)
  assert.ok(out.endsWith('.zip'), '应保留扩展名')
})

test('sanitizeFilename: 扩展名过长（>20）时改为硬截断，不吃掉名字本体', () => {
  // name.length - dotIndex > 20 分支：扩展名占了 31 个字符。
  // （keep = limit - ext.length 恒 >= 180，故 keep<=0 是防御性死代码，无法用输入触发。）
  const long = `${'a'.repeat(190)}.${'b'.repeat(30)}`
  const out = sanitizeFilename(long)
  assert.equal(out.length, MAX_FILENAME_LENGTH, `应硬截断到 ${MAX_FILENAME_LENGTH}，实际 ${out.length}`)
  // 200 - 190 = 10，硬截断结果 = 190 个 a + 点 + 9 个 b
  assert.equal(out, `${'a'.repeat(190)}.${'b'.repeat(9)}`, '应是原始串的前 200 个字符')
})

test('sanitizeFilename: 无扩展名的超长名字走硬截断（dotIndex<=0 分支）', () => {
  const long = 'a'.repeat(300)
  const out = sanitizeFilename(long)
  assert.equal(out.length, MAX_FILENAME_LENGTH)
  assert.equal(out, 'a'.repeat(MAX_FILENAME_LENGTH))
})

/* ------------------------------ 从 URL 推导 ------------------------------ */

test('deriveFilenameFromUrl: 常规 URL 取末段并 URI 解码', () => {
  assert.equal(deriveFilenameFromUrl('https://example.com/dir/ubuntu.iso'), 'ubuntu.iso')
  assert.equal(deriveFilenameFromUrl('https://example.com/a%20b.zip'), 'a b.zip')
  assert.equal(deriveFilenameFromUrl('https://example.com/a.zip?x=1#frag'), 'a.zip')
})

test('deriveFilenameFromUrl: 拒绝路径穿越（0.4.1 实测写到 cwd 之外）', () => {
  const out = deriveFilenameFromUrl('http://host/..%2F..%2F..%2Fescaped.txt')
  assert.equal(out.includes('/'), false, `不得含路径分隔符：${out}`)
  assert.equal(out.includes('\\'), false, `不得含路径分隔符：${out}`)
  assert.notEqual(out, '..')
  assert.equal(out, 'escaped.txt')
})

test('deriveFilenameFromUrl: 绝对路径式 payload 也退化为单段名', () => {
  const out = deriveFilenameFromUrl(
    'https://evil.example/a%2F..%2F..%2F..%2F%2E%2E%2FWindows%2FSystem32%2Fdrivers%2Fetc%2Fhosts',
  )
  assert.equal(out.includes('/'), false)
  assert.equal(out.includes('\\'), false)
})

test('deriveFilenameFromUrl: 保留设备名被规避', () => {
  assert.equal(deriveFilenameFromUrl('https://example.com/CON'), '_CON')
})

test('deriveFilenameFromUrl: 无法推导时回退 download', () => {
  assert.equal(deriveFilenameFromUrl('https://example.com/'), FALLBACK_FILENAME)
  assert.equal(deriveFilenameFromUrl('not-a-url'), FALLBACK_FILENAME)
})

test('deriveFilenameFromUrl: 非法百分号编码回落到原始片段，而不是抛错或回退 download', () => {
  // decodeURIComponent('a%zz.bin') 会抛 URIError，走 catch 分支用原始片段。
  // 断言的是「用了原始片段」这个具体结果，不是「没崩」。
  assert.equal(deriveFilenameFromUrl('https://example.com/a%zz.bin'), 'a%zz.bin')
  // 单个游离的 % 同理
  assert.equal(deriveFilenameFromUrl('https://example.com/100%.bin'), '100%.bin')
})
