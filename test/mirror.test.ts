/**
 * mirror.ts 测试：镜像前缀拼接。
 *
 * 遵循本仓库的「正向信号」契约：每条用例都断言“真的产出了正确结果”，
 * 而不是“没有崩溃”。镜像拼接的静默失败形态是「拼错但 URL 看起来仍合法」，
 * 因此断言必须落到拼接后的字符串本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_MIRROR,
  GITHUB_HOSTS,
  RECOMMENDED_MIRRORS,
  applyMirror,
  isAutoMirror,
  isGithubUrl,
  isHttpUrl,
  mirrorCandidates,
  normalizeMirror,
} from '../src/mirror.js'

/** 注意：不要命名为 URL，否则会遮蔽全局 URL 构造函数 */
const SAMPLE_URL = 'https://github.com/owner/repo/releases/download/v1/a.zip'

/* ------------------------------ 拼接结果 ------------------------------ */

test('applyMirror: 未提供镜像 -> 原样返回', () => {
  assert.equal(applyMirror(SAMPLE_URL, undefined), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, null), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, ''), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, '   '), SAMPLE_URL)
})

test('applyMirror: 标准前缀 -> 前缀 + 完整原始 URL', () => {
  assert.equal(
    applyMirror(SAMPLE_URL, 'https://gh-proxy.com/'),
    'https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1/a.zip',
  )
})

test('applyMirror: 结果必须是可解析的 URL（防止拼出畸形地址）', () => {
  const mirrored = applyMirror(SAMPLE_URL, 'https://gh-proxy.com/')
  const parsed = new URL(mirrored)
  assert.equal(parsed.protocol, 'https:')
  assert.equal(parsed.host, 'gh-proxy.com')
  assert.ok(mirrored.endsWith(SAMPLE_URL), '原始 URL 应完整保留在末尾')
})

test('applyMirror: 前缀缺尾斜杠 -> 自动补上，不吞掉协议头', () => {
  const mirrored = applyMirror(SAMPLE_URL, 'https://gh-proxy.com')
  assert.ok(mirrored.startsWith('https://gh-proxy.com/https://'), mirrored)
  assert.ok(mirrored.endsWith(SAMPLE_URL))
})

test('applyMirror: 裸域名 -> 自动补 https://', () => {
  assert.ok(applyMirror(SAMPLE_URL, 'ghfast.top').startsWith('https://ghfast.top/'))
})

test('applyMirror: 首尾空白被裁剪，不影响拼接', () => {
  assert.equal(
    applyMirror(SAMPLE_URL, '  https://gh-proxy.com/  '),
    applyMirror(SAMPLE_URL, 'https://gh-proxy.com/'),
  )
})

test('applyMirror: 非 http(s) URL 不走镜像（避免拼出无意义地址）', () => {
  assert.equal(applyMirror('file:///tmp/a.zip', 'https://gh-proxy.com/'), 'file:///tmp/a.zip')
  assert.equal(applyMirror('ftp://h/a.zip', 'https://gh-proxy.com/'), 'ftp://h/a.zip')
})
/**
 * 1.0.0 修正：镜像前缀本身也必须过协议白名单。
 *
 * 0.9.0 只校验了 `args.url`，`mirror` 原样拼接。而拼接是**字符串拼接**：
 * `mirror = "file:///C:/Windows/win.ini?x="` 加上 URL 之后，整串仍然是一个合法的
 * `file:` URL —— 后半个 http(s) 地址退化成查询串。实测把这条结果交给 curl：
 *
 *   curl -L --fail "file:///C:/Windows/win.ini?x=https://github.com/a/b.zip"
 *   -> exit 0，目标文件里恰好是 win.ini 的内容（92 字节）
 *
 * 也就是说第一层防护（协议白名单）被 mirror 参数整个绕过，又回到了「本地文件被读走」
 * 那条实测缺陷。因此这里断言：不是 http(s) 的镜像前缀一律不生效。
 */
test('applyMirror: 镜像前缀不是 http(s) -> 不生效，原样返回（防白名单绕过）', () => {
  assert.equal(applyMirror(SAMPLE_URL, 'file:///C:/Windows/win.ini?x='), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, 'file:///etc/passwd#'), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, 'javascript://alert(1)//'), SAMPLE_URL)
  assert.equal(applyMirror(SAMPLE_URL, 'data://text/plain,x'), SAMPLE_URL)
})

test('normalizeMirror: 非 http(s) scheme 原样保留，交由 applyMirror 拒绝', () => {
  // 归一化只负责「补 scheme / 补尾斜杠」，不做安全判定；
  // 判定集中在 applyMirror，避免两个函数各有一套规则。
  // 尾斜杠会被补上（归一化的既定行为），但 scheme 仍是 file:，applyMirror 会拒绝
  assert.equal(normalizeMirror('file:///C:/Windows/win.ini?x='), 'file:///C:/Windows/win.ini?x=/')
})

/* ------------------------------ 归一化 ------------------------------ */

test('normalizeMirror: 补 scheme、补尾斜杠、去空白', () => {
  assert.equal(normalizeMirror('gh-proxy.com'), 'https://gh-proxy.com/')
  assert.equal(normalizeMirror('https://gh-proxy.com'), 'https://gh-proxy.com/')
  assert.equal(normalizeMirror('https://gh-proxy.com/'), 'https://gh-proxy.com/')
  assert.equal(normalizeMirror('  ghfast.top  '), 'https://ghfast.top/')
  assert.equal(normalizeMirror('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/')
})

test('normalizeMirror: 保留非默认端口与非 https scheme', () => {
  assert.equal(normalizeMirror('http://localhost:7890'), 'http://localhost:7890/')
})

test('normalizeMirror: 空串 -> 空串（调用据此判定“未启用镜像”）', () => {
  assert.equal(normalizeMirror(''), '')
  assert.equal(normalizeMirror('   '), '')
})

/* ------------------------------ 协议判定 ------------------------------ */

test('isHttpUrl: 识别 http / https，拒绝其他协议', () => {
  assert.equal(isHttpUrl('https://a/b'), true)
  assert.equal(isHttpUrl('http://a/b'), true)
  assert.equal(isHttpUrl('HTTPS://A/B'), true)
  assert.equal(isHttpUrl('file:///a'), false)
  assert.equal(isHttpUrl('ftp://a'), false)
  assert.equal(isHttpUrl('a/b'), false)
})

/* ------------------------------ 推荐镜像 ------------------------------ */

test('RECOMMENDED_MIRRORS: 每一项都是可直接使用的 https 前缀', () => {
  assert.ok(RECOMMENDED_MIRRORS.length >= 3)
  for (const m of RECOMMENDED_MIRRORS) {
    assert.equal(normalizeMirror(m), m, `推荐镜像应已归一化: ${m}`)
    assert.ok(m.startsWith('https://'), m)
    assert.ok(m.endsWith('/'), m)
  }
})

/* ------------------------------ 自动镜像 ------------------------------ */

test('isAutoMirror: 只认字面量 auto（大小写与首尾空白不敏感）', () => {
  assert.equal(isAutoMirror(AUTO_MIRROR), true)
  assert.equal(isAutoMirror('auto'), true)
  assert.equal(isAutoMirror('  AUTO  '), true)
  assert.equal(isAutoMirror('Auto'), true)
  // 别的一律不是自动模式，否则会把普通前缀当成自动而悄悄改变行为
  assert.equal(isAutoMirror('automatic'), false)
  assert.equal(isAutoMirror('https://gh-proxy.com/'), false)
  assert.equal(isAutoMirror(''), false)
  assert.equal(isAutoMirror(undefined), false)
  assert.equal(isAutoMirror(null), false)
})

test('isGithubUrl: 只认 GitHub 的下载链路', () => {
  assert.equal(isGithubUrl(SAMPLE_URL), true)
  assert.equal(isGithubUrl('https://raw.githubusercontent.com/o/r/main/a.json'), true)
  assert.equal(isGithubUrl('https://objects.githubusercontent.com/x'), true)
  assert.equal(isGithubUrl('https://codeload.github.com/o/r/zip/refs/heads/main'), true)
  assert.equal(isGithubUrl('https://gist.githubusercontent.com/u/id/raw/a.txt'), true)
  // 子域名也算（GitHub 会发到 release-assets 之类的子域）
  assert.equal(isGithubUrl('https://sub.github.com/a'), true)
  // 非 GitHub：自动镜像对它们没有意义，只会把下载绕进第三方
  assert.equal(isGithubUrl('https://example.com/a.zip'), false)
  assert.equal(isGithubUrl('https://notgithub.com/a.zip'), false)
  // 关键：不能把 github.com 当成后缀匹配吃掉 —— evilgithub.com 不是 GitHub
  assert.equal(isGithubUrl('https://evilgithub.com/a.zip'), false)
  assert.equal(isGithubUrl('https://github.com.evil.example/a.zip'), false)
  assert.equal(isGithubUrl('file:///C:/a.zip'), false)
  assert.equal(isGithubUrl('not a url'), false)
})

test('GITHUB_HOSTS: 每一项都是裸域名（不带协议、不带路径）', () => {
  assert.ok(GITHUB_HOSTS.length >= 3)
  for (const host of GITHUB_HOSTS) {
    assert.equal(host, host.toLowerCase(), host)
    assert.ok(!host.includes('/'), host)
    assert.ok(!host.includes(':'), host)
  }
})

test('mirrorCandidates: 按前缀表顺序给出「前缀 + 完整原始 URL」', () => {
  const candidates = mirrorCandidates(SAMPLE_URL, ['https://m1/', 'https://m2/'])
  assert.deepEqual(candidates, [
    { mirror: 'https://m1/', url: `https://m1/${SAMPLE_URL}` },
    { mirror: 'https://m2/', url: `https://m2/${SAMPLE_URL}` },
  ])
})

test('mirrorCandidates: 前缀会被归一化（裸域名补 https、补尾斜杠）', () => {
  const candidates = mirrorCandidates(SAMPLE_URL, ['ghfast.top'])
  assert.deepEqual(candidates, [{ mirror: 'https://ghfast.top/', url: `https://ghfast.top/${SAMPLE_URL}` }])
})

test('mirrorCandidates: 非 http(s) 的 URL 或前缀被跳过（与 applyMirror 同一套判定）', () => {
  assert.deepEqual(mirrorCandidates('file:///C:/a.zip', ['https://m1/']), [])
  assert.deepEqual(mirrorCandidates(SAMPLE_URL, ['file:///C:/evil?x=', 'javascript://x//']), [])
  // 混合时只保留合法的那些
  const mixed = mirrorCandidates(SAMPLE_URL, ['file:///C:/evil?x=', 'https://m1/'])
  assert.deepEqual(mixed.map((c) => c.mirror), ['https://m1/'])
})

test('mirrorCandidates: 缺省用 RECOMMENDED_MIRRORS，且顺序与常量一致', () => {
  const candidates = mirrorCandidates(SAMPLE_URL)
  assert.deepEqual(candidates.map((c) => c.mirror), [...RECOMMENDED_MIRRORS])
  for (const c of candidates) assert.ok(c.url.endsWith(SAMPLE_URL))
})
