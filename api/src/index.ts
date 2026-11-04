import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

async function parseName(request: Request): Promise<string | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) || !('name' in body)) {
    return null
  }

  const name = body.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return null
  }

  return name.trim()
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes', async (c) => {
  const { results: homes } = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY rowid',
  ).all<{ id: string; name: string }>()

  return c.json({ homes }, 200)
})

app.post('/api/homes', async (c) => {
  const name = await parseName(c.req.raw)
  if (name === null) {
    return c.json({ error: 'Name must be a non-empty string' }, 400)
  }

  const id = crypto.randomUUID()
  const home = await c.env.DB.prepare(
    'INSERT INTO homes (id, name) VALUES (?, ?) RETURNING id, name',
  )
    .bind(id, name)
    .first<{ id: string; name: string }>()

  if (!home) {
    return c.json({ error: 'Failed to create home' }, 500)
  }

  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const name = await parseName(c.req.raw)
  if (name === null) {
    return c.json({ error: 'Name must be a non-empty string' }, 400)
  }

  const homeId = c.req.param('homeId')
  const id = crypto.randomUUID()
  const member = await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, member_order)
     SELECT ?, ?, ?, COALESCE(
       (SELECT MAX(member_order) + 1 FROM members WHERE home_id = ?),
       0
     )
     WHERE EXISTS (SELECT 1 FROM homes WHERE id = ?)
     RETURNING id, home_id AS homeId, name`,
  )
    .bind(id, homeId, name, homeId, homeId)
    .first<{ id: string; homeId: string; name: string }>()

  if (!member) {
    return c.json({ error: 'Home not found' }, 404)
  }

  return c.json(member, 201)
})

app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: members } = await c.env.DB.prepare(
    `SELECT id, home_id AS homeId, name
     FROM members
     WHERE home_id = ?
     ORDER BY member_order`,
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; name: string }>()

  return c.json({ members }, 200)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('title' in body) ||
    !('totalCents' in body)
  ) {
    return c.json({ error: 'Request body must include a title and totalCents' }, 400)
  }

  const { title, totalCents } = body
  if (typeof title !== 'string' || title.trim().length === 0) {
    return c.json({ error: 'Title must be a non-empty string' }, 400)
  }
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive safe integer' }, 422)
  }

  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY member_order',
  )
    .bind(homeId)
    .all<{ id: string }>()
  if (members.length === 0) {
    return c.json({ error: 'Home must have at least one member' }, 422)
  }

  const billId = crypto.randomUUID()
  const baseShare = Math.floor(totalCents / members.length)
  const remainingCents = totalCents % members.length
  const shares = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: baseShare + (index < remainingCents ? 1 : 0),
    paidAt: null,
  }))

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title.trim(), totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, home_id, member_id, amount_cents) VALUES (?, ?, ?, ?, ?)',
      ).bind(share.id, billId, homeId, share.memberId, share.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)

  return c.json({ id: billId, homeId, title: title.trim(), totalCents, shares }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: rows } = await c.env.DB.prepare(
    `SELECT bills.id, bills.home_id AS homeId, bills.title,
            bills.total_cents AS totalCents,
            shares.id AS shareId, shares.member_id AS memberId, members.name AS memberName,
            shares.amount_cents AS amountCents, shares.paid_at AS paidAt
     FROM bills
     LEFT JOIN shares ON shares.bill_id = bills.id
     LEFT JOIN members ON members.id = shares.member_id
     WHERE bills.home_id = ?
     ORDER BY bills.rowid, shares.rowid`,
  )
    .bind(homeId)
    .all<{
      id: string
      homeId: string
      title: string
      totalCents: number
      shareId: string | null
      memberId: string | null
      memberName: string | null
      amountCents: number | null
      paidAt: string | null
    }>()

  const billsById = new Map<
    string,
    {
      id: string
      homeId: string
      title: string
      totalCents: number
      shares: {
        id: string
        memberId: string
        memberName: string
        amountCents: number
        paidAt: string | null
      }[]
    }
  >()

  for (const row of rows) {
    let bill = billsById.get(row.id)
    if (!bill) {
      bill = {
        id: row.id,
        homeId: row.homeId,
        title: row.title,
        totalCents: row.totalCents,
        shares: [],
      }
      billsById.set(row.id, bill)
    }

    if (
      row.shareId !== null &&
      row.memberId !== null &&
      row.memberName !== null &&
      row.amountCents !== null
    ) {
      bill.shares.push({
        id: row.shareId,
        memberId: row.memberId,
        memberName: row.memberName,
        amountCents: row.amountCents,
        paidAt: row.paidAt,
      })
    }
  }

  return c.json({ bills: Array.from(billsById.values()) }, 200)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const { billId, shareId } = c.req.param()
  const paidAt = new Date().toISOString()
  const payment = await c.env.DB.prepare(
    `UPDATE shares
     SET paid_at = ?, idempotency_key = ?
     WHERE bill_id = ? AND id = ? AND paid_at IS NULL
     RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt`,
  )
    .bind(paidAt, idempotencyKey, billId, shareId)
    .first<{ id: string; memberId: string; amountCents: number; paidAt: string }>()

  if (payment) {
    return c.json(payment, 200)
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, member_id AS memberId, amount_cents AS amountCents,
            paid_at AS paidAt, idempotency_key AS idempotencyKey
     FROM shares
     WHERE bill_id = ? AND id = ?`,
  )
    .bind(billId, shareId)
    .first<{
      id: string
      memberId: string
      amountCents: number
      paidAt: string | null
      idempotencyKey: string | null
    }>()

  if (!existing) {
    return c.json({ error: 'Bill or share not found' }, 404)
  }

  if (existing.paidAt && existing.idempotencyKey === idempotencyKey) {
    return c.json(
      {
        id: existing.id,
        memberId: existing.memberId,
        amountCents: existing.amountCents,
        paidAt: existing.paidAt,
      },
      200,
    )
  }

  return c.json({ error: 'Share has already been paid' }, 409)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: balances } = await c.env.DB.prepare(
    `SELECT members.id AS memberId, members.name,
            COALESCE(SUM(CASE WHEN shares.paid_at IS NULL THEN shares.amount_cents ELSE 0 END), 0)
              AS outstandingCents
     FROM members
     LEFT JOIN shares ON shares.member_id = members.id AND shares.home_id = members.home_id
     WHERE members.home_id = ?
     GROUP BY members.id, members.name, members.member_order
     ORDER BY members.member_order`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances }, 200)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  console.error('API request failed', error)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
