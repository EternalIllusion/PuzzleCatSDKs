import { PuzzleCatError } from './error'
import { request, unwrap, type ApiResponse } from './request'

// ==================== OAuth 2.0 第三方登录 ====================

export interface OAuthConfig {
  /** PuzzleCat 站点根地址，如 https://puzzle.cat */
  baseUrl: string
  /** 应用 ID */
  clientId: string
  /** 应用密钥：仅服务端持有；浏览器端禁止传入 */
  clientSecret?: string
  /** 回调地址，须与注册时完全一致 */
  redirectUri: string
  /** 授权范围，默认 profile */
  scope?: string
}

/** Token 端点响应（裸 OAuth JSON，非统一包装） */
export interface OAuthToken {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** GET /api/oauth/userinfo → data */
export interface OAuthUserInfo {
  /** 用户 hashid */
  id: string
  email: string
  nickname: string
  avatar: string
  bio: string
}

/** GET /api/oauth/token/info → data */
export interface OAuthTokenInfo {
  userId: string
  appId: string
  scope: string
  expiresAt: string
}

/** 授权回调 URL 携带的参数 */
export interface OAuthCallback {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

export class PuzzleCatOAuthClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret?: string
  private readonly redirectUri: string
  private readonly scope: string

  constructor(config: OAuthConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.redirectUri = config.redirectUri
    this.scope = config.scope ?? 'profile'
  }

  /** 生成授权页 URL（浏览器端可直接跳转，不涉及 Secret）。
   *  传入 redirectUri 可覆盖构造配置（如多端回调、动态回调场景） */
  buildAuthorizeUrl(state?: string, redirectUri?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri ?? this.redirectUri,
      response_type: 'code',
      scope: this.scope,
    })
    if (state) params.set('state', state)
    return `${this.baseUrl}/oauth/authorize?${params.toString()}`
  }

  /** 解析授权回调 URL（code 5 分钟有效、一次性） */
  static parseCallback(url: string | URL): OAuthCallback {
    const u = url instanceof URL ? url : new URL(url)
    return {
      code: u.searchParams.get('code') ?? undefined,
      state: u.searchParams.get('state') ?? undefined,
      error: u.searchParams.get('error') ?? undefined,
      error_description: u.searchParams.get('error_description') ?? undefined,
    }
  }

  /** 授权码换取 Token（须服务端调用，需要 App Secret）。
   *  传入 redirectUri 覆盖构造配置时，须与授权时使用的回调一致（服务端校验） */
  exchangeCode(code: string, redirectUri?: string): Promise<OAuthToken> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri ?? this.redirectUri,
    })
  }

  /** 刷新 Token：每次调用签发新 refresh_token，旧值立即失效，请覆盖本地存储 */
  refreshToken(refreshToken: string): Promise<OAuthToken> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  /** 获取用户信息（Bearer） */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    return unwrap(
      await request<ApiResponse<OAuthUserInfo>>(this.baseUrl, {
        method: 'GET',
        path: '/api/oauth/userinfo',
        token: accessToken,
      }),
    )
  }

  /** 探测令牌有效性（Bearer） */
  async getTokenInfo(accessToken: string): Promise<OAuthTokenInfo> {
    return unwrap(
      await request<ApiResponse<OAuthTokenInfo>>(this.baseUrl, {
        method: 'GET',
        path: '/api/oauth/token/info',
        token: accessToken,
      }),
    )
  }

  /** 撤销令牌；撤销 access_token 会连带撤销其关联 refresh_token */
  async revokeToken(
    token: string,
    tokenTypeHint: 'access_token' | 'refresh_token' = 'access_token',
  ): Promise<void> {
    if (!this.clientSecret) {
      return Promise.reject(
        new PuzzleCatError('调用 token 端点需要 clientSecret（仅服务端可用）', 400),
      )
    }
    await request<{ success: boolean }>(this.baseUrl, {
      method: 'POST',
      path: '/api/oauth/token/revoke',
      body: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        token,
        token_type_hint: tokenTypeHint,
      },
    })
  }

  private tokenRequest<T = OAuthToken>(body: Record<string, string>): Promise<T> {
    if (!this.clientSecret) {
      return Promise.reject(
        new PuzzleCatError('调用 token 端点需要 clientSecret（仅服务端可用）', 400),
      )
    }
    return request<T>(this.baseUrl, {
      method: 'POST',
      path: '/api/oauth/token',
      body: { client_id: this.clientId, client_secret: this.clientSecret, ...body },
    })
  }
}

/** 浏览器端引导登录的 state 存储 key（sessionStorage） */
export const OAUTH_STATE_STORAGE_KEY = 'puzzlecat_oauth_state'

/** 浏览器端引导用户前往 PuzzleCat 授权页。
 *  授权码换 Token 需要 App Secret，必须在自建服务端完成，浏览器只负责跳转。 */
export function redirectToPuzzleCatLogin(
  client: Pick<PuzzleCatOAuthClient, 'buildAuthorizeUrl'>,
  stateStorageKey: string = OAUTH_STATE_STORAGE_KEY,
): void {
  const state = Math.random().toString(36).slice(2)
  try {
    sessionStorage.setItem(stateStorageKey, state)
  } catch {
    /* 隐私模式等场景忽略存储失败 */
  }
  window.location.assign(client.buildAuthorizeUrl(state))
}
