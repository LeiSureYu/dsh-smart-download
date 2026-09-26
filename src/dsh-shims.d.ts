/**
 * 开发期类型兜底声明（shim）。
 *
 * DSH 0.1.0-rc.5 的正式包若已随 devDependencies 安装并自带类型，
 * TypeScript 会优先使用 node_modules 中的真实类型，本文件可直接删除。
 * 本文件仅为在框架包尚未发布 / 未安装时，让 `tsc` 与编辑器不报错。
 * 不产生任何运行时代码，运行时仍使用真实包的实现。
 */

declare module '@deepseek-ai/cordis' {
  /** 仅声明本插件用到的 tools 服务 */
  export interface Context {
    tools: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register(tool: unknown): unknown
    }
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** 假设 defineTool 为泛型工厂，原样返回工具定义对象 */
  export function defineTool<T>(tool: T): T
}
