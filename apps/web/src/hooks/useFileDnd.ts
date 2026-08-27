// 面板内部拖拽状态机：文件/文件夹行可拖动，落到文件夹行或根区完成移动。
// OS 外部文件拖放（上传）不经过本模块 —— 由 drop 处理处按 readPayload 结果
// 是否为 null 分流到 useFolderDropUpload。
import { useCallback, useState } from 'react';

export type DragPayload =
  | { kind: 'file'; key: string; name: string }
  | { kind: 'folder'; path: string };

export const FILE_MIME = 'application/x-sca-file';
export const FOLDER_MIME = 'application/x-sca-folder';

/** 目标容器标识：'' = 根目录，否则为文件夹完整路径。 */
export type DropTarget = string;

function writePayload(e: React.DragEvent, payload: DragPayload) {
  const mime = payload.kind === 'file' ? FILE_MIME : FOLDER_MIME;
  e.dataTransfer.setData(mime, JSON.stringify(payload));
  // 兜底 text/plain，防止目标端 custom MIME 读取被安全策略清空
  e.dataTransfer.setData('text/plain', payload.kind === 'folder' ? payload.path : payload.key);
  e.dataTransfer.effectAllowed = 'move';
}

export function readPayload(e: React.DragEvent): DragPayload | null {
  try {
    const f = e.dataTransfer.getData(FILE_MIME);
    if (f) return JSON.parse(f) as DragPayload;
    const fo = e.dataTransfer.getData(FOLDER_MIME);
    if (fo) return JSON.parse(fo) as DragPayload;
  } catch {
    // ignore malformed payloads
  }
  return null;
}

/** 文件夹不能落到自己或自己的子树里。targetPath=''（根）恒为合法。 */
export function isFolderSelfDrop(from: string, targetPath: DropTarget): boolean {
  if (!targetPath) return false;
  return targetPath === from || targetPath.startsWith(`${from}/`);
}

/** 拖拽移动的状态与事件工厂。dropTarget 用于行高亮（'' = 根区）。 */
export function useFileDnd() {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const onDragStart = useCallback((payload: DragPayload) => (e: React.DragEvent) => {
    writePayload(e, payload);
    setDragging(payload);
    setDropTarget(null);
  }, []);

  const clear = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
  }, []);

  /** 行 / 根区的 dragover 处理。仅当存在内部拖拽载荷时才劫持默认行为。
   *  注意：文件夹行调用方需先 e.stopPropagation()，否则事件冒泡到面板根区
   *  会把 dropTarget 覆写成根（''），高亮与提示条随之失真。 */
  const onDragOver = useCallback(
    (target: DropTarget) => (e: React.DragEvent) => {
      if (dragging) {
        if (
          dragging.kind === 'folder' &&
          isFolderSelfDrop(dragging.path, target)
        ) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      } else {
        // OS 文件拖入：标记为复制（上传），让外层 onDrop 能收到
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
      setDropTarget(target);
    },
    [dragging],
  );

  const onDragLeave = useCallback((target: DropTarget) => () => {
    setDropTarget((prev) => (prev === target ? null : prev));
  }, []);

  return { dragging, dropTarget, onDragStart, onDragOver, onDragLeave, clear };
}
