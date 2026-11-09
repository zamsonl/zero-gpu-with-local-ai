// Markdown → sanitized DOM for assistant replies.
//
// Replies are rendered block by block: the text is lexed into top-level blocks and only blocks
// whose source changed are rebuilt, so a streaming reply costs one block per frame and a code block
// being written keeps its element (and working buttons) the whole time. Every block's HTML goes
// through DOMPurify; images are never loaded (the CSP blocks them anyway) and render as their alt
// text linking to the image; links open in a new tab without a referrer.

import { Marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.js";
import { CodeBlock } from "./code-block.js";
import { h } from "./dom.js";

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
    image({ href, text }) {
      const label = escapeHtml(`Image: ${text || "no description"}`);
      return href ? `<a class="md-image" href="${escapeHtml(href)}">${label}</a>` : `<span class="md-image">${label}</span>`;
    },
  },
});

const purifier = DOMPurify(window);

// The only classes markup may carry: code languages and the image placeholder above. Anything
// else could borrow the app's own styling.
const ALLOWED_CLASSES = {
  CODE: /^language-[\w#+.-]+$/,
  A: /^md-image$/,
  SPAN: /^md-image$/,
};

purifier.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class") data.keepAttr = ALLOWED_CLASSES[node.nodeName]?.test(data.attrValue) ?? false;
});
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  // Nothing that loads a resource, takes input or restyles the page.
  FORBID_TAGS: [
    "img", "picture", "source", "video", "audio", "track", "iframe", "frame", "object", "embed",
    "form", "input", "button", "select", "option", "textarea", "style", "link", "meta", "base",
    "dialog", "template", "slot",
  ],
  FORBID_ATTR: ["style", "id", "name", "srcset", "background", "poster", "tabindex", "accesskey", "autofocus", "contenteditable"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
  RETURN_DOM_FRAGMENT: true,
};

export class MarkdownView {
  /** @type {{raw: string, nodes: Node[], code: CodeBlock|null}[]} */
  #blocks = [];

  constructor(el) {
    this.el = el;
  }

  /** Renders `text`, reusing every block whose source is unchanged. `final` once the text is complete. */
  render(text, { final = false } = {}) {
    const tokens = marked.lexer(text);
    // Reference-style links resolve across blocks; on the last pass rebuild everything so a
    // definition that arrived late applies to the blocks above it.
    if (final && Object.keys(tokens.links ?? {}).length) this.#reset();
    const blocks = tokens.filter((token) => token.type !== "space" && token.type !== "def");

    blocks.forEach((token, index) => {
      const current = this.#blocks[index];
      if (current?.raw === token.raw) {
        if (final) current.code?.update(token.text, { final });
        return;
      }
      if (current?.code && token.type === "code" && current.code.language === languageOf(token)) {
        current.code.update(token.text, { final });
        current.raw = token.raw;
        return;
      }
      const next = renderBlock(token, final);
      if (current) {
        current.nodes[0].before(...next.nodes);
        for (const node of current.nodes) node.remove();
        this.#blocks[index] = next;
      } else {
        this.el.append(...next.nodes);
        this.#blocks.push(next);
      }
    });
    for (const stale of this.#blocks.splice(blocks.length)) for (const node of stale.nodes) node.remove();
  }

  #reset() {
    this.#blocks = [];
    this.el.replaceChildren();
  }
}

function renderBlock(token, final) {
  if (token.type === "code") {
    const code = new CodeBlock(token.lang);
    code.update(token.text, { final });
    return { raw: token.raw, nodes: [code.el], code };
  }
  const fragment = purifier.sanitize(marked.parser([token]), PURIFY_CONFIG);
  enhance(fragment);
  const nodes = [...fragment.childNodes];
  // Every block keeps at least one node so it has a place in the document to be replaced at.
  return { raw: token.raw, nodes: nodes.length ? nodes : [document.createTextNode("")], code: null };
}

/** Code blocks nested in lists or quotes get the same treatment; wide tables scroll on their own. */
function enhance(fragment) {
  for (const pre of fragment.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const language = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
    const block = new CodeBlock(language);
    block.update(code ? code.textContent : pre.textContent, { final: true });
    pre.replaceWith(block.el);
  }
  for (const table of fragment.querySelectorAll("table")) {
    const wrap = h("div", { class: "table-wrap", tabindex: "0" });
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function languageOf(token) {
  return (token.lang || "").trim().split(/\s+/)[0].toLowerCase();
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
