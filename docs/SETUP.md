# Deploy your own workspace

Requirements: Node.js 20+ with npm, Python 3.10+ for packaging/tests, a Cloudflare account with Workers/D1/R2 access, and your own eligible Kaggle or Colab account. Follow provider rules and current plan limits.

## 1. Create Cloudflare resources

From `worker/`:

```sh
npm ci
npx wrangler login
npx wrangler d1 create qwen-chats
npx wrangler r2 bucket create qwen-images
```

Edit `worker/wrangler.toml`: choose a unique Worker name, put the database ID returned by **your** create command into `database_id`, and use **your** bucket/database names. No maintainer resources are configured.

```sh
npx wrangler d1 migrations apply qwen-chats --remote
npx wrangler secret put RELAY_KEY
```

Generate your own long random workspace key and enter it at Wrangler's hidden prompt. Do not put it in source, a command argument, a screenshot or Git. `AUTH_MODE="key"` protects website API access by default. Website users with that workspace key share that deployment's website history; use separate deployments for separate private workspaces.

Optional: to start the website owner's Kaggle notebook using the website Start button, create the owner's Kaggle API token and save it using `npx wrangler secret put KAGGLE_API_TOKEN`. The local-agent per-user flow instead asks each user for their own token, transiently authenticates it, and has no owner-credential fallback.

## 2. Deploy and configure downloads

```sh
npx wrangler deploy
```

Copy your own deployment origin from Wrangler, then:

```sh
npm run configure -- https://YOUR-WORKER.workers.dev
npx wrangler deploy
```

The configure command writes ignored `client/agent/deployment.local.json`, rebuilds the configured agent ZIP and Colab download, and leaves the public `deployment.json` template blank. The second deploy publishes those configured assets. Source ZIPs in this repository stay unconfigured; a visitor should download the configured connector from their own deployed website.

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and use only your own development secrets. That file is ignored and should never be committed. Follow the same resource configuration with local migrations when running Wrangler locally.

## 3. Run a website model notebook

Kaggle: use the website Start control with your optional owner API secret, or import `notebooks/kaggle.ipynb`, provide your deployment origin/relay key, select the required GPU configuration and Internet access, and run it privately. Background committed runs differ from interactive sessions; confirm GPU shutdown in Kaggle when finished.

Colab: download the current configured Colab notebook from your deployment, or upload `notebooks/colab.ipynb`. Set your relay origin in `COLAB_CONFIG`, provide `QWEN_RELAY_KEY` through Colab Secrets or the hidden prompt, choose an available GPU and keep the runtime connected. Free Colab has usage restrictions; consult its FAQ. A new Colab VM does not mount Kaggle Datasets and may download files again.

`COLAB_URL` may point to **your own** private notebook for the website's Open Colab shortcut. The default template opens Colab's homepage and contains no personal Drive link.

## 4. Set up the local coding agent

Open `/agent/` on your deployed website and download the configured ZIP. Extract it; on Windows double-click `Start Qwen OpenCode.cmd`. Install Node.js if needed, select a project, allow missing reviewed tools, enter your own Kaggle token and confirm cache/GPU use. Other supported systems can run `node opencode.mjs --setup` from the extracted helper.

The first setup prepares your private cache using a CPU notebook. The GPU session starts after the Dataset is ready. Later starts reuse that Dataset. Private/gated or unsupported model sources are rejected; optional links support public Hugging Face complete GGUF files only. Your notebook and Dataset links appear in setup activity.

Read the bundled `README.md` and `OPENCODE.md` for approvals, history, browser isolation, continuing sessions, token replacement and shutdown.
