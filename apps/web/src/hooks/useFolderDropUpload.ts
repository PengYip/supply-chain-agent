// 拖放到文件面板的批量上传队列：支持 OS 多选文件与整个文件夹（保留层级）。
// 层级来源优先级：DataTransferItem.webkitGetAsEntry 递归枚举 >
// File.webkitRelativePath > 平铺到目标目录。串行上传以避免并发落盘互踩。
import { useCallback, useMemo, useRef, useState } from 'react';
import { uploadWithProgress, type UploadProgressInfo } from '../api/uploadWithProgress';

export interface DroppedItem {
  file: File;
  /** 相对目录（不含根名），'' = 平铺。 */
  relativeDir: string;
}

// -- FileSystemEntry 最小形状（TS DOM lib 未覆盖 readEntries 分批语义） --
type FSEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader: () => {
    readEntries: (cb: (entries: FSEntry[]) => void, err?: (e: unknown) => void) => void;
  };
};

function getAsEntry(item: DataTransferItem): FSEntry | null {
  const fn = (item as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
  if (typeof fn !== 'function') return null;
  try {
    return (fn.call(item) as FSEntry | null) ?? null;
  } catch {
    return null;
  }
}

async function readAllEntries(dir: FSEntry): Promise<FSEntry[]> {
  const reader = dir.createReader();
  const out: FSEntry[] = [];
  // readEntries 每次最多返回 100 条，必须循环读到空数组为止。
  for (;;) {
    const batch = await new Promise<FSEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

async function walkEntry(entry: FSEntry, parentDir: string, out: DroppedItem[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativeDir: parentDir });
  } else if (entry.isDirectory) {
    const nextDir = parentDir ? `${parentDir}/${entry.name}` : entry.name;
    for (const child of await readAllEntries(entry)) {
      await walkEntry(child, nextDir, out);
    }
  }
}

/** 收集一次 drop 的全部条目（展开文件夹为平铺清单 + 相对目录）。 */
export async function collectDropItems(dt: DataTransfer): Promise<DroppedItem[]> {
  const out: DroppedItem[] = [];
  const entries: FSEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const entry = getAsEntry(item);
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) {
    for (const e of entries) await walkEntry(e, '', out);
    return out;
  }
  // 降级：只有 files 可用（如部分浏览器对目录拖放不给 entry）
  for (const f of Array.from(dt.files ?? [])) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const idx = rel.lastIndexOf('/');
    out.push({ file: f, relativeDir: idx > 0 ? rel.slice(0, idx) : '' });
  }
  return out;
}

export interface UploadItem {
  id: number;
  name: string;
  dir: string;
  percent: number;
  loaded: number;
  total: number;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
}

export interface UploadAggregate {
  total: number;
  done: number;
  failed: number;
  bytesLoaded: number;
  bytesTotal: number;
}

/**
 * 队列 hook。ensureDirs 用于把层级里的缺失虚拟目录补齐（调用方持有
 * useFiles 的 createFolder），onDone 在整批结束后回调并携带成功/失败数。
 */
export function useFolderDropUpload(opts: {
  ensureDirs: (dirs: string[]) => Promise<void>;
  onDone: (okCount: number, failCount: number) => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const counter = useRef(0);

  const active = uploads.some((u) => u.status === 'uploading');

  const patch = useCallback((id: number, p: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...p } : u)));
  }, []);

  const enqueue = useCallback(
    async (items: DroppedItem[], targetDir: string) => {
      // 1. 目标路径下需要存在的完整祖先链，去重后一次性补齐。
      const dirs = new Set<string>();
      for (const it of items) {
        const full = it.relativeDir
          ? targetDir
            ? `${targetDir}/${it.relativeDir}`
            : it.relativeDir
          : targetDir;
        let cur = '';
        for (const seg of full.split('/').filter(Boolean)) {
          cur = cur ? `${cur}/${seg}` : seg;
          dirs.add(cur);
        }
      }
      if (dirs.size > 0) await opts.ensureDirs(Array.from(dirs));

      // 2. 登记队列行，随后逐个串行上传（进度实时回写对应行）。
      const staged: UploadItem[] = items.map((it) => ({
        id: ++counter.current,
        name: it.file.name,
        dir: targetDir,
        percent: 0,
        loaded: 0,
        total: it.file.size,
        status: 'uploading' as const,
      }));
      setUploads((prev) => [...prev, ...staged]);

      let ok = 0;
      let fail = 0;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const row = staged[i]!;
        const fullDir = item.relativeDir
          ? targetDir
            ? `${targetDir}/${item.relativeDir}`
            : item.relativeDir
          : targetDir;
        try {
          await uploadWithProgress(item.file, fullDir, (p: UploadProgressInfo) =>
            patch(row.id, { percent: p.percent, loaded: p.loaded }),
          );
          patch(row.id, { status: 'done', percent: 100, loaded: row.total });
          ok += 1;
        } catch (e) {
          patch(row.id, {
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
          });
          fail += 1;
        }
      }
      opts.onDone(ok, fail);
      // 完成/失败均已可见一段时间后清掉非失败行；失败项保留供查看。
      setTimeout(() => {
        setUploads((prev) => prev.filter((u) => u.status === 'failed'));
      }, 1500);
    },
    [opts, patch],
  );

  const aggregate: UploadAggregate = useMemo(
    () => ({
      total: uploads.length,
      done: uploads.filter((u) => u.status !== 'uploading').length,
      failed: uploads.filter((u) => u.status === 'failed').length,
      bytesLoaded: uploads.reduce((s, u) => s + (u.status === 'done' ? u.total : u.loaded), 0),
      bytesTotal: uploads.reduce((s, u) => s + u.total, 0),
    }),
    [uploads],
  );

  return { uploads, active, aggregate, enqueue };
}

/** 队列实例形状：App 层创建后经 prop 下发给 FileDrawer 消费，
 *  全页面拖拽上传与抽屉内上传共用同一队列。 */
export type UploadQueueApi = ReturnType<typeof useFolderDropUpload>;
