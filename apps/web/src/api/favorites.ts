// /api/favorites client (对话收藏). Thin typed wrappers over fetch; all
// calls are same-origin with cookies (auth via Better Auth session).

export type FavoriteStatus = 'idle' | 'busy' | 'interrupted'

/** One row of GET /api/favorites (own scope) — userId/userEmail only present
 *  meaningfully in admin scope=all rows but always returned by the API. */
export interface SessionFavoriteEntry {
  sessionId: string
  userId: string
  userEmail: string | null
  title: string | null
  status: FavoriteStatus
  note: string | null
  createdAt: string
  updatedAt: string
}

/** GET /api/favorites/:sessionId response. */
export interface FavoriteProbe {
  sessionId: string
  favorited: boolean
  note: string | null
  updatedAt: string | null
}

export async function listFavorites(scopeAll = false): Promise<SessionFavoriteEntry[]> {
  const res = await fetch(`/api/favorites${scopeAll ? '?scope=all' : ''}`, { credentials: 'include' })
  if (!res.ok) throw new Error(`list favorites failed (${res.status})`)
  const data = (await res.json()) as { favorites: SessionFavoriteEntry[] }
  return data.favorites ?? []
}

export async function getFavorite(sessionId: string): Promise<FavoriteProbe | null> {
  try {
    const res = await fetch(`/api/favorites/${sessionId}`, { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as FavoriteProbe
  } catch {
    return null
  }
}

/** Favorite (upsert) a session with an optional feedback note. Empty note
 *  normalizes to null server-side. Throws on failure (caller surfaces). */
export async function setFavorite(sessionId: string, note?: string | null): Promise<void> {
  const res = await fetch(`/api/favorites/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ note: note ?? null }),
  })
  if (!res.ok) throw new Error(`favorite failed (${res.status})`)
}

export async function clearFavorite(sessionId: string): Promise<void> {
  const res = await fetch(`/api/favorites/${sessionId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`unfavorite failed (${res.status})`)
}
