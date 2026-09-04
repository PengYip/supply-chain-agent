// 全局复核弹窗的打开请求通道(发布/订阅单例)。
// 背景: ReviewModal 渲染 DocumentReviewCard,而复核卡的 container 变体又要
// 能打开子单据的复核弹窗 —— 直接相互 import 会形成循环依赖。经此通道解耦:
// App 层单例订阅并挂载 ReviewModal;文件树子单据行、复核卡拆分清单等任意
// 宿主调用 requestOpenReview(docId, queue?) 发起。弹窗已开时切换目标(由 App 层
// key 化重挂载实现)。

/** 复核队列项。结构选择 {docId, reviewStatus?} 而非裸 docId 数组: 队列需要
 *  在确认/更正后回写单项状态(onUpdated 的 snapshot.reviewStatus),驱动
 *  「自动前进时跳过已复核」与完成提示的实时口径;裸字符串数组每次回写都
 *  要在外部重建映射。reviewStatus 缺省/null 按 pending 对待(与
 *  BatchUnitSummary.reviewStatus 旧响应的兜底口径一致,安全侧)。 */
export interface ReviewQueueItem {
  docId: string
  reviewStatus?: 'pending' | 'confirmed' | 'corrected' | null
}

type ReviewRequestListener = (docId: string, queue: ReviewQueueItem[] | null) => void;

let listener: ReviewRequestListener | null = null;

/** App 层订阅打开请求;返回退订函数(组件卸载时清理)。 */
export function subscribeReviewRequests(l: ReviewRequestListener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** 请求打开某文档的复核弹窗(container/unit/普通文档皆可)。
 *  queue 携带同组完整队列时,弹窗进入翻页模式(上一份/下一份 + 确认后自动
 *  前进到下一个待复核);缺省 = 单文档模式,行为与队列化之前完全一致。 */
export function requestOpenReview(docId: string, queue?: ReviewQueueItem[]): void {
  if (!docId) return;
  listener?.(docId, queue && queue.length > 0 ? queue : null);
}

/** 从 container 子单据清单构造复核队列: 只收已生成的 docId,保留清单原序
 *  (= 用户在清单/文件树里看到的顺序,「下一份」与视觉顺序一致)。 */
export function buildReviewQueueFromUnits(
  units: ReadonlyArray<{ docId: string | null; reviewStatus?: 'pending' | 'confirmed' | 'corrected' | null }>,
): ReviewQueueItem[] {
  const out: ReviewQueueItem[] = [];
  for (const u of units) {
    if (typeof u.docId === 'string' && u.docId) {
      out.push({ docId: u.docId, reviewStatus: u.reviewStatus ?? null });
    }
  }
  return out;
}

// -- 批量拆分修正成功后的容器刷新通道 --
// 重拆/单 unit 重抽/合并会改变单据组的子单据清单: 修正入口调用
// requestRefreshContainers(), App 层订阅后递增文件抽屉的刷新令牌,
// 重拉已展开单据组的子单据(复核卡自身会就地重拉,不依赖本通道)。

type ContainerRefreshListener = () => void;

let refreshListener: ContainerRefreshListener | null = null;

/** App 层订阅容器刷新请求;返回退订函数(组件卸载时清理)。 */
export function subscribeContainerRefreshes(l: ContainerRefreshListener): () => void {
  refreshListener = l;
  return () => {
    if (refreshListener === l) refreshListener = null;
  };
}

/** 通知「单据组子单据清单可能已变化」(重拆/重抽/合并成功后调用)。 */
export function requestRefreshContainers(): void {
  refreshListener?.();
}
