/**
 * 镜像加速：把原始 URL 拼到镜像前缀后面。
 *
 * 主流 GitHub 镜像（gh-proxy / ghfast / ghproxy.net 等）都采用「前缀 + 完整原始 URL」
 * 的形式，例如：
 *   https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1/a.zip
 * 因此这里只做前缀拼接，不做路径改写：调用方传入原始 URL 与镜像前缀即可。
 *
 * ⚠️ 镜像前缀同样必须过协议白名单（1.0.0 修正）：拼接是**字符串拼接**，
 * `mirror = "file:///C:/Windows/win.ini?x="` 接上原始 URL 之后，整串仍是一个
 * 合法的 `file:` URL（后半个地址退化成查询串）。实测该结果交给 curl 是
 * exit 0、落盘 win.ini 的内容 —— 第一层防护被 mirror 参数整个绕过。
 * 因此非 http(s) 的镜像前缀一律不生效，详见 `applyMirror`。
 *
 * 纯函数、无网络、无副作用，便于单测。
 */

/** README 中推荐的若干公开镜像（仅作文档提示，不在运行时硬编码依赖） */
export const RECOMMENDED_MIRRORS: readonly string[] = Object.freeze([
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
])

/** 判断是否为 http / https URL（镜像只对这两类协议有意义） */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 归一化镜像前缀：
 * - 去首尾空白；
 * - 缺少 scheme 时补 `https://`（允许直接写 `gh-proxy.com`）；
 * - 结尾补 `/`，保证拼接后不会把原始 URL 的协议头吃掉。
 */
export function normalizeMirror(mirror: string): string {
  let m = mirror.trim()
  if (!m) return ''
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(m)) {
    m = `https://${m}`
  }
  if (!m.endsWith('/')) m += '/'
  return m
}

/**
 * 把镜像前缀应用到目标 URL。
 *
 * 不生效（原样返回 url）的情况：
 * - 未传镜像 / 镜像为空串；
 * - 目标 URL 不是 http(s)（镜像只代理 http(s)，对 file:// 等无意义）；
 * - **镜像前缀本身不是 http(s)** —— 否则前缀会决定最终请求的 scheme，
 *   把协议白名单整个绕过（1.0.0 修正，实测见文件头）。
 *
 * @param url 原始下载地址
 * @param mirror 镜像前缀，如 `https://gh-proxy.com/` 或 `gh-proxy.com`
 * @returns 实际请求的地址
 */
export function applyMirror(url: string, mirror?: string | null): string {
  if (!mirror) return url
  const normalized = normalizeMirror(mirror)
  if (!normalized) return url
  if (!isHttpUrl(url)) return url
  // 前缀也必须过白名单：拼接后整串的 scheme 由前缀决定，所以「前缀是 http(s)」
  // 与「原始 URL 是 http(s)」是同一个安全前提，缺一不可（见文件头实测）。
  if (!isHttpUrl(normalized)) return url
  return normalized + url
}
