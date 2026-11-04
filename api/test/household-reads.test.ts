import { describe, expect, it } from 'vitest'
import { call } from './helpers'

describe('household read endpoints', () => {
  it('lists homes with their names', async () => {
    const created = await call<{ id: string; name: string }>('POST', '/api/homes', {
      body: { name: 'Cedar House' },
    })

    const listed = await call<{ homes: { id: string; name: string }[] }>('GET', '/api/homes')

    expect(listed.status).toBe(200)
    expect(listed.body.homes).toContainEqual(created.body)
  })

  it('lists household members in the order they were added', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', {
      body: { name: 'Maple House' },
    })
    await call('POST', `/api/homes/${home.body.id}/members`, { body: { name: 'Asha' } })
    await call('POST', `/api/homes/${home.body.id}/members`, { body: { name: 'Ben' } })

    const listed = await call<{ members: { name: string }[] }>(
      'GET',
      `/api/homes/${home.body.id}/members`,
    )

    expect(listed.status).toBe(200)
    expect(listed.body.members.map((member) => member.name)).toEqual(['Asha', 'Ben'])
  })
})
