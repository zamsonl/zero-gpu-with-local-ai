// Files attached to a message. The browser reads documents as text (code, logs, data, PDF text)
// and sends `{ name, type, text }`; it shrinks pictures and sends `{ name, type, data }` (base64
// JPEG, PNG or WebP). The server validates them and stores them with the user message. Documents
// are appended to that message's text when it goes to the model; pictures go alongside it, to a
// server whose model can see them.

import { badRequest, tooLarge } from "./http.js";

export const MAX_FILES = 10;
export const MAX_ATTACHMENT_CHARS = 120_000;
export const MAX_IMAGES = 4;
// Base64 characters across a message's pictures: about 1 MB of image, so a message with its text
// and documents still fits in one database row (2 MB).
export const MAX_IMAGE_DATA = 1_300_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
// What a picture costs in the conversation memory, counted like text (about 1,000 tokens).
export const IMAGE_CHARS = 3_000;
const MAX_NAME_CHARS = 200;
const MAX_TYPE_CHARS = 100;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates `value` (absent, or an array of files) into documents `{ name, type, size, text }` and
 * pictures `{ name, type, size, data }`.
 */
export function parseAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest('"attachments" must be a list of files.');
  if (value.length > MAX_FILES) throw badRequest(`Attach at most ${MAX_FILES} files per message.`);
  let chars = 0;
  let imageData = 0;
  const files = value.map((file, i) => {
    if (!file || typeof file !== "object") throw badRequest(`Attachment ${i + 1} is not a file.`);
    const name = cleanName(file.name, i);
    const type = typeof file.type === "string" ? file.type.slice(0, MAX_TYPE_CHARS) : "";
    if (file.data != null) {
      if (!IMAGE_TYPES.includes(type)) throw badRequest(`"${name}" isn't a JPEG, PNG or WebP picture.`);
      if (typeof file.data !== "string" || !file.data || !BASE64.test(file.data)) throw badRequest(`"${name}" isn't readable picture data.`);
      imageData += file.data.length;
      return { name, type, size: Math.floor((file.data.length * 3) / 4), data: file.data };
    }
    if (typeof file.text !== "string") throw badRequest(`"${name}" has no text.`);
    chars += file.text.length;
    return { name, type, size: file.text.length, text: file.text };
  });
  const images = files.filter(isImage).length;
  if (images > MAX_IMAGES) throw badRequest(`Attach at most ${MAX_IMAGES} pictures per message.`);
  if (imageData > MAX_IMAGE_DATA) throw tooLarge("The pictures are too large together. Attach fewer, or smaller ones.");
  if (chars > MAX_ATTACHMENT_CHARS) {
    throw tooLarge(`The attached files hold ${chars.toLocaleString("en-US")} characters; the limit is ${MAX_ATTACHMENT_CHARS.toLocaleString("en-US")}.`);
  }
  return files;
}

export const isImage = (file) => typeof file?.data === "string";

/**
 * The message as the model sees it: the text, then each document in a tagged block. Pictures are
 * named in the text (the model gets them separately, see modelImages), so a model that can't see
 * them, or a later turn that no longer sends them, still knows they were there.
 */
export function modelContent(content, attachments) {
  if (!attachments?.length) return content;
  const documents = attachments.filter((f) => !isImage(f));
  const pictures = attachments.filter(isImage);
  const blocks = documents.map((f) => `<file name="${f.name.replace(/"/g, "'")}">\n${f.text}\n</file>`);
  const intro = documents.length === 0 ? null : documents.length === 1 ? "Attached file:" : `Attached files (${documents.length}):`;
  const shown = pictures.length ? `[${pictures.length === 1 ? "Picture" : "Pictures"} attached: ${pictures.map((f) => f.name).join(", ")}]` : null;
  return [content.trim(), shown, intro, ...blocks].filter(Boolean).join("\n\n");
}

/** The base64 pictures attached to a message, for Ollama's `images` field. */
export function modelImages(attachments) {
  return (attachments ?? []).filter(isImage).map((f) => f.data);
}

function cleanName(raw, index) {
  if (typeof raw !== "string") throw badRequest(`Attachment ${index + 1} has no name.`);
  // Keep the file name only, without any folder part or control characters.
  const name = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) throw badRequest(`Attachment ${index + 1} has no name.`);
  return Array.from(name).slice(0, MAX_NAME_CHARS).join("");
}
