import { toCanvas } from 'html-to-image'

/** 对话导出为图片（长图 / 分页多图）。
 *
 *  滚动容器裁切的处理方式：不直接对 overflow-auto 的滚动容器截图（那样只
 *  能拿到视口内的可见高度），而是定位消息流列表节点本身，深克隆到离屏
 *  「导出舞台」（自带页眉 + 白底 + 两侧留白），列表克隆天然是全高内容，
 *  输入框、「回到最新」悬浮层等都在列表之外，不会进入导出结果。
 *  舞台挂到 body 上（fixed 定位移出视口），Tailwind 类与字体正常生效，
 *  html-to-image 按克隆节点的计算样式渲染成 canvas，再按需输出。 */

/** 分页模式单页切片高度（输出 PNG 的像素高度） */
const PAGE_SLICE_HEIGHT = 2000
/** 舞台高度超过该值时把 pixelRatio 从 2 降到 1，避免超长对话撑爆 canvas 面积上限 */
const TALL_CONTENT_PX = 16000
/** 多文件下载之间的间隔：连续触发容易被浏览器下载限流拦截 */
const DOWNLOAD_INTERVAL_MS = 350

export type ExportMode = 'long' | 'paged'

export interface ExportChatOptions {
  /** 会话标题（进入导出页眉与文件名） */
  title: string
  /** long = 一张完整长图；paged = 按页高切片成多张 */
  mode: ExportMode
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

/** 克隆后移除动画类：离屏克隆会让 CSS 动画从头播放，截到中间帧会出现半透明/位移。 */
function stripAnimations(clone: HTMLElement): void {
  const animated = clone.querySelectorAll(
    '.animate-slide-up, .animate-fade-in, .animate-pulse-dot, .animate-spin, .animate-pulse',
  )
  for (const el of Array.from(animated)) {
    el.classList.remove(
      'animate-slide-up',
      'animate-fade-in',
      'animate-pulse-dot',
      'animate-spin',
      'animate-pulse',
    )
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateTime(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 导出文件名主干：标题（剔除文件系统非法字符）+ 日期。 */
function buildFileStem(title: string): string {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片编码失败'))
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 延迟回收：下载启动需要一点时间，立即回收会截断传输
      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
      resolve()
    }, 'image/png')
  })
}

/** 导出当前对话为图片。返回生成的文件数；无消息内容等失败场景抛 Error（调用方 toast）。 */
export async function exportChatAsImages(
  root: HTMLElement | null,
  options: ExportChatOptions,
): Promise<number> {
  const list = findMessageList(root)
  if (!list) throw new Error('未找到消息内容')
  if (!hasRenderedMessages(list)) throw new Error('当前对话暂无消息，无法导出')

  const listWidth = Math.ceil(list.getBoundingClientRect().width)
  if (listWidth <= 0) throw new Error('消息区域不可见，请稍后重试')

  // 组装离屏导出舞台：页眉 + 消息列表克隆 + 两侧留白。
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
  stage.style.cssText = `position: fixed; left: -10000px; top: 0; width: ${stageWidth}px; background: #FFFFFF`
  stage.append(buildExportHeader(options.title, dateLabel), contentWrap)
  document.body.appendChild(stage)

  let canvas: HTMLCanvasElement | null = null
  try {
    const height = Math.ceil(stage.getBoundingClientRect().height)
    if (height <= 0) throw new Error('消息区域高度异常，请稍后重试')
    // 超长对话降低像素密度，避免超出浏览器 canvas 面积上限
    const pixelRatio = height > TALL_CONTENT_PX ? 1 : 2
    canvas = await toCanvas(stage, {
      width: stageWidth,
      height,
      pixelRatio,
      backgroundColor: '#FFFFFF',
      skipFonts: true,
      // 跨域/失效图片用 1px 透明图占位，避免整体导出失败
      imagePlaceholder:
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    })
  } catch {
    throw new Error('图片渲染失败，请重试')
  } finally {
    stage.remove()
  }
  if (!canvas) throw new Error('图片渲染失败，请重试')

  const stem = buildFileStem(options.title)
  if (options.mode === 'long') {
    await downloadCanvas(canvas, `${stem}.png`)
    return 1
  }

  // 分页多图：按页高切片，逐张下载（间隔触发，规避浏览器多文件下载限流）
  const pageCount = Math.ceil(canvas.height / PAGE_SLICE_HEIGHT)
  for (let i = 0; i < pageCount; i++) {
    const sliceHeight = Math.min(PAGE_SLICE_HEIGHT, canvas.height - i * PAGE_SLICE_HEIGHT)
    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = sliceHeight
    const ctx = slice.getContext('2d')
    if (!ctx) throw new Error('画布初始化失败')
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, slice.width, slice.height)
    ctx.drawImage(
      canvas,
      0,
      i * PAGE_SLICE_HEIGHT,
      canvas.width,
      sliceHeight,
      0,
      0,
      canvas.width,
      sliceHeight,
    )
    await downloadCanvas(slice, `${stem}-第${i + 1}页.png`)
    if (i < pageCount - 1) await sleep(DOWNLOAD_INTERVAL_MS)
  }
  return pageCount
}
