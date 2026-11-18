import type { ClipboardEvent, DragEvent } from 'react';
import { api } from './api';

/** What passes through the proxy in front of the board in one request; larger images are made smaller first. */
const SEND_MAX = 950 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The images in a paste or a drop, if any: files, not text that looks like a link. */
export function imagesIn(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return [...data.files].filter((f) => TYPES.includes(f.type));
}

/** A screenshot can be several megabytes; it is redrawn as WebP, smaller and if need be narrower, until it fits. */
async function fitted(file: File): Promise<Blob> {
  if (file.size <= SEND_MAX || file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', 0.86));
    if (blob !== null && blob.size <= SEND_MAX) return blob;
    scale *= 0.75;
  }
  throw new Error('the image is too large even when made smaller');
}

/** Uploads the images and answers the Markdown that shows them, one per line. */
export async function markdownFor(files: File[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const url = await api.image(await fitted(file));
    const alt = (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, '') : 'image').replace(/[[\]\n]/g, ' ');
    lines.push(`![${alt}](${url})`);
  }
  return lines.join('\n');
}

/**
 * Paste and drop handlers for a text box: images are uploaded and their Markdown put where the caret was.
 * `run` reports what went wrong (the board's act); text pastes are left to the browser.
 */
export function imageHandlers(value: string, onChange: (v: string) => void, run: (work: () => Promise<unknown>) => Promise<boolean>) {
  const insert = (el: HTMLTextAreaElement | HTMLInputElement, files: File[]): void => {
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    void run(async () => {
      const md = await markdownFor(files);
      const before = value.slice(0, start);
      const pad = before === '' || before.endsWith('\n') ? '' : '\n';
      onChange(`${before}${pad}${md}\n${value.slice(end)}`);
    });
  };
  return {
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      const files = imagesIn(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      insert(e.currentTarget, files);
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      const files = imagesIn(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      insert(e.currentTarget, files);
    },
  };
}
