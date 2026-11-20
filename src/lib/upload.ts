import { api } from './api';
import type { FileInfo } from './types';
import { uploadSafeName } from './utils';

const MAX_DIMENSION = 2560;

/**
 * Shrink large photos before upload: phone pictures are often 4-8 MB and
 * 4000px wide, which wastes free-tier storage. Small images, GIFs (animation)
 * and SVGs are left alone.
 */
export async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || /gif|svg|x-icon/.test(file.type)) return file;
  if (file.size < 400_000) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // e.g. HEIC in browsers that can't decode it
  }
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const toBlob = (type: string, q: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
    let blob = await toBlob('image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') {
      // Safari can't encode WebP; JPEG is fine for photos but would drop PNG transparency.
      if (file.type === 'image/png') return file;
      blob = await toBlob('image/jpeg', 0.86);
    }
    if (!blob || blob.size >= file.size) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}.${ext}`, { type: blob.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

export interface UploadResult {
  file: FileInfo;
  markdown: string;
}

/** `id`, chosen here (idFor), lets the same upload be sent again without storing the file twice. */
export async function uploadForNote(file: File, noteId: string | null, compress = true, id?: string): Promise<UploadResult> {
  const prepared = compress ? await prepareImage(file) : file;
  const name = uploadSafeName(prepared.name || 'pasted-image.png');
  const info = await api.uploadFile(prepared, name, { noteId, ...(id ? { id } : {}) });
  return { file: info, markdown: markdownFor(info) };
}

export function markdownFor(info: Pick<FileInfo, 'mime' | 'name' | 'url'>): string {
  const label = info.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || info.name;
  if (info.mime.startsWith('image/') || info.mime.startsWith('video/') || info.mime.startsWith('audio/')) {
    return `![${label}](${info.url})`;
  }
  return `[📎 ${info.name}](${info.url})`;
}

/** Open the OS file picker and resolve with the chosen files. */
export function pickFiles(accept: string, multiple = true, capture?: 'environment'): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}
