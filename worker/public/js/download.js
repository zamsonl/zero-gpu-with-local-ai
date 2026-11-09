// Saves generated text (code snippets, chat exports) as a file through a temporary object URL.

const EXTENSIONS = {
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh", console: "sh",
  powershell: "ps1", ps1: "ps1", pwsh: "ps1", bat: "bat", cmd: "bat",
  python: "py", py: "py", javascript: "js", js: "js", jsx: "jsx", mjs: "mjs",
  typescript: "ts", ts: "ts", tsx: "tsx", json: "json", html: "html", xml: "xml", svg: "svg",
  css: "css", scss: "scss", less: "less", c: "c", h: "h", cpp: "cpp", "c++": "cpp", hpp: "hpp",
  csharp: "cs", cs: "cs", java: "java", kotlin: "kt", go: "go", rust: "rs", rs: "rs",
  ruby: "rb", rb: "rb", php: "php", swift: "swift", lua: "lua", perl: "pl", r: "r",
  sql: "sql", yaml: "yml", yml: "yml", toml: "toml", ini: "ini", dockerfile: "Dockerfile",
  makefile: "mk", markdown: "md", md: "md", diff: "diff", patch: "diff", graphql: "graphql",
  vbnet: "vb", objectivec: "m", text: "txt", plaintext: "txt", txt: "txt",
};

/** `snippet.py` for python; Dockerfiles keep their conventional name. */
export function snippetFilename(language) {
  const ext = EXTENSIONS[(language || "").toLowerCase()] ?? "txt";
  return ext === "Dockerfile" ? "Dockerfile" : `snippet.${ext}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  // Revoke on a later task: the download has been handed to the browser by then.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}
