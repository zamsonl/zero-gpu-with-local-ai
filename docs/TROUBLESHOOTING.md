# Troubleshooting

## Quick Start

Use [the three-step guide](QUICKSTART.md). If Offline appears, run the notebook and paste its newest whole link. If the key is rejected, use the newest notebook output; the connection key is not a Kaggle API token. Downloading model files again and the absence of compaction/coding tools are expected in Quick Start. Use [Advanced Setup](SETUP.md) for those features.

## Advanced Setup

| Symptom | Action |
| --- | --- |
| Setup package is not linked to a deployment | Download a configured ZIP from your own server; administrators run `npm run configure -- https://YOUR-WORKER.workers.dev` and redeploy. |
| First setup is preparing a cache | This is a CPU-only first download/verification/upload. Wait for Dataset readiness; no GPU notebook should start beforehand. Check Dataset storage and the CPU notebook if it fails. |
| Cache already exists | It is reused only if owned, private, identity/manifest verified and READY. Model revisions have separate cache identities. |
| Waiting for GPUs | Kaggle owns the queue. Repeated starts can worsen launch limits. Cache reuse does not remove queueing/loading. |
| Launch limit or rejected/stale token | Check active notebooks. Forget the saved token before entering a replacement or switching accounts. A new token for the same account does not reset cooldown/daily limits or GPU quota. |
| Thinking repeats after a tool | Use the current relay/connector. Historical working notes and tool IDs/results are preserved. Old in-flight requests retain their old implementation. Compaction remains finite; inspect saved history when an important detail is missing. |
| Memory or model runner error | Errors have separate safe reason codes. One known recoverable model error can be retried automatically; persistent failures, unknown streams and memory exhaustion stop explicitly. Check notebook/runtime logs. |
| Long context stalls | Native automatic compaction uses the same model. Repeated failures are bounded. Huge latest prompts/tool results may need splitting or a smaller targeted read; cloud storage cannot enlarge one model context. |
| Colab disconnects | Check available hardware, runtime limits and permitted use in Colab's official FAQ. A fresh VM needs downloads again. |
| Window closed but GPU might be running | Check Kaggle and stop the corresponding session. A lost shutdown acknowledgement is not proof that allocation ended. |

## Notebook cleanup

Completed/stopped old `qwen-agent-*` sessions and disposable verification/probe notebooks are candidates after confirming they are not running/queued and contain no outputs you need. Keep the active serving notebook. One reusable `heretic-agent-cache-build-*` CPU notebook is used by current setup; deleting it is unnecessary and setup can recreate it. Keep the private **Dataset** to retain cached files. A historical one-time builder notebook is not the Dataset itself. Nothing in setup automatically deletes users' notebooks or Datasets.
