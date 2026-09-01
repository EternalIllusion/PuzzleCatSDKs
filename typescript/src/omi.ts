import { PuzzleCatError } from './error'
import { request, unwrap, type ApiResponse } from './request'

// ==================== OMI 外部管理接口 ====================

export interface OmiConfig {
  /** PuzzleCat 站点根地址 */
  baseUrl: string
  /** 应用 ID（omi_ 开头） */
  clientId: string
  /** 应用密钥：仅创建/重置时可见一次，请加密存储 */
  clientSecret: string
  /** token 端点 429 限流后的重试等待（毫秒），默认 2000 */
  retryDelayMs?: number
}

/** POST /api/omi/token 响应（裸 JSON，非统一包装） */
export interface OmiToken {
  access_token: string
  token_type: string
  expires_in: number
  app_id: string
  name: string
}

/** GET /api/omi/token/info → data */
export interface OmiTokenInfo {
  appId: string
  name: string
  expiresAt: string
  permissions: OmiPermissions
}

export type BadgeType = 'normal' | 'premium'
export type WalletKind = 'cat_strips' | 'makeup_cards'
export type RedeemMode = 'unique' | 'shared'
export type RewardKind = 'cat_strips' | 'makeup_cards' | 'badge'

export interface OmiBadgePermission {
  enabled: boolean
  /** 可操作勋章类型，空数组 = 全部 */
  badge_types: BadgeType[]
  /** 限定具体勋章 hashid，空 = 不限 */
  badge_ids: string[]
  /** 发放等级上限 */
  max_level: number
  /** 单次批量发放人数上限 */
  max_users_per_call: number
}

export interface OmiWalletPermission {
  allow_increase: boolean
  allow_decrease: boolean
  min_amount: number
  max_amount: number
}

export interface OmiRedeemPermission {
  enabled: boolean
  modes: RedeemMode[]
  reward_kinds: RewardKind[]
  max_count: number
  max_amount: number
  max_redemptions: number
  badge_types: BadgeType[]
}

/** OMI 应用权限配置（安全默认全部禁用） */
export interface OmiPermissions {
  badge: OmiBadgePermission
  wallet: {
    cat_strips: OmiWalletPermission
    makeup_cards: OmiWalletPermission
  }
  redeem: OmiRedeemPermission
}

/** 勋章发放结果 */
export interface AwardResult {
  /** 实际新授予人数（已持有同等级及以上者被跳过） */
  awarded: number
}

/** 钱包调整结果 */
export interface WalletAdjustResult {
  kind: WalletKind
  amount: number
  /** 调整后余额 */
  balance: number
}

export interface RedeemCodeItem {
  id: string
  batchId: string
  code: string
}

/** 兑换码批次 */
export interface RedeemBatchResult {
  id: string
  mode: RedeemMode
  rewardKind: RewardKind
  rewardAmount: number
  badgeId: string | null
  badgeName: string | null
  allowUserRepeat: boolean
  maxRedemptions: number | null
  status: string
  note: string
  createdAt: string
  codeCount: number
  redeemedCount: number
  /** 生成批次时返回本次全部码 */
  codes?: RedeemCodeItem[]
}

export interface CreateRedeemBatchParams {
  mode: RedeemMode
  rewardKind: RewardKind
  rewardAmount: number
  /** rewardKind = 'badge' 时必填 */
  badgeId?: string
  /** unique 模式码数；shared 固定为 1 */
  count?: number
  /** shared 模式必填 */
  maxRedemptions?: number
  allowUserRepeat?: boolean
  note?: string
}

export class PuzzleCatOmiClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly retryDelayMs: number
  private tokenCache?: { token: OmiToken; expiresAt: number }

  constructor(config: OmiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.retryDelayMs = config.retryDelayMs ?? 2000
  }

  /** 获取访问令牌：自动缓存复用，过期前 60 秒提前重取 */
  async getToken(force = false): Promise<OmiToken> {
    const now = Date.now()
    if (!force && this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token
    }
    const token = await this.fetchToken()
    this.tokenCache = { token, expiresAt: now + token.expires_in * 1000 - 60_000 }
    return token
  }

  /** 令牌与应用信息、权限配置自查 */
  async getTokenInfo(): Promise<OmiTokenInfo> {
    return this.withToken((token) =>
      request<ApiResponse<OmiTokenInfo>>(this.baseUrl, {
        method: 'GET',
        path: '/api/omi/token/info',
        token,
      }).then(unwrap),
    )
  }

  /** 撤销当前令牌（撤销后本地缓存失效） */
  async revokeToken(): Promise<void> {
    await this.withToken((token) =>
      request<ApiResponse<null>>(this.baseUrl, {
        method: 'POST',
        path: '/api/omi/token/revoke',
        token,
      }),
    )
    this.tokenCache = undefined
  }

  /** 授予勋章（单个用户）；等级只升不降，已有同等级及以上则跳过 */
  async awardBadge(userId: string, badgeId: string, level = 1): Promise<number> {
    return this.awardBadges([userId], badgeId, level)
  }

  /** 批量授予勋章（userIds 数量受权限 max_users_per_call 限制） */
  async awardBadges(userIds: string[], badgeId: string, level = 1): Promise<number> {
    const result = await this.businessCall<AwardResult>('/api/omi/badges/award', {
      userIds,
      badgeId,
      level,
    })
    return result.awarded
  }

  /** 撤销勋章；不传 level 时撤销该勋章全部等级记录 */
  async revokeBadge(userId: string, badgeId: string, level?: number): Promise<void> {
    await this.businessCall<null>('/api/omi/badges/revoke', { userId, badgeId, level })
  }

  /** 钱包调整：amount 正=增加、负=减少；增减方向与范围受应用权限控制 */
  async adjustWallet(
    userId: string,
    kind: WalletKind,
    amount: number,
    note: string,
  ): Promise<WalletAdjustResult> {
    return this.businessCall<WalletAdjustResult>('/api/omi/wallet/adjust', {
      userId,
      kind,
      amount,
      note,
    })
  }

  /** 生成兑换码批次 */
  createRedeemBatch(params: CreateRedeemBatchParams): Promise<RedeemBatchResult> {
    return this.businessCall<RedeemBatchResult>('/api/omi/redeem/batches', params)
  }

  // ---------- 内部 ----------

  private async fetchToken(): Promise<OmiToken> {
    const body = {
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }
    try {
      return await request<OmiToken>(this.baseUrl, { method: 'POST', path: '/api/omi/token', body })
    } catch (err) {
      // 限流 429（同应用+IP 每 10 分钟 30 次）：等待后重试一次
      if (err instanceof PuzzleCatError && err.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
        return request<OmiToken>(this.baseUrl, { method: 'POST', path: '/api/omi/token', body })
      }
      throw err
    }
  }

  /** 自动携带有效令牌调用；业务接口 401 时强制重取令牌重试一次 */
  private async withToken<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await fn((await this.getToken()).access_token)
    } catch (err) {
      if (err instanceof PuzzleCatError && err.status === 401) {
        return fn((await this.getToken(true)).access_token)
      }
      throw err
    }
  }

  private businessCall<T>(path: string, body: unknown): Promise<T> {
    return this.withToken((token) =>
      request<ApiResponse<T>>(this.baseUrl, { method: 'POST', path, body, token }).then(unwrap),
    )
  }
}
