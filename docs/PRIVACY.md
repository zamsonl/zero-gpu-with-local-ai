# Privacy and credentials

## Quick Start

The supplied public GitHub Pages app is static: your browser connects directly to your own notebook using its private session key. You may instead use the included `web/index.html` locally. The notebook prints credentials in a URL fragment; keep the whole link and notebook output private. Chats stay in that browser's IndexedDB and can be exported/imported. Hosted and local copies have separate storage. No maintainer Worker or GPU account is used. No Kaggle API token is required by this path.

## Advanced Setup

- Public source/ZIP templates contain no maintainer endpoint, API token, Cloudflare database ID, private notebook link, chat export or remembered credential.
- Configure your own deployment. Its configured downloadable connector necessarily contains that deployment's public origin, but no API token. `deployment.local.json` and live `.dev.vars` are ignored.
- A local-agent Kaggle token goes over HTTPS to your configured relay for authentication and your account's cache/session operations. It is not sent to the model, embedded in notebook source, saved in D1, or passed into OpenCode/browser child environments. Windows saved credentials use DPAPI CurrentUser; other systems have no plaintext-storage fallback.
- CPU builders use Kaggle's short-lived notebook-native upload authentication and a narrow callback credential. Temporary upload capabilities are encrypted in operational storage and removed after confirmed commit/cancellation/failure; status APIs never return them.
- Model/runtime caches contain upstream files and licenses, not prompts, project files or conversations.
- Website chat/history lives in the deployer's D1/R2. Local OpenCode conversations, thinking and tool results live under the isolated local project/account directory. The relay and GPU provider process model traffic; choose providers/deployments you trust.
- Local tools can expose data if approved. Credential path deny rules, browser isolation and approval prompts reduce risk but do not make OS commands a sandbox. Review actions before approval.
- Keep notebooks private. Never publish a notebook with live credentials, logs containing connection capabilities, or populated cell outputs. Templates have empty outputs.

Deleting an app tab or stopping a response does not prove GPU shutdown. Check the notebook's actual state. Deleting local saved credentials does not revoke a Kaggle token; revoke it in Kaggle when needed.
