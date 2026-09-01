/**
 * PuzzleCat TypeScript SDK
 * 版本号由 package.json 维护
 * 运行环境：Node.js ≥ 18 | 浏览器（要求原生 fetch）
 */

/** SDK 统一异常：所有失败均抛出本类 */
export class PuzzleCatError extends Error {
  /** HTTP 状态码（token 端点限流为 429；业务包装错误为业务 code） */
  readonly status: number
  /** RFC 6749 错误码（invalid_client / invalid_grant 等）；非 token 端点为 null */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'PuzzleCatError'
    this.status = status
    this.code = code
  }
}
