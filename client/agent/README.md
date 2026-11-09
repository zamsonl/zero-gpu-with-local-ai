# Local coding agent

Use OpenCode with a model hosted on your own Kaggle account. No local Ollama or model weights are needed. All AI roles, including titles and compaction, use the selected hosted model; Qwen 27B is the default.

## Start

1. Install Node.js 20+ with npm, then extract the ZIP.
2. On Windows, double-click **Start Qwen OpenCode.cmd**. **Start Qwen Agent.cmd** opens the same guided setup.
3. Choose your project folder. Allow installation of missing reviewed OpenCode and Playwright tools if wanted.
4. Create your Kaggle API token and paste it into the local setup password field. Never put it in a chat, URL, screenshot or repository.
5. Confirm private cache preparation and GPU use. First use prepares a private model/runtime Dataset using one reusable **CPU-only** builder. The GPU notebook starts after that cache is ready. Later starts reuse it.
6. OpenCode opens in its own terminal when ready. Review tool approvals. Exit OpenCode when finished and confirm its notebook has stopped in Kaggle.

For terminal setup, run `node opencode.mjs --setup`. Use `--continue` or `--session ID` to resume saved local history. See [OPENCODE.md](OPENCODE.md) for advanced options. Windows can remember the token using DPAPI CurrentUser encryption. Other platforms have no plaintext-storage fallback. Installed local tools are reused.

## Models and cache

Leave Model empty for Qwen 27B Q5_K_P. Optional links support **public Hugging Face GGUF only**: a repository or complete single `.gguf` file. The model must support chat/tools and fit the GPU. Private/gated models, other hosts, safetensors, projectors and split shards are rejected. No substitute model is silently loaded.

Each account owns its caches. Each immutable model/runtime version has a separate private Dataset, while the account reuses one CPU builder notebook. Files are checksum verified before upload. Custom cache hits still perform checksum, import, tool/thinking capability, context and full-GPU checks.

The first build takes longer and needs enough temporary disk and Dataset storage. It uses CPU allocation, not GPU allowance. Later starts skip compatible weight/runtime downloads. GPU queueing and loading still take time. Cancel requests CPU cancellation before GPU launch; a lost local process has a bounded cache-controller inactivity backstop.

## Long tasks

Thinking is visible by default. Working notes are carried into subsequent model prompts across tool calls so native runtime conversion does not discard the plan. Plans are distinguished from actual tool results. Completed reasoning-pass tokens are counted. Automatic compaction uses the same model; original history remains saved locally. Finite summaries cannot guarantee perfect recall.

A recognized runner/tool-format failure gets at most one bounded recovery with thinking off. Failed actions are not released or replayed. Unknown streams, Stop, memory exhaustion and tokenizer overflow have separate handling. A model request has a two-hour limit; recovery cannot loop indefinitely.

Two hours is a wall-time allowance per generation, not an unlimited token window. Automatic compaction keeps the session usable as it grows, subject to the selected model's context and finite summaries. The connector stops repeated identical tool/result cycles across turns even when OpenCode's own loop check misses them. Hosting shutdowns and exhausted budgets can still interrupt work. After updating, restart the notebook and reopen this helper; an already running process keeps its previous settings.

Setup saves a non-secret launch reference before contacting Kaggle. If confirmation is lost, Retry checks that same notebook instead of submitting another. Confirmed refusals use a short retry delay rather than consuming the connector's daily GPU-launch allowance. Kaggle's own quota and permission limits still apply. The event log identifies the source, operation, HTTP status and available wait time; deleting notebooks or the private cache is not a normal restart step.

## Privacy, approvals and shutdown

The Kaggle token is used over HTTPS for your own cache/session operations. It is never included in model messages, OpenCode configuration, notebook source or child-process environment. The relay handles model traffic: use a deployment you trust. OpenCode history stays in its isolated local project/account storage. The website has separate cloud-backed chat storage.

Tools run on your computer. **Terminal commands are not a filesystem sandbox.** Review approvals, particularly destructive actions or commands outside the selected folder. Credential paths are denied by policy. Playwright uses an isolated sandboxed browser; dangerous evaluation/upload tools are disabled.

GPU allocation continues during startup, approvals, local tools and idle time. Exit OpenCode to request shutdown. Force-closing, crashes or network loss can prevent confirmation: check Kaggle rather than assuming allocation ended. Kaggle platform/runtime/quota limits still apply.

Replace a stale token or change accounts with `node opencode.mjs --forget-kaggle-token`, then reopen setup. This removes only the saved credential. A replacement token for the same account does not reset launch limits or GPU quota.

## Deployment

Administrators configure their own relay with `worker/tools/configure-deployment.mjs`, then deploy the rebuilt ZIP. Public source contains no maintainer endpoint or credentials. OpenCode 1.19.5 CLI is the reviewed supported interface; the separate Desktop GUI is not configured by this connector.
