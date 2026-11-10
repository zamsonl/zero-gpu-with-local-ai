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
| Launch cooldown or GPU quota | Check the stated source and wait time. The connector's launch guard and Kaggle's own limits are different. Retry the saved launch reference to reconcile an uncertain start; do not delete notebooks or the cache as a routine restart step. A new token for the same account does not reset limits or GPU quota. |
| Token explicitly rejected, stale or from another account | Forget the saved token before entering a replacement or switching accounts. A notebook refusal is not automatically proof of a bad token; check its operation and HTTP status. |
| A notebook was accepted, then status polling returned 403 | Update the relay and helper. Older versions used a fixed title with a different requested slug; Kaggle created a title-derived name while the connector polled an invented URL. New titles match their unique slugs, returned notebook identities are validated and saved, and older identities are repaired only when their scoped launch secret matches. A status-probe403 no longer rejects the token or shuts down an accepted launch; authenticated startup progress continues under the existing timeout. [Kaggle title/slug contract](https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md) |
| `GetKernelSessionStatus` returns 403 after deleting an old coding notebook | Repeating Retry cannot distinguish a deleted notebook from a private/inaccessible one. Update and reopen the helper. If you deleted the old coding notebooks and checked that none are running or queued, use the explicit recovery checkbox, then check the same launch. Recovery verifies the complete authenticated account inventory and zero reserved GPU time before retiring eligible legacy tracking. Existing notebooks, ambiguous accepted launches, unavailable checks and active local session signals remain blocked. No Kaggle notebook or cache is deleted by recovery. |
| Token is requested again after a failed GPU start | The updated helper remembers a manually entered token after the authenticated cache check succeeds, before requesting the GPU notebook. Windows encryption and the remember-token choice still apply; rejected tokens and failed cache checks are not saved. |
| Thinking repeats after a tool | Use the current relay/connector. Historical working notes and tool IDs/results are preserved. Old in-flight requests retain their old implementation. Compaction remains finite; inspect saved history when an important detail is missing. |
| Memory or model runner error | Errors have separate safe reason codes. One known recoverable model error can be retried automatically; persistent failures, unknown streams and memory exhaustion stop explicitly. Check notebook/runtime logs. |
| Long context stalls | Native automatic compaction uses the same model. Repeated failures are bounded. Huge latest prompts/tool results may need splitting or a smaller targeted read; cloud storage cannot enlarge one model context. |
| Updated web chat asks to restart the notebook | Restart using the updated Kaggle/Colab notebook. Old notebooks reject five-minute resumable legs; the relay does not restart their inference silently. Reopen the local helper after updating it. |
| A long request reaches its limit | Advanced model jobs allow up to two hours per generation, with finite context and connection budgets. Saved transcripts remain available. This does not guarantee uninterrupted hosting or perfect recall; see [long sessions](ARCHITECTURE.md#long-sessions). |
| Colab disconnects | Check available hardware, runtime limits and permitted use in Colab's official FAQ. A fresh VM needs downloads again. |
| Window closed but GPU might be running | Check Kaggle and stop the corresponding session. A lost shutdown acknowledgement is not proof that allocation ended. |

## Notebook cleanup

Completed/stopped old `qwen-agent-*` sessions and disposable verification/probe notebooks are candidates after confirming they are not running/queued and contain no outputs you need. Keep the active serving notebook. One reusable `heretic-agent-cache-build-*` CPU notebook is used by current setup; deleting it is unnecessary and setup can recreate it. Keep the private **Dataset** to retain cached files. A historical one-time builder notebook is not the Dataset itself. Nothing in setup automatically deletes users' notebooks or Datasets.
