import { PuzzleCatError } from './error'
import {
  type OAuthCallback,
  type OAuthConfig,
  type OAuthToken,
  type OAuthTokenInfo,
  type OAuthUserInfo,
  PuzzleCatOAuthClient,
} from './oauth'
import {
  type CreateRedeemBatchParams,
  type OmiConfig,
  type OmiToken,
  type OmiTokenInfo,
  PuzzleCatOmiClient,
  type RedeemBatchResult,
  type WalletAdjustResult,
  type WalletKind,
} from './omi'

/**
 * 统一入口配置：baseUrl 全局一份，oauth / omi 按需启用。
 * 例：`new PuzzleCatClient({ baseUrl, oauth: {...}, omi: {...} })`
 */
export interface PuzzleCatClientConfig {
  /** PuzzleCat 站点根地址，如 https://puzzle.cat */
  baseUrl: string
  /** OAuth 2.0 登录配置（仅需登录功能时传入） */
  oauth?: Omit<OAuthConfig, 'baseUrl'>
  /** OMI 外部管理接口配置（仅需管理功能时传入） */
  omi?: Omit<OmiConfig, 'baseUrl'>
}

/**
 * PuzzleCat SDK 统一入口：一次配置、一个实例，同时暴露 OAuth 登录与 OMI 管理能力。
 *
 * - 顶层方法为常用接口的便捷转发，未配置对应模块时调用会抛出 PuzzleCatError；
 * - `client.oauth` / `client.omi` 提供各自完整 API（高级用法）；
 * - 浏览器端只应使用登录引导能力（oauth 不传 clientSecret，不使用 exchangeCode 等）。
 */
export class PuzzleCatClient {
  readonly baseUrl: string
  /** OAuth 客户端；未配置 oauth 时为 null */
  readonly oauth: PuzzleCatOAuthClient | null
  /** OMI 客户端；未配置 omi 时为 null */
  readonly omi: PuzzleCatOmiClient | null

  constructor(config: PuzzleCatClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.oauth = config.oauth
      ? new PuzzleCatOAuthClient({ baseUrl: this.baseUrl, ...config.oauth })
      : null
    this.omi = config.omi
      ? new PuzzleCatOmiClient({ baseUrl: this.baseUrl, ...config.omi })
      : null
  }

  // ---------- OAuth 便捷方法 ----------

  /** 生成授权页 URL（浏览器端可直接跳转，不涉及 Secret）。
   *  传入 redirectUri 可覆盖构造配置（如多端回调、动态回调场景） */
  buildAuthorizeUrl(state?: string, redirectUri?: string): string {
    return this.requireOAuth().buildAuthorizeUrl(state, redirectUri)
  }

  /** 解析授权回调 URL（code 5 分钟有效、一次性） */
  static parseCallback(url: string | URL): OAuthCallback {
    return PuzzleCatOAuthClient.parseCallback(url)
  }

  /** 授权码换取 Token（须服务端调用，需要 App Secret）。
   *  传入 redirectUri 覆盖构造配置时，须与授权时使用的回调一致（服务端校验） */
  exchangeCode(code: string, redirectUri?: string): Promise<OAuthToken> {
    return this.requireOAuth().exchangeCode(code, redirectUri)
  }

  /** 刷新 Token：每次调用签发新 refresh_token，旧值立即失效，请覆盖本地存储 */
  refreshToken(refreshToken: string): Promise<OAuthToken> {
    return this.requireOAuth().refreshToken(refreshToken)
  }

  /** 获取用户信息（Bearer） */
  getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    return this.requireOAuth().getUserInfo(accessToken)
  }

  /** 探测 OAuth 令牌有效性（Bearer） */
  getOAuthTokenInfo(accessToken: string): Promise<OAuthTokenInfo> {
    return this.requireOAuth().getTokenInfo(accessToken)
  }

  /** 撤销 OAuth 令牌；撤销 access_token 会连带撤销其关联 refresh_token */
  revokeOAuthToken(
    token: string,
    tokenTypeHint: 'access_token' | 'refresh_token' = 'access_token',
  ): Promise<void> {
    return this.requireOAuth().revokeToken(token, tokenTypeHint)
  }

  // ---------- OMI 便捷方法 ----------

  /** 获取 OMI 访问令牌：自动缓存复用，过期前 60 秒提前重取 */
  getOmiToken(force = false): Promise<OmiToken> {
    return this.requireOmi().getToken(force)
  }

  /** OMI 令牌与应用信息、权限配置自查 */
  getOmiTokenInfo(): Promise<OmiTokenInfo> {
    return this.requireOmi().getTokenInfo()
  }

  /** 撤销当前 OMI 令牌（撤销后本地缓存失效） */
  revokeOmiToken(): Promise<void> {
    return this.requireOmi().revokeToken()
  }

  /** 授予勋章（单个用户）；等级只升不降，已有同等级及以上则跳过 */
  awardBadge(userId: string, badgeId: string, level = 1): Promise<number> {
    return this.requireOmi().awardBadge(userId, badgeId, level)
  }

  /** 批量授予勋章（userIds 数量受权限 max_users_per_call 限制） */
  awardBadges(userIds: string[], badgeId: string, level = 1): Promise<number> {
    return this.requireOmi().awardBadges(userIds, badgeId, level)
  }

  /** 撤销勋章；不传 level 时撤销该勋章全部等级记录 */
  revokeBadge(userId: string, badgeId: string, level?: number): Promise<void> {
    return this.requireOmi().revokeBadge(userId, badgeId, level)
  }

  /** 钱包调整：amount 正=增加、负=减少；增减方向与范围受应用权限控制 */
  adjustWallet(
    userId: string,
    kind: WalletKind,
    amount: number,
    note: string,
  ): Promise<WalletAdjustResult> {
    return this.requireOmi().adjustWallet(userId, kind, amount, note)
  }

  /** 生成兑换码批次 */
  createRedeemBatch(params: CreateRedeemBatchParams): Promise<RedeemBatchResult> {
    return this.requireOmi().createRedeemBatch(params)
  }

  // ---------- 内部 ----------

  private requireOAuth(): PuzzleCatOAuthClient {
    if (!this.oauth) {
      throw new PuzzleCatError('未启用 oauth：构造 PuzzleCatClient 时请传入 oauth 配置', 400)
    }
    return this.oauth
  }

  private requireOmi(): PuzzleCatOmiClient {
    if (!this.omi) {
      throw new PuzzleCatError('未启用 omi：构造 PuzzleCatClient 时请传入 omi 配置', 400)
    }
    return this.omi
  }
}
