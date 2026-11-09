// Shows an attached file in a dialog: a document's text with Copy and Download, or a picture at
// full size with Download.

import { copyFromButton } from "./clipboard.js";
import { h, icon } from "./dom.js";
import { downloadBlob, downloadText } from "./download.js";
import { formatBytes, formatChars, isPictureAttachment, pictureUrl } from "./files.js";
import { animateDialogDismissal, dismiss } from "./motion.js";

export function viewFile(file) {
  const picture = isPictureAttachment(file);
  const text = picture ? "" : (file.text ?? "");
  const close = h("button", { class: "icon-button", type: "button", "aria-label": "Close", title: "Close (Esc)" }, icon("close"));
  const copy = picture ? null : h("button", { class: "button", type: "button" }, icon("copy"), h("span", { class: "button-label", text: "Copy" }));
  const download = h("button", { class: "button", type: "button" }, icon("download"), h("span", { text: "Download" }));
  const body = picture
    ? h("div", { class: "file-dialog-body file-dialog-picture" }, h("img", { src: pictureUrl(file), alt: file.name }))
    : h("pre", { class: "file-dialog-body", tabindex: "0" }, text);
  const dialog = h(
    "dialog",
    { class: `dialog file-dialog${picture ? " is-picture" : ""}`, "aria-label": file.name },
    h(
      "div",
      { class: "file-dialog-head" },
      icon(picture ? "image" : "file"),
      h("div", { class: "file-dialog-title" }, h("strong", { text: file.name }), h("span", { text: picture ? `Picture, ${formatBytes(file.size ?? 0)}` : formatChars(text.length) })),
      close,
    ),
    body,
    h("div", { class: "file-dialog-foot" }, copy, download),
  );
  copy?.addEventListener("click", () => copyFromButton(copy, text));
  download.addEventListener("click", () => {
    if (picture) downloadBlob(pictureBlob(file), file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg");
    else downloadText(text, file.name.replace(/\.pdf$/i, ".txt"));
  });
  close.addEventListener("click", () => dismiss(dialog));
  animateDialogDismissal(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

function pictureBlob(file) {
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: file.type || "image/jpeg" });
}
