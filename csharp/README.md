# PuzzleCat SDK for ccxc-backend（C#）

为 [ccxc-backend](https://github.com/cipherpuzzles/ccxc-backend)（`main` 分支）提供 **OAuth 2.0 第三方登录** 与 **OMI 外部管理接口**（勋章发放 / 钱包调整 / 兑换码生成）的 C# SDK。

> **重要前提**：官方仓库原版**不包含**任何 PuzzleCat 集成。本 SDK 与下面的接入指南用于在官方代码上**从零新增**该能力，并直接复用官方基础设施：

| 设施 | 使用 |
|------|------|
| 命名空间 | `ccxc_backend.Controllers.Users`（与官方 `UserController.cs` 同级） |
| HTTP | `ccxc_backend.Functions.HttpRequest`（官方自带，含 HttpClientFactory） |
| 日志 | `Ccxc.Core.Utils.Logger`（Info / Warn / Error） |
| 配置 | AppID / AppSecret 由构造函数传入；可接入 ccxc 配置（见『接入指南 · 配置应用凭据』） |
| JSON | Newtonsoft.Json 13.0.3（`Ccxc.Core.Utils` 传递依赖，无需新增包） |

## 文件说明

| 文件 | 说明 |
|------|------|
| `PuzzleCatSdk.cs` | SDK 源码，放置于 `ccxc-backend/Controllers/Users/` 目录即可编译 |
| `README.md` | 本文件：SDK 接入与使用说明 |

## OAuth 登录

```csharp
using ccxc_backend.Controllers.Users;

// 凭据可从 ccxc 配置读取（见『接入指南 · 配置应用凭据』）
var oauth = new PuzzleCatOAuthClient(
    Config.Config.Options.PuzzleCatAppID,
    Config.Config.Options.PuzzleCatAppSecret);

// 生成授权页 URL（ccxc 的 host 动态变化，直接传入即可覆盖默认回调）
var url = oauth.BuildAuthorizeUrl(state: uuid, redirectUri: $"https://{host}/oauth_pc");

// 回调处理：解析 → 校验 state（防 CSRF）→ 换 Token → 取用户信息
var cb = PuzzleCatOAuthClient.ParseCallback(callbackUrl);
if (cb.State != storedState) throw new Exception("state 不匹配");
if (cb.Error != null) throw new Exception(cb.ErrorDescription ?? cb.Error);

var token = await oauth.ExchangeCodeAsync(cb.Code!, redirectUri: $"https://{host}/oauth_pc");
var user = await oauth.GetUserInfoAsync(token.AccessToken); // user.Id / Email / Nickname / Bio
```

### API 一览（OAuth）

| 方法 | 说明 |
|------|------|
| `PuzzleCatOAuthClient(clientId, clientSecret?, baseUrl?, redirectUri?, scope?)` | 显式配置（baseUrl 默认 `https://puzzle.cat`） |
| `BuildAuthorizeUrl(state?, redirectUri?)` | 生成授权页 URL，支持动态回调覆盖 |
| `ParseCallback(url)`（静态） | 解析授权回调参数 |
| `ExchangeCodeAsync(code, redirectUri?)` | 授权码换 Token（需要 Secret） |
| `RefreshTokenAsync(refreshToken)` | 刷新 Token（令牌轮换，旧值失效） |
| `GetUserInfoAsync(accessToken)` | 用户信息（id/email/nickname/avatar/bio） |
| `GetTokenInfoAsync(accessToken)` | 探测令牌有效性 |
| `RevokeTokenAsync(token, tokenTypeHint?)` | 撤销令牌（连带撤销关联 refresh_token） |

## OMI 外部管理接口

OMI 应用（`omi_` 开头）与 OAuth 应用相互独立，AppID/AppSecret 直接传入：

```csharp
var omi = new PuzzleCatOmiClient(clientId: "omi_xxx", clientSecret: "xxx");

var info = await omi.GetTokenInfoAsync();          // 启动时自查权限（安全默认全禁用）
var awarded = await omi.AwardBadgeAsync("u_hashid", "badge_hashid", 1);
var balance = await omi.AdjustWalletAsync("u_hashid", WalletKind.CatStrips, 5, "活动奖励");
var batch = await omi.CreateRedeemBatchAsync(new CreateRedeemBatchParams
{
    Mode = RedeemMode.Unique,
    RewardKind = RewardKind.CatStrips,
    RewardAmount = 5,
    Count = 100,
    Note = "直播活动兑换",
});
```

| 方法 | 说明 |
|------|------|
| `GetTokenAsync(force?)` | 访问令牌：自动缓存复用、过期前 60 秒提前重取 |
| `GetTokenInfoAsync()` | 令牌与应用信息、权限配置自查 |
| `RevokeTokenAsync()` | 撤销当前令牌（本地缓存失效） |
| `AwardBadgeAsync` / `AwardBadgesAsync` | 勋章发放（等级只升不降；实体 ID 一律 hashid） |
| `RevokeBadgeAsync(userId, badgeId, level?)` | 勋章撤销（不传 level 撤销全部等级） |
| `AdjustWalletAsync(userId, kind, amount, note)` | 钱包调整（猫条 / 补签卡） |
| `CreateRedeemBatchAsync(params)` | 兑换码批次（unique / shared） |

## 接入指南

接入共 4 步，不修改 ccxc 现有接口：

### 1. 引入 SDK

```
ccxc-backend/Controllers/Users/PuzzleCatSdk.cs
```

SDK 无新增 NuGet 依赖，随项目直接编译。

### 2. 配置应用凭据（推荐）

在 `ccxc-backend/Config/Config.cs` 的 `Config` 类中（`HttpPort` 等字段旁）添加：

```csharp
[OptionDescription("PuzzleCat OAuth 应用 AppID")]
public string PuzzleCatAppID { get; set; } = "";

[OptionDescription("PuzzleCat OAuth 应用 AppSecret")]
public string PuzzleCatAppSecret { get; set; } = "Change Content!!!";
```

然后在 `ccxc-backend/Config/ccxc.config.toml` 的 `["Config/CcxcConfig"]` 段落中添加：

```toml
# PuzzleCat OAuth 应用 AppID
PuzzleCatAppID = ""
# PuzzleCat OAuth 应用 AppSecret
PuzzleCatAppSecret = ""
```

ccxc 的 `SystemOption` 机制：启动时从 `Config/ccxc.config.toml` 读取带 `[OptionDescription]` 的属性；toml 中缺失的配置项会**自动补写空白项**（不写也不会报错），填入值后经 `Config.Config.Options.PuzzleCatAppID` 读取。不接入 ccxc 配置时，可直接在构造 `PuzzleCatOAuthClient` 时传入凭据（或环境变量）。

### 3. 实现登录接口

参考实现：在 `ccxc-backend/Controllers/Users/` 下新建 `UserOAuthController.cs`（Session 创建与 `/user-login` 一致），提供 `POST /user-get-oauth-url` 与 `POST /user-oauth-login` 两个接口：

```csharp
using Ccxc.Core.HttpServer;
using Ccxc.Core.Utils;
using ccxc_backend.DataModels; // 注意：UserSession 在 ccxc_backend.DataModels（user.cs 内定义），
                              // 不要引入 Ccxc.Core.Plugins.DataModels，否则与它同名冲突（CS0104）
using ccxc_backend.DataServices;
using ccxc_backend.Functions;
using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Threading.Tasks;

namespace ccxc_backend.Controllers.Users
{
    public class OAuthGetURLRequest
    {
        [Required(Message = "host不能为空")]
        public string host { get; set; } // 前端所在域名，回调地址为 https://{host}/oauth_pc
    }

    public class OAuthGetURLResponse : BasicResponse
    {
        public string url { get; set; }
    }

    public class OAuthLoginRequest
    {
        [Required(Message = "host不能为空")]
        public string host { get; set; }

        [Required(Message = "state不能为空")]
        public string state { get; set; }

        [Required(Message = "code不能为空")]
        public string code { get; set; }
    }

    [Export(typeof(HttpController))]
    public class UserOAuthController : HttpController
    {
        private static PuzzleCatOAuthClient GetOAuthClient() =>
            new(Config.Config.Options.PuzzleCatAppID, Config.Config.Options.PuzzleCatAppSecret);

        /// <summary>生成授权 URL：state 存入 Redis（防 CSRF），回调地址按请求域名动态生成</summary>
        [HttpHandler("POST", "/user-get-oauth-url")]
        public async Task GetOAuthURL(Request request, Response response)
        {
            var requestJson = request.Json<OAuthGetURLRequest>();
            if (!Validation.Valid(requestJson, out var reason))
            {
                await response.BadRequest(reason);
                return;
            }

            var uuid = Guid.NewGuid().ToString("n");
            var cache = DbFactory.GetCache();
            await cache.Put(cache.GetCacheKey($"oauth_{uuid}"), uuid, 180000); // 3 分钟有效

            var url = GetOAuthClient().BuildAuthorizeUrl(
                state: uuid,
                redirectUri: $"https://{requestJson.host}/oauth_pc");

            await response.JsonResponse(200, new OAuthGetURLResponse { url = url });
        }

        /// <summary>回调登录：校验 state → 换 Token → 取用户信息 → 按邮箱查/建用户 → 建 Session</summary>
        [HttpHandler("POST", "/user-oauth-login")]
        public async Task UserOauthLogin(Request request, Response response)
        {
            var requestJson = request.Json<OAuthLoginRequest>();
            if (!Validation.Valid(requestJson, out var reason))
            {
                await response.BadRequest(reason);
                return;
            }

            var cache = DbFactory.GetCache();

            // 校验 state（防 CSRF），一次性使用
            var stateKey = cache.GetCacheKey($"oauth_{requestJson.state}");
            var storedState = await cache.Get<string>(stateKey);
            if (storedState != requestJson.state)
            {
                await response.BadRequest("state 校验失败，请重新发起登录");
                return;
            }
            await cache.Delete(stateKey);

            // 换 Token → 用户信息（失败时抛出 PuzzleCatException）
            OAuthUserInfo userInfo;
            try
            {
                var token = await GetOAuthClient().ExchangeCodeAsync(
                    requestJson.code,
                    redirectUri: $"https://{requestJson.host}/oauth_pc");
                userInfo = await GetOAuthClient().GetUserInfoAsync(token.AccessToken);
            }
            catch (PuzzleCatException ex)
            {
                Logger.Error($"[PuzzleCat] OAuth 失败: [{ex.Status}] {ex.Code} {ex.Message}");
                await response.BadRequest("PuzzleCat 登录失败，请重试");
                return;
            }

            if (string.IsNullOrEmpty(userInfo.Email))
            {
                await response.BadRequest("PuzzleCat 账号未设置邮箱，无法登录");
                return;
            }

            // 按邮箱查/建用户（OAuth 邮箱已由 PuzzleCat 验证，直接激活 roleid=1；无密码，登录仅走 OAuth）
            var userDb = DbFactory.Get<User>();
            var userItem = await userDb.SimpleDb.AsQueryable().Where(it => it.email == userInfo.Email).FirstAsync();
            if (userItem == null)
            {
                var user = new user
                {
                    username = userInfo.Nickname,
                    email = userInfo.Email,
                    hashkey = CryptoUtils.GenRandomIV(),
                    password = "",
                    roleid = 1,
                    create_time = DateTime.Now,
                    update_time = DateTime.Now,
                    theme_color = UserController.GetRandomThemeColor(),
                    profile = userInfo.Bio
                };
                var uid = await userDb.SimpleDb.AsInsertable(user).RemoveDataCache().ExecuteReturnIdentityAsync();
                user.uid = uid;
                userItem = user;
            }

            if (userItem.roleid < 1)
            {
                await response.BadRequest("该账号暂不可登录");
                return;
            }

            // 创建 Session（与官方 /user-login 一致；如需审计日志可参照其写入 login_log）
            var uuid = Guid.NewGuid().ToString("n");
            var sk = CryptoUtils.GetRandomKey();
            var newSession = new UserSession
            {
                uid = userItem.uid,
                gid = 0,
                username = userItem.username,
                roleid = userItem.roleid,
                color = userItem.theme_color,
                third_pron = UserSession.GetThirdPron(userItem.gender, userItem.third_pron),
                token = uuid,
                sk = sk,
                login_time = DateTime.Now,
                last_update = DateTime.Now,
                is_active = 1,
                is_betaUser = 0
            };

            var userSessionsKey = cache.GetUserSessionStorage(userItem.uid);
            var userSessions = await cache.Get<List<string>>(userSessionsKey) ?? new List<string>();
            if (userSessions.Count + 1 > Config.SystemConfigLoader.Config.UserSessionMaxCount)
            {
                var firstSessionKey = cache.GetUserSessionKey(userSessions[0]);
                var firstSessionItem = await cache.Get<UserSession>(firstSessionKey);
                if (firstSessionItem != null)
                {
                    firstSessionItem.is_active = 0;
                    firstSessionItem.inactive_message = "您的账号已在另一地点登录，超过最大登录数量限制。";
                    await cache.Put(firstSessionKey, firstSessionItem, Config.SystemConfigLoader.Config.UserSessionTimeout * 1000);
                }
                userSessions.RemoveAt(0);
            }
            userSessions.Add(uuid);
            await cache.Put(userSessionsKey, userSessions, 30L * 86400000);
            await cache.Put(cache.GetUserSessionKey(uuid), newSession, Config.SystemConfigLoader.Config.UserSessionTimeout * 1000);

            await response.JsonResponse(200, new UserLoginResponse
            {
                status = 1,
                user_login_info = new UserLoginResponse.UserLoginInfo
                {
                    uid = userItem.uid,
                    username = userItem.username,
                    roleid = userItem.roleid,
                    token = uuid,
                    sk = sk,
                    etc = "10000",
                    color = userItem.theme_color
                }
            });
        }
    }
}
```

回调地址 `/oauth_pc` 需由部署方将请求转发至 `/user-oauth-login`，或由独立回调页直接调用该接口。

### 4. 构建

```bash
dotnet build src/ccxc-backend/ccxc-backend.csproj
```

## 错误处理

ccxc 的 `HttpRequest.Post/Get` 不返回 HTTP 状态码，SDK 统一以 `PuzzleCatException` 报告错误，并按响应体语义推断状态：

| 场景 | SDK 行为 |
|------|----------|
| token 端点返回 `{ error, error_description }` | 抛 `PuzzleCatException`，`Status` 按 RFC 6749 错误码推断（invalid_client→401 / invalid_grant→400 / access_denied→403） |
| 业务接口统一包装 `code != 200` | 抛 `PuzzleCatException`，`Status = code`（如 403 权限不足） |
| OMI 业务 401（令牌失效） | 自动强制重取令牌重试一次 |
| OMI token 限流 429 | 无法取到 `access_token` → 等待 `retryDelayMs`（默认 2000ms）重试一次 |
| 响应非 JSON | 抛 `PuzzleCatException`，`Status = 0`（未知） |

## 安全建议

1. **App Secret 仅放服务端**（ccxc 配置 `PuzzleCatAppSecret` 存服务端，勿进前端/仓库/日志）。
2. **必须校验 state** 防 CSRF：示例中已实现（`oauth_{uuid}` Redis 缓存比对、一次性使用），勿省略。
3. **令牌轮换**：OAuth 每次刷新签发新 `refresh_token`，旧值立即失效，务必覆盖保存。
4. 生产环境回调必须 HTTPS。
