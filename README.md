# PuzzleCat SDKs

本文是面向PuzzleCat第三方开发者的官方 SDK 文档，覆盖 **OAuth 2.0 第三方登录**与 **外部管理接口（OMI）**。

文档中的实现示例为 TypeScript版本。其余语言版本详见各语言文件夹下的README文件。

## 开始使用

### 对接手册

[Typescript SDK](./typescript/README.md)

> 适用于：&#9;Node.js>18    
> 适用框架：&#9;ETPS Engine; EJPS Engine

[C# SDK (CCXC)](./csharp/README.md)

> 适用于：&#9;.NET 8.0    
> 适用框架：&#9;CCXC Engine

Python SDK (暂未发布)

> 适用于：&#9;Python3.8+ + Request    
> 适用框架：&#9;Pnku Site; GPH Site

### 开发示例

[NextJS · 使用PuzzleCat登录](./typescript/examples/NextJS_Login_with_PuzzleCat.md)

[Typescript · OMI批量运营](./typescript/examples/OMI_Batch_Reawrd.md)

## 快速开始

统一入口 `PuzzleCatClient`：一次配置、一个实例，按需启用 OAuth / OMI 模块：

```typescript
const client = new PuzzleCatClient();
```

## 使用 PuzzleCat 账号登录

```typescript
const oauthClient = new PuzzleCatOAuthClient()

async function handleCallback(callbackUrl: string | URL) {
  const cb = PuzzleCatOAuthClient.parseCallback(callbackUrl)
  const token = await oauthClient.exchangeCode(cb.code!)
  const user = await oauthClient.getUserInfo(token.access_token)
  return user
}
```

## 错误处理

所有失败均抛出 `PuzzleCatError`（`message` / `status` / `code`）：

```typescript
try {
  ......
} catch (err) {
  if (err instanceof PuzzleCatError) {
    console.error(`[${err.status}] ${err.code ?? '-'} ${err.message}`)
    // 403 权限不足：检查应用权限配置
    // 401 令牌无效：SDK 已自动重取一次，仍失败说明应用被禁用或密钥已重置
    // 429 token 端点限流：同应用+IP 每 10 分钟 30 次，降低重取频率
  }
}
```