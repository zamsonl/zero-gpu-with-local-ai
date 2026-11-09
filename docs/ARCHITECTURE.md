# Architecture and data boundaries

## Quick Start

`server/server.py` runs inside your Kaggle or Colab notebook, starts the model and an authenticated gatekeeper, and prints a link to the supplied `web/index.html` chat app. Browser requests go directly to your notebook's quick-tunnel address with your session key. Chats remain in browser IndexedDB; the optional `cli/chat.mjs` keeps local history. No Worker deployment, D1 or R2 is needed. Quick Start omits compaction, persistent model caching, image generation and the local coding agent.

## Advanced Setup

The sections below describe the optional full workspace.

`worker/src/index.js` routes website APIs, private notebook callbacks, per-user cache preparation and isolated local-agent sessions. `worker/public/` is the current website. D1 migrations define website chats, messages, checkpoints and operational state; R2 stores generated pictures and opt-in long-input source text.

`worker/src/kaggle-server.py`, cache helpers and resumable jobs run on the remote notebook. Finite authenticated transport legs reconnect to one model job using its identity and cursor. Tunnel reconnects do not restart inference. Main model requests have bounded wall time, output, context and external-request budgets. Platform terminations remain possible.

`worker/src/opencode.js` validates OpenAI-compatible messages/native tools, preserves working notes in native model-visible content, and holds tool output until terminal success. It keeps original user instructions and real tool results distinct from unverified plans. Recognized recovery uses the same model and original deadline, never an unlimited retry loop.

`worker/src/personal-cache.js` authenticates the supplied user's Kaggle token, reserves one CPU build, receives scoped callbacks, encrypts temporary blob capabilities, commits a private owned Dataset and checks its readiness/manifest/version. The permanent Kaggle token is not stored. Model/runtime fingerprinting separates cache versions. CPU/GPU launch identities and unknown acknowledgements are reconciled instead of blindly resubmitted.

`client/agent/` owns Windows setup, secure token storage, reviewed local tool installation, private project/account OpenCode history, and local child-process lifecycle. Model calls pass through the configured relay to the user's private Kaggle notebook. All AI roles use the selected model. Terminal tools run as the OS user, with approval policy rather than a filesystem sandbox.

The website model notebook and local-agent notebook are separate allocations and histories. Local-agent cache/session APIs do not use the website owner's private GPU, token or cache for other accounts. Website authentication is a workspace key rather than a multi-user identity system.
