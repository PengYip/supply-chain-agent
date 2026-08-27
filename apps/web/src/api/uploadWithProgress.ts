// Upload transport shared by the chat input and the file-manager drop queue.
// XHR is used instead of fetch because only XHR exposes upload-direction
// byte-level progress (xhr.upload.onprogress); fetch has no equivalent.

export interface UploadProgressInfo {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadResult {
  docId: string;
  filename: string;
  key: string;
  directory: string;
}

/** Client-side guard mirroring env.MAX_UPLOAD_BYTES on the server (25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * POST multipart to /api/files with per-byte progress callbacks.
 * Rejects with Error(message) -- messages are user-facing Chinese strings.
 */
export function uploadWithProgress(
  file: File,
  directory: string,
  onProgress?: (info: UploadProgressInfo) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    if (directory) fd.append('directory', directory);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: e.total > 0 ? Math.round((e.loaded / e.total) * 100) : 0,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error(`unexpected response (${xhr.status})`));
        }
        return;
      }
      let detail = `upload failed (${xhr.status})`;
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string; detail?: string };
        detail =
          j.error === 'file too large'
            ? `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MiB），上限为 25 MiB`
            : j.error || j.detail || detail;
      } catch {
        // keep default message
      }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(fd);
  });
}
