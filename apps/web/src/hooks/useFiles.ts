import { useState, useEffect, useCallback } from 'react';

export interface FileEntry {
  key: string;
  size: number;
  lastModified: string;
}

export function useFiles() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/files');
      if (res.ok) setFiles(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const downloadFile = useCallback(async (key: string) => {
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}`);
      if (res.ok) {
        const { url } = await res.json();
        window.open(url, '_blank');
      }
    } catch { /* ignore */ }
  }, []);

  return { files, loading, refresh, downloadFile };
}
