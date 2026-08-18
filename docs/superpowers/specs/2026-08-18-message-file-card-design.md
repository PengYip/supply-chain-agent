# Message File Card Design

Date: 2026-08-18
Status: Approved (design approved by user; spec pending user review)

## Problem

When a user attaches files to a conversation (via context files) and sends a
message, the sent message shows only the text. The attachment context is
invisible in history: after a page refresh or session reload, there is no
indication which files the message referred to. The user wants a file
placeholder card (icon + filename + type) rendered inside the sent user
message, matching the provided reference screenshot (a file card for
`01_合同.pdf` with a red PDF icon displayed above the message text).

## Scope Decisions (user-confirmed)

1. **Placement**: Both pre-send and post-send.
   - Pre-send: the existing context-file chip above the composer stays as-is
     (including its live parse-status badge).
   - Post-send: a static file card embedded inside the sent user message,
     persistent in history.
2. **Click behavior**: Deferred. The card is non-clickable/neutral. Online
   preview will be wired in a later feature; the data model reserves `docId`
   and `key` for that future integration.
3. **Parse status**: Static card in the sent message. The parse badge
   (解析中/已解析/失败) renders only on the pre-send composer chip, never
   inside the message.

## Approach Chosen: Custom `data-attachment` UI Part

Alternatives considered:

- **Native `file` UI part + server-side stripping**: rejected. Requires
  server changes to strip file parts before `convertToModelMessages`
  (otherwise the URL is passed to the provider). Additionally, presign URLs
  expire, so historical messages would render dead links. The UI must be
  hand-written either way, so the native type buys nothing.
- **Out-of-band attachment table keyed by messageId**: rejected. Requires new
  server schema + queries, breaks the self-contained message persistence
  model, largest change surface.

Chosen approach rationale (verified against ai@6.0.246 in this repo):

- The server persists raw client UIMessages verbatim
  (`appendMessages(sessionId, messages)` in `apps/server/src/routes/chat.ts`),
  so any UI part embedded in the user message survives history reload
  (`GET /api/sessions/:id`) with zero server changes.
- `convertToModelMessages` **silently drops `data-*` parts** (verified by
  running a node script against the installed `ai` package): the attachment
  metadata never reaches the model, leaks no URLs, costs no tokens.
- A native `file` part, by contrast, IS converted and its URL passed to the
  provider — confirming `data-*` is the correct part family.

## Design

### 1. Data structure

```ts
// apps/web/src/utils/realChatUtils.ts
export interface AttachmentData {
  filename: string; // original filename, e.g. "01_合同.pdf"
  docId: string;    // documents.id — hook for future online preview
  key: string;      // MinIO object key — hook for future presign download
  fileType: string; // extension-derived, uppercased for display: "PDF"
}

export interface AttachmentUIPart {
  type: 'data-attachment';
  id: string; // = docId, unique within the message
  data: AttachmentData;
}
```

`fileType` derives from the filename extension (pdf/docx/xlsx/png/...). The
card's type label displays the uppercased extension. Unknown/missing
extensions fall back to a generic file icon and "FILE" label.

`data-attachment` is not in the AI SDK's typed UIMessage part union; the
renderer treats unknown part types via a narrow type guard. No library
changes, no server changes.

### 2. Send path (`useSessionMessages.sendMessage`)

When `contextFiles` is non-empty at send time, the optimistic user message is
built with attachment parts prepended before the text part:

```
parts: [...contextFiles.map(toAttachmentPart), { type: 'text', text }]
```

- The optimistic append renders the card immediately.
- The 409-rollback logic is unchanged.
- `POST /api/chat` body unchanged: the message itself now carries the parts;
  the `contextFiles` metadata field continues as today (it still drives the
  server-side system prompt about parse status and recall tools — that flow
  is untouched).

### 3. Render path (`realChatUtils.buildRenderItems` + `RealMessageItem`)

- `buildRenderItems()` gains an `attachment` segment type, emitted in part
  order (attachments first, then text, since that is the construction order).
- In `RealMessageItem`, for user messages each segment renders in order:
  - `attachment` segment: static card — file-type icon + filename (ellipsis
    truncation for long names) + type label. No click handler, no parse
    badge, no close button.
  - `text` segment: existing blue bubble.
- Card position: stacked above the text bubble inside the same right-aligned
  outgoing column, ~8px vertical gap — matching the reference screenshot.
- History snapshot reload renders identically (parts round-trip verbatim).
- Legacy messages without attachment parts are unaffected.

### 4. Icon and styling

Extension-based color classes (PDF red, Word blue, Excel green, image purple,
other gray), consistent with the existing composer chip's visual language:
light-gray rounded card (~60px tall), icon ~32px, filename ~14px dark,
type label ~12px gray. Pure CSS/Tailwind, no new dependencies, no emoji in
code.

### 5. Error handling

- Attachment parts are pure display metadata; there is no runtime failure
  mode at render time. If a historical `data-attachment` part is malformed
  (missing filename), the renderer skips that part gracefully rather than
  crashing the message list.
- Send-time failure behavior is unchanged (message rollback on 409); the
  card lives and dies with its message.

## Testing

The web app has no unit-test infrastructure. Verification per repo
convention:

1. `npm run build` (tsc -b + vite build) — type safety of the new part types.
2. `npm run lint` — oxlint.
3. Manual smoke on dev server (frontend :5173):
   - Upload a file, add to conversation, send a message: card appears above
     the text bubble in the sent message.
   - Multiple files: multiple cards stack in order.
   - Refresh the page / switch sessions and back: card reproduces from
     history.
   - Message without files: unchanged rendering.
   - Confirm (via network/server log or existing behavior) that the model
     reply does not reference attachment URLs — data parts never convert.

## Out of Scope

- Click / download / online-preview on the message card (future feature;
  `docId` + `key` reserved in the data model for it).
- Parse-status badge inside the sent message.
- Changes to the pre-send composer chip UI or the server-side contextFiles
  system-prompt flow.
- Multimodal (image-to-model) support.
