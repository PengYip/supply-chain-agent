// 页面级 OS 文件拖拽感知：文件从操作系统拖入窗口任意位置时暴露
// dragActive（驱动全屏提示遮罩），松手在无人认领的区域时回调
// onDropFiles 接管上传。仅认领 dataTransfer.types 含 'Files' 的拖拽 ——
// 文件树内部排序/移动用自定义 MIME（无 'Files'），不会误触发遮罩。
import { useEffect, useRef, useState } from 'react';

/** 类型守卫：非空且携带 OS 文件（同时收窄掉 null）。 */
function carriesOsFiles(dt: DataTransfer | null): dt is DataTransfer {
  return !!dt && Array.from(dt.types).includes('Files');
}

export function usePageFileDrop(opts: { onDropFiles: (dt: DataTransfer) => void }) {
  const [dragActive, setDragActive] = useState(false);
  // dragenter/dragleave 在子元素间移动时成对触发，用计数器区分「窗口内
  // 移动」与「真正离开窗口」；drop / 取消时归零。
  const depthRef = useRef(0);
  // 回调走 ref：上传队列的 enqueue 身份随渲染变化，但不应重复订阅事件。
  const onDropFilesRef = useRef(opts.onDropFiles);
  useEffect(() => {
    onDropFilesRef.current = opts.onDropFiles;
  });

  useEffect(() => {
    const reset = () => {
      depthRef.current = 0;
      setDragActive(false);
    };

    const handleDragEnter = (e: DragEvent) => {
      if (!carriesOsFiles(e.dataTransfer)) return;
      depthRef.current += 1;
      setDragActive(true);
    };

    const handleDragOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!carriesOsFiles(dt)) return;
      // preventDefault 后 drop 才能在任意位置触发；copy 语义给光标加加号。
      e.preventDefault();
      dt.dropEffect = 'copy';
      // 兜底：dragenter 意外丢失时由高频 dragover 重新武装遮罩。
      if (depthRef.current === 0) {
        depthRef.current = 1;
        setDragActive(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      if (!carriesOsFiles(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragActive(false);
    };

    const handleDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!carriesOsFiles(dt)) return;
      reset();
      // 文件抽屉/文件夹行等既有 drop 处理器已 preventDefault（或已阻止
      // 冒泡到 window），这里只接管「无人认领」的落点，避免双重上传。
      if (e.defaultPrevented) return;
      e.preventDefault();
      onDropFilesRef.current(dt);
    };

    // 遮罩归零兜底（2026-09-02 修复「拖到文件夹松手后遮罩不消失」）:
    // 文件夹行/子级容器的 drop 处理器会 stopPropagation —— React 合成事件的
    // stopPropagation 会在 React 根容器委托处截停原生事件, 冒泡到 window 的
    // drop 永远不触发, depthRef 遗留 >0、遮罩卡死。捕获阶段监听先于任何
    // 目标处理器执行、不依赖事件能否冒泡: 任何携带 OS 文件的落点都先归零
    // 遮罩; 后续冒泡 handler 的「无人认领才上传」语义不变(归零幂等)。
    const handleDropCapture = (e: DragEvent) => {
      if (!carriesOsFiles(e.dataTransfer)) return;
      reset();
    };

    // 拖拽被 Esc 取消等边缘场景兜底归零（dragend 不冒泡，走捕获监听）。
    const handleDragEnd = () => reset();

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('drop', handleDropCapture, true);
    window.addEventListener('dragend', handleDragEnd, true);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('drop', handleDropCapture, true);
      window.removeEventListener('dragend', handleDragEnd, true);
    };
  }, []);

  return { dragActive };
}
