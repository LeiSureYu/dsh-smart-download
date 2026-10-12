/**
 * headers.ts 测试：请求头的合成、校验与三种落地形式。
 *
 * 遵循本仓库的「正向信号」契约：断言的是“合成出的头表长什么样”，而不是
 * “没抛错”。这一层的静默失败形态是「头被悄悄丢掉」—— 站点按 UA 分流时，
 * 丢掉 UA 的后果是探测与下载拿到两份不同的响应，而调用方毫无察觉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_HEADER_COUNT,
  MAX_HEADER_VALUE_LENGTH,
  RESERVED_HEADERS,
  buildRequestHeaders,
  headerKey,
  headersToAria2Args,
  headersToCurlArgs,
  headersToFetchInit,
  normalizeHeaderName,
} from '../src/headers.js'

/** 取成功结果里的头表；失败直接断言失败，避免用例里到处判 kind */
function headersOf(input: Parameters<typeof buildRequestHeaders>[0]): Record<string, string> {
  const result = buildRequestHeaders(input)
  assert.equal(result.ok, true, `应当构造成功：${result.ok ? '' : result.reason}`)
  return result.ok ? result.headers : {}
}

/* ------------------------------ 归一化 ------------------------------ */

test('normalizeHeaderName: 统一成 X-Foo-Bar 形式', () => {
  assert.equal(normalizeHeaderName('user-agent'), 'User-Agent')
  assert.equal(normalizeHeaderName('USER-AGENT'), 'User-Agent')
  assert.equal(normalizeHeaderName('  x-custom-header  '), 'X-Custom-Header')
  assert.equal(normalizeHeaderName('referer'), 'Referer')
})

test('headerKey: 比较键统一小写去空白（同名头只保留一条）', () => {
  assert.equal(headerKey('  User-Agent '), 'user-agent')
  assert.equal(headerKey('USER-AGENT'), 'user-agent')
})

test('normalizeHeaderName: 连续连字符与首尾连字符不产生错位', () => {
  // 空段原样保留，只把有内容的段首字母大写 —— 不能把 `x--y` 压成 `X-Y`
  assert.equal(normalizeHeaderName('x--y'), 'X--Y')
  assert.equal(normalizeHeaderName('-x'), '-X')
})

/* ------------------------------ 合成 ------------------------------ */

test('buildRequestHeaders: 三个入参合并成一份头表', () => {
  const headers = headersOf({
    userAgent: 'Mozilla/5.0 (test)',
    referer: 'https://docs.example.com/install',
    headers: { Authorization: 'Bearer t0ken', 'X-Trace': 'abc' },
  })
  assert.deepEqual(headers, {
    Authorization: 'Bearer t0ken',
    'X-Trace': 'abc',
    'User-Agent': 'Mozilla/5.0 (test)',
    Referer: 'https://docs.example.com/install',
  })
})

test('buildRequestHeaders: 命名参数覆盖 headers 里的同名项（更具体的意图优先）', () => {
  const headers = headersOf({
    userAgent: 'from-userAgent',
    headers: { 'user-agent': 'from-headers' },
  })
  assert.deepEqual(headers, { 'User-Agent': 'from-userAgent' })
  // 只保留一条：两条 User-Agent 会让 curl / aria2 的行为随实现而变
  assert.equal(Object.keys(headers).length, 1)
})

test('buildRequestHeaders: 大小写不同的同名头只留一条，且后写覆盖先写', () => {
  const headers = headersOf({ headers: { 'X-A': '1', 'x-a': '2' } })
  assert.deepEqual(headers, { 'X-A': '2' })
})

test('buildRequestHeaders: 不传任何入参 -> 空头表（不是 undefined）', () => {
  assert.deepEqual(headersOf({}), {})
  assert.deepEqual(headersOf({ headers: null }), {})
  // 空字符串的 UA / Referer 视为未提供，不产出空头
  assert.deepEqual(headersOf({ userAgent: '   ', referer: '' }), {})
})

test('buildRequestHeaders: 允许 Authorization / Cookie 这类门控下载需要的头', () => {
  const headers = headersOf({ headers: { Cookie: 'session=abc', Authorization: 'Basic eA==' } })
  assert.equal(headers.Cookie, 'session=abc')
  assert.equal(headers.Authorization, 'Basic eA==')
})

/* ------------------------------ 拒绝路径 ------------------------------ */

test('buildRequestHeaders: 插件自身管理的头一律拒绝（否则破坏探测 / 续传 / 校验）', () => {
  for (const name of RESERVED_HEADERS) {
    const result = buildRequestHeaders({ headers: { [name]: 'x' } })
    assert.equal(result.ok, false, `${name} 必须被拒绝`)
    assert.match(result.ok ? '' : result.reason, /不允许覆盖/)
  }
  // 大小写不敏感：Range / range / RANGE 都要挡住
  for (const name of ['Range', 'range', 'RANGE', 'Accept-Encoding', 'Host']) {
    assert.equal(buildRequestHeaders({ headers: { [name]: 'x' } }).ok, false, `${name} 必须被拒绝`)
  }
})

test('buildRequestHeaders: 头值含 CR / LF / NUL -> 拒绝（请求头注入）', () => {
  for (const value of ['a\r\nX-Evil: 1', 'a\nb', 'a\rb', 'a\u0000b']) {
    const result = buildRequestHeaders({ headers: { 'X-Test': value } })
    assert.equal(result.ok, false, `${JSON.stringify(value)} 必须被拒绝`)
    assert.match(result.ok ? '' : result.reason, /注入|控制字符/)
  }
  // 制表符在头值里合法，不能误伤
  assert.equal(buildRequestHeaders({ headers: { 'X-Test': 'a\tb' } }).ok, true)
})

test('buildRequestHeaders: 头名非法 / 为空 / 过长 -> 拒绝', () => {
  assert.equal(buildRequestHeaders({ headers: { '': 'x' } }).ok, false)
  assert.equal(buildRequestHeaders({ headers: { 'Bad Name': 'x' } }).ok, false, '空格不是 token 字符')
  assert.equal(buildRequestHeaders({ headers: { 'X-Bad\u0001': 'x' } }).ok, false)
  assert.equal(buildRequestHeaders({ headers: { ['X'.repeat(200)]: 'x' } }).ok, false)
})

test('buildRequestHeaders: 头值非字符串 -> 拒绝（不做隐式转换）', () => {
  assert.equal(buildRequestHeaders({ headers: { 'X-Num': 1 } }).ok, false)
  assert.equal(buildRequestHeaders({ headers: { 'X-Obj': { a: 1 } } }).ok, false)
  assert.equal(buildRequestHeaders({ headers: { 'X-Null': null } }).ok, false)
})

test('buildRequestHeaders: 头值超长 -> 拒绝（恰好等于上限必须通过）', () => {
  const exact = 'x'.repeat(MAX_HEADER_VALUE_LENGTH)
  assert.equal(buildRequestHeaders({ headers: { 'X-Big': exact } }).ok, true)
  const result = buildRequestHeaders({ headers: { 'X-Big': `${exact}x` } })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /过长/)
})

test('buildRequestHeaders: 头数量超上限 -> 拒绝', () => {
  const many: Record<string, string> = {}
  for (let i = 0; i <= MAX_HEADER_COUNT; i++) many[`X-H${i}`] = 'v'
  const result = buildRequestHeaders({ headers: many })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /过多/)
  // 恰好等于上限时必须通过（边界不能差一）
  const exact: Record<string, string> = {}
  for (let i = 0; i < MAX_HEADER_COUNT; i++) exact[`X-H${i}`] = 'v'
  assert.equal(buildRequestHeaders({ headers: exact }).ok, true)
})

test('buildRequestHeaders: headers 不是对象 -> 拒绝', () => {
  assert.equal(buildRequestHeaders({ headers: 'nope' as never }).ok, false)
  assert.equal(buildRequestHeaders({ headers: ['a'] as never }).ok, false)
})

/* ------------------------------ 三种落地形式 ------------------------------ */

const SAMPLE = { 'User-Agent': 'ua/1', Referer: 'https://r.example/' }

test('headersToCurlArgs: 每个头一条 -H，统一写法避免 -A/-e 的优先级不确定性', () => {
  assert.deepEqual(headersToCurlArgs(SAMPLE), [
    '-H', 'User-Agent: ua/1',
    '-H', 'Referer: https://r.example/',
  ])
  assert.deepEqual(headersToCurlArgs(undefined), [], '没有头时不产出任何参数')
  assert.deepEqual(headersToCurlArgs({}), [])
})

test('headersToAria2Args: 每个头一条 --header=Name: value', () => {
  assert.deepEqual(headersToAria2Args(SAMPLE), [
    '--header=User-Agent: ua/1',
    '--header=Referer: https://r.example/',
  ])
  assert.deepEqual(headersToAria2Args(undefined), [])
})

test('headersToFetchInit: 探测强制的 identity 最后合并，调用方覆盖不掉', () => {
  const init = headersToFetchInit({ 'User-Agent': 'ua/1' }, 'identity')
  assert.deepEqual(init, { 'User-Agent': 'ua/1', 'accept-encoding': 'identity' })
  // 即便（理论上）传进来一个 accept-encoding，也必须被 identity 顶掉
  const forced = headersToFetchInit({ 'accept-encoding': 'gzip' }, 'identity')
  assert.equal(forced['accept-encoding'], 'identity')
  assert.deepEqual(headersToFetchInit(undefined, 'identity'), { 'accept-encoding': 'identity' })
})
