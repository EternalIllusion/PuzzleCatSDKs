import { PuzzleCatError } from './error'

/** 统一响应包装：除 token 端点外的所有接口均返回 { code, message, data, timestamp } */
export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
  timestamp: number
}

/** Token 端点错误体（RFC 6749 风格裸 JSON） */
export interface TokenErrorBody {
  error: string
  error_description?: string
}

interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  token?: string
}

/** 底层请求：JSON 序列化、Bearer 注入与错误归一 */
export async function request<T>(baseUrl: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${baseUrl}${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const json = (await res.json().catch(() => null)) as
    | (T & Partial<TokenErrorBody> & Partial<ApiResponse>)
    | null
  if (!res.ok) {
    throw new PuzzleCatError(
      json?.error_description || json?.message || `请求失败（HTTP ${res.status}）`,
      res.status,
      json?.error ?? null,
    )
  }
  return json as T
}

/** 从统一响应包装中取出 data；code 非 200 时抛错 */
export function unwrap<T>(resp: ApiResponse<T>): T {
  if (resp.code !== 200) throw new PuzzleCatError(resp.message, resp.code)
  return resp.data
}
