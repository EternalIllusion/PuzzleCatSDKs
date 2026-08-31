# PuzzleCat SDKs

> 本文是面向PuzzleCat第三方开发者的官方 SDK 文档，覆盖 **OAuth 2.0 第三方登录**与 **外部管理接口（OMI）**。文档中的实现示例为 TypeScript版本。其余语言版本详见各语言文件夹下的README文件。

## 快速开始

```typescript
import {
  PuzzleCatOAuthClient,   // OAuth 2.0 登录
  PuzzleCatOmiClient,     // OMI 外部管理接口
  PuzzleCatError,         // 统一异常
} from 'puzzlecat-sdk'
```

## 使用 PuzzleCat 账号登录

完整流程：**注册应用 → 引导授权 → 回调换取 Token → 获取用户信息 → 刷新 / 撤销**。

### 注册应用

填写「申请 OAuth 应用」表单（应用名称、描述、回调 URI、Logo、申请目的、联系方式），管理员审核通过后获得 **App ID** 与 **App Secret**（仅显示一次）。回调 URI 须与后续请求完全一致。

### 浏览器端：引导授权

浏览器端只能引导跳转，**不能**换取 Token（需要 Secret）：

```typescript
import { PuzzleCatOAuthClient, redirectToPuzzleCatLogin, OAUTH_STATE_STORAGE_KEY } from 'puzzlecat-sdk'

const oauthClient = new PuzzleCatOAuthClient({
  baseUrl: 'https://puzzle.cat',
  clientId: 'YOUR_APP_ID',
  redirectUri: 'https://your-app.com/api/auth/puzzlecat/callback',
})

// 登录按钮 onClick：
redirectToPuzzleCatLogin(oauthClient)
// 内部实现：生成随机 state → 存 sessionStorage（key = OAUTH_STATE_STORAGE_KEY）→ 跳转授权页
```

### 服务端：回调换取 Token 与用户信息

回调到达自建服务端后，解析参数、**校验 state**、换取 Token：

```typescript
import { PuzzleCatOAuthClient, PuzzleCatError, OAUTH_STATE_STORAGE_KEY } from '@/lib/ts-sdk'

const oauthClient = new PuzzleCatOAuthClient({
  baseUrl: process.env.PUZZLECAT_BASE_URL!,
  clientId: process.env.PUZZLECAT_CLIENT_ID!,
  clientSecret: process.env.PUZZLECAT_CLIENT_SECRET!, // 仅服务端
  redirectUri: process.env.PUZZLECAT_REDIRECT_URI!,
})

async function handleCallback(callbackUrl: string | URL) {
  const cb = PuzzleCatOAuthClient.parseCallback(callbackUrl)

  // 1. 校验 state 防 CSRF（与发起登录时存入的 state 比对）
  const stored = sessionStorage.getItem(OAUTH_STATE_STORAGE_KEY) // 服务端可用 cookie
  if (!cb.state || cb.state !== stored) throw new PuzzleCatError('state 不匹配', 400)
  sessionStorage.removeItem(OAUTH_STATE_STORAGE_KEY)

  // 2. 用户拒绝授权：回调带 error=access_denied
  if (cb.error) throw new PuzzleCatError(cb.error_description ?? cb.error, 400, cb.error)

  // 3. 授权码换 Token（code 5 分钟有效、一次性）
  const token = await oauthClient.exchangeCode(cb.code!)

  // 4. 获取用户信息
  const user = await oauthClient.getUserInfo(token.access_token)
  // user = { id: 'hashid', email, nickname, avatar, bio }

  // 5. 建立自有会话；务必持久化 refresh_token（令牌轮换：下次刷新后旧值失效）
  await upsertSession(user, token)
  return user
}
```

**关键点**：
- `exchangeCode` / `refreshToken` / `revokeToken` 走 `/api/oauth/token`，返回**裸 OAuth JSON**；`getUserInfo` / `getTokenInfo` 返回统一包装 `{ code, message, data, timestamp }`（SDK 已解包，直接得到 `data`）。
- `user.id` 为 **hashid**（如 `a1b2c3`），用作自建系统用户关联键，勿用于自增数字假设。
- 用户被禁用时：授权页返回 403；刷新返回 `403 access_denied` 并撤销该应用下该用户全部 refresh_token。

### 刷新 / 撤销 Token

```typescript
// 刷新（有效期：access 2 小时 / refresh 30 天）
const newToken = await oauthClient.refreshToken(savedRefreshToken)
await saveToken(newToken) // 必须覆盖保存：旧 refresh_token 已失效（令牌轮换）

// 撤销（撤销 access_token 会连带撤销关联 refresh_token）
await oauthClient.revokeToken(token.access_token, 'access_token')

// 探测令牌有效性
const info = await oauthClient.getTokenInfo(token.access_token)
// info = { userId, appId, scope, expiresAt }
```

## OMI外部管理接口

OMI 面向**外部系统**提供受限管理能力：勋章发放/撤销、钱包调整（猫条/补签卡）、兑换码生成。认证为 `client_credentials` 换取**不透明访问令牌**（非 JWT），权限由 PuzzleCat 超管按应用逐项授权（安全默认全禁用），所有调用写入审计日志。

### 配置与令牌管理

```typescript
import { PuzzleCatOmiClient } from '@/lib/ts-sdk'

const omi = new PuzzleCatOmiClient({
  baseUrl: process.env.PUZZLECAT_BASE_URL!,
  clientId: process.env.PUZZLECAT_OMI_APP_ID!,      // omi_ 开头
  clientSecret: process.env.PUZZLECAT_OMI_SECRET!,  // 仅创建/重置时可见一次
})

// 令牌自动管理：getToken() 内部缓存复用，过期前 60 秒提前重取；
// 业务接口 401 时自动重取一次重试；token 端点 429 限流自动等待重试一次。
const { access_token, app_id, name, expires_in } = await omi.getToken()

// 自查：令牌与应用信息、权限配置
const info = await omi.getTokenInfo()
// info.permissions 见下方权限结构；enabled=false 的域调用会返回 403

// 自撤销当前令牌（可选的令牌生命周期管理）
await omi.revokeToken()
```

### 勋章发放 / 撤销

```typescript
// 单用户发放，默认 1 级
const awarded1 = await omi.awardBadge('u_hashid', 'badge_hashid')
// 批量发放（数量受权限 max_users_per_call 限制）
const awarded2 = await omi.awardBadges(['u1', 'u2', 'u3'], 'badge_hashid', 2)
// awarded = 实际新授予人数

// 撤销：不传 level 撤销该勋章全部等级记录
await omi.revokeBadge('u_hashid', 'badge_hashid', 1)
```

**规则**：
- 实体 ID 一律 **hashid**，裸数字 ID 会被拒绝。
- **只升不降**：目标等级 ≤ 用户已有最高等级时跳过（不重复发放、不产生低等级记录）。
- `level` 默认 1，不得超出授权 `max_level`；目标用户被禁用则拒绝。
- 授予记录 `awarded_by` 为空，授予者信息以审计日志为准。

### 钱包调整（猫条 / 补签卡）

```typescript
// amount 正=增加、负=减少；方向与 |amount| 范围受应用权限控制
const result = await omi.adjustWallet('u_hashid', 'cat_strips', 5, '夏日活动奖励')
// result = { kind: 'cat_strips', amount: 5, balance: 128 }  balance 为调整后余额

await omi.adjustWallet('u_hashid', 'makeup_cards', -1, '补签卡消耗补偿')
```

- `note` 必填，写入账本备注（建议带活动标识，便于对账）。
- 余额不足的扣减返回 `400`，不产生账本变更。

### 兑换码生成

```typescript
// unique：生成 100 个一次性码
const batch = await omi.createRedeemBatch({
  mode: 'unique',
  rewardKind: 'cat_strips',
  rewardAmount: 5,
  count: 100,
  note: '直播活动兑换',
})
// batch.codes = [{ id, batchId, code }, ...]  本次批次全部码

// shared：1 个共享码，最多领取 10000 次
await omi.createRedeemBatch({
  mode: 'shared',
  rewardKind: 'badge',
  badgeId: 'badge_hashid', // rewardKind='badge' 时必填
  maxRedemptions: 10000,
  allowUserRepeat: false,
  note: '周年庆限定勋章',
})
```

- 模式 / 奖励类型 / 码数 / 金额 / 领取上限均受应用权限约束，超出返回 `403`。
- 批次创建者记录为应用创建时的超管用户（责任可追溯）。

### 权限结构与自查

`getTokenInfo().permissions` 结构（服务端下发，与超管后台配置一致）：

```typescript
interface OmiPermissions {
  badge: {
    enabled: boolean
    badge_types: Array<'normal' | 'premium'>  // 空 = 全部
    badge_ids: string[]                        // 空 = 不限
    max_level: number
    max_users_per_call: number
  }
  wallet: {
    cat_strips:   { allow_increase: boolean; allow_decrease: boolean; min_amount: number; max_amount: number }
    makeup_cards: { allow_increase: boolean; allow_decrease: boolean; min_amount: number; max_amount: number }
  }
  redeem: {
    enabled: boolean
    modes: Array<'unique' | 'shared'>
    reward_kinds: Array<'cat_strips' | 'makeup_cards' | 'badge'>
    max_count: number
    max_amount: number
    max_redemptions: number
    badge_types: Array<'normal' | 'premium'>
  }
}
```

建议启动时调用一次 `getTokenInfo()` 校验所需权限，未授权（`enabled=false` / 配置不满足）时提前告警而非调用后才发现 `403`。

## 错误处理

所有失败均抛出 `PuzzleCatError`（`message` / `status` / `code`）：

```typescript
try {
  await omi.awardBadge(userId, badgeId)
} catch (err) {
  if (err instanceof PuzzleCatError) {
    console.error(`[${err.status}] ${err.code ?? '-'} ${err.message}`)
    // 403 权限不足：检查应用权限配置
    // 401 令牌无效：SDK 已自动重取一次，仍失败说明应用被禁用或密钥已重置
    // 429 token 端点限流：同应用+IP 每 10 分钟 30 次，降低重取频率
  }
}
```

### OAuth 错误码（token 端点）

| 错误码 | HTTP | 说明 |
|--------|------|------|
| invalid_request | 400 | 缺少参数 |
| invalid_client | 401 | 客户端认证失败（App ID/Secret 错误或应用禁用） |
| invalid_grant | 400 | code/refresh 无效、过期或 redirect_uri 不匹配 |
| access_denied | 403 | 用户拒绝或账号禁用 |

### OMI 错误码（业务接口）

| HTTP | 含义 |
|------|------|
| 400 | 参数错误（缺失/非法枚举/裸数字 ID/余额不足等） |
| 401 | 令牌缺失/无效/过期/已撤销；client_credentials 认证失败 |
| 403 | 应用未获该项权限或超出授权边界 |
| 404 | 管理端资源不存在 |
| 429 | token 端点限流（每 10 分钟 30 次） |
| 500 | 服务端错误 |

## 安全规范

1. **App Secret 仅放服务端**，禁止出现在前端代码 / 仓库 / 日志；浏览器端 SDK 不传 `clientSecret`。
2. **必须校验 state**：发起登录时生成随机 state 并存储，回调时比对，防止 CSRF。
3. **令牌轮换**：OAuth 每次刷新都会签发新 `refresh_token`，旧值立即失效，务必覆盖保存。
4. Token 安全存储（服务端数据库 / 密钥管理系统），勿放入 URL、勿写入日志。
5. 生产回调必须 HTTPS。
6. OMI 密钥只显示一次，服务端只存哈希；泄漏可在后台撤销全部令牌。
7. 密钥重置或应用被禁用/删除时，该应用**全部已签发令牌立即失效**（SDK 401 重试会随之失败，属预期）。

## 示例

[NextJS·使用PuzzleCat登录](./typescript/examples/NextJS_Login_with_PuzzleCat.md)
[OMI批量运营](./typescript/examples/OMI_Batch_Reawrd.md)

## 注意事项

| 事项 | 说明 |
|------|------|
| 令牌有效期 | 授权码 5 分钟；OAuth access 2 小时 / refresh 30 天；OMI access 固定 7200 秒 |
| hashid | 所有实体 ID（用户、勋章、批次）为 hashid，禁止传裸数字 |
| OAuth 用户禁用 | 授权页 403；刷新时 403 并撤销该应用下该用户全部 refresh_token |
| OMI 只升不降 | 勋章发放等级 ≤ 已有最高等级时跳过 |
| OMI 审计 | 所有调用（成功/拒绝/失败）均写入审计日志，可在后台按应用筛选 |
