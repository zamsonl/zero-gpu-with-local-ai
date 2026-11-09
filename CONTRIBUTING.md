# Contributing

Use Node.js 20+ and Python 3.10+. From `worker/`, run `npm ci`, `npm test`, `npm run test:agent`, and `npm run test:cache`. Tests use local fake services and inert deployment configuration; they do not need a real GPU or personal API token. Windows filesystem symlink tests can skip if the user lacks symlink privilege.

Use an isolated checkout for changes. Add meaningful regression tests at the actual transport/lifecycle seam when changing recovery, cache ownership, cancellation, context handling or tool safety. Do not update supported OpenCode/runtime versions silently: validate provider schema, thinking, tools, compaction and browser lifecycle first.

After changing client files, run `python tools/build-local-agent.py`. After shared notebook/runtime changes run `python tools/build-colab-notebook.py` and the notebook tests. These commands are run from `worker/`. From the repository root, `python tools/build_download.py` rebuilds the blank source notebooks, connector and complete `DOWNLOAD ME.zip`. It refuses a configured private database binding. Configured production downloads belong on the operator's own site.

Before publishing, verify that source and nested ZIPs contain no personal endpoint or secret, and that notebook outputs remain empty. Keep upstream license notices. Never commit generated local test state or downloaded model/runtime payloads.
