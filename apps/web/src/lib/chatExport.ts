import { toCanvas } from 'html-to-image'
import JSZip from 'jszip'

/** 对话导出为图片（长图 / 分页多图，经预览确认后落盘）。
 *
 *  滚动容器裁切的处理方式：不直接对 overflow-auto 的滚动容器截图（那样只
 *  能拿到视口内的可见高度），而是定位消息流列表节点本身，深克隆到离屏
 *  「导出舞台」（自带页眉 + 白底 + 两侧留白），列表克隆天然是全高内容，
 *  输入框、「回到最新」悬浮层等都在列表之外，不会进入导出结果。
 *
 *  离屏定位的关键约束（2026-08 修复空白的教训）：html-to-image 会把截图
 *  目标自身的 computed style 原样序列化进 SVG foreignObject，若目标是
 *  position:fixed + 负偏移的元素，克隆内容会画在 foreignObject 视口之外，
 *  得到尺寸正常但全白的图。因此离屏定位只由「外壳」承担，真正传给
 *  toCanvas 的舞台保持 static 文档流，并以 options.style 再兜底一次。 */

/** 分页模式单页切片高度（输出 PNG 的像素高度） */
const PAGE_SLICE_HEIGHT = 2000
/** 浏览器 canvas 单边安全上限：html-to-image 超过该值会静默等比缩放，
 *  这里主动把像素密度限制在「不触顶」的范围，保证输出尺寸可预期 */
const MAX_CANVAS_EDGE = 16384
/** 空白自检的最低「内容像素」占比（0.1%）：仅页眉一条的占比就有约 0.3%，
 *  正常对话远高于此；真空白则是 0，阈值留足余量避免误杀 */
const BLANK_CONTENT_RATIO = 0.001

export type ExportMode = 'long' | 'paged'

export interface ExportChatOptions {
  /** 会话标题（进入导出页眉与文件名） */
  title: string
  /** long = 一张完整长图；paged = 按页高切片成多张 */
  mode: ExportMode
}

/** 渲染产物：主画布由调用方持有，预览确认后再落盘/复制，用完调
 *  disposeExportCanvas 释放（画布可能上万平方米，别等 GC）。 */
export interface ChatExportResult {
  mode: ExportMode
  title: string
  /** 主画布：long 模式即成品；paged 模式按 PAGE_SLICE_HEIGHT 切片 */
  canvas: HTMLCanvasElement
  /** 实际像素密度（已乘进画布尺寸，预览尺寸展示用） */
  pixelRatio: number
  /** paged 模式总页数；long 模式恒为 1 */
  pageCount: number
}

/** 在 ChatWorkspace 包裹层内定位消息流列表。
 *  RealChatView 里有两个 .max-w-3xl（消息流 + 输入区内层），消息流的父级
 *  是 overflow-auto 滚动容器 —— 以此特征区分，不依赖 DOM 顺序。 */
function findMessageList(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.max-w-3xl'))) {
    const parent = el.parentElement
    if (parent) {
      const oy = getComputedStyle(parent).overflowY
      if (oy === 'auto' || oy === 'scroll') return el
    }
  }
  return null
}

/** 会话里是否已有消息：RealMessageItem 根节点带 animate-slide-up 类，空态欢迎卡没有。 */
function hasRenderedMessages(list: HTMLElement): boolean {
  return Array.from(list.children).some(
    (c) => c instanceof HTMLElement && c.classList.contains('animate-slide-up'),
  )
}

/** 离屏克隆里需要摘除的动画类：CSS 动画在克隆中会从头播放，截到中间帧
 *  会出现半透明/位移。除了类名，还要清内联 animation（覆盖 style 属性
 *  写动画的残留），双管齐下。 */
const ANIMATION_CLASSES = [
  'animate-slide-up',
  'animate-fade-in',
  'animate-pulse-dot',
  'animate-pulse-bar',
  'animate-drop-float',
  'animate-spin',
  'animate-pulse',
]

function stripAnimations(clone: HTMLElement): void {
  const animated = clone.querySelectorAll<HTMLElement>('.' + ANIMATION_CLASSES.join(', .'))
  for (const el of [clone, ...Array.from(animated)]) {
    for (const cls of ANIMATION_CLASSES) el.classList.remove(cls)
    el.style.animation = 'none'
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateTime(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 导出文件名主干：标题（剔除文件系统非法字符）+ 日期。 */
export function buildFileStem(title: string): string {
  const safe = (title.trim() || '对话快照')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const d = new Date()
  return `${safe || '对话快照'}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
}

/** 导出页眉（inline style 写死色值：不依赖 Tailwind JIT 是否收录动态类名，
 *  渲染结果稳定；色值取自语义 token 的亮色值）。 */
function buildExportHeader(title: string, dateLabel: string): HTMLElement {
  const header = document.createElement('div')
  header.style.cssText =
    'display: flex; align-items: center; gap: 12px; padding: 20px 24px; border-bottom: 1px solid #E2E8F0; background: #FFFFFF'

  const mark = document.createElement('div')
  mark.style.cssText =
    'width: 32px; height: 32px; border-radius: 8px; background: #0F3A5C; display: flex; align-items: center; justify-content: center; flex: none'
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'

  const textCol = document.createElement('div')
  textCol.style.cssText = 'min-width: 0; flex: 1'

  const nameRow = document.createElement('div')
  nameRow.style.cssText =
    'font-size: 15px; font-weight: 600; color: #1E293B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap'
  nameRow.textContent = title || '未命名对话'

  const subRow = document.createElement('div')
  subRow.style.cssText = 'margin-top: 3px; font-size: 12px; color: #64748B'
  subRow.textContent = `供应链贸易执行助理 · 导出于 ${dateLabel}`

  textCol.append(nameRow, subRow)
  header.append(mark, textCol)
  return header
}

/** 画布空白自检：导出主体是白底 + 深色文字/彩色气泡，正常内容必然有足量
 *  非纯白像素。按行抽样（最多约 256 行、行内每 16px 取 1 点），避免对整
 *  幅画布 getImageData 的大块读回开销。宁可报错也不产出一张空白图。 */
function assertCanvasNotBlank(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布初始化失败')
  const rowStep = Math.max(1, Math.ceil(canvas.height / 256))
  const colStep = 16
  let sampled = 0
  let content = 0
  for (let y = 0; y < canvas.height; y += rowStep) {
    const row = ctx.getImageData(0, y, canvas.width, 1).data
    for (let i = 0; i < row.length; i += 4 * colStep) {
      sampled += 1
      if (row[i + 3] < 250) {
        // 半透明像素（背景填充应为不透明，出现即视为内容痕迹）
        content += 1
      } else if (row[i] <= 245 || row[i + 1] <= 245 || row[i + 2] <= 245) {
        // 非纯白像素
        content += 1
      }
    }
  }
  if (sampled === 0 || content / sampled < BLANK_CONTENT_RATIO) {
    throw new Error('导出结果为空白，渲染未生效，请重试')
  }
}

/** 渲染当前对话并返回主画布（不落盘）。无消息/找不到内容等失败场景抛
 *  Error（调用方 toast）；空白自检同样在此抛错。 */
export async function renderChatExport(
  root: HTMLElement | null,
  options: ExportChatOptions,
): Promise<ChatExportResult> {
  const list = findMessageList(root)
  if (!list) throw new Error('未找到消息内容')
  if (!hasRenderedMessages(list)) throw new Error('当前对话暂无消息，无法导出')

  const listWidth = Math.ceil(list.getBoundingClientRect().width)
  if (listWidth <= 0) throw new Error('消息区域不可见，请稍后重试')

  // 组装导出舞台：页眉 + 消息列表克隆 + 两侧留白。舞台是 static 文档流、
  // 显式宽度 + 白底（显式宽度防止克隆宽度塌陷，白底防止透明背景）。
  const clone = list.cloneNode(true) as HTMLElement
  stripAnimations(clone)
  clone.style.margin = '0'

  const sidePad = 20
  const stageWidth = listWidth + sidePad * 2
  const contentWrap = document.createElement('div')
  contentWrap.style.cssText = `padding: 20px ${sidePad}px 36px`
  contentWrap.appendChild(clone)

  const dateLabel = formatDateTime()
  const stage = document.createElement('div')
  stage.style.cssText = `width: ${stageWidth}px; background: #FFFFFF`
  stage.append(buildExportHeader(options.title, dateLabel), contentWrap)

  // 离屏外壳独占 fixed + 负偏移：它不进入截图，定位样式不会被序列化；
  // 舞台留在文档流内，foreignObject 渲染时内容完整落在自身视口里。
  const offscreen = document.createElement('div')
  offscreen.style.cssText = 'position: fixed; left: -10000px; top: 0'
  offscreen.appendChild(stage)
  document.body.appendChild(offscreen)

  let canvas: HTMLCanvasElement
  let pixelRatio = 1
  try {
    const height = Math.ceil(stage.getBoundingClientRect().height)
    if (height <= 0) throw new Error('消息区域高度异常，请稍后重试')
    // 像素密度在 2 与「最长边不超 canvas 上限」之间取值（向下取整到百分位），
    // 超长对话自动降密度而不是被库静默缩放
    const maxEdge = Math.max(stageWidth, height)
    pixelRatio = Math.floor(Math.min(2, MAX_CANVAS_EDGE / maxEdge) * 100) / 100
    try {
      canvas = await toCanvas(stage, {
        width: stageWidth,
        height,
        pixelRatio,
        backgroundColor: '#FFFFFF',
        skipFonts: true,
        // 跨域/失效图片用 1px 透明图占位，避免整体导出失败
        imagePlaceholder:
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        // 双保险：即使将来结构变动让定位样式回到渲染根上，也在克隆根节点
        // 强制重置回文档流内（html-to-image 会在复制 computed style 之后
        // 应用 options.style，可覆盖）
        style: {
          position: 'static',
          left: 'auto',
          top: 'auto',
          right: 'auto',
          bottom: 'auto',
          margin: '0',
        },
      })
    } catch {
      throw new Error('图片渲染失败，请重试')
    }
    assertCanvasNotBlank(canvas)
  } finally {
    offscreen.remove()
  }

  const pageCount = options.mode === 'paged' ? Math.ceil(canvas.height / PAGE_SLICE_HEIGHT) : 1
  return { mode: options.mode, title: options.title, canvas, pixelRatio, pageCount }
}

/** 从主画布切出第 pageIndex 页（0 起）。供预览与 ZIP 打包共用。 */
export function sliceExportPage(canvas: HTMLCanvasElement, pageIndex: number): HTMLCanvasElement {
  const y = pageIndex * PAGE_SLICE_HEIGHT
  const sliceHeight = Math.min(PAGE_SLICE_HEIGHT, canvas.height - y)
  if (sliceHeight <= 0) throw new Error(`页码越界：第 ${pageIndex + 1} 页`)
  const slice = document.createElement('canvas')
  slice.width = canvas.width
  slice.height = sliceHeight
  const ctx = slice.getContext('2d')
  if (!ctx) throw new Error('画布初始化失败')
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, slice.width, slice.height)
  ctx.drawImage(canvas, 0, y, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
  return slice
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片编码失败'))
    }, 'image/png')
  })
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收：下载启动需要一点时间，立即回收会截断传输
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 长图：单张 PNG 落盘。 */
export async function downloadLongImage(result: ChatExportResult): Promise<void> {
  const blob = await canvasToBlob(result.canvas)
  downloadBlob(blob, `${buildFileStem(result.title)}.png`)
}

/** 分页多图：逐页切片打包为单个 ZIP 落盘。
 *  PNG 本身已是压缩格式，ZIP 采用 STORE（只归档不二次压缩）：几十页的
 *  导出也能秒级完成，体积差异可忽略。逐页编码、编码完立即释放切片画布，
 *  长对话多页导出不累积内存。 */
export async function downloadPagedZip(result: ChatExportResult): Promise<{ filename: string; pageCount: number }> {
  const zip = new JSZip()
  const stem = buildFileStem(result.title)
  for (let i = 0; i < result.pageCount; i++) {
    const slice = sliceExportPage(result.canvas, i)
    const blob = await canvasToBlob(slice)
    slice.width = 0
    slice.height = 0
    zip.file(`${stem}-第${i + 1}页.png`, blob)
  }
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
  const filename = `${stem}.zip`
  downloadBlob(archive, filename)
  return { filename, pageCount: result.pageCount }
}

/** 剪贴板写图片的能力检测：需要安全上下文（HTTPS / localhost）且浏览器
 *  提供 ClipboardItem（Firefox 的 clipboard.write 仅支持纯文本，写图片会
 *  直接失败，故双条件缺一即视为不可用）。 */
export function canCopyImageToClipboard(): boolean {
  return (
    typeof navigator.clipboard?.write === 'function' && typeof window.ClipboardItem !== 'undefined'
  )
}

/** 长图复制到剪贴板。能力不足或写入被拒（焦点丢失/权限拒绝）时抛带原因
 *  的 Error，由调用方 toast，不产出未处理异常。 */
export async function copyCanvasToClipboard(canvas: HTMLCanvasElement): Promise<void> {
  if (!canCopyImageToClipboard()) {
    throw new Error('当前环境不支持复制图片（需 HTTPS 或 localhost 环境）')
  }
  const blob = await canvasToBlob(canvas)
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`复制图片失败：${reason}`)
  }
}

/** 释放主画布（宽高置 0 立即归还画布缓冲）。预览模态关闭时调用；
 *  操作是幂等的，重复调用无副作用。 */
export function disposeExportCanvas(result: ChatExportResult): void {
  result.canvas.width = 0
  result.canvas.height = 0
}
