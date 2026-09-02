# 本地测试（OAuth 登录 + OMI 面板）

内置零依赖测试服务器，可以：

- **OAuth**：完整走通第三方登录流程（发起授权 → 回调换 Token → 用户信息 → 刷新 / 撤销），附带 state 防 CSRF 校验演示；
- **OMI**：通过简易网页面板调用外部管理接口（令牌自查 / 勋章发放与撤销 / 钱包调整 / 兑换码生成）。

## 1. 配置环境变量

复制模板并填写：

```powershell
Copy-Item test\.env.example test\.env
```

```dotenv
# PuzzleCat 站点根地址（必填）
PUZZLECAT_BASE_URL=https://puzzle.cat

# OAuth 应用 ID 与密钥（启用 OAuth 登录测试）
PUZZLECAT_OAUTH_APP_ID=
PUZZLECAT_OAUTH_SECRET=

# OMI 应用 ID（omi_ 开头）与密钥（启用 OMI 面板）
PUZZLECAT_OMI_APP_ID=
PUZZLECAT_OMI_SECRET=

# 可选：回调地址（默认 http://localhost:3000/api/auth/callback）与端口（默认 3000）
# PUZZLECAT_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/callback
# PORT=3000
```

> 前置要求：回调地址须与 PuzzleCat 后台注册的**完全一致**；本地测试推荐注册 `http://localhost:3000/api/auth/callback`。

## 2. 启动

```powershell
pnpm build        # 首次或源码变更后执行（测试服务器直接加载 dist/）
pnpm test:server
```

启动成功输出：

```
PuzzleCat SDK 本地测试服务器已启动
  面板地址:       http://localhost:3000/
  OAuth 回调地址: http://localhost:3000/api/auth/callback（需在 PuzzleCat 后台注册一致）
  启用模块:       OAuth ✔ | OMI ✔
```

## 3. 测试 OAuth 登录

1. 打开 http://localhost:3000/ ，点击 **使用 PuzzleCat 账号登录**；
2. 跳转 PuzzleCat 授权页，同意授权后回跳到本地面板；
3. 面板显示用户信息（id / email / nickname / avatar / bio），可展开查看 `access_token` 与 `refresh_token`；
4. 点击 **刷新 Token** 验证令牌轮换（旧 refresh_token 失效，新值已覆盖保存）；
5. 点击 **撤销 Token** / **退出登录** 验证撤销与清会话。

可在 PuzzleCat 授权页选择"拒绝"，验证回调错误分支（面板顶部展示错误原因）。

## 4. 使用 OMI 面板

- **获取 Token 信息与权限**：展示应用信息与权限配置（勋章 / 钱包 / 兑换码各项限额），建议先自查再调用；
- **勋章发放**：用户 ID 支持逗号 / 换行分隔批量发放，返回实际授予人数（已持有同等级者跳过）；
- **勋章撤销**：level 留空 = 撤销该勋章全部等级记录；
- **钱包调整**：amount 正数增加、负数减少，方向与范围受应用权限控制；
- **兑换码批次**：`unique` 生成 N 个一码一兑的码（响应含全部码），`shared` 生成单码多兑（填每人限兑次数）；奖励类型选 `badge` 时需填勋章 ID。

每次调用结果展示在页面底部"调用结果"区（含 OMI 返回的完整 JSON）。

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动报 `缺少 PUZZLECAT_BASE_URL` | 确认已复制 `.env.example` 为 `.env` 并填写 |
| 启动报 `未找到 dist/index.js` | 先执行 `npm run build` |
| 授权页报 `redirect_uri` 不匹配 | 回调地址与后台注册不一致，检查 `PUZZLECAT_OAUTH_REDIRECT_URI` |
| 回调后提示 `invalid_grant` | code 过期（5 分钟）或重复使用，重新登录即可 |
| OMI 调用返回 403 | 应用未授权该操作，联系 PuzzleCat 超管配置权限 |
| OMI 返回 429 | token 端点限流（同应用+IP 每 10 分钟 30 次），稍后重试（SDK 已自动等待重试一次） |

## 安全说明

- 会话与 token 仅存于服务器内存，重启即清空；适合本地联调，不可用于生产；
- `PUZZLECAT_OAUTH_SECRET` / `PUZZLECAT_OMI_SECRET` 只应出现在本机 `test/.env`（已 gitignore）；
- 面板明文展示 token 便于调试，请勿在共享环境使用本服务器。
