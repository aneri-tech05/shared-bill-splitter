import { describe, expect, it } from 'vitest'
import { call, createBill, createHome, type Share } from './helpers'

async function setup() {
  const { homeId } = await createHome(['Asha', 'Ben'])
  const bill = await createBill(homeId, 1000)
  const share = bill.body.shares[0]
  if (!share) throw new Error('bill has no shares')
  return { homeId, billId: bill.body.id, share }
}

function pay(billId: string, shareId: string, key: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: { 'Idempotency-Key': key },
  })
}

describe('concurrent share payments', () => {
  it('allows only one of two different keys to pay the same share', async () => {
    const { billId, share } = await setup()

    const results = await Promise.all([
      pay(billId, share.id, 'request-one'),
      pay(billId, share.id, 'request-two'),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
  })

  it('returns the original result to concurrent requests using the same key', async () => {
    const { billId, share } = await setup()

    const results = await Promise.all([
      pay(billId, share.id, 'same-request'),
      pay(billId, share.id, 'same-request'),
    ])

    expect(results.map((result) => result.status)).toEqual([200, 200])
    expect(results[0]?.body.paidAt).toBe(results[1]?.body.paidAt)
  })
})
