// Reading attached files in the browser. Text files (code, logs, data, configs) are decoded as
// UTF-8; PDFs go through pdf.js (loaded only when one is attached) for their text layer. Pictures
// (when the model server can see them) are scaled down and re-encoded as JPEG, small enough to be
// stored with the message. Anything else is refused with a reason the person can act on.

export const MAX_FILES = 10;
export const MAX_TOTAL_CHARS = 120_000;
/** A legacy large-text hint; the current composer uses its live context allowance. */
export const LARGE_TOTAL_CHARS = 60_000;
export const MAX_PICTURES = 4;
// The longest side a picture is sent at: about 1,000 tokens for the model, a few hundred KB stored.
const PICTURE_MAX_SIDE = 1280;
// Base64 characters per picture; the server takes 1.3M across a message's pictures.
const PICTURE_MAX_DATA = 320_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;

export class FileRejected extends Error {}

/**
 * Resolves to a document `{ name, type, text }` or a picture `{ name, type, data, width, height }`
 * (base64 JPEG), or rejects with a FileRejected explaining why. `pictures` says whether the model
 * server running now can see pictures.
 */
export async function readFile(file, { pictures = false } = {}) {
  if (isPicture(file)) {
    if (!pictures) {
      throw new FileRejected(`${file.name} is a picture. Pictures need a running Qwen model with vision enabled. Start the updated Kaggle or Colab notebook.`);
    }
    if (file.size > MAX_PICTURE_BYTES) {
      throw new FileRejected(`${file.name} is ${formatBytes(file.size)}; pictures up to ${formatBytes(MAX_PICTURE_BYTES)} can be attached.`);
    }
    return readPicture(file);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new FileRejected(`${file.name} is ${formatBytes(file.size)}; files up to ${formatBytes(MAX_FILE_BYTES)} can be attached.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf(file, bytes)) return { name: file.name, type: "application/pdf", text: await pdfText(file.name, bytes) };
  if (looksBinary(bytes)) {
    throw new FileRejected(`${file.name} isn't a text file. Attach code, text, logs, data, PDFs or pictures; other binaries can't be read.`);
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  return { name: file.name, type: file.type || "text/plain", text };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "1,240 characters" or "12K characters", for chips and warnings. */
export function formatChars(count) {
  return count < 10_000 ? `${count.toLocaleString()} characters` : `${Math.round(count / 1000)}K characters`;
}

export const isPictureAttachment = (file) => typeof file?.data === "string";

/** The picture formats browsers decode everywhere, by type or, failing that, by extension. */
function isPicture(file) {
  return /^image\/(jpeg|png|webp|gif|bmp|avif)$/i.test(file.type) || (!file.type && /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name));
}

/** A data: URL for showing a stored picture. */
export function pictureUrl(file) {
  return `data:${file.type || "image/jpeg"};base64,${file.data}`;
}

/**
 * Decodes the picture (respecting its EXIF orientation), scales it so its longest side is at most
 * PICTURE_MAX_SIDE and re-encodes it as JPEG on white (pictures with transparency get a white
 * background), stepping quality and size down until it fits PICTURE_MAX_DATA.
 */
async function readPicture(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new FileRejected(`${file.name} couldn't be opened as a picture.`);
  }
  try {
    for (const [side, quality] of [[PICTURE_MAX_SIDE, 0.86], [PICTURE_MAX_SIDE, 0.72], [1024, 0.7], [768, 0.7]]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      const url = canvas.toDataURL("image/jpeg", quality);
      const data = url.slice(url.indexOf(",") + 1);
      if (data.length <= PICTURE_MAX_DATA) return { name: file.name, type: "image/jpeg", data, width, height };
    }
  } finally {
    bitmap.close();
  }
  throw new FileRejected(`${file.name} is too detailed to send, even scaled down.`);
}

function isPdf(file, bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  return magic === "%PDF-" || file.type === "application/pdf";
}

/** NUL bytes, or invalid UTF-8 in more than a sliver of the start, mean it isn't text. */
function looksBinary(bytes) {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return true;
  const sample = new TextDecoder("utf-8").decode(head);
  const bad = sample.split("�").length - 1;
  return bad > Math.max(4, sample.length * 0.01);
}

let pdfjs = null;

async function pdfText(name, bytes) {
  pdfjs ??= await import("../vendor/pdfjs/pdf.min.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    return lib;
  });
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  } catch (err) {
    throw new FileRejected(`${name} couldn't be opened as a PDF (${err?.message || "unreadable"}).`);
  }
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
      pages.push(`[Page ${n}]\n${text.trim()}`);
    }
    const text = pages.join("\n\n");
    if (!text.replace(/\[Page \d+\]/g, "").trim()) {
      throw new FileRejected(`${name} has no text layer (it's probably scanned images), so there's nothing to read.`);
    }
    return text;
  } finally {
    doc.destroy();
  }
}
