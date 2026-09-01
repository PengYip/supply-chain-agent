// 全局复核弹窗的打开请求通道(发布/订阅单例)。
// 背景: ReviewModal 渲染 DocumentReviewCard,而复核卡的 container 变体又要
// 能打开子单据的复核弹窗 —— 直接相互 import 会形成循环依赖。经此通道解耦:
// App 层单例订阅并挂载 ReviewModal;文件树子单据行、复核卡拆分清单等任意
// 宿主调用 requestOpenReview(docId) 发起。弹窗已开时切换目标(由 App 层
// key 化重挂载实现)。

type ReviewRequestListener = (docId: string) => void;

let listener: ReviewRequestListener | null = null;

/** App 层订阅打开请求;返回退订函数(组件卸载时清理)。 */
export function subscribeReviewRequests(l: ReviewRequestListener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** 请求打开某文档的复核弹窗(container/unit/普通文档皆可)。 */
export function requestOpenReview(docId: string): void {
  if (!docId) return;
  listener?.(docId);
}
