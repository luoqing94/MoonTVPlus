/**
 * Shared helpers for exporting cached M3U8 downloads (File System / IndexedDB).
 * Used by DownloadManagementPanel and DownloadPanel task-list Export.
 */

import {
  buildIndexedDBVideoCacheKey,
  getIndexedDBVideoManifestByEpisode,
  getIndexedDBVideoSegments,
} from '@/lib/indexeddb-video-cache';

export type ExportableDownloadTask = {
  id: string;
  title: string;
  source: string;
  videoId: string;
  episodeIndex: number;
  videoTitle?: string;
  episodeTitle?: string;
  downloadMode: 'browser' | 'filesystem' | 'indexeddb';
};

export function sanitizeExportFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'download'
  );
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deriveBaseTitle(task: ExportableDownloadTask): string {
  if (task.videoTitle) return task.videoTitle;
  const firstTitle = task.title || '未知视频';
  return (
    firstTitle
      .replace(/[_\s-]*第\s*\d+\s*集.*$/u, '')
      .replace(/[_\s-]*EP?\s*\d+.*$/iu, '')
      .trim() || firstTitle
  );
}

export function getTaskExportFilename(
  task: ExportableDownloadTask,
  usedFilenames: Set<string>
): string {
  const episodeLabel = `第${task.episodeIndex + 1}集`;
  const baseTitle = deriveBaseTitle(task);
  const episodeTitle = task.episodeTitle
    ? `${episodeLabel}_${task.episodeTitle}`
    : episodeLabel;
  const baseFilename = sanitizeExportFilename(`${baseTitle}_${episodeTitle}`);
  let filename = `${baseFilename}.ts`;
  let duplicateIndex = 2;

  while (usedFilenames.has(filename)) {
    filename = `${baseFilename}_${duplicateIndex}.ts`;
    duplicateIndex += 1;
  }

  usedFilenames.add(filename);
  return filename;
}

export async function getStoredDownloadDirHandle(): Promise<
  FileSystemDirectoryHandle | undefined
> {
  const dbName = 'MoonTVPlus';
  const storeName = 'dirHandles';

  return new Promise<FileSystemDirectoryHandle | undefined>((resolve) => {
    const request = indexedDB.open(dbName, 2);

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve(undefined);
        return;
      }

      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const getRequest = store.get('downloadDir');

      getRequest.onsuccess = () => {
        const handle = getRequest.result as
          | FileSystemDirectoryHandle
          | undefined;
        db.close();
        resolve(handle);
      };

      getRequest.onerror = () => {
        db.close();
        resolve(undefined);
      };
    };

    request.onerror = () => resolve(undefined);
  });
}

export async function readFilesystemTaskAsBlobParts(
  task: ExportableDownloadTask,
  dirHandle: FileSystemDirectoryHandle
): Promise<BlobPart[]> {
  const sourceDirHandle = await dirHandle.getDirectoryHandle(task.source, {
    create: false,
  });
  const videoIdDirHandle = await sourceDirHandle.getDirectoryHandle(
    task.videoId,
    { create: false }
  );
  const epDirHandle = await videoIdDirHandle.getDirectoryHandle(
    `ep${task.episodeIndex + 1}`,
    { create: false }
  );

  const segmentFiles: Array<{ name: string; file: File }> = [];
  for await (const entry of epDirHandle.values()) {
    if (entry.kind === 'file' && /^segment_\d+\.ts$/i.test(entry.name)) {
      const fileHandle = entry as FileSystemFileHandle;
      segmentFiles.push({
        name: entry.name,
        file: await fileHandle.getFile(),
      });
    }
  }

  segmentFiles.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );

  if (segmentFiles.length === 0) {
    throw new Error('未找到可导出的分片文件');
  }

  return segmentFiles.map(({ file }) => file);
}

export async function readIndexedDBTaskAsBlobParts(
  task: ExportableDownloadTask
): Promise<BlobPart[]> {
  const manifest = await getIndexedDBVideoManifestByEpisode(
    task.source,
    task.videoId,
    task.episodeIndex
  );
  const cacheKey =
    manifest?.cacheKey ||
    buildIndexedDBVideoCacheKey(task.source, task.videoId, task.episodeIndex);
  const segments = await getIndexedDBVideoSegments(cacheKey);

  if (segments.length === 0) {
    throw new Error('未找到可导出的 IndexedDB 分片');
  }

  return segments.map((segment) => segment.data);
}

export type ExportDownloadResult = {
  exportedCount: number;
  failedTitles: string[];
};

/**
 * Export one or more cached downloads via the same blob-download path used by
 * DownloadManagementPanel (triggers iOS open-with sheet when user-initiated).
 */
export async function exportDownloadTasks(
  tasksToExport: ExportableDownloadTask[]
): Promise<ExportDownloadResult> {
  if (tasksToExport.length === 0) {
    return { exportedCount: 0, failedTitles: [] };
  }

  const unsupportedTasks = tasksToExport.filter(
    (task) => task.downloadMode === 'browser'
  );
  if (unsupportedTasks.length > 0) {
    throw new Error(
      '浏览器下载模式的文件未保存在本地缓存中，无法导出。请仅选择 File System API 或 IndexedDB 缓存记录。'
    );
  }

  let dirHandle: FileSystemDirectoryHandle | undefined;
  if (tasksToExport.some((task) => task.downloadMode === 'filesystem')) {
    dirHandle = await getStoredDownloadDirHandle();
    if (!dirHandle) {
      throw new Error(
        '无法读取下载目录授权，请先在下载设置中重新选择保存目录。'
      );
    }

    const permission = await (
      dirHandle as FileSystemDirectoryHandle & {
        requestPermission: (opts: {
          mode: 'read' | 'readwrite';
        }) => Promise<PermissionState>;
      }
    ).requestPermission({ mode: 'read' });
    if (permission !== 'granted') {
      throw new Error('未获得下载目录读取权限，无法导出。');
    }
  }

  const usedFilenames = new Set<string>();
  let exportedCount = 0;
  const failedTitles: string[] = [];

  for (const task of tasksToExport) {
    try {
      const parts =
        task.downloadMode === 'filesystem'
          ? await readFilesystemTaskAsBlobParts(task, dirHandle!)
          : await readIndexedDBTaskAsBlobParts(task);
      const blob = new Blob(parts, { type: 'video/MP2T' });
      triggerBlobDownload(blob, getTaskExportFilename(task, usedFilenames));
      exportedCount += 1;
    } catch (error) {
      console.error('导出任务失败:', task.title, error);
      failedTitles.push(`第 ${task.episodeIndex + 1} 集`);
    }
  }

  return { exportedCount, failedTitles };
}
