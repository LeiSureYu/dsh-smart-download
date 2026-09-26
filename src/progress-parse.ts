/**
 * 解析 aria2c --summary-interval=1 输出的进度摘要行。
 * 实测（aria2 1.37.0，--show-console-readout=false）形如：
 *   [#de8d33 11MiB/40MiB(27%) CN:4 DL:10MiB ETA:2s]
 * 其中 # 后为十六进制 GID，速度字段为 DL（单位本身即 /s）。
 * 同时兼容旧 readout 的 SIZE: 前缀与 SPD: 字段。
 *
 * 本文件同时提供“逐行切分”与 curl 进度解析，供生产代码与测试共用，
 * 避免测试用自己复刻的切分逻辑而绕过真实实现。
 */

/** 解析出的 aria2 摘要信息 */
export interface ParsedSummary {
  /** 进度百分比 0-100 */
  pct: number
  /** 速度字符串，规范化为如 "10MiB/s" */
  spd: string
  /** 剩余时间字符串，如 "2s"、"4m51s"；临近完成 aria2 可能省略，故可选 */
  eta?: string
}

const SUMMARY_RE =
  /^\[#[\w]+\s+(?:SIZE:\s*)?[\d.]+\s*[KMGTPE]?i?B\/[\d.]+\s*[KMGTPE]?i?B\((\d+)%\)\s+CN:\d+\s+(?:DL|SPD):\s*([\d.]+\s*[KMGTPE]?i?Bs?)(?:\s+ETA:(\S+?))?\]\s*$/i

/**
 * 按 \r\n / \r / \n 切分原始文本。
 * 末尾无终止符的半截内容会作为最后一个元素返回（由调用方决定是否保留）。
 */
export function splitIntoLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/)
}

/** 将速度统一规范化为 “单位/s” 形式 */
function normalizeSpeed(raw: string): string {
  let speed = raw.replace(/\s+/g, '')
  if (speed.endsWith('/s')) return speed
  // 形如 "115.7KiBs" 的写法，去掉末尾 s 后补 "/s"
  if (speed.endsWith('s')) speed = speed.slice(0, -1)
  return `${speed}/s`
}

/** 解析单行 aria2 摘要；非摘要行（日志、分隔线、空行）返回 null。 */
export function parseAria2Summary(line: string): ParsedSummary | null {
  const trimmed = line.trim()
  const m = SUMMARY_RE.exec(trimmed)
  if (!m) return null

  const pct = parseInt(m[1], 10)
  if (!Number.isFinite(pct)) return null

  return { pct, spd: normalizeSpeed(m[2]), eta: m[3] }
}

/**
 * 解析 curl --progress-bar 单行中的百分比。
 * 形如 "##########  31.2%" -> 31.2；非进度行返回 null。
 */
export function parseCurlProgress(line: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(line)
  if (!m) return null
  const pct = parseFloat(m[1])
  return Number.isFinite(pct) ? pct : null
}
