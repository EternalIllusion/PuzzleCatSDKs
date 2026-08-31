# OMI：批量运营

```typescript
import { PuzzleCatOmiClient, PuzzleCatError } from '@/lib/ts-sdk'

const omi = new PuzzleCatOmiClient({
  baseUrl: process.env.PUZZLECAT_BASE_URL!,
  clientId: process.env.PUZZLECAT_OMI_APP_ID!,
  clientSecret: process.env.PUZZLECAT_OMI_SECRET!,
})

async function grantActivityReward(userIds: string[], badgeId: string) {
  const awarded = await omi.awardBadges(userIds, badgeId, 2)
  console.log(`勋章发放成功：${awarded}/${userIds.length} 人获得`)

  for (const userId of userIds) {
    await omi.adjustWallet(userId, 'cat_strips', 10, '活动奖励')
  }
}

async function main() {
  try {
    await grantActivityReward(['u_hashid_1', 'u_hashid_2'], 'badge_hashid')
    const batch = await omi.createRedeemBatch({
      mode: 'unique',
      rewardKind: 'makeup_cards',
      rewardAmount: 3,
      count: 50,
      note: '用户回馈',
    })
    console.log(batch.codes?.map((c) => c.code))
  } catch (err) {
    if (err instanceof PuzzleCatError) {
      console.error(`OMI 调用失败 [${err.status}]: ${err.message}`)
    }
    throw err
  }
}
```