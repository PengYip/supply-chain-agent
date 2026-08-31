/** 会话分享 API。
 *  后端契约（并行开发中，按契约对接）：
 *  - POST /api/sessions/:sessionId/share（需登录）→ 200 { token, path }
 *  - GET  /api/share/:token（公开，免登录）→ 200 { title, createdAt, messages }，
 *    404 表示分享不存在或已失效。
 *  分享链接 = window.location.origin + path（生产同源；本地 dev 由 vite 代理 /api）。 */

export interface ShareLinkResponse {
  token: string
  path: string
}

/** AI SDK 6 UIMessage 的宽松前端类型：分享页消费 role 与 parts 中的
 *  text / data-attachment / tool-*（解析复用 realChatUtils.buildRenderItems，
 *  与主聊天同一套映射）；step-start / reasoning 等其余 part 类型静默跳过。
 *  tool-* part 字段形状：state 为 output-available | output-error 等，
 *  input/output 即工具入参/结果（output 为对象）。 */
export interface ShareMessagePart {
  type: string
  text?: string
  state?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  errorText?: string
  data?: unknown
}

export interface ShareMessage {
  id: string
  role: string
  parts: ShareMessagePart[]
}

export interface ShareSnapshot {
  title: string
  createdAt: string
  messages: ShareMessage[]
}

/** 为会话创建分享链接。Cookie 认证、同源。失败抛 Error（优先透出服务端 message）。 */
export async function createSessionShare(sessionId: string): Promise<ShareLinkResponse> {
  let res: Response
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { error?: string }
      if (typeof data.error === 'string' && data.error) message = data.error
    } catch {
      /* 非 JSON 响应，保留状态码文案 */
    }
    throw new Error(message)
  }
  let data: ShareLinkResponse
  try {
    data = (await res.json()) as ShareLinkResponse
  } catch {
    throw new Error('响应格式异常')
  }
  if (typeof data.token !== 'string' || typeof data.path !== 'string') {
    throw new Error('响应格式异常')
  }
  return data
}

/** 按 token 拉取分享快照（免登录读取）。返回 null 表示 404（不存在或已失效）；
 *  其余网络/服务端错误抛 Error，由分享页给出重试入口。 */
export async function fetchSessionShare(token: string): Promise<ShareSnapshot | null> {
  let res: Response
  try {
    res = await fetch(`/api/share/${encodeURIComponent(token)}`)
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`加载失败（${res.status}）`)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const snap = data as Partial<ShareSnapshot>
  if (
    typeof snap.title !== 'string' ||
    typeof snap.createdAt !== 'string' ||
    !Array.isArray(snap.messages)
  ) {
    throw new Error('响应格式异常')
  }
  return snap as ShareSnapshot
}
