/**
 * PuzzleCat SDK 本地测试服务器（零依赖，Node 原生 http 模块）
 *
 * 功能：
 *   - OAuth 2.0 完整流程：发起登录 → 授权回调换 Token → 用户信息 → 刷新 / 撤销
 *   - OMI 简易面板 API：令牌自查 / 勋章发放与撤销 / 钱包调整 / 兑换码生成
 *
 * 使用：
 *   1. 复制 test/.env.example 为 test/.env 并填写；
 *   2. npm run build（确保 dist/ 存在）；
 *   3. npm run test:server，打开 http://localhost:3000
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PuzzleCatClient, PuzzleCatError } from '../dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ==================== 环境变量（真实环境变量优先于 test/.env） ====================

function loadEnvFile() {
  const file = path.join(__dirname, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile()

const PORT = Number(process.env.PORT || 3000)
const BASE_URL = (process.env.PUZZLECAT_BASE_URL || '').replace(/\/+$/, '')
const REDIRECT_URI =
  process.env.PUZZLECAT_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/api/auth/callback`

if (!BASE_URL) {
  console.error('[PuzzleCat test] 缺少 PUZZLECAT_BASE_URL，请复制 test/.env.example 为 test/.env 后填写')
  process.exit(1)
}
if (!fs.existsSync(path.join(__dirname, '../dist/index.js'))) {
  console.error('[PuzzleCat test] 未找到 dist/index.js，请先在 typescript 目录执行 npm run build')
  process.exit(1)
}

// ==================== 客户端构建（按 env 启用模块） ====================

const config = { baseUrl: BASE_URL }
if (process.env.PUZZLECAT_OAUTH_APP_ID) {
  config.oauth = {
    clientId: process.env.PUZZLECAT_OAUTH_APP_ID,
    clientSecret: process.env.PUZZLECAT_OAUTH_SECRET, // 本地测试需要 Secret 才能在回调中换 Token
    redirectUri: REDIRECT_URI,
  }
}
if (process.env.PUZZLECAT_OMI_APP_ID && process.env.PUZZLECAT_OMI_SECRET) {
  config.omi = {
    clientId: process.env.PUZZLECAT_OMI_APP_ID,
    clientSecret: process.env.PUZZLECAT_OMI_SECRET,
  }
}
const client = new PuzzleCatClient(config)
const oauthEnabled = Boolean(config.oauth)
const omiEnabled = Boolean(config.omi)

// ==================== 会话与 state（内存存储，仅限本地测试） ====================

const SESSION_COOKIE = 'puzzlecat_test_session'
/** sessionId -> { oauth: { token, user } | null } */
const sessions = new Map()
/** state -> 创建时间戳；授权码 5 分钟有效，同步过期 */
const authStates = new Map()

function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function getSession(req) {
  const id = parseCookies(req)[SESSION_COOKIE]
  const data = id ? sessions.get(id) : undefined
  return data ? { id, data } : null
}

function setSessionCookie(res, id) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// ==================== HTTP 辅助 ====================

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj, null, 2))
}

function sendOk(res, data) {
  sendJson(res, 200, { ok: true, data })
}

function sendError(res, err) {
  if (err instanceof PuzzleCatError) {
    // 业务 code 可能超出 HTTP 状态码范围，落到 500
    const status = err.status >= 100 && err.status < 600 ? err.status : 500
    sendJson(res, status, { ok: false, error: err.message, status: err.status, code: err.code })
  } else {
    sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new PuzzleCatError('请求体不是合法 JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

// ==================== 路由 ====================

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const { pathname } = url

  try {
    // 页面与元信息
    if (req.method === 'GET' && (pathname === '/' || pathname === '/panel')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'))
    }
    if (req.method === 'GET' && pathname === '/api/meta') {
      return sendOk(res, { baseUrl: BASE_URL, redirectUri: REDIRECT_URI, oauthEnabled, omiEnabled })
    }

    // ---- OAuth ----
    if (req.method === 'GET' && pathname === '/api/auth/login') return handleLogin(res)
    if (req.method === 'GET' && pathname === '/api/auth/callback') return handleCallback(res, url)
    if (req.method === 'GET' && pathname === '/api/auth/session') return handleGetSession(req, res)
    if (req.method === 'POST' && pathname === '/api/auth/refresh') return handleRefresh(req, res)
    if (req.method === 'POST' && pathname === '/api/auth/revoke') return handleRevoke(req, res)
    if (req.method === 'POST' && pathname === '/api/auth/logout') return handleLogout(req, res)

    // ---- OMI ----
    if (req.method === 'GET' && pathname === '/api/omi/token-info') return handleOmiTokenInfo(req, res)
    if (req.method === 'POST' && pathname === '/api/omi/award') return handleOmiAward(req, res)
    if (req.method === 'POST' && pathname === '/api/omi/revoke-badge') return handleOmiRevokeBadge(req, res)
    if (req.method === 'POST' && pathname === '/api/omi/wallet') return handleOmiWallet(req, res)
    if (req.method === 'POST' && pathname === '/api/omi/redeem') return handleOmiRedeem(req, res)

    sendJson(res, 404, { ok: false, error: 'Not Found' })
  } catch (err) {
    sendError(res, err)
  }
}

// ---------- OAuth ----------

function requireOauth() {
  if (!client.oauth) {
    throw new PuzzleCatError('OAuth 未启用：请在 test/.env 配置 PUZZLECAT_OAUTH_APP_ID', 400)
  }
}

/** 发起登录：生成随机 state（防 CSRF）→ 跳转授权页 */
function handleLogin(res) {
  requireOauth()
  const state = crypto.randomBytes(16).toString('hex')
  authStates.set(state, Date.now())
  redirect(res, client.buildAuthorizeUrl(state))
}

/** 授权回调：校验 state → 换 Token → 获取用户信息 → 建立会话 */
async function handleCallback(res, url) {
  requireOauth()
  const cb = PuzzleCatClient.parseCallback(url)

  const createdAt = cb.state ? authStates.get(cb.state) : undefined
  if (!createdAt || Date.now() - createdAt > 5 * 60_000) {
    return redirect(res, `/?error=${encodeURIComponent('state 不匹配或已过期（可能为伪造回调）')}`)
  }
  authStates.delete(cb.state)

  if (cb.error) {
    return redirect(res, `/?error=${encodeURIComponent(cb.error_description || cb.error)}`)
  }
  try {
    const token = await client.exchangeCode(cb.code)
    const user = await client.getUserInfo(token.access_token)
    const sessionId = crypto.randomBytes(16).toString('hex')
    sessions.set(sessionId, { oauth: { token, user } })
    setSessionCookie(res, sessionId)
    redirect(res, '/')
  } catch (err) {
    const message = err instanceof PuzzleCatError ? err.message : String(err?.message ?? err)
    redirect(res, `/?error=${encodeURIComponent(message)}`)
  }
}

function handleGetSession(req, res) {
  const session = getSession(req)
  if (!session?.data.oauth) return sendOk(res, { user: null, token: null })
  const { token, user } = session.data.oauth
  sendOk(res, {
    user,
    token: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
      scope: token.scope,
    },
  })
}

/** 刷新 Token（令牌轮换：旧 refresh_token 立即失效，必须覆盖保存） */
async function handleRefresh(req, res) {
  const session = getSession(req)
  if (!session?.data.oauth) throw new PuzzleCatError('未登录', 401)
  const newToken = await client.refreshToken(session.data.oauth.token.refresh_token)
  session.data.oauth.token = newToken
  sendOk(res, { access_token: newToken.access_token, refresh_token: newToken.refresh_token })
}

/** 撤销 OAuth 令牌（连带撤销关联 refresh_token） */
async function handleRevoke(req, res) {
  const session = getSession(req)
  if (!session?.data.oauth) throw new PuzzleCatError('未登录', 401)
  await client.revokeOAuthToken(session.data.oauth.token.access_token, 'access_token')
  session.data.oauth = null
  sendOk(res, { message: '令牌已撤销' })
}

function handleLogout(req, res) {
  const session = getSession(req)
  if (session) sessions.delete(session.id)
  clearSessionCookie(res)
  sendOk(res, { message: '已退出登录' })
}

// ---------- OMI ----------

function requireOmi() {
  if (!client.omi) {
    throw new PuzzleCatError('OMI 未启用：请在 test/.env 配置 PUZZLECAT_OMI_APP_ID 与 PUZZLECAT_OMI_SECRET', 400)
  }
}

/** 令牌与应用信息、权限配置自查 */
function handleOmiTokenInfo(req, res) {
  requireOmi()
  return client.getOmiTokenInfo().then((info) => sendOk(res, info))
}

/** 勋章发放：userIds 支持逗号 / 换行分隔，批量调用 */
async function handleOmiAward(req, res) {
  requireOmi()
  const body = await readBody(req)
  const userIds = String(body.userIds ?? '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!userIds.length) throw new PuzzleCatError('userIds 不能为空', 400)
  const badgeId = String(body.badgeId ?? '').trim()
  if (!badgeId) throw new PuzzleCatError('badgeId 不能为空', 400)
  const level = Number(body.level ?? 1)
  const awarded = await client.awardBadges(userIds, badgeId, level)
  sendOk(res, { awarded, total: userIds.length })
}

/** 勋章撤销：level 不填时撤销该勋章全部等级 */
async function handleOmiRevokeBadge(req, res) {
  requireOmi()
  const body = await readBody(req)
  const userId = String(body.userId ?? '').trim()
  const badgeId = String(body.badgeId ?? '').trim()
  if (!userId || !badgeId) throw new PuzzleCatError('userId 与 badgeId 必填', 400)
  const level = body.level === '' || body.level === undefined ? undefined : Number(body.level)
  await client.revokeBadge(userId, badgeId, level)
  sendOk(res, { message: '撤销成功' })
}

/** 钱包调整：amount 正=增加、负=减少 */
async function handleOmiWallet(req, res) {
  requireOmi()
  const body = await readBody(req)
  const userId = String(body.userId ?? '').trim()
  const kind = String(body.kind ?? '').trim()
  const amount = Number(body.amount)
  const note = String(body.note ?? '').trim() || '本地测试'
  if (!userId) throw new PuzzleCatError('userId 必填', 400)
  if (!['cat_strips', 'makeup_cards'].includes(kind)) {
    throw new PuzzleCatError('kind 必须为 cat_strips 或 makeup_cards', 400)
  }
  if (!Number.isFinite(amount) || amount === 0) throw new PuzzleCatError('amount 必须为非零数字', 400)
  sendOk(res, await client.adjustWallet(userId, kind, amount, note))
}

/** 兑换码批次生成 */
async function handleOmiRedeem(req, res) {
  requireOmi()
  const body = await readBody(req)
  const mode = String(body.mode ?? '')
  const rewardKind = String(body.rewardKind ?? '')
  const rewardAmount = Number(body.rewardAmount)
  if (!['unique', 'shared'].includes(mode)) throw new PuzzleCatError('mode 必须为 unique 或 shared', 400)
  if (!['cat_strips', 'makeup_cards', 'badge'].includes(rewardKind)) {
    throw new PuzzleCatError('rewardKind 必须为 cat_strips / makeup_cards / badge', 400)
  }
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
    throw new PuzzleCatError('rewardAmount 必须为正数', 400)
  }

  const params = { mode, rewardKind, rewardAmount }
  if (rewardKind === 'badge') {
    const badgeId = String(body.badgeId ?? '').trim()
    if (!badgeId) throw new PuzzleCatError('rewardKind=badge 时 badgeId 必填', 400)
    params.badgeId = badgeId
  }
  if (mode === 'unique') {
    const count = Number(body.count)
    if (!Number.isInteger(count) || count < 1) throw new PuzzleCatError('unique 模式 count 必须为正整数', 400)
    params.count = count
  } else {
    const maxRedemptions = Number(body.maxRedemptions)
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
      throw new PuzzleCatError('shared 模式 maxRedemptions 必须为正整数', 400)
    }
    params.maxRedemptions = maxRedemptions
  }
  if (body.allowUserRepeat === true) params.allowUserRepeat = true
  const note = String(body.note ?? '').trim()
  if (note) params.note = note

  sendOk(res, await client.createRedeemBatch(params))
}

// ==================== 启动 ====================

const server = http.createServer(handleRequest)
server.listen(PORT, () => {
  console.log('PuzzleCat SDK 本地测试服务器已启动')
  console.log(`  面板地址:       http://localhost:${PORT}/`)
  console.log(`  OAuth 回调地址: ${REDIRECT_URI}（需在 PuzzleCat 后台注册一致）`)
  console.log(`  启用模块:       OAuth ${oauthEnabled ? '✔' : '✘（.env 配 PUZZLECAT_OAUTH_APP_ID）'} | OMI ${omiEnabled ? '✔' : '✘（.env 配 PUZZLECAT_OMI_APP_ID + SECRET）'}`)
})
