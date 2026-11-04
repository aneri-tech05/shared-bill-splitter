import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

type Home = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Balance = { memberId: string; name: string; outstandingCents: number }
type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}
type HouseholdData = { members: Member[]; bills: Bill[]; balances: Balance[] }

const REQUEST_TIMEOUT_MS = 15_000
const SELECTED_HOME_STORAGE_KEY = 'shared-bill-splitter.selected-home'

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super('The request timed out. Check your connection and retry.')
    this.name = 'RequestTimeoutError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestJson(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  signal?.addEventListener('abort', abortFromParent, { once: true })
  if (signal?.aborted) controller.abort()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(path, { ...init, signal: controller.signal })
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `The request failed (HTTP ${response.status}).`
      throw new ApiError(message, response.status)
    }

    return payload
  } catch (error) {
    if (timedOut) {
      throw new RequestTimeoutError()
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromParent)
  }
}

function parseHome(value: unknown): Home | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0
  ) {
    return null
  }
  return { id: value.id, name: value.name }
}

function parseMember(value: unknown): Member | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.homeId !== 'string' ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0
  ) {
    return null
  }
  return { id: value.id, homeId: value.homeId, name: value.name }
}

function parseBalance(value: unknown): Balance | null {
  if (
    !isRecord(value) ||
    typeof value.memberId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.outstandingCents !== 'number' ||
    !Number.isSafeInteger(value.outstandingCents) ||
    value.outstandingCents < 0
  ) {
    return null
  }
  return {
    memberId: value.memberId,
    name: value.name,
    outstandingCents: value.outstandingCents,
  }
}

function parseShare(value: unknown): Share | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.memberId !== 'string' ||
    typeof value.amountCents !== 'number' ||
    !Number.isSafeInteger(value.amountCents) ||
    value.amountCents < 0 ||
    (value.memberName !== undefined && typeof value.memberName !== 'string') ||
    (value.paidAt !== null && (typeof value.paidAt !== 'string' || value.paidAt.length === 0))
  ) {
    return null
  }
  return {
    id: value.id,
    memberId: value.memberId,
    memberName: typeof value.memberName === 'string' ? value.memberName : '',
    amountCents: value.amountCents,
    paidAt: value.paidAt,
  }
}

function parseBill(value: unknown): Bill | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.homeId !== 'string' ||
    typeof value.title !== 'string' ||
    value.title.trim().length === 0 ||
    typeof value.totalCents !== 'number' ||
    !Number.isSafeInteger(value.totalCents) ||
    value.totalCents <= 0 ||
    !Array.isArray(value.shares)
  ) {
    return null
  }
  const shares = value.shares.map(parseShare)
  if (!shares.every((share): share is Share => share !== null)) return null
  return {
    id: value.id,
    homeId: value.homeId,
    title: value.title,
    totalCents: value.totalCents,
    shares,
  }
}

function parseList<T>(
  payload: unknown,
  property: string,
  parser: (value: unknown) => T | null,
): T[] {
  if (!isRecord(payload) || !Array.isArray(payload[property])) {
    throw new Error('The server returned an unexpected response. Please retry.')
  }
  const values = payload[property].map(parser)
  if (!values.every((value): value is T => value !== null)) {
    throw new Error('The server returned incomplete or invalid data. Please retry.')
  }
  return values
}

function formatCents(amountCents: number): string {
  const whole = Math.floor(amountCents / 100).toLocaleString('en-US')
  const fraction = String(amountCents % 100).padStart(2, '0')
  return `$${whole}.${fraction}`
}

function amountInputToCents(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null
  const [whole = '', fractional = ''] = value.split('.')
  const wholeDollars = Number(whole)
  const cents = wholeDollars * 100 + Number(fractional.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

function loadStoredHomeId(): string {
  try {
    return window.localStorage.getItem(SELECTED_HOME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function Dashboard() {
  const [homes, setHomes] = useState<Home[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState(loadStoredHomeId)
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeLoadError, setHomeLoadError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<HouseholdData | null>(null)
  const [dashboardHomeId, setDashboardHomeId] = useState('')
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showNewHomeForm, setShowNewHomeForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const homesController = useRef<AbortController | null>(null)
  const dashboardController = useRef<AbortController | null>(null)
  const dashboardRequestVersion = useRef(0)
  const idempotencyKeys = useRef(new Map<string, string>())

  const selectedHome = homes.find((home) => home.id === selectedHomeId) ?? null
  const currentDashboard = dashboardHomeId === selectedHomeId ? dashboard : null
  const members = currentDashboard?.members ?? []
  const bills = currentDashboard?.bills ?? []
  const balances = currentDashboard?.balances ?? []
  const unpaidTotal = balances.reduce((sum, balance) => sum + balance.outstandingCents, 0)
  const paidShares = bills.reduce(
    (sum, bill) => sum + bill.shares.filter((share) => share.paidAt !== null).length,
    0,
  )
  const unpaidShares = bills.reduce(
    (sum, bill) => sum + bill.shares.filter((share) => share.paidAt === null).length,
    0,
  )

  const refreshHomes = useCallback(async (preferredHomeId: string, signal?: AbortSignal) => {
    const payload = await requestJson('/api/homes', {}, signal)
    const loadedHomes = parseList(payload, 'homes', parseHome)
    setHomes(loadedHomes)
    const storedId = loadStoredHomeId()
    const preferred =
      loadedHomes.find((home) => home.id === preferredHomeId) ??
      loadedHomes.find((home) => home.id === storedId) ??
      loadedHomes[0]
    setSelectedHomeId(preferred?.id ?? '')
    setHomeLoadError(null)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    homesController.current = controller
    setHomeLoading(true)
    void refreshHomes(loadStoredHomeId(), controller.signal)
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return
        setHomeLoadError(
          loadError instanceof Error ? loadError.message : 'Could not load homes. Please retry.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setHomeLoading(false)
          homesController.current = null
        }
      })

    return () => controller.abort()
  }, [refreshHomes])

  useEffect(() => {
    try {
      if (selectedHomeId) {
        window.localStorage.setItem(SELECTED_HOME_STORAGE_KEY, selectedHomeId)
      } else {
        window.localStorage.removeItem(SELECTED_HOME_STORAGE_KEY)
      }
    } catch {
      // Storage is optional; the selected home remains available in component state.
    }
  }, [selectedHomeId])

  useEffect(() => {
    dashboardController.current?.abort()
    if (!selectedHomeId) {
      setDashboard(null)
      setDashboardHomeId('')
      setDashboardError(null)
      setDashboardLoading(false)
      return
    }

    const controller = new AbortController()
    dashboardController.current = controller
    dashboardRequestVersion.current = refreshVersion
    setDashboardLoading(true)
    setDashboardError(null)

    const homePath = `/api/homes/${encodeURIComponent(selectedHomeId)}`
    void Promise.all([
      requestJson(`${homePath}/members`, {}, controller.signal),
      requestJson(`${homePath}/bills`, {}, controller.signal),
      requestJson(`${homePath}/balances`, {}, controller.signal),
    ])
      .then(([membersPayload, billsPayload, balancesPayload]) => {
        const loadedMembers = parseList(membersPayload, 'members', parseMember)
        const loadedBills = parseList(billsPayload, 'bills', parseBill)
        const loadedBalances = parseList(balancesPayload, 'balances', parseBalance)
        if (
          loadedMembers.some((member) => member.homeId !== selectedHomeId) ||
          loadedBills.some((bill) => bill.homeId !== selectedHomeId)
        ) {
          throw new Error('The server returned data for a different home. Please retry.')
        }
        if (!controller.signal.aborted && dashboardRequestVersion.current === refreshVersion) {
          setDashboard({ members: loadedMembers, bills: loadedBills, balances: loadedBalances })
          setDashboardHomeId(selectedHomeId)
        }
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted && dashboardRequestVersion.current === refreshVersion) {
          setDashboardError(
            loadError instanceof Error
              ? loadError.message
              : 'Could not load this home. Please retry.',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && dashboardRequestVersion.current === refreshVersion) {
          dashboardController.current = null
          setDashboardLoading(false)
        }
      })

    return () => controller.abort()
  }, [selectedHomeId, refreshVersion])

  function clearMessages() {
    setActionError(null)
    setNotice(null)
  }

  async function createHome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('homeName') ?? '').trim()
    if (!name) {
      setActionError('Enter a household name.')
      return
    }

    clearMessages()
    setSubmitting(true)
    try {
      const payload = await requestJson('/api/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const home = parseHome(payload)
      if (!home) throw new Error('The server returned an invalid home.')

      setHomes((current) =>
        current.some((existing) => existing.id === home.id) ? current : [...current, home],
      )
      setSelectedHomeId(home.id)
      setShowNewHomeForm(false)
      setHomeLoadError(null)
      form.reset()
      setNotice(`${home.name} is ready. Add household members to get started.`)
    } catch (requestError) {
      setActionError(
        requestError instanceof Error ? requestError.message : 'Could not create the household.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedHomeId) return
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('memberName') ?? '').trim()
    if (!name) {
      setActionError('Enter a member name.')
      return
    }

    clearMessages()
    setSubmitting(true)
    try {
      const payload = await requestJson(
        `/api/homes/${encodeURIComponent(selectedHomeId)}/members`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      )
      const member = parseMember(payload)
      if (!member || member.homeId !== selectedHomeId) {
        throw new Error('The server returned an invalid member.')
      }
      form.reset()
      setNotice(`${member.name} was added to ${selectedHome?.name ?? 'the household'}.`)
      setRefreshVersion((version) => version + 1)
    } catch (requestError) {
      setActionError(
        requestError instanceof Error ? requestError.message : 'Could not add this member.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function createBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedHomeId) return
    if (members.length === 0) {
      setActionError('Add at least one member before creating a bill.')
      return
    }
    const form = event.currentTarget
    const formData = new FormData(form)
    const title = String(formData.get('billTitle') ?? '').trim()
    const amountInput = String(formData.get('billAmount') ?? '').trim()
    const totalCents = amountInputToCents(amountInput)
    if (!title) {
      setActionError('Enter a bill title.')
      return
    }
    if (totalCents === null) {
      setActionError('Enter an amount greater than zero with no more than two decimal places.')
      return
    }

    clearMessages()
    setSubmitting(true)
    try {
      const payload = await requestJson(`/api/homes/${encodeURIComponent(selectedHomeId)}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, totalCents }),
      })
      const bill = parseBill(payload)
      if (!bill || bill.homeId !== selectedHomeId) {
        throw new Error('The server returned an invalid bill.')
      }
      form.reset()
      setNotice(`${bill.title} was added and split across ${bill.shares.length} members.`)
      setRefreshVersion((version) => version + 1)
    } catch (requestError) {
      setActionError(
        requestError instanceof Error ? requestError.message : 'Could not create this bill.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function payShare(billId: string, share: Share) {
    clearMessages()
    setPayingShareId(share.id)
    const storageKey = `${billId}:${share.id}`
    let idempotencyKey = idempotencyKeys.current.get(storageKey)
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID()
      idempotencyKeys.current.set(storageKey, idempotencyKey)
    }

    try {
      const payload = await requestJson(
        `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(share.id)}/pay`,
        { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
      )
      const paidShare = parseShare(payload)
      if (
        !paidShare ||
        paidShare.id !== share.id ||
        paidShare.memberId !== share.memberId ||
        paidShare.amountCents !== share.amountCents ||
        paidShare.paidAt === null
      ) {
        throw new Error('The server returned an unexpected payment response.')
      }

      setDashboard((current) =>
        current
          ? {
              ...current,
              bills: current.bills.map((bill) =>
                bill.id === billId
                  ? {
                      ...bill,
                      shares: bill.shares.map((currentShare) =>
                        currentShare.id === paidShare.id
                          ? { ...paidShare, memberName: currentShare.memberName }
                          : currentShare,
                      ),
                    }
                  : bill,
              ),
            }
          : current,
      )
      idempotencyKeys.current.delete(storageKey)
      setNotice(`${share.memberName || 'Member'}’s share is paid.`)
      setRefreshVersion((version) => version + 1)
    } catch (requestError) {
      setActionError(
        requestError instanceof RequestTimeoutError
          ? 'The payment request timed out. The share remains unpaid here; retry to confirm its status.'
          : requestError instanceof Error
            ? requestError.message
            : 'Could not complete the payment. Please retry.',
      )
    } finally {
      setPayingShareId(null)
    }
  }

  async function retryHomes() {
    homesController.current?.abort()
    const controller = new AbortController()
    homesController.current = controller
    setHomeLoading(true)
    setHomeLoadError(null)
    try {
      await refreshHomes(selectedHomeId, controller.signal)
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setHomeLoadError(
          loadError instanceof Error ? loadError.message : 'Could not load homes. Please retry.',
        )
      }
    } finally {
      if (!controller.signal.aborted) {
        homesController.current = null
        setHomeLoading(false)
      }
    }
  }

  const retryDashboard = () => setRefreshVersion((version) => version + 1)

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Shared Bill Splitter home">
          <span className="brand-icon" aria-hidden="true">
            S
          </span>
          <span>Shared Bill Splitter</span>
        </a>
        <div className="topbar-meta">
          <span className="connection-dot" />
          <span>Household workspace</span>
        </div>
      </header>

      <div className="dashboard-wrap">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">HOUSEHOLD OVERVIEW</p>
            <h1>{selectedHome?.name ?? 'Your shared expenses, in one place'}</h1>
            <p className="welcome-copy">
              {selectedHome
                ? 'Track bills, settle shares, and keep everyone on the same page.'
                : 'Create a home to start organizing shared household expenses.'}
            </p>
          </div>
          <div className="welcome-actions">
            <label className="home-select-wrap">
              <span>Current household</span>
              <select
                aria-label="Select household"
                value={selectedHomeId}
                onChange={(event) => {
                  clearMessages()
                  setSelectedHomeId(event.target.value)
                }}
                disabled={homeLoading || homes.length === 0}
              >
                {homes.length === 0 ? <option value="">No households yet</option> : null}
                {homes.map((home) => (
                  <option key={home.id} value={home.id}>
                    {home.name}
                  </option>
                ))}
              </select>
            </label>
            {homes.length > 0 ? (
              <button
                type="button"
                className="button button-secondary new-home-toggle"
                onClick={() => setShowNewHomeForm((visible) => !visible)}
              >
                {showNewHomeForm ? 'Cancel' : '＋ New home'}
              </button>
            ) : null}
          </div>
        </section>

        {(homeLoadError || dashboardError || actionError) && (
          <div className="alert alert-error" role="alert">
            <div>
              <strong>We couldn’t complete that request</strong>
              <p>{actionError ?? dashboardError ?? homeLoadError}</p>
            </div>
            {homeLoadError ? (
              <button type="button" className="button button-outline" onClick={retryHomes}>
                Retry
              </button>
            ) : null}
            {dashboardError ? (
              <button type="button" className="button button-outline" onClick={retryDashboard}>
                Retry
              </button>
            ) : null}
          </div>
        )}

        {notice && (
          <div className="alert alert-success" role="status">
            <span className="success-check" aria-hidden="true">
              ✓
            </span>
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}

        <section className="metrics-grid" aria-label="Household summary">
          <MetricCard
            label="Outstanding"
            value={currentDashboard ? formatCents(unpaidTotal) : '—'}
            detail={unpaidShares === 1 ? '1 share to settle' : `${unpaidShares} shares to settle`}
            accent="metric-green"
          />
          <MetricCard
            label="Members"
            value={currentDashboard ? String(members.length) : '—'}
            detail={members.length === 1 ? 'household member' : 'household members'}
            accent="metric-blue"
          />
          <MetricCard
            label="Bills"
            value={currentDashboard ? String(bills.length) : '—'}
            detail={bills.length === 1 ? 'tracked bill' : 'tracked bills'}
            accent="metric-violet"
          />
          <MetricCard
            label="Shares settled"
            value={currentDashboard ? `${paidShares} / ${paidShares + unpaidShares}` : '—'}
            detail={`${paidShares} paid · ${unpaidShares} unpaid`}
            accent="metric-amber"
          />
        </section>

        {homes.length > 0 && showNewHomeForm ? (
          <section className="home-create-strip" aria-label="Create a new household">
            <div>
              <strong className="home-create-title">Create a new household</strong>
              <p className="home-create-subtitle">
                Start a separate space for another shared home.
              </p>
            </div>
            <form className="inline-form home-create-form home-create-inline" onSubmit={createHome}>
              <label className="sr-only" htmlFor="new-home-name">
                Household name
              </label>
              <input
                id="new-home-name"
                name="homeName"
                placeholder="e.g. Cedar Street House"
                maxLength={100}
                required
              />
              <button className="button button-primary" type="submit" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create household'}
              </button>
            </form>
          </section>
        ) : null}

        {homeLoading ? (
          <LoadingPanel label="Loading your households…" />
        ) : homeLoadError ? null : homes.length === 0 ? (
          <section className="onboarding-card">
            <div className="onboarding-copy">
              <span className="section-icon icon-green" aria-hidden="true">
                ⌂
              </span>
              <div>
                <p className="eyebrow">GET STARTED</p>
                <h2>Create your first household</h2>
                <p>Set up a shared home, then invite members and add your first bill.</p>
              </div>
            </div>
            <form className="inline-form home-create-form" onSubmit={createHome}>
              <label className="sr-only" htmlFor="new-home-name">
                Household name
              </label>
              <input
                id="new-home-name"
                name="homeName"
                placeholder="e.g. Cedar Street House"
                maxLength={100}
                required
              />
              <button className="button button-primary" type="submit" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create household'}
              </button>
            </form>
          </section>
        ) : dashboardLoading && !currentDashboard ? (
          <LoadingPanel label="Loading household details…" />
        ) : dashboardError ? null : (
          <>
            <div className="content-grid">
              <section className="panel members-panel">
                <SectionTitle
                  eyebrow="YOUR HOUSEHOLD"
                  title="Members"
                  count={currentDashboard ? members.length : null}
                />
                {members.length === 0 ? (
                  <EmptyMessage
                    title="No members yet"
                    description="Add the people who share expenses in this household."
                  />
                ) : (
                  <ul className="member-list">
                    {members.map((member) => (
                      <li className="member-item" key={member.id}>
                        <span className="avatar">{initials(member.name)}</span>
                        <span className="member-name">{member.name}</span>
                        <span className="member-balance">
                          {formatCents(
                            balances.find((balance) => balance.memberId === member.id)
                              ?.outstandingCents ?? 0,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="stacked-form" onSubmit={addMember}>
                  <label htmlFor="new-member-name">Add a member</label>
                  <div className="inline-form">
                    <input
                      id="new-member-name"
                      name="memberName"
                      placeholder="Member name"
                      maxLength={100}
                      required
                    />
                    <button className="button button-secondary" type="submit" disabled={submitting}>
                      Add
                    </button>
                  </div>
                </form>
              </section>

              <section className="panel balances-panel">
                <SectionTitle eyebrow="AT A GLANCE" title="Member balances" />
                <p className="section-description">Unpaid shares across all household bills.</p>
                {members.length === 0 ? (
                  <EmptyMessage
                    title="Balances appear here"
                    description="Add a household member to start tracking balances."
                  />
                ) : balances.length === 0 ? (
                  <LoadingPanel label="Loading balances…" compact />
                ) : (
                  <ul className="balance-list">
                    {balances.map((balance) => (
                      <li className="balance-item" key={balance.memberId}>
                        <span className="avatar avatar-small">{initials(balance.name)}</span>
                        <span className="balance-name">{balance.name}</span>
                        <strong
                          className={balance.outstandingCents > 0 ? 'amount-due' : 'amount-clear'}
                        >
                          {formatCents(balance.outstandingCents)}
                        </strong>
                      </li>
                    ))}
                  </ul>
                )}
                {members.length > 0 && unpaidShares === 0 && currentDashboard ? (
                  <p className="settled-note">
                    <span>✓</span> Everyone is all settled up.
                  </p>
                ) : null}
              </section>
            </div>

            <section className="panel bills-panel">
              <div className="bills-heading">
                <SectionTitle eyebrow="ACTIVITY" title="Household bills" />
                <span className="bills-count">
                  {bills.length} {bills.length === 1 ? 'bill' : 'bills'}
                </span>
              </div>

              <form className="bill-create-form" onSubmit={createBill}>
                <div className="form-field bill-title-field">
                  <label htmlFor="new-bill-title">Bill name</label>
                  <input
                    id="new-bill-title"
                    name="billTitle"
                    placeholder="e.g. Electricity"
                    maxLength={100}
                    required
                  />
                </div>
                <div className="form-field amount-field">
                  <label htmlFor="new-bill-amount">Total amount</label>
                  <div className="currency-input">
                    <span>$</span>
                    <input
                      id="new-bill-amount"
                      name="billAmount"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      pattern="\d+(\.\d{1,2})?"
                      required
                    />
                  </div>
                </div>
                <button
                  className="button button-primary create-bill-button"
                  type="submit"
                  disabled={submitting || members.length === 0}
                  title={members.length === 0 ? 'Add a member before creating a bill' : undefined}
                >
                  {submitting ? 'Adding…' : 'Add bill'}
                </button>
              </form>
              {members.length === 0 ? (
                <p className="form-hint">Add at least one member before creating a bill.</p>
              ) : null}

              {dashboardLoading && !currentDashboard ? (
                <LoadingPanel label="Loading bills…" />
              ) : bills.length === 0 ? (
                <EmptyMessage
                  title="No bills yet"
                  description={
                    members.length === 0
                      ? 'Add household members, then create the first shared bill.'
                      : 'Add a bill above to split an expense across your members.'
                  }
                />
              ) : (
                <div className="bill-list">
                  {bills.map((bill) => (
                    <article className="bill-card" key={bill.id}>
                      <div className="bill-card-header">
                        <div>
                          <h3>{bill.title}</h3>
                          <p>
                            {bill.shares.length}{' '}
                            {bill.shares.length === 1 ? 'member share' : 'member shares'}
                          </p>
                        </div>
                        <div className="bill-total">
                          <span>Bill total</span>
                          <strong>{formatCents(bill.totalCents)}</strong>
                        </div>
                      </div>
                      <ul className="share-list">
                        {bill.shares.map((share) => {
                          const paid = share.paidAt !== null
                          const busy = payingShareId === share.id
                          return (
                            <li className="share-row" key={share.id}>
                              <span className={`avatar avatar-small ${paid ? 'avatar-paid' : ''}`}>
                                {initials(share.memberName || 'Member')}
                              </span>
                              <span className="share-name">{share.memberName || 'Member'}</span>
                              <strong className="share-amount">
                                {formatCents(share.amountCents)}
                              </strong>
                              <span
                                className={`status-pill ${paid ? 'status-paid' : 'status-unpaid'}`}
                              >
                                <span className="status-dot" />
                                {paid ? 'Paid' : 'Unpaid'}
                              </span>
                              {paid ? (
                                <span className="paid-date">
                                  {share.paidAt
                                    ? `Paid ${new Date(share.paidAt).toLocaleDateString()}`
                                    : ''}
                                </span>
                              ) : (
                                <button
                                  className="button button-pay"
                                  type="button"
                                  onClick={() => void payShare(bill.id, share)}
                                  disabled={payingShareId !== null}
                                >
                                  {busy ? 'Processing…' : 'Pay share'}
                                </button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </article>
                  ))}
                </div>
              )}
              {dashboardLoading && currentDashboard ? (
                <p className="refreshing-note" role="status">
                  Refreshing household data…
                </p>
              ) : null}
              {dashboardError && currentDashboard ? (
                <div className="inline-error" role="alert">
                  <span>{dashboardError}</span>
                  <button type="button" className="text-button" onClick={retryDashboard}>
                    Retry
                  </button>
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </main>
  )
}

function MetricCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string
  value: string
  detail: string
  accent: string
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${accent}`} aria-hidden="true">
        <span />
      </div>
      <p>{label}</p>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </article>
  )
}

function SectionTitle({
  eyebrow,
  title,
  count,
}: {
  eyebrow: string
  title: string
  count?: number | null
}) {
  return (
    <div className="section-title">
      <p className="eyebrow">{eyebrow}</p>
      <h2>
        {title}
        {count !== undefined && count !== null ? (
          <span className="title-count">{count}</span>
        ) : null}
      </h2>
    </div>
  )
}

function EmptyMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-message">
      <span className="empty-mark" aria-hidden="true">
        —
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )
}

function LoadingPanel({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`loading-panel ${compact ? 'loading-compact' : ''}`} role="status">
      <span className="loading-indicator" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}
