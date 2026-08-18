# Message File Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a static file placeholder card (icon + filename + type) inside sent user messages when context files accompany the message, persistent across history reloads.

**Architecture:** Attachments are embedded in the user UIMessage as custom `data-attachment` parts at send time. The server already persists raw UIMessages verbatim, and `convertToModelMessages` (ai@6.0.246, verified in this repo) silently drops `data-*` parts, so zero server changes are needed. The web renderer gains an `attachment` segment kind and a `FileAttachmentCard` component.

**Tech Stack:** React 19 + TypeScript + Tailwind (apps/web workspace); Vercel AI SDK 6 `UIMessage` part shape; lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-08-18-message-file-card-design.md`

## Global Constraints

- No emoji anywhere in code (repo-wide convention).
- AI SDK 6 only — do not import from `@ai-sdk/react` (unused in this codebase; streaming is custom via `useSessionMessages`).
- No new npm dependencies.
- No server-side changes (`apps/server` is untouched by this feature).
- Web workspace has no unit-test infrastructure — verification per task is `npm run build` (tsc -b) + `npm run lint`; full manual smoke in Task 4.
- Required order before claiming done: **build → lint → test** (`npm test` runs server vitest; server is untouched, run it once at the end to confirm green).
- Repo colors are a custom Tailwind palette (`bgGray`, `textDark`, `textGray`, `borderGray`, `steelBlue`, `deepSea`, `danger`, `success`, `amber`) — use these tokens, not raw Tailwind colors.

---

### Task 1: Attachment part types, builder, and render-segment support

**Files:**
- Modify: `apps/web/src/utils/realChatUtils.ts` (whole file is 126 lines; changes at top for types, in `buildRenderItems` for part handling and the user-message filter)

**Interfaces:**
- Consumes: `ContextFile` (type-only) from `apps/web/src/hooks/useFiles.ts` — `{ docId: string; filename: string; key: string }`
- Produces (used by Tasks 2 and 3):
  - `export interface AttachmentData { filename: string; docId: string; key: string; fileType: string }`
  - `export interface AttachmentUIPart { type: 'data-attachment'; id: string; data: AttachmentData }`
  - `export const toAttachmentPart = (file: ContextFile): AttachmentUIPart`
  - `Segment` union gains `{ kind: 'attachment'; attachment: AttachmentData }`

- [ ] **Step 1: Add type imports and attachment types after the `ToolCallStep` interface**

Add at line 1 (new import, before `ToolCallStep`):

```ts
import type { ContextFile } from '../hooks/useFiles'
```

Add after the `ToolCallStep` interface (after line 12):

```ts
/** Display-only attachment metadata embedded in user messages as a custom
 *  `data-attachment` UI part. convertToModelMessages (AI SDK 6) silently
 *  drops `data-*` parts, so this never reaches the model — it exists purely
 *  for rendering and history persistence. docId/key are reserved hooks for
 *  the future online-preview feature. */
export interface AttachmentData {
  filename: string
  docId: string
  key: string
  fileType: string // uppercased extension, e.g. "PDF"; "FILE" when unknown
}

export interface AttachmentUIPart {
  type: 'data-attachment'
  id: string // = docId, unique within the message
  data: AttachmentData
}

/** Derive the display type label from the filename extension. */
const deriveFileType = (filename: string): string => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename.trim())
  return m ? m[1].toUpperCase() : 'FILE'
}

/** Build the `data-attachment` part for a context file at send time. */
export const toAttachmentPart = (file: ContextFile): AttachmentUIPart => ({
  type: 'data-attachment',
  id: file.docId,
  data: {
    filename: file.filename,
    docId: file.docId,
    key: file.key,
    fileType: deriveFileType(file.filename),
  },
})
```

- [ ] **Step 2: Extend the `Segment` union**

In the `Segment` type (currently lines 16-25), add the attachment variant as the first member:

```ts
export type Segment =
  | { kind: 'attachment'; attachment: AttachmentData }
  | { kind: 'text'; text: string }
  | { kind: 'tool-group'; steps: ToolCallStep[] }
  | {
      kind: 'approval-request'
      approvalId: string
      toolCallId: string
      toolName: string
      args: unknown
    }
```

- [ ] **Step 3: Handle `data-attachment` parts in `buildRenderItems`**

In `buildRenderItems`, extend the local parts cast (currently lines 46-55) by adding `data?: unknown` to the cast type:

```ts
    const parts = (msg.parts || []) as Array<{
      type: string
      text?: string
      toolCallId?: string
      toolName?: string
      input?: unknown
      output?: unknown
      state?: string
      approval?: { id: string }
      data?: unknown
    }>
```

Then inside the `for (const p of parts)` loop, add this branch right after the text-part branch (after line 70's `continue`), before the approval-requested branch:

```ts
      // 用户消息内嵌的文件卡片：data-attachment part（convertToModelMessages
      // 会静默丢弃 data-* parts，纯展示用途）。畸形数据跳过，不崩消息列表。
      if (p.type === 'data-attachment') {
        const d = p.data
        if (d !== null && typeof d === 'object') {
          const a = d as Record<string, unknown>
          if (typeof a.filename === 'string' && a.filename.length > 0) {
            flushText()
            segments.push({
              kind: 'attachment',
              attachment: {
                filename: a.filename,
                docId: typeof a.docId === 'string' ? a.docId : '',
                key: typeof a.key === 'string' ? a.key : '',
                fileType: typeof a.fileType === 'string' && a.fileType.length > 0 ? a.fileType : 'FILE',
              },
            })
          }
        }
        continue
      }
```

- [ ] **Step 4: Stop filtering attachment segments out of user messages**

Replace the user-message branch (currently lines 120-123):

```ts
    } else if (segments.length > 0) {
      // 用户消息只保留文本段（v6 下用户输入为 text part）
      items.push({ id, role, segments: segments.filter((s) => s.kind === 'text') })
    }
```

with:

```ts
    } else if (segments.length > 0) {
      // 用户消息保留文本段与附件卡片段（data-attachment parts）
      items.push({ id, role, segments: segments.filter((s) => s.kind === 'text' || s.kind === 'attachment') })
    }
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run build`
Expected: exits 0 (tsc -b for web passes; server tsc untouched).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/utils/realChatUtils.ts
git commit -m "feat(web): attachment data-attachment part types and render segments"
```

---

### Task 2: Embed attachment parts in the sent user message

**Files:**
- Modify: `apps/web/src/hooks/useSessionMessages.ts` (imports at top; user message construction at lines 212-217)

**Interfaces:**
- Consumes: `toAttachmentPart(file: ContextFile): AttachmentUIPart` from `../utils/realChatUtils` (Task 1)
- Produces: user messages whose `parts` array is `[...attachmentParts, { type: 'text', text }]`. Downstream consumers: `POST /api/chat` body (unchanged shape — server persists raw UIMessages verbatim) and `buildRenderItems` (Task 1).

- [ ] **Step 1: Import the builder**

Add after the existing `import type { ContextFile } from './useFiles'` (line 3):

```ts
import { toAttachmentPart } from '../utils/realChatUtils'
```

- [ ] **Step 2: Prepend attachment parts to the user message**

Replace the user message construction (currently lines 212-217):

```ts
      const userMsg = {
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt: new Date().toISOString(),
      } as unknown as UIMessage
```

with:

```ts
      // 附件以 data-attachment parts 内嵌：服务端原样持久化 UIMessage，
      // convertToModelMessages 静默丢弃 data-*，历史刷新后卡片可复现。
      const attachmentParts = (sendOpts?.contextFiles ?? []).map(toAttachmentPart)
      const userMsg = {
        id: generateId(),
        role: 'user',
        parts: [...attachmentParts, { type: 'text', text }],
        createdAt: new Date().toISOString(),
      } as unknown as UIMessage
```

The rest of `sendMessage` (optimistic append, 409 rollback, `contextFiles` metadata in the POST body) is unchanged.

- [ ] **Step 3: Typecheck and build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useSessionMessages.ts
git commit -m "feat(web): embed data-attachment parts in sent user messages"
```

---

### Task 3: FileAttachmentCard component and message rendering

**Files:**
- Create: `apps/web/src/components/FileAttachmentCard.tsx`
- Modify: `apps/web/src/components/RealMessageItem.tsx` (imports at lines 1-20; `RealMessageItem` component at lines 344-460)

**Interfaces:**
- Consumes: `AttachmentData` and `Segment` (attachment variant) from `../utils/realChatUtils` (Task 1)
- Produces: `FileAttachmentCard` React component, `{ attachment: AttachmentData }` props — static display card, no click handlers.

- [ ] **Step 1: Create `FileAttachmentCard.tsx`**

```tsx
import React from 'react'
import clsx from 'clsx'
import { FileText, FileSpreadsheet, FileImage, File as FileIcon } from 'lucide-react'
import type { AttachmentData } from '../utils/realChatUtils'

/** Static file placeholder card rendered inside sent user messages.
 *  Pure display (icon + filename + type label): no click, no parse badge.
 *  Online-preview wiring is a future feature (docId/key already persisted). */

type IconMeta = { icon: React.FC<{ className?: string }>; classes: string }

const EXT_META: Record<string, IconMeta> = {
  pdf: { icon: FileText, classes: 'bg-danger/10 text-danger' },
  doc: { icon: FileText, classes: 'bg-steelBlue/10 text-steelBlue' },
  docx: { icon: FileText, classes: 'bg-steelBlue/10 text-steelBlue' },
  xls: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  xlsx: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  csv: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  png: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  jpg: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  jpeg: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  gif: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  webp: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
}

const DEFAULT_META: IconMeta = { icon: FileIcon, classes: 'bg-bgGray text-textGray' }

const metaFor = (fileType: string): IconMeta => {
  const key = fileType.toLowerCase()
  return EXT_META[key] ?? DEFAULT_META
}

export const FileAttachmentCard: React.FC<{ attachment: AttachmentData }> = ({ attachment }) => {
  const meta = metaFor(attachment.fileType)
  const Icon = meta.icon
  return (
    <div className="flex items-center gap-3 w-56 rounded-lg bg-bgGray border border-borderGray/60 px-3 py-2.5 select-none">
      <div className={clsx('w-8 h-8 rounded flex items-center justify-center shrink-0', meta.classes)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-textDark truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-xs text-textGray">{attachment.fileType}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Restructure `RealMessageItem` to render cards above the user bubble**

In `RealMessageItem.tsx`:

2a. Extend imports — change line 18 to also import `Segment`:

```ts
import { type RenderItem, type Segment, type ToolCallStep } from '../utils/realChatUtils'
```

and add after it:

```ts
import { FileAttachmentCard } from './FileAttachmentCard'
```

2b. Inside the `RealMessageItem` component body, after the `fullText` computation (after line 357) and replacing the `lastTextSegmentIdx` block (lines 358-365), add:

```ts
  type AttachmentSegment = Extract<Segment, { kind: 'attachment' }>
  const attachmentSegments = item.segments.filter(
    (s): s is AttachmentSegment => s.kind === 'attachment',
  )
  // 用户消息含附件时：卡片堆叠在气泡上方（同一右对齐列），与参考截图一致。
  const wrapped = isUser && attachmentSegments.length > 0
  const contentSegments = wrapped
    ? item.segments.filter((s) => s.kind !== 'attachment')
    : item.segments

  // 找最后一个文本段的位置：流式光标只挂在末尾文本段上（避免中间文本段也出光标）
  const renderSegments = (segs: Segment[]) => {
    let lastTextSegmentIdx = -1
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].kind === 'text') {
        lastTextSegmentIdx = i
        break
      }
    }
    return segs.map((seg, idx) => {
      if (seg.kind === 'text') {
        const isLastText = idx === lastTextSegmentIdx
        return (
          <div key={`t-${idx}`} className="text-textDark">
            <MarkdownContent>{seg.text}</MarkdownContent>
            {isStreaming && !isUser && isLastText && (
              <span className="inline-flex ml-1 gap-0.5 align-middle">
                <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '200ms' }} />
                <span className="w-1 h-1 rounded-full bg-textGray animate-pulse-dot" style={{ animationDelay: '400ms' }} />
              </span>
            )}
          </div>
        )
      }

      if (seg.kind === 'approval-request') {
        return (
          <SoftGateCard
            key={`a-${seg.approvalId}`}
            approvalId={seg.approvalId}
            toolName={seg.toolName}
            args={seg.args}
            onApprove={onApprove || (() => {})}
            onDeny={onDeny || (() => {})}
          />
        )
      }

      if (seg.kind === 'attachment') {
        return <FileAttachmentCard key={`att-${seg.attachment.docId}-${idx}`} attachment={seg.attachment} />
      }

      // tool-group：连续工具调用归一组，保持时间顺序（夹在前后文本段之间）
      return (
        <div key={`g-${idx}`} className="rounded-lg border border-borderGray bg-bgGray/50 overflow-hidden mt-2">
          <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-steelBlue" />
            <span className="text-xs font-medium text-textDark">工具调用</span>
          </div>
          <div className="px-3 divide-y divide-borderGray/50">
            {seg.steps.map((step) => (
              <RealToolStep key={step.toolCallId} step={step} />
            ))}
          </div>
        </div>
      )
    })
  }
```

2c. Replace the bubble JSX (currently lines 377-429, the outer bubble `<div>` through the closing `</div>` of the `space-y-2` container) with:

```tsx
      {wrapped ? (
        <div className="flex flex-col items-end gap-2 max-w-[85%] min-w-0">
          {attachmentSegments.map((seg, idx) => (
            <FileAttachmentCard key={`att-${seg.attachment.docId}-${idx}`} attachment={seg.attachment} />
          ))}
          <div
            className={clsx(
              'group rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
              isUser ? 'bg-steelBlue text-white rounded-tr-sm' : 'bg-white border border-borderGray text-textDark rounded-tl-sm',
            )}
          >
            <div className="space-y-2">{renderSegments(contentSegments)}</div>
          </div>
        </div>
      ) : (
        <div
          className={clsx(
            'group max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
            isUser ? 'bg-steelBlue text-white rounded-tr-sm' : 'bg-white border border-borderGray text-textDark rounded-tl-sm',
          )}
        >
          <div className="space-y-2">{renderSegments(item.segments)}</div>
        </div>
      )}
```

Keep the copy-to-clipboard block that follows (lines 430-456) INSIDE the assistant bubble path — since the copy button currently lives inside the bubble div after the `space-y-2` container, move it inside the non-wrapped bubble div (assistant messages never have `wrapped === true`, so behavior is unchanged):

```tsx
        <div
          className={clsx(
            'group max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm',
            isUser ? 'bg-steelBlue text-white rounded-tr-sm' : 'bg-white border border-borderGray text-textDark rounded-tl-sm',
          )}
        >
          <div className="space-y-2">{renderSegments(item.segments)}</div>
          {/* Copy-to-clipboard affordance (assistant messages with text only).
              Hover-revealed via the `group` on the bubble; force-visible for the
              1.5s confirmation window after a click. */}
          {!isUser && fullText && (
            <div className="flex justify-end mt-1.5 -mb-1">
              <button
                type="button"
                onClick={async () => {
                  await copyMessageText(fullText)
                  setCopiedId(item.id)
                  setTimeout(
                    () => setCopiedId((cur) => (cur === item.id ? null : cur)),
                    1500,
                  )
                }}
                title="复制"
                className={clsx(
                  'transition text-[11px] text-textGray hover:text-textDark',
                  copiedId === item.id
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {copiedId === item.id ? '已复制' : '复制'}
              </button>
            </div>
          )}
        </div>
```

(The wrapped branch's bubble stays without the copy button — user messages never render it.)

- [ ] **Step 3: Typecheck, build, and lint**

Run: `npm run build && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/FileAttachmentCard.tsx apps/web/src/components/RealMessageItem.tsx
git commit -m "feat(web): render file attachment cards in user messages"
```

---

### Task 4: Full verification and smoke test

**Files:**
- No code changes expected. Verification only.

**Interfaces:**
- Consumes: the complete feature (Tasks 1-3).

- [ ] **Step 1: Full repo gate (build → lint → test)**

Run: `npm run build && npm run lint && npm test`
Expected: all exit 0. Server tests are untouched by this feature (web-only change) but must stay green.

- [ ] **Step 2: Manual smoke on dev server**

If a frontend dev server is already running on :5173, reuse it — do NOT start a second one. Otherwise run `npm run dev:all` (backend :3001 + frontend :5173), log in, open a session.

Checklist (expected result after each):

1. Upload a PDF via the paperclip button, add it to the conversation (添加到对话), type a message, send: a gray file card (red PDF icon, filename, `PDF` label) renders ABOVE the blue text bubble in the sent message.
2. Add two files of different types (e.g. PDF + XLSX), send: two cards stack vertically above the bubble, in context-file order, with correct icons (red / green).
3. Send a message with a filename of unusual extension (e.g. `.zip`): card renders with the generic gray file icon and `ZIP` label.
4. Refresh the page (F5) with the same session open: the cards re-render identically from history.
5. Switch to another session and back: cards still render.
6. Send a message WITHOUT files: rendering identical to before (blue bubble only, no card).
7. Long filename: truncated with ellipsis, full name visible on hover (`title` attribute).
8. Assistant reply does not mention attachment URLs (data parts never reach the model — verify the reply discusses content, not links).

- [ ] **Step 3: Push**

Run: `git push origin main`
Expected: push succeeds; CI (install → build → lint → test) green; CD deploys.

---

## Self-Review Notes

- Spec coverage: data structure (Task 1), send path (Task 2), render path + card placement above bubble (Task 3), icon/styling (Task 3 Step 1), error handling — malformed part skip (Task 1 Step 3) + no-runtime-failure rationale (no card state), testing (Tasks 1-3 build gates + Task 4 smoke). Out-of-scope items (click/preview, parse badge in message, server changes) have no tasks, correctly.
- Type consistency: `AttachmentData` fields (`filename`, `docId`, `key`, `fileType`) identical across Tasks 1 and 3; `toAttachmentPart` name/signature identical in Tasks 1-2; Segment attachment variant `{ kind: 'attachment'; attachment: AttachmentData }` used consistently in Tasks 1 and 3.
- No placeholders: every code step shows complete code.
