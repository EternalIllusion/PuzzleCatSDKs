/**
 * PuzzleCat TypeScript SDK
 * 覆盖 OAuth 2.0 第三方登录 与 OMI 外部管理接口（勋章发放/钱包调整/兑换码生成）
 *
 * 快速开始：
 *   import { PuzzleCatClient } from 'puzzle-cat-sdk'
 *   const client = new PuzzleCatClient({
 *     baseUrl: 'https://puzzle.cat',
 *     oauth: { clientId: '...', clientSecret: '...', redirectUri: '...' },
 *     omi:   { clientId: 'omi_...', clientSecret: '...' },
 *   })
 */
export { PuzzleCatError } from './error'
export { ApiResponse, TokenErrorBody, request, unwrap } from './request'
export {
  OAuthConfig,
  OAuthToken,
  OAuthUserInfo,
  OAuthTokenInfo,
  OAuthCallback,
  PuzzleCatOAuthClient,
  OAUTH_STATE_STORAGE_KEY,
  redirectToPuzzleCatLogin,
} from './oauth'
export {
  OmiConfig,
  OmiToken,
  OmiTokenInfo,
  BadgeType,
  WalletKind,
  RedeemMode,
  RewardKind,
  OmiBadgePermission,
  OmiWalletPermission,
  OmiRedeemPermission,
  OmiPermissions,
  AwardResult,
  WalletAdjustResult,
  RedeemCodeItem,
  RedeemBatchResult,
  CreateRedeemBatchParams,
  PuzzleCatOmiClient,
} from './omi'
export { PuzzleCatClientConfig, PuzzleCatClient } from './client'
