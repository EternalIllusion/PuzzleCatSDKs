# Next.js App Router：服务端登录

`app/api/auth/puzzlecat/route.ts`（发起登录）：

```typescript
import { NextResponse } from 'next/server'
import { PuzzleCatOAuthClient, redirectToPuzzleCatLogin } from '@/lib/ts-sdk'

export function GET() {
  // 在服务端直接生成授权 URL 返回给客户端跳转，state 写入 HttpOnly cookie
  const client = new PuzzleCatOAuthClient({
    baseUrl: process.env.PUZZLECAT_BASE_URL!,
    clientId: process.env.PUZZLECAT_CLIENT_ID!,
    redirectUri: `${process.env.APP_BASE_URL}/api/auth/puzzlecat/callback`,
  })
  const state = Math.random().toString(36).slice(2)
  const url = client.buildAuthorizeUrl(state)
  const res = NextResponse.redirect(url)
  res.cookies.set('puzzlecat_oauth_state', state, { httpOnly: true, sameSite: 'lax' })
  return res
}
```

`app/api/auth/puzzlecat/callback/route.ts`（回调）：

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { PuzzleCatOAuthClient, PuzzleCatError } from '@/lib/ts-sdk'

const client = new PuzzleCatOAuthClient({
  baseUrl: process.env.PUZZLECAT_BASE_URL!,
  clientId: process.env.PUZZLECAT_CLIENT_ID!,
  clientSecret: process.env.PUZZLECAT_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_BASE_URL}/api/auth/puzzlecat/callback`,
})

export async function GET(req: NextRequest) {
  const cb = PuzzleCatOAuthClient.parseCallback(req.url)
  const stored = req.cookies.get('puzzlecat_oauth_state')?.value
  if (!cb.state || cb.state !== stored) {
    return NextResponse.redirect('/login?error=invalid_state')
  }
  if (cb.error) {
    return NextResponse.redirect(`/login?error=${cb.error}`)
  }
  try {
    const token = await client.exchangeCode(cb.code!)
    const user = await client.getUserInfo(token.access_token)
    await upsertUserSession(user, token) // 自行实现：持久化 access/refresh token 与用户映射
    return NextResponse.redirect('/')
  } catch (err) {
    const message = err instanceof PuzzleCatError ? err.message : 'unknown'
    return NextResponse.redirect(`/login?error=${encodeURIComponent(message)}`)
  }
}
```
