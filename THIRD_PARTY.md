# Third-party components

Project code uses the repository's MIT license. This does not relicense dependencies or model weights.

- Qwen/HauhauCS model files are downloaded from their pinned Hugging Face sources; upstream model cards and licenses apply.
- Qwen-Image model files and associated components keep their upstream licenses; current source selection is in the checked-in runtime.
- Ollama and cloudflared releases are downloaded from their official upstream repositories. Their full runtime/license trees remain intact in private caches.
- OpenCode CLI and Playwright MCP/browser packages retain their upstream licenses and are installed separately into the user's local tools directory.
- Vendored website libraries keep the notices shipped alongside them. See `worker/public/vendor/`.

No model weights or proprietary credentials are included in source releases.
