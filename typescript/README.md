# puzzle-cat-sdk

PuzzleCat 官方 TypeScript SDK，覆盖 **OAuth 2.0 第三方登录** 与 **外部管理接口（OMI）**（勋章发放 / 钱包调整 / 兑换码生成）。

- 运行环境：Node.js ≥ 18（要求原生 fetch）| 浏览器
- 零运行时依赖，双格式输出（ESM + CJS），完整 TypeScript 类型

## 安装

```bash
npm install puzzle-cat-sdk
```

## 快速开始

统一入口 `PuzzleCatClient`：一次配置、一个实例，按需启用 OAuth / OMI 模块。

```typescript
import { PuzzleCatClient } from 'puzzle-cat-sdk'

// 仅登录：new PuzzleCatClient({ baseUrl, oauth: {...} })
// 仅管理：new PuzzleCatClient({ baseUrl, omi: {...} })
const client = new PuzzleCatClient({
  baseUrl: 'https://puzzle.cat',
  oauth: {
    clientId: 'YOUR_APP_ID',
    clientSecret: process.env.PUZZLECAT_CLIENT_SECRET!, // 仅服务端持有
    redirectUri: 'https://your-app.com/api/auth/puzzlecat/callback',
  },
  omi: {
    clientId: 'omi_YOUR_APP_ID',
    clientSecret: process.env.PUZZLECAT_OMI_SECRET!,
  },
})
```

- 顶层方法为常用接口的便捷转发（未启用对应模块时调用会抛出 `PuzzleCatError`）；
- `client.oauth` / `client.omi` 暴露各自完整 API；
- 也可单独使用 `PuzzleCatOAuthClient` / `PuzzleCatOmiClient`（与旧版行为一致）。

## 使用 PuzzleCat 账号登录

完整流程：**注册应用 → 引导授权 → 回调换取 Token → 获取用户信息 → 刷新 / 撤销**。

### 浏览器端：引导授权

浏览器端只能引导跳转，**不能**换取 Token（需要 Secret）：

```typescript
import { PuzzleCatClient, redirectToPuzzleCatLogin } from 'puzzle-cat-sdk'

const client = new PuzzleCatClient({
  baseUrl: 'https://puzzle.cat',
  oauth: {
    clientId: 'YOUR_APP_ID',
    redirectUri: 'https://your-app.com/api/auth/puzzlecat/callback', // 不传 clientSecret
  },
})

// 登录按钮 onClick：生成随机 state → 存 sessionStorage → 跳转授权页
redirectToPuzzleCatLogin(client)
```

### 服务端：回调换取 Token 与用户信息

```typescript
import { PuzzleCatClient, PuzzleCatError } from 'puzzle-cat-sdk'

const client = new PuzzleCatClient({ /* 同上，含 clientSecret */ })

async function handleCallback(callbackUrl: string | URL) {
  const cb = PuzzleCatClient.parseCallback(callbackUrl)

  // 1. 校验 state 防 CSRF（与发起登录时存入的 state 比对）
  const stored = sessionStorage.getItem('puzzlecat_oauth_state')
  if (!cb.state || cb.state !== stored) throw new PuzzleCatError('state 不匹配', 400)
  sessionStorage.removeItem('puzzlecat_oauth_state')

  // 2. 用户拒绝授权：回调带 error=access_denied
  if (cb.error) throw new PuzzleCatError(cb.error_description ?? cb.error, 400, cb.error)

  // 3. 授权码换 Token（code 5 分钟有效、一次性）
  const token = await client.exchangeCode(cb.code!)

  // 4. 获取用户信息（user.id 为 hashid，用作自有系统关联键）
  const user = await client.getUserInfo(token.access_token)

  // 5. 建立自有会话；务必持久化 refresh_token（令牌轮换：下次刷新后旧值失效）
  await upsertSession(user, token)
  return user
}
```

### 动态 redirectUri（可选）

构造时配置的 `redirectUri` 为默认值；如遇多端回调、动态回调等场景，可在调用时传入覆盖（不传则回退到构造配置）：

```typescript
// 授权时覆盖：按本次会话动态指定回调地址
const url = client.buildAuthorizeUrl(state, 'https://your-app.com/api/auth/puzzlecat/callback?from=mobile')

// 换 Token 时必须传入与授权时一致的回调地址（服务端校验，不一致会 invalid_grant）
const token = await client.exchangeCode(code, 'https://your-app.com/api/auth/puzzlecat/callback?from=mobile')
```

注意：动态回调地址仍需为应用注册时登记的 URI 前缀之下（遵循 OAuth 回调校验规则），并确保与授权、换 Token 两次调用完全一致。

### 刷新 / 撤销 Token

```typescript
// 刷新（有效期：access 2 小时 / refresh 30 天）
const newToken = await client.refreshToken(savedRefreshToken)
await saveToken(newToken) // 必须覆盖保存：旧 refresh_token 已失效（令牌轮换）

// 撤销（撤销 access_token 会连带撤销关联 refresh_token）
await client.revokeOAuthToken(token.access_token, 'access_token')

// 探测令牌有效性
const info = await client.getOAuthTokenInfo(token.access_token)
```

## OMI 外部管理接口

OMI 面向**外部系统**提供受限管理能力，认证为 `client_credentials`，权限由 PuzzleCat 超管按应用逐项授权（安全默认全禁用），所有调用写入审计日志。

```typescript
// 令牌自动管理：内部缓存复用、过期前 60 秒提前重取、业务接口 401 自动重试一次、
// token 端点 429 限流自动等待重试一次
const { access_token } = await client.getOmiToken()

// 自查：令牌与应用信息、权限配置
const info = await client.getOmiTokenInfo()

// 勋章发放 / 撤销（等级只升不降；实体 ID 一律 hashid）
await client.awardBadge('u_hashid', 'badge_hashid')          // 单用户，默认 1 级
await client.awardBadges(['u1', 'u2'], 'badge_hashid', 2)    // 批量
await client.revokeBadge('u_hashid', 'badge_hashid', 1)      // 不传 level 撤销全部等级

// 钱包调整（amount 正=增加、负=减少；方向与范围受应用权限控制）
const result = await client.adjustWallet('u_hashid', 'cat_strips', 5, '夏日活动奖励')
// result = { kind: 'cat_strips', amount: 5, balance: 128 }

// 兑换码生成
const batch = await client.createRedeemBatch({
  mode: 'unique',
  rewardKind: 'cat_strips',
  rewardAmount: 5,
  count: 100,
  note: '直播活动兑换',
})
// batch.codes = [{ id, batchId, code }, ...]  本次批次全部码
```

建议启动时调用一次 `getOmiTokenInfo()` 校验所需权限，未授权时提前告警而非调用后才发现 `403`。

## 错误处理

所有失败均抛出 `PuzzleCatError`（`message` / `status` / `code`）：

```typescript
try {
  await client.awardBadge(userId, badgeId)
} catch (err) {
  if (err instanceof PuzzleCatError) {
    console.error(`[${err.status}] ${err.code ?? '-'} ${err.message}`)
  }
}
```

- OAuth token 端点错误码：`invalid_request`（400）/ `invalid_client`（401）/ `invalid_grant`（400）/ `access_denied`（403）
- OMI 业务接口：400 参数错误 / 401 令牌无效（SDK 已自动重取一次）/ 403 权限不足 / 404 资源不存在 / 429 token 限流（每 10 分钟 30 次）/ 500 服务端错误

## 安全规范

1. **App Secret 仅放服务端**，禁止出现在前端代码 / 仓库 / 日志；浏览器端 SDK 不传 `clientSecret`。
2. **必须校验 state**（防 CSRF）：发起登录时生成随机 state 并存储，回调时比对。
3. **令牌轮换**：OAuth 每次刷新都会签发新 `refresh_token`，旧值立即失效，务必覆盖保存。
4. Token 安全存储（服务端数据库 / 密钥管理系统），勿放入 URL、勿写入日志。
5. 生产回调必须 HTTPS。OMI 密钥只显示一次，泄漏可在后台撤销全部令牌。

## 本地开发与发布

```bash
npm install          # 安装依赖
npm run typecheck    # 类型检查（静态校验）
npm run build        # 构建 dist/（ESM + CJS + d.ts）
npm run pack:dry     # 预览发布包内容
npm publish          # 发布到 npm（自动执行 build）
```

- 发布包仅包含 `dist/` 产物与 `package.json`（见 `files` 字段），源码与示例不入包；
- 版本管理：修改 `package.json` 的 `version` 后执行 `npm publish`，或使用 `npm version patch|minor|major` 自动递增。

## 相关文档

- [NextJS·使用PuzzleCat登录](./examples/NextJS_Login_with_PuzzleCat.md)
- [OMI批量运营](./examples/OMI_Batch_Reawrd.md)
