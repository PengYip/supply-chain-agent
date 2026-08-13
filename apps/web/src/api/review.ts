import type { DocumentReviewPayload } from '../components/DocumentReviewCard'

/** A single user correction against a structured field. `value` preserves the
 *  field's original type (number stays number, string stays string). */
export type ReviewCorrection = { name: string; value: string | number }

/** Request body for POST /api/documents/:docId/review. At most one of the two
 *  action flags is meaningful per call: either send `corrections` (one or more
 *  changed fields) or send `confirm: true` (accept the document as-is). */
export type ReviewRequestBody = {
  corrections?: ReviewCorrection[]
  confirm?: boolean
}

/** Success envelope. `snapshot` is the full review payload with updated
 *  reviewStatus / fields / vectorization — drop-in for the card's local state. */
export type ReviewSuccessResponse = {
  ok: true
  docId: string
  snapshot: DocumentReviewPayload
}

/** Error envelope. */
export type ReviewErrorResponse = {
  ok: false
  error: string
}

/** POST a document review action (corrections or confirm-as-is) to the backend.
 *  Cookie-authed, same-origin. Throws an Error on any non-2xx / network failure
 *  or when the response envelope is malformed — callers surface the message. */
export async function submitReview(
  docId: string,
  body: ReviewRequestBody,
): Promise<ReviewSuccessResponse> {
  let res: Response
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(docId)}/review`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as ReviewErrorResponse
      if (data && data.ok === false && typeof data.error === 'string' && data.error) {
        message = data.error
      }
    } catch {
      /* response wasn't JSON — keep the status-based message */
    }
    throw new Error(message)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const envelope = data as ReviewSuccessResponse
  if (!envelope || envelope.ok !== true || !envelope.snapshot) {
    throw new Error('响应格式异常')
  }
  return envelope
}
