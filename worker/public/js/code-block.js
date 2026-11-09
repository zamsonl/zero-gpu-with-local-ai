// A fenced code block: language and line count, Copy and Download, line numbers beside the
// highlighted code. It is updated in place while a reply streams, so its buttons keep working on a
// block that is still being written.

import hljs from "../vendor/highlight.min.js";
import dockerfile from "../vendor/hljs-dockerfile.min.js";
import powershell from "../vendor/hljs-powershell.min.js";
import { copyFromButton } from "./clipboard.js";
import { h, icon } from "./dom.js";
import { downloadText, snippetFilename } from "./download.js";

hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("dockerfile", dockerfile);

// Re-highlighting a huge block on every frame would stall the page; past this it waits for the end.
const LIVE_HIGHLIGHT_CHARS = 20_000;

export class CodeBlock {
  #code = null;
  #highlighted = false;
  #codeEl = h("code", { class: "hljs" });
  #gutter = h("div", { class: "code-gutter", "aria-hidden": "true" });
  #count = h("span", { class: "code-count" });
  #lines = 0;

  /** @param {string} info the fence's info string, e.g. "python" or "js title=app.js" */
  constructor(info) {
    this.language = (info || "").trim().split(/\s+/)[0].toLowerCase();
    const filename = snippetFilename(this.language);
    const copy = codeAction("copy", "Copy", "Copy code", () => copyFromButton(copy, this.#code));
    const download = codeAction("download", "Download", `Download as ${filename}`, () =>
      downloadText(this.#code, filename),
    );
    this.el = h(
      "div",
      { class: "code-block" },
      h(
        "div",
        { class: "code-head" },
        h("span", { class: "code-lang" }, h("span", { text: this.language || "text" }), this.#count),
        h("div", { class: "code-actions" }, copy, download),
      ),
      // The numbers sit in their own column, so selecting or copying the code never picks them up.
      h("div", { class: "code-body" }, this.#gutter, h("pre", { tabindex: "0", "aria-label": `${this.language || "Plain text"} code` }, this.#codeEl)),
    );
  }

  /** Sets the code. Long blocks are highlighted only once `final` (the reply has ended). */
  update(code, { final = false } = {}) {
    if (code === this.#code && (this.#highlighted || !final)) return;
    this.#code = code;
    const lines = code.replace(/\n$/, "").split("\n").length;
    if (lines !== this.#lines) {
      this.#lines = lines;
      this.#gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
      this.#count.textContent = ` · ${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    const language = hljs.getLanguage(this.language) ? this.language : null;
    if (language && (final || code.length <= LIVE_HIGHLIGHT_CHARS)) {
      // highlight.js escapes the code: its output is spans around escaped text.
      this.#codeEl.innerHTML = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      this.#highlighted = true;
    } else {
      this.#codeEl.textContent = code;
      this.#highlighted = !language;
    }
  }
}

function codeAction(iconName, label, title, onclick) {
  return h(
    "button",
    { class: "code-action", type: "button", title, onclick },
    icon(iconName),
    h("span", { class: "button-label", text: label }),
  );
}
