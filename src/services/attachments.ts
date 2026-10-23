/**
 * 收據照片：在 Web Worker 中壓縮（長邊 1600px、約 300KB 內）並產生 240px 縮圖，存入 IndexedDB。
 * 壓縮函式庫採動態載入，不影響首屏。
 */
import { db, uid } from '@/db/schema';
import type { Attachment } from '@/db/types';
// 將壓縮函式庫打包成本機資源給 Web Worker 使用（預設會從 jsDelivr CDN 載入，離線時會失敗）
import libPath from 'browser-image-compression/dist/browser-image-compression.js?url';

const libURL = () => new URL(libPath, location.origin).href;

async function dims(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const r = { width: bmp.width, height: bmp.height };
    bmp.close();
    return r;
  } catch {
    return { width: 0, height: 0 };
  }
}

export async function saveImageAttachment(file: File): Promise<Attachment> {
  const { default: compress } = await import('browser-image-compression');
  const blob = await compress(file, { maxSizeMB: 0.3, maxWidthOrHeight: 1600, useWebWorker: true, libURL: libURL(), fileType: 'image/jpeg', initialQuality: 0.75 });
  const thumb = await compress(file, { maxSizeMB: 0.03, maxWidthOrHeight: 240, useWebWorker: true, libURL: libURL(), fileType: 'image/jpeg' });
  const { width, height } = await dims(blob);
  const att: Attachment = { id: uid(), transactionId: '', blob, thumb, mime: 'image/jpeg', width, height, createdAt: Date.now() };
  await db.attachments.add(att);
  return att;
}

/** 刪除未連結到任何帳目的附件（使用者取消記帳時） */
export async function discardAttachments(ids: string[]): Promise<void> {
  const rows = await db.attachments.bulkGet(ids);
  await db.attachments.bulkDelete(rows.filter((r) => r && !r.transactionId).map((r) => r!.id));
}
