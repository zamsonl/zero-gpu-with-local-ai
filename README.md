# Zero GPU with Local AI

![Zero GPU with Local AI — your Qwen workspace, without a local GPU](docs/media/hero.svg)

Run **Qwen on Kaggle or Colab**. Chat in your browser, work with documents and images, or use **OpenCode on your PC** to edit files, run commands and browse the web.

**[Deploy your workspace →](docs/SETUP.md)** · **[Set up local coding →](docs/SETUP.md#4-set-up-the-local-coding-agent)** · [Download the source](https://github.com/zamsonl/zero-gpu-with-local-ai/raw/main/DOWNLOAD%20ME.zip)

<picture>
  <source media="(max-width: 600px)" srcset="docs/media/chat-mobile.png">
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/chat-dark.png">
  <img src="docs/media/chat.png" alt="Actual Qwen browser workspace showing readable code, a reasoning control and context usage, with example conversation data">
</picture>

*Actual interface with example conversation data. [Mobile preview](docs/media/chat-mobile.png).*

Requires your own Cloudflare deployment and eligible Kaggle or Colab account. GPU access and free-tier allowances depend on the providers.

## Chat, read, create

Stream answers and thinking, attach documents or pictures, and generate images. Adjust text size, chat width and the composer to suit your screen.

| Talk through a task | Work with files | Keep longer conversations useful |
| --- | --- | --- |
| Choose a thinking mode or use **Answer now**. | Attach documents and images; opt into processing oversized text. | Track context, compact manually or automatically, and retain working notes. |

Compaction uses your hosted model. Original history stays saved, but summaries can lose details and the model's context remains finite.

## Bring Qwen to your projects

![Actual guided local coding setup showing an example project path, an empty token field, browser tools and private cache stages](docs/media/local-setup.png)

*Actual setup interface. Example project; no account or token shown.*

Select a project, connect your Kaggle account, and open OpenCode. Guided setup handles local tools, isolated Playwright tools and encrypted token storage on Windows. Local coding uses Kaggle; Colab is available for browser chat.

First setup builds your **private model/runtime cache on CPU**, then starts the GPU. Compatible later starts reuse the Dataset; GPU queueing and memory loading still take time.

Each coding-agent user uses their own Kaggle account and allocation. Local coding history stays on their PC; website chats have separate cloud history and model sessions.

## Start here

| What you want | What to do |
| --- | --- |
| **Browser chat** | [Deploy your Worker](docs/SETUP.md), then start your model notebook. |
| **Local coding** | Download the configured ZIP from `/agent/` on your deployed website. Extract it and open `Start Qwen OpenCode.cmd` on Windows. |
| **Manual notebooks** | [Kaggle](notebooks/kaggle.ipynb) or [Colab](notebooks/colab.ipynb), using your relay URL and key. |
| **Contribute or test** | [Development guide](CONTRIBUTING.md); tests need no GPU. |

Deployment needs Node.js 20+, Python 3.10+ for packaging/tests, and Cloudflare Workers/D1/R2. The source ZIP is unconfigured; get your working connector from **your deployed website**. GitHub Pages alone cannot run the backend.

## How it fits together

![Your browser and local OpenCode tools connect through your Cloudflare relay to your cloud GPU; local-agent model files are reused from a private Kaggle Dataset](docs/media/how-it-works.svg)

Your Worker connects the interface to the model notebook. D1 stores website history/memory; R2 stores pictures and opt-in long-input source text. App source: [`worker/public/`](worker/public/) and [`worker/src/`](worker/src/).

[Architecture](docs/ARCHITECTURE.md) · [Privacy and credentials](docs/PRIVACY.md) · [Troubleshooting and notebook cleanup](docs/TROUBLESHOOTING.md)

<details>
<summary><strong>Models, context and custom GGUF support</strong></summary>

- **Kaggle:** Qwen 27B Q5_K_P with 98,304 tokens of total context, shared by input and replies, on the required GPU configuration.
- **Colab:** the smaller Qwen 9B Q6_K model attempts 32K, 24K, 16K or 8K context according to measured full-GPU fit. Available hardware is not guaranteed.
- **Optional local-agent models:** public Hugging Face complete GGUF files only. Revisions/checksums are pinned and tool/context capabilities are checked. Private, gated and unsupported sources are rejected; another model is never silently substituted.
- Image generation uses a separate Qwen-Image mode and shares the notebook's GPU with chat.
- The reviewed coding connector uses **OpenCode 1.19.5 CLI**. It does not configure the separate Desktop GUI.

Historical working notes, native tool IDs and actual results are preserved across tool rounds. Notes are unverified plans rather than proof of execution. Continuation and recovery are bounded; persistent model, context or transport failures can still stop work. No external AI provider handles titles, compaction or browser planning.

</details>

<details>
<summary><strong>Privacy, permissions, costs and runtime limits</strong></summary>

Deploy your own resources and keep notebooks private. The public template contains no maintainer service URL, account bindings, tokens or chat history. Website users sharing a workspace key share that deployment's website history; separate deployments provide separate workspaces.

The local-agent token is sent to your configured relay for your account's operations, not to the model or notebook source. Model caches contain upstream files and licenses, not conversations or project files. Keep the private cache **Dataset** if you want later starts to reuse its files. A new Colab VM does not mount Kaggle Datasets and may download files again.

Terminal tools run with your OS user's permissions: selecting a folder does not create a shell sandbox. Review approvals and keep project backups. See [privacy boundaries](docs/PRIVACY.md) and [security guidance](SECURITY.md).

Kaggle and Colab control GPU queues, quotas and session lifetimes. Confirm notebook shutdown when finished; closing a tab or stopping a reply does not prove GPU allocation ended. Colab's free managed runtimes restrict some web-service/UI uses; read its [official FAQ](https://research.google.com/colaboratory/faq.html).

Cloudflare services have plan limits and optional billable usage. Review [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Unlimited or permanently free hosting is not guaranteed.

</details>

## License

Project code is [MIT](LICENSE). Model weights are downloaded from upstream and retain their own licenses; they are not bundled in this repository or its ZIPs. See [third-party notices](THIRD_PARTY.md).
