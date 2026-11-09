# Qwen in OpenCode

This launcher opens the standard OpenCode terminal UI in your chosen project folder. All AI work, including titles, summaries and conversation compaction, uses **qwen3.8-hauhau in your own private Kaggle notebook**. It uses your Kaggle GPU allowance while the notebook is allocated, including time spent reviewing an approval. Your PC runs the coding tools; it does not download Qwen model weights.

## Easiest setup on Windows

1. Extract the ZIP and double-click **Start Qwen OpenCode.cmd**, or use the desktop shortcut. A local setup window opens. Node.js LTS with npm is required; if missing, the launcher offers its official download page.
2. Choose your project using the modern Windows Explorer folder picker, or paste its full path. The last chosen project and browser choice are remembered locally.
3. Click **Get API token** to open the official Kaggle API settings. Paste your own modern token into the setup window's password field. Windows stores it encrypted after a confirmed bootstrap; a saved token is shown as **Encrypted token saved**, never revealed by the server. Change or forget it from the same screen.
4. Keep **Browser & web search** enabled if wanted. Allow installation of missing reviewed tools and confirm using **your own Kaggle GPU allowance**, then click **Start Qwen**. Local tool checks and the sandboxed browser check run before GPU allocation. Installed tools are reused.
5. Watch the actual stages and the expandable activity log: local tools, Kaggle queue, runtime download, model loading and connection. The **Cancel setup** button cancels startup and requests shutdown of any confirmed notebook. An uncertain launch is never automatically retried.
6. OpenCode opens in its own interactive terminal once Qwen is ready. You can then close setup and keep coding. Exit OpenCode, or choose **Stop notebook** in setup, to request notebook shutdown.

This interface is served only on loopback, uses a private per-launch capability and a separate one-use terminal handoff, and keeps tokens out of URLs, process arguments and logs. The hosted download page never receives your token. The fixed Kaggle settings link opens in your normal browser for sign-in; login and token creation stay under your control. Closing setup during startup requests cancellation after a short reload grace period. After the coding terminal opens, that terminal owns the notebook lifetime. A failed local tool or browser check starts no GPU notebook.

The terminal-only guide remains available with `node opencode.mjs --setup`. Direct command-line arguments on **Start Qwen OpenCode.cmd** retain the existing advanced behavior.

## Your first task

When OpenCode opens, type this and press Enter:

> List the files in this folder and explain what this project does. Don't edit anything yet.

For a browser check, ask:

> Use the browser to open https://example.com and tell me its heading.

Review any tool approval before accepting it. The configured model is `personal-kaggle-qwen/qwen3.8-hauhau`; build, plan, title, summary and compaction all use that same hosted Qwen. No other AI provider is enabled. Exit OpenCode when finished so the connector can request notebook shutdown.

## Visible thinking and long work

The coding agents use **Balanced reasoning** by default. Qwen's reasoning is streamed separately from the answer and tool calls, so it appears as OpenCode thinking blocks. This update expands thinking once in each isolated Qwen project/account profile; a later explicit collapse is remembered. Use **`/thinking`** to collapse or expand it. That command changes display only. Short title, summary and compaction helpers still use the same Qwen, with thinking off so their output budget goes to the actual title or saved notes.

**Automatic context compaction is enabled.** Before the 98,304-token window fills, OpenCode asks the same Qwen to summarize the session and then continues automatically. The prompt preserves your current goal, constraints and corrections, exact file paths, changes, test results, unresolved errors and next steps. The latest two turns are kept verbatim when they fit the 16,384-token recent-history budget; older tool history is not aggressively pruned. OpenCode still shortens each older tool result to 2,000 characters in the summary request, so important details in an omitted suffix may need to be read again from the project or original local session. The profile reserves 12,288 tokens for reply and protocol overhead and allows up to 8,192 output tokens per model turn. Compaction extends a conversation across turns; it cannot make one uninterrupted thinking pass infinite or guarantee perfect recall. Original local history remains saved, so important details can be reviewed. Large tool results can still require another compaction or a smaller targeted read.

If a confirmed model turn spends its entire output budget on thinking without answering or calling a tool, the relay makes **one** finishing pass with thinking off, using the same Qwen and saved reasoning. It uses measured token counts to reserve space; transport failures and Stop never authorize a replay. A second empty result remains an explicit failure. Repeated tokenizer overflow cannot compact forever: after two failed recovery attempts, automatic retries stop and ask for a smaller latest prompt or tool read. A successful main response clears that failure streak.

Close the old connector and launch this updated copy once. Its fresh personal notebook advertises the longer request transport; an older running notebook returns an explicit restart instruction rather than silently retaining the old timeout.

The connector sends a scoped keep-alive while its owning terminal window remains open, including startup, tool execution and approval waits. Exit OpenCode or press Ctrl+C to stop the heartbeat and request shutdown of that personal notebook. Startup and individual model requests can wait for up to **two hours**. If the connector crashes or loses its connection, a two-hour idle safeguard is the backstop. Kaggle can still stop a notebook because of its own session, GPU-quota or availability limits; the connector cannot extend those platform limits. Closing a terminal abruptly can prevent a shutdown acknowledgement, so confirm its state in Kaggle.

## Website and Windows EXE

You can keep the Heretic Qwen website and local OpenCode open together. Their chats and session controls are separate. The website uses its configured website notebook; this connector starts your private `qwen-agent-*` notebook. That can allocate two GPU notebooks, and Kaggle's account concurrency or remaining quota can prevent the second one from starting. They do not automatically share one GPU or one conversation.

On Windows, the connector already runs the native **`opencode.exe`** from the reviewed OpenCode 1.19.5 package. No local Qwen model is installed. The separate official **OpenCode Desktop GUI** is another application: the separate desktop application uses a shared background service, different API/configuration handling and a process lifecycle that can continue after its window closes. It is **not supported by this connector release**. Passing its GUI executable to `--opencode-bin` fails the version check before allocating a GPU. This guide does not change the desktop app's global profile or attach its shared service to your personal token.

## Remembered token and account changes

Windows remembers the token encrypted with **DPAPI CurrentUser** under your local `.qwen` folder. It is not a plaintext token file and can be decrypted only in the supported Windows user/machine context. The token is never placed in OpenCode config, model messages, browser URLs or the child process environment. Other operating systems have no plaintext-storage fallback and may require token entry again.

Use `--no-remember-token` to bypass both saved-token loading and saving for a launch. To remove the saved token before switching Kaggle accounts or replacing a revoked token, run:

```powershell
node opencode.mjs --forget-kaggle-token
```

This removes only the local saved credential and starts no notebook. It does not revoke your token in Kaggle or delete saved notebooks. Then double-click the launcher and enter the new account's token. GPU consent remains separate on every launch. An explicit `--kaggle-token-file` takes precedence and does not get copied into the remembered-token store.

Guided setup is also available from a terminal:

```powershell
node opencode.mjs --setup
```

## Direct and advanced launches

Install Node.js with npm first. From the extracted `qwen-local-agent` folder (the folder containing `opencode.mjs`), an explicit first installation is:

```powershell
node opencode.mjs --install-opencode
```

This explicit option downloads the pinned OpenCode **1.19.5** CLI into `~/.qwen/opencode-tools`. Subsequent launches need no installation option:

```powershell
node opencode.mjs
node opencode.mjs --folder "C:\Projects\my-app"
```

On Windows, double-clicking `Start Qwen OpenCode.cmd` starts guided setup. Supplying command-line arguments keeps the direct CLI behavior; use `--setup` explicitly to combine flags with the guide. An existing native OpenCode 1.19.5 executable can be selected with `--opencode-bin PATH`; `.cmd`, `.bat` and PowerShell wrappers are deliberately not evaluated. OpenCode 2 uses a different configuration schema and is not accepted by this reviewed launcher.

The launcher checks the folder and local tools before asking for a credential. Enter **your own** modern Kaggle API token (`KGAT_…`) at the hidden prompt, then explicitly consent to allocating your own GPU notebook. The token goes only to the fixed personal-session bootstrap endpoint over HTTPS. It is never added to OpenCode's configuration, model messages or process environment. A private token text file can be used with `--kaggle-token-file PATH`; protect and remove that file yourself. `--consent-kaggle-gpu` is the explicit noninteractive consent option.

The launcher waits for the personal notebook and Qwen model to become ready before starting OpenCode. Cold starts may download runtime/model files inside Kaggle. It prints a safe launch reference; reuse `--launch-id REFERENCE` only when explicitly retrying an uncertain launch, after checking your notebooks. There is no fallback to the owner's account or saved owner relay configuration.

## Approvals and local tools

Ordinary file reads and file discovery may run automatically. Known credential file names and credential directories are denied by the file-read/edit rules. Edits, writes, shell commands, content search, external directories, web fetches and browser actions ask for approval. Plan and Explore deny the dedicated editing tools; shell commands still ask for approval and an approved shell command can change files. External AI/search providers, default plugins, project OpenCode configs and external skills are disabled. The launcher never passes `--auto`.

These are OpenCode's approval rules, not an operating-system sandbox. Review shell and search requests carefully: an approved command has your local OS permissions and can read files that the dedicated read tool would deny. Do not put credentials in prompts or approve commands that expose them. The launcher also disables project instruction discovery with the project config isolation flag; describe any project-specific rules in your prompt.

## Browser and web-search tools

Guided setup automatically configures the official Microsoft Playwright MCP, with approval before installing missing packages. It can browse websites and perform searches through a search engine's website; all reasoning stays on your hosted Qwen. No external AI search provider is enabled. Use `--setup --no-browser` to opt out. Advanced direct launches can install its pinned package explicitly:

```powershell
node opencode.mjs --install-browser --with-browser
```

Then use `--with-browser` on later launches. On Windows the launcher prefers an installed official Chrome, then Edge, each in a fresh isolated profile. It falls back to the pinned Chromium package if neither is installed; other platforms default to Chromium. The launcher opens a disposable blank page with its sandbox enabled **before** asking for your token or allocating a GPU. A failed browser check stops the launch.

Choose a supported browser explicitly when needed:

```powershell
node opencode.mjs --with-browser --browser chrome
node opencode.mjs --with-browser --browser msedge
node opencode.mjs --install-browser --with-browser --browser chromium
```

`--install-browser` installs Chromium only when Chromium is selected. An installed Chrome or Edge is reused as an executable, without reading your existing browser profile or logged-in tabs. The pinned MCP package is `@playwright/mcp@0.0.84`; enabling the browser never invokes `npx` or installs packages automatically. Browser tools run locally with `--isolated`, explicit `--sandbox`, `--no-webmcp` and image responses omitted. They use a fresh temporary browser profile without CDP, an extension, stored login state or an existing browser profile. They require no browser API key. Screenshots/downloads stay in the temporary browser output folder until this launch closes. Browser content returned by MCP can reach your Qwen session. Page JavaScript evaluation, arbitrary browser code, file upload and drag/drop tools are denied; other browser actions ask for approval. Standard browser typing may enter text into editable fields, so review those requests.

The installed official Chrome and Edge channels passed local navigation/snapshot checks with the sandbox enabled on this Windows host; Chrome also passed in the normal visible mode. The bundled Chromium build still reports `Target crashed` here. If your selected browser fails preflight, choose an installed Chrome or Edge, or launch without `--with-browser`; the launcher keeps the sandbox enabled.

## History and shutdown

Local OpenCode conversations, tool outputs and session state persist under `~/.qwen/opencode-projects/<project-and-account-hash>`. The namespace depends on the real selected folder and your Kaggle username, so a fresh personal notebook can resume the same local conversation without sharing history between accounts. Use OpenCode's session selector, or:

```powershell
node opencode.mjs --folder "C:\Projects\my-app" --continue
node opencode.mjs --folder "C:\Projects\my-app" --session ses_example
```

`--state-dir PATH` changes this history location; `--tools-dir PATH` changes the package installation location. Keep history private: prompts and tool outputs may contain sensitive project text. The launcher does not intentionally write either Kaggle credentials or scoped relay keys to its config or history. Only the spawned OpenCode process receives its current scoped relay key; local browser MCP receives an empty override for that key.

Each run uses its own temporary config, config home and browser directory. It does not overwrite global or project OpenCode settings. Existing managed/admin OpenCode configuration causes a preflight failure, because those settings could override the Qwen-only provider and approval rules.

Each new personal session saves a separate `qwen-agent-*` notebook in Kaggle. Stopping its run does not delete that saved notebook. Old stopped agent/test notebooks are cleanup candidates after checking that they are not active or queued. Keep the main website server and model-cache dataset; automatic notebook deletion is not part of setup.

Exit OpenCode or press Ctrl+C to stop the owned local process and request shutdown of **that personal Kaggle notebook**. Cancellation during bootstrap waits for the launch identity and then records shutdown, including queued starts. Confirm the notebook has stopped in Kaggle; a closed terminal, machine crash, lost connection or rejected shutdown cannot guarantee immediate GPU release. Local conversations remain saved; temporary config/browser data is removed on normal cleanup.

## Maintainer verification

Mocked tests do not allocate a Kaggle notebook:

```powershell
node --test client/agent/test/opencode.test.mjs
```

The reviewed integration uses the [OpenCode 1 CLI/environment contract](https://opencode.ai/docs/cli/), [config precedence](https://opencode.ai/docs/config/), [OpenAI-compatible provider](https://opencode.ai/docs/providers/), [permissions](https://opencode.ai/docs/permissions/), [local MCP configuration](https://opencode.ai/docs/mcp-servers/) and [official Playwright MCP](https://github.com/microsoft/playwright-mcp). Pin changes require revalidating effective configuration, provider isolation, approval behavior and child/cloud cleanup against the actual CLI.


## Model selection — Hugging Face GGUF only

The default remains your Qwen 27B Q5_K_P at 98,304 context. Open **Model** in the guided setup to enter an optional public Hugging Face repository or a complete single-file `.gguf` link. **Hugging Face GGUF only**: Ollama library links, other hosts, private/gated files, authentication tokens in URLs, safetensors and split GGUF shards are not supported. A repository link selects Q4_K_M first, then Q5_K_M, Q6_K or Q8_0 if available. The selected file must be between 100 MB and 24 GB and advertise Ollama chat and tool-calling capabilities.

The connector validates public metadata before asking Kaggle to allocate a notebook, pins the file revision/digest and verifies its checksum before import. It keeps the internal relay model alias for compatibility but imports the selected file, with no default-model fallback. Custom context is measured at 32K, 24K, 16K or 8K up to the model's advertised training limit. OpenCode's input/output and compaction budgets use the actual loaded context. Thinking is disabled for a model that does not advertise it. Approval rules, personal-account isolation and two-hour request controls remain in force. Leave the link empty to restore the default Qwen. CLI equivalent: `node opencode.mjs --setup --model-url https://huggingface.co/OWNER/REPO`.

## Startup troubleshooting

The activity view records changed stages and new log lines, rather than appending the same polled status. While starting, the local connector checks Kaggle's actual notebook status at most once every 30 seconds using the token only in private process memory; it drops that reference after readiness or cancellation. Queued, running-without-Python-output and model loading are distinct states. A terminal Kaggle error stops waiting and links you to the notebook logs; it does not start another notebook.

If a launch limit is reached, check existing notebooks. To replace a stale token or connect a different account: choose **Forget saved token**, enter a new token, then retry. Generating a replacement token for the same account does not reset its cooldown, daily launch counter or Kaggle GPU quota. Cancel an existing setup before switching accounts. The troubleshooting panel stays readable while startup is in progress.

A local PC model folder cannot be mounted directly by Kaggle. Setup automatically prepares an owned private model/runtime Dataset on CPU, then attaches its ready pinned version to the GPU notebook. Default Qwen and custom Hugging Face models have separate caches. Other accounts never inherit a private owner cache. Download reuse does not remove GPU queueing or loading.

## Automatic private cache and working-note continuity

Setup first checks your own private cache. If missing, one reusable CPU builder downloads and verifies the selected model/runtime, uploads the files, and creates a private Dataset in your account. The GPU notebook starts only after Dataset readiness and identity checks. Later starts reuse it. Different immutable models have separate caches. Dataset storage and CPU availability still apply. Cached custom GGUFs retain checksum, import, tools, thinking and context checks. Keep the Dataset to retain cache reuse.

Working notes now travel in ordinary model-visible content across tool rounds and finishing calls. This avoids the native runtime dropping the separate historical thinking field. Notes remain unverified; actual tool results establish completed actions. Known runner/tool-format errors get one bounded recovery under the original deadline, without releasing failed actions. Token reporting retains completed thinking usage. Unknown failures and context limits remain explicit rather than retrying indefinitely.
