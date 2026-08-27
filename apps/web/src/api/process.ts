/** Terminal parse outcome reported by POST /api/documents/:docId/process. */
export type DocumentParseStatus = 'parsed' | 'needs_ocr' | 'failed'

/** Client-side lifecycle for a doc referenced in a conversation: 'parsing'
 *  while the in-flight process call runs (set locally at click time), then the
 *  terminal outcome returned by the endpoint. */
export type DocParseState = 'parsing' | DocumentParseStatus

/** Request body for POST /api/documents/:docId/process. All fields optional —
 *  an empty body lets the backend classify on its own. force=true 让服务端放行
 *  终态 parsed 的短路重新跑解析(仅 parsed 可被放行, needs_ocr 不受影响)。 */
export type ProcessRequestBody = {
  docType?: string
  modality?: string
  force?: boolean
}

/** Success envelope (200). */
export type ProcessSuccessResponse = {
  ok: true
  docId: string
  parseStatus: DocumentParseStatus
  blockCount?: number
  classifiedDocType?: string
}

/** Error envelope (404 etc.). */
export type ProcessErrorResponse = {
  ok: false
  error: string
}

/** POST a background parse for one document. Cookie-authed, same-origin.
 *  Throws an Error on any non-2xx / network failure or when the response
 *  envelope is malformed — callers surface the message. */
export async function processDocument(
  docId: string,
  body?: ProcessRequestBody,
): Promise<ProcessSuccessResponse> {
  let res: Response
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(docId)}/process`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as ProcessErrorResponse
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
  const envelope = data as ProcessSuccessResponse
  if (
    !envelope ||
    envelope.ok !== true ||
    (envelope.parseStatus !== 'parsed' && envelope.parseStatus !== 'needs_ocr' && envelope.parseStatus !== 'failed')
  ) {
    throw new Error('响应格式异常')
  }
  return envelope
}
