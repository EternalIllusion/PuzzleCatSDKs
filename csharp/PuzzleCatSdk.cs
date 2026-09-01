// ============================================================================
// PuzzleCat SDK for ccxc-backend
// ----------------------------------------------------------------------------
// 面向 ccxc-backend 官方仓库（https://github.com/cipherpuzzles/ccxc-backend，main 分支）深度对接：
//   - 命名空间：ccxc_backend.Controllers.Users（与官方 UserController.cs 同级）
//   - HTTP：ccxc_backend.Functions.HttpRequest（官方自带，含 HttpClientFactory）
//   - 日志：Ccxc.Core.Utils.Logger
//   - 配置：官方 Config.cs 无 PuzzleCat 字段，AppID/AppSecret 由构造函数显式传入
//     （如需走配置，可按 README 改造流程在 Config.cs / CcxcConfig.xml 自行添加）
//   - JSON：Newtonsoft.Json（JObject，Ccxc.Core.Utils 传递依赖）
// 覆盖：OAuth 2.0 第三方登录 + OMI 外部管理接口（勋章/钱包/兑换码）
//
// 使用：复制到 ccxc-backend/Controllers/Users/ 下即可，无新增依赖。
// ============================================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using ccxc_backend.Functions;
using Ccxc.Core.Utils;

#nullable enable

namespace ccxc_backend.Controllers.Users
{
    // ==================== 通用基础 ====================

    /// <summary>SDK 统一异常：所有失败均抛出本类</summary>
    public class PuzzleCatException : Exception
    {
        /// <summary>HTTP 状态码；ccxc HttpRequest 不暴露状态码时按响应体语义推断，未知为 0</summary>
        public int Status { get; }

        /// <summary>RFC 6749 错误码（invalid_client / invalid_grant 等）；非 token 端点为 null</summary>
        public string? Code { get; }

        public PuzzleCatException(string message, int status = 0, string? code = null) : base(message)
        {
            Status = status;
            Code = code;
        }
    }

    /// <summary>统一响应包装：除 token 端点外的所有接口均返回 { code, message, data, timestamp }</summary>
    internal class ApiResponse
    {
        public int Code { get; set; }
        public string Message { get; set; } = "";
        public JToken? Data { get; set; }
        public long Timestamp { get; set; }
    }

    /// <summary>按 RFC 6749 错误码推断 HTTP 状态（HttpRequest 不返回状态码）</summary>
    internal static class OAuthErrorStatus
    {
        public static int Guess(string error) => error switch
        {
            "invalid_request" => 400,
            "invalid_grant" => 400,
            "invalid_client" => 401,
            "access_denied" => 403,
            "unauthorized_client" => 403,
            "unsupported_grant_type" => 400,
            "unsupported_response_type" => 400,
            "invalid_scope" => 400,
            "server_error" => 500,
            "temporarily_unavailable" => 503,
            _ => 0,
        };
    }

    // ==================== OAuth 2.0 第三方登录 ====================

    /// <summary>Token 端点响应（裸 OAuth JSON，非统一包装）</summary>
    public class OAuthToken
    {
        public string AccessToken { get; set; } = "";
        public string TokenType { get; set; } = "Bearer";
        public int ExpiresIn { get; set; }
        public string RefreshToken { get; set; } = "";
        public string Scope { get; set; } = "";
    }

    /// <summary>GET /api/oauth/userinfo → data</summary>
    public class OAuthUserInfo
    {
        /// <summary>用户 hashid</summary>
        public string Id { get; set; } = "";
        public string Email { get; set; } = "";
        public string Nickname { get; set; } = "";
        public string Avatar { get; set; } = "";
        public string Bio { get; set; } = "";
    }

    /// <summary>GET /api/oauth/token/info → data</summary>
    public class OAuthTokenInfo
    {
        public string UserId { get; set; } = "";
        public string AppId { get; set; } = "";
        public string Scope { get; set; } = "";
        public string ExpiresAt { get; set; } = "";
    }

    /// <summary>授权回调 URL 携带的参数</summary>
    public class OAuthCallback
    {
        public string? Code { get; set; }
        public string? State { get; set; }
        public string? Error { get; set; }
        public string? ErrorDescription { get; set; }
    }

    public class PuzzleCatOAuthClient
    {
        private readonly string _baseUrl;
        private readonly string _clientId;
        private readonly string? _clientSecret;
        private readonly string _redirectUri;
        private readonly string _scope;

        /// <summary>显式配置。官方 ccxc 的 Config.cs 没有 PuzzleCat 字段，AppID/AppSecret 必须传入；
        /// 典型用法：new PuzzleCatOAuthClient(Config.Config.Options.PuzzleCatAppID, Config.Config.Options.PuzzleCatAppSecret)
        /// （后者需先按 README 改造流程在 Config.cs / Config/ccxc.config.toml 添加字段）。
        /// redirectUri 缺省时可在 BuildAuthorizeUrl / ExchangeCodeAsync 时动态传入（ccxc 的 host 每次可能不同）</summary>
        public PuzzleCatOAuthClient(string clientId, string? clientSecret = null, string baseUrl = "https://puzzle.cat", string redirectUri = "", string scope = "profile email")
        {
            _baseUrl = baseUrl.TrimEnd('/');
            _clientId = clientId;
            _clientSecret = clientSecret;
            _redirectUri = redirectUri;
            _scope = scope;
        }

        /// <summary>生成授权页 URL（浏览器端可直接跳转，不涉及 Secret）。
        /// 传入 redirectUri 可覆盖构造配置（如多端回调、动态回调场景，ccxc 的 host 每次可能不同）</summary>
        public string BuildAuthorizeUrl(string? state = null, string? redirectUri = null)
        {
            var scope = string.Join("+", _scope.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            var redirect = Uri.EscapeDataString(redirectUri ?? _redirectUri);
            var url = $"{_baseUrl}/oauth/authorize?client_id={_clientId}&response_type=code&scope={scope}&redirect_uri={redirect}";
            if (!string.IsNullOrEmpty(state)) url += $"&state={Uri.EscapeDataString(state)}";
            return url;
        }

        /// <summary>解析授权回调 URL（code 5 分钟有效、一次性）</summary>
        public static OAuthCallback ParseCallback(string url)
        {
            var u = new Uri(url);
            string? Get(string key)
            {
                var query = u.Query.TrimStart('?');
                foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var idx = pair.IndexOf('=');
                    if (idx < 0) continue;
                    if (Uri.UnescapeDataString(pair[..idx]) == key)
                    {
                        return Uri.UnescapeDataString(pair[(idx + 1)..]);
                    }
                }
                return null;
            }
            return new OAuthCallback
            {
                Code = Get("code"),
                State = Get("state"),
                Error = Get("error"),
                ErrorDescription = Get("error_description"),
            };
        }

        /// <summary>授权码换取 Token（须服务端调用，需要 App Secret）。
        /// 传入 redirectUri 覆盖构造配置时，须与授权时使用的回调一致（服务端校验）</summary>
        public Task<OAuthToken> ExchangeCodeAsync(string code, string? redirectUri = null)
        {
            EnsureSecret(); // 同步快速失败：未配置 Secret 时立即抛错
            return TokenRequestAsync<OAuthToken>("/api/oauth/token", new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["redirect_uri"] = redirectUri ?? _redirectUri,
            });
        }

        /// <summary>刷新 Token：每次调用签发新 refresh_token，旧值立即失效，请覆盖本地存储</summary>
        public Task<OAuthToken> RefreshTokenAsync(string refreshToken)
        {
            EnsureSecret(); // 同步快速失败：未配置 Secret 时立即抛错
            return TokenRequestAsync<OAuthToken>("/api/oauth/token", new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
            });
        }

        /// <summary>获取用户信息（Bearer）</summary>
        public async Task<OAuthUserInfo> GetUserInfoAsync(string accessToken)
        {
            var json = await HttpRequest.Get($"{_baseUrl}/api/oauth/userinfo", BearerHeaders(accessToken));
            return await UnwrapDataAsync(json, "/api/oauth/userinfo", () =>
            {
                var data = JObject.Parse(json)["data"] as JObject;
                return new OAuthUserInfo
                {
                    Id = data?["id"]?.ToString() ?? "",
                    Email = data?["email"]?.ToString() ?? "",
                    Nickname = data?["nickname"]?.ToString() ?? "",
                    Avatar = data?["avatar"]?.ToString() ?? "",
                    Bio = data?["bio"]?.ToString() ?? "",
                };
            });
        }

        /// <summary>探测令牌有效性（Bearer）</summary>
        public async Task<OAuthTokenInfo> GetTokenInfoAsync(string accessToken)
        {
            var json = await HttpRequest.Get($"{_baseUrl}/api/oauth/token/info", BearerHeaders(accessToken));
            return await UnwrapDataAsync(json, "/api/oauth/token/info", () =>
            {
                var data = JObject.Parse(json)["data"] as JObject;
                return new OAuthTokenInfo
                {
                    UserId = data?["userId"]?.ToString() ?? "",
                    AppId = data?["appId"]?.ToString() ?? "",
                    Scope = data?["scope"]?.ToString() ?? "",
                    ExpiresAt = data?["expiresAt"]?.ToString() ?? "",
                };
            });
        }

        /// <summary>撤销令牌；撤销 access_token 会连带撤销其关联 refresh_token</summary>
        public async Task RevokeTokenAsync(string token, string tokenTypeHint = "access_token")
        {
            EnsureSecret();
            await HttpRequest.Post($"{_baseUrl}/api/oauth/token/revoke", JsonConvert.SerializeObject(new
            {
                client_id = _clientId,
                client_secret = _clientSecret,
                token,
                token_type_hint = tokenTypeHint,
            }), new Dictionary<string, string> { { "Accept", "application/json" } });
        }

        // ---------- 内部 ----------

        private Dictionary<string, string> BearerHeaders(string accessToken) => new()
        {
            { "Authorization", $"Bearer {accessToken}" },
        };

        private void EnsureSecret()
        {
            if (string.IsNullOrEmpty(_clientSecret))
            {
                throw new PuzzleCatException("调用 token 端点需要 clientSecret（仅服务端可用）", 400);
            }
        }

        /// <summary>token 端点请求：响应为裸 OAuth JSON；解析失败或带 error 时抛错</summary>
        private async Task<T> TokenRequestAsync<T>(string path, Dictionary<string, string> body) where T : class, new()
        {
            body["client_id"] = _clientId;
            body["client_secret"] = _clientSecret!;

            var json = await HttpRequest.Post($"{_baseUrl}{path}", JsonConvert.SerializeObject(body),
                new Dictionary<string, string> { { "Accept", "application/json" } });

            JObject obj;
            try
            {
                obj = JObject.Parse(json);
            }
            catch (Exception ex)
            {
                Logger.Error($"[PuzzleCat] {path} 响应非 JSON: {ex.Message}");
                throw new PuzzleCatException($"PuzzleCat 请求失败（{path}）", 0);
            }

            var err = obj["error"]?.ToString();
            if (!string.IsNullOrEmpty(err))
            {
                var desc = obj["error_description"]?.ToString() ?? err;
                Logger.Error($"[PuzzleCat] {path} 失败: {err} {desc}");
                throw new PuzzleCatException(desc, OAuthErrorStatus.Guess(err), err);
            }

            var result = new T();
            // 通过 JObject 填充（属性名与 JSON 字段一致，忽略大小写下划线）
            FillFromJson(result, obj);
            return result;
        }

        /// <summary>业务接口：解析统一包装 { code, message, data, timestamp }，code 非 200 抛错</summary>
        private async Task<T> UnwrapDataAsync<T>(string json, string path, Func<T> build) where T : class
        {
            try
            {
                var resp = JsonConvert.DeserializeObject<ApiResponse>(json);
                if (resp?.Code != 200)
                {
                    throw new PuzzleCatException(resp?.Message ?? $"PuzzleCat 请求失败（{path}）", resp?.Code ?? 0);
                }
                return build();
            }
            catch (PuzzleCatException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Logger.Error($"[PuzzleCat] {path} 解析失败: {ex.Message}");
                throw new PuzzleCatException($"PuzzleCat 请求失败（{path}）", 0);
            }
        }

        /// <summary>把 JObject 同名字段填充到对象属性（忽略大小写下划线，如 access_token → AccessToken）</summary>
        private static bool FillFromJson(object target, JObject obj)
        {
            foreach (var prop in target.GetType().GetProperties())
            {
                if (!prop.CanWrite) continue;
                var propKey = prop.Name.ToLowerInvariant();

                JToken? val = null;
                foreach (var jp in obj.Properties())
                {
                    // 规范化 JSON 字段名后与属性名比对：access_token / accessToken / AccessToken 均匹配
                    if (jp.Name.ToLowerInvariant().Replace("_", "") == propKey)
                    {
                        val = jp.Value;
                        break;
                    }
                }
                if (val == null || val.Type == JTokenType.Null) continue;

                var t = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
                try
                {
                    if (t == typeof(int) || t == typeof(long))
                    {
                        prop.SetValue(target, Convert.ChangeType(val.ToString(), t));
                    }
                    else if (t == typeof(string))
                    {
                        prop.SetValue(target, val.ToString());
                    }
                    else if (t == typeof(bool))
                    {
                        prop.SetValue(target, val.Value<bool>());
                    }
                }
                catch (Exception)
                {
                    // 字段类型不匹配时忽略该字段
                }
            }
            return true;
        }
    }

    // ==================== OMI 外部管理接口 ====================

    /// <summary>POST /api/omi/token 响应（裸 JSON，非统一包装）</summary>
    public class OmiToken
    {
        public string AccessToken { get; set; } = "";
        public string TokenType { get; set; } = "";
        public int ExpiresIn { get; set; }
        public string AppId { get; set; } = "";
        public string Name { get; set; } = "";
    }

    /// <summary>GET /api/omi/token/info → data</summary>
    public class OmiTokenInfo
    {
        public string AppId { get; set; } = "";
        public string Name { get; set; } = "";
        public string ExpiresAt { get; set; } = "";
        public OmiPermissions? Permissions { get; set; }
    }

    public class OmiPermissions
    {
        public OmiBadgePermission? Badge { get; set; }
        public OmiWalletPermissions? Wallet { get; set; }
        public OmiRedeemPermission? Redeem { get; set; }
    }

    public class OmiBadgePermission
    {
        public bool Enabled { get; set; }
        /// <summary>可操作勋章类型，空数组 = 全部</summary>
        public List<string> BadgeTypes { get; set; } = new();
        /// <summary>限定具体勋章 hashid，空 = 不限</summary>
        public List<string> BadgeIds { get; set; } = new();
        /// <summary>发放等级上限</summary>
        public int MaxLevel { get; set; }
        /// <summary>单次批量发放人数上限</summary>
        public int MaxUsersPerCall { get; set; }
    }

    public class OmiWalletPermissions
    {
        public OmiWalletPermission? CatStrips { get; set; }
        public OmiWalletPermission? MakeupCards { get; set; }
    }

    public class OmiWalletPermission
    {
        public bool AllowIncrease { get; set; }
        public bool AllowDecrease { get; set; }
        public int MinAmount { get; set; }
        public int MaxAmount { get; set; }
    }

    public class OmiRedeemPermission
    {
        public bool Enabled { get; set; }
        public List<string> Modes { get; set; } = new();
        public List<string> RewardKinds { get; set; } = new();
        public int MaxCount { get; set; }
        public int MaxAmount { get; set; }
        public int MaxRedemptions { get; set; }
        public List<string> BadgeTypes { get; set; } = new();
    }

    /// <summary>勋章/钱包/兑换码类型常量</summary>
    public static class WalletKind { public const string CatStrips = "cat_strips"; public const string MakeupCards = "makeup_cards"; }
    public static class RedeemMode { public const string Unique = "unique"; public const string Shared = "shared"; }
    public static class RewardKind { public const string CatStrips = "cat_strips"; public const string MakeupCards = "makeup_cards"; public const string Badge = "badge"; }

    /// <summary>钱包调整结果</summary>
    public class WalletAdjustResult
    {
        public string Kind { get; set; } = "";
        public int Amount { get; set; }
        /// <summary>调整后余额</summary>
        public int Balance { get; set; }
    }

    public class RedeemCodeItem
    {
        public string Id { get; set; } = "";
        public string BatchId { get; set; } = "";
        public string Code { get; set; } = "";
    }

    /// <summary>兑换码批次</summary>
    public class RedeemBatchResult
    {
        public string Id { get; set; } = "";
        public string Mode { get; set; } = "";
        public string RewardKind { get; set; } = "";
        public int RewardAmount { get; set; }
        public string? BadgeId { get; set; }
        public string? BadgeName { get; set; }
        public bool AllowUserRepeat { get; set; }
        public int? MaxRedemptions { get; set; }
        public string Status { get; set; } = "";
        public string Note { get; set; } = "";
        public string CreatedAt { get; set; } = "";
        public int CodeCount { get; set; }
        public int RedeemedCount { get; set; }
        /// <summary>生成批次时返回本次全部码</summary>
        public List<RedeemCodeItem>? Codes { get; set; }
    }

    public class CreateRedeemBatchParams
    {
        /// <summary>unique / shared</summary>
        public string Mode { get; set; } = "";
        /// <summary>cat_strips / makeup_cards / badge</summary>
        public string RewardKind { get; set; } = "";
        public int RewardAmount { get; set; }
        /// <summary>RewardKind = badge 时必填</summary>
        public string? BadgeId { get; set; }
        /// <summary>unique 模式码数；shared 固定为 1</summary>
        public int? Count { get; set; }
        /// <summary>shared 模式必填</summary>
        public int? MaxRedemptions { get; set; }
        public bool? AllowUserRepeat { get; set; }
        public string? Note { get; set; }
    }

    public class PuzzleCatOmiClient
    {
        private readonly string _baseUrl;
        private readonly string _clientId;
        private readonly string _clientSecret;
        private readonly int _retryDelayMs;
        private (OmiToken Token, DateTime ExpiresAt)? _tokenCache;

        /// <summary>OMI 应用（omi_ 开头）与 OAuth 应用相互独立，ccxc 配置暂无对应项，须显式传入</summary>
        public PuzzleCatOmiClient(string clientId, string clientSecret, string baseUrl = "https://puzzle.cat", int retryDelayMs = 2000)
        {
            _baseUrl = baseUrl.TrimEnd('/');
            _clientId = clientId;
            _clientSecret = clientSecret;
            _retryDelayMs = retryDelayMs;
        }

        /// <summary>获取访问令牌：自动缓存复用，过期前 60 秒提前重取。
        /// ccxc HttpRequest 不暴露状态码，限流 429（每 10 分钟 30 次）表现为无法取得 access_token，
        /// 此时等待 retryDelayMs 重试一次</summary>
        public async Task<OmiToken> GetTokenAsync(bool force = false)
        {
            var now = DateTime.UtcNow;
            if (!force && _tokenCache is { } cached && cached.ExpiresAt > now)
            {
                return cached.Token;
            }
            var token = await FetchTokenAsync();
            _tokenCache = (token, now.AddSeconds(token.ExpiresIn - 60));
            return token;
        }

        /// <summary>令牌与应用信息、权限配置自查</summary>
        public async Task<OmiTokenInfo> GetTokenInfoAsync()
        {
            return await WithTokenAsync(async (token) =>
            {
                var json = await HttpRequest.Get($"{_baseUrl}/api/omi/token/info", BearerHeaders(token));
                var data = await ParseBusinessAsync(json, "/api/omi/token/info");
                return data["data"]?.ToObject<OmiTokenInfo>() ?? new OmiTokenInfo();
            }, "/api/omi/token/info");
        }

        /// <summary>撤销当前令牌（撤销后本地缓存失效）</summary>
        public async Task RevokeTokenAsync()
        {
            await WithTokenAsync(async (token) =>
            {
                var json = await HttpRequest.Post($"{_baseUrl}/api/omi/token/revoke", "{}", BearerHeaders(token));
                await ParseBusinessAsync(json, "/api/omi/token/revoke");
                return true;
            }, "/api/omi/token/revoke");
            _tokenCache = null;
        }

        /// <summary>授予勋章（单个用户）；等级只升不降，已有同等级及以上则跳过</summary>
        public Task<int> AwardBadgeAsync(string userId, string badgeId, int level = 1)
        {
            return AwardBadgesAsync(new List<string> { userId }, badgeId, level);
        }

        /// <summary>批量授予勋章（userIds 数量受权限 max_users_per_call 限制）</summary>
        public async Task<int> AwardBadgesAsync(IEnumerable<string> userIds, string badgeId, int level = 1)
        {
            var data = await BusinessCallAsync("/api/omi/badges/award", new { userIds, badgeId, level });
            return data["awarded"]?.Value<int>() ?? 0;
        }

        /// <summary>撤销勋章；不传 level 时撤销该勋章全部等级记录</summary>
        public async Task RevokeBadgeAsync(string userId, string badgeId, int? level = null)
        {
            await BusinessCallAsync("/api/omi/badges/revoke", new { userId, badgeId, level });
        }

        /// <summary>钱包调整：amount 正=增加、负=减少；增减方向与范围受应用权限控制</summary>
        public async Task<WalletAdjustResult> AdjustWalletAsync(string userId, string kind, int amount, string note)
        {
            var data = await BusinessCallAsync("/api/omi/wallet/adjust", new { userId, kind, amount, note });
            return data.ToObject<WalletAdjustResult>() ?? new WalletAdjustResult();
        }

        /// <summary>生成兑换码批次</summary>
        public async Task<RedeemBatchResult> CreateRedeemBatchAsync(CreateRedeemBatchParams p)
        {
            var data = await BusinessCallAsync("/api/omi/redeem/batches", new
            {
                p.Mode,
                p.RewardKind,
                p.RewardAmount,
                p.BadgeId,
                p.Count,
                p.MaxRedemptions,
                p.AllowUserRepeat,
                p.Note,
            });
            return data.ToObject<RedeemBatchResult>() ?? new RedeemBatchResult();
        }

        // ---------- 内部 ----------

        private Dictionary<string, string> BearerHeaders(string accessToken) => new()
        {
            { "Authorization", $"Bearer {accessToken}" },
            { "Accept", "application/json" },
        };

        /// <summary>业务调用：自动携带有效令牌并校验响应；包装 code 401 时强制重取令牌重试一次</summary>
        private Task<JObject> BusinessCallAsync(string path, object body)
        {
            return WithTokenAsync(async (token) =>
            {
                var json = await HttpRequest.Post($"{_baseUrl}{path}", JsonConvert.SerializeObject(body), BearerHeaders(token));
                return await ParseBusinessAsync(json, path);
            }, path);
        }

        /// <summary>自动携带有效令牌调用；包装 code 401 时强制重取令牌重试一次</summary>
        private async Task<T> WithTokenAsync<T>(Func<string, Task<T>> fn, string path = "")
        {
            try
            {
                return await fn((await GetTokenAsync()).AccessToken);
            }
            catch (PuzzleCatException ex) when (ex.Status == 401)
            {
                Logger.Warn($"[PuzzleCat] OMI 令牌无效（{path}），强制重取后重试一次");
                return await fn((await GetTokenAsync(force: true)).AccessToken);
            }
        }

        private async Task<OmiToken> FetchTokenAsync()
        {
            var body = new
            {
                grant_type = "client_credentials",
                client_id = _clientId,
                client_secret = _clientSecret,
            };

            string json;
            try
            {
                json = await HttpRequest.Post($"{_baseUrl}/api/omi/token", JsonConvert.SerializeObject(body),
                    new Dictionary<string, string> { { "Accept", "application/json" } });
            }
            catch (Exception ex)
            {
                Logger.Error($"[PuzzleCat] OMI token 请求异常: {ex.Message}");
                throw new PuzzleCatException("PuzzleCat OMI 请求失败", 0);
            }

            JObject obj;
            try
            {
                obj = JObject.Parse(json);
            }
            catch
            {
                obj = null!;
            }

            // 限流（429）或响应异常：表现为拿不到 access_token，等待后重试一次
            var accessToken = obj?["access_token"]?.ToString();
            if (string.IsNullOrEmpty(accessToken))
            {
                await Task.Delay(_retryDelayMs);
                json = await HttpRequest.Post($"{_baseUrl}/api/omi/token", JsonConvert.SerializeObject(body),
                    new Dictionary<string, string> { { "Accept", "application/json" } });
                try
                {
                    obj = JObject.Parse(json);
                }
                catch
                {
                    obj = null!;
                }
                accessToken = obj?["access_token"]?.ToString();
                if (string.IsNullOrEmpty(accessToken))
                {
                    var err = obj?["error"]?.ToString();
                    var desc = obj?["error_description"]?.ToString() ?? "无法获取访问令牌";
                    Logger.Error($"[PuzzleCat] OMI token 获取失败: {err} {desc}");
                    throw new PuzzleCatException(desc, err == null ? 0 : OAuthErrorStatus.Guess(err), err);
                }
            }

            // 走到此处 accessToken 非空（取自 obj），obj 必非空
            var token = new OmiToken
            {
                AccessToken = accessToken,
                TokenType = obj?["token_type"]?.ToString() ?? "Bearer",
                ExpiresIn = obj?["expires_in"]?.Value<int>() ?? 0,
                AppId = obj?["app_id"]?.ToString() ?? "",
                Name = obj?["name"]?.ToString() ?? "",
            };
            Logger.Info($"[PuzzleCat] OMI token 获取成功（{token.Name}）");
            return token;
        }

        /// <summary>解析统一包装 { code, message, data, timestamp }：code 非 200 抛错，成功返回 data 节点</summary>
        private static async Task<JObject> ParseBusinessAsync(string json, string path)
        {
            try
            {
                var resp = JsonConvert.DeserializeObject<ApiResponse>(json);
                if (resp?.Code != 200)
                {
                    Logger.Warn($"[PuzzleCat] {path} 业务失败: [{resp?.Code}] {resp?.Message}");
                    throw new PuzzleCatException(resp?.Message ?? $"PuzzleCat 请求失败（{path}）", resp?.Code ?? 0);
                }
                return resp.Data as JObject ?? new JObject();
            }
            catch (PuzzleCatException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Logger.Error($"[PuzzleCat] {path} 响应解析失败: {ex.Message}");
                throw new PuzzleCatException($"PuzzleCat 请求失败（{path}）", 0);
            }
        }
    }
}
