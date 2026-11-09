# Website context and serving profile

Current update (29 October 2026): durable structured memory and Finish answer are deployed
on Worker `c0033f66-7f0a-481f-a01c-08405f3565b2` with Kaggle notebook version 13.
181 automated tests and real-model recall after two compactions passed. Previous notes stay
verbatim; new corrections append chronologically. See [robust compaction](ROBUST_COMPACTION.md).

The earlier rollout evidence follows.

Status: deployed and live verification complete on Worker
`0d36e0c5-f961-46c4-b6dc-20823f9e2079` and cached Kaggle notebook version 12.
The same 27B model runs at 98,304 total context with batch 256, entirely on GPU.
Fresh chat, vision, an 87,211-token input replay and manual near-full browser compaction passed.
Source and operator notes are synchronized; final source checks passed.

The website refreshes context copy from the registered server and distinguishes input
estimates from measured usage. Offline status does not claim an active capacity. The counter
includes the draft, documents, pictures, instructions and reply reservation, and reports omitted history.

## Compact session and Cloudflare storage

The manual Compact session button summarizes older conversation with the same model and
keeps the two latest user turns in full. Original messages, attached files, search and exports
remain saved. The global generation lock and Stop apply to compaction. Failed, cancelled or
unhelpful summaries preserve the previous checkpoint. Editing covered messages invalidates it.

Cloudflare D1 stores the full transcript and compacted memory. Subsequent requests send that
memory plus recent turns within the model's input budget. Repeated compaction supports continued
conversation beyond one window, with lossy summaries rather than infinite active context or
perfect recall. Stored transcripts and model attention have separate limits.

The old saved history preference was 60,000 characters, roughly 20K tokens; it is now Automatic.
At 98,304 total tokens, automatic thinking reserves 24,576 reply tokens and 1,024 overhead,
leaving 72,704 estimated input tokens. With thinking off, the default input allowance is 93,184.
Document uploads retain a separate limit of 120,000 characters across 10 files.

## Measured GPU profile

The same 27B Q5_K_P weights, BF16 vision projector and q8_0 KV precision were tested on two T4 GPUs.

| Context | Processing batch | GPU fit | Short math/reasoning/vision |
|---:|---:|---|---|
| 81,920 | 512 | 66/66 layers | Pass |
| 98,304 | 512 | 65/66 layers | Excluded |
| 98,304 | 256 | 66/66 layers | Pass |
| 131,072 | 256 | 65/66 layers | Excluded |

The selected profile returned the same correct beginning/middle/end codes as baseline on an
identical 51,298-token synthetic input. Final live verification also completed with 87,211 measured
input tokens. These checks establish fit and the tested responses, not accuracy on every long task.
No numerical precision was reduced. The learned fit includes model/runtime/cache identity, batch,
KV precision and GPU shape; transient load exceptions clear the claimed profile identity.

Startup, browser chat, continuation, compaction and ordinary raw requests carry batch 256.
Explicit raw-client options remain authoritative. Large, compressed or unparseable raw requests
retain direct pass-through; those clients should specify `options.num_batch:256` for this profile.

## Resumable inference and final live replay

A notebook job owns the Ollama request independently of tunnel connections. The Worker reads
finite 15-second NDJSON legs until the first model record, then 90-second legs, resuming the
same authenticated job and cursor after a dropped leg. Complete records are delivered once;
partial envelopes are fetched again. Raw JSON text, including int64 values, remains intact.
Nonstream and ineligible raw requests retain the synchronous path.

Each GET has a 30-second header deadline. Tunnel rotation recovery uses GET for the existing
job, never a replacement inference; a new server's missing job is fatal. Stop/disconnect sends
DELETE to the last confirmed owner. Idle/runtime/output bounds cover abandoned work.
Compaction chunks share a request budget, and the four-MiB assembled payload allowance remains.

Two controlled 87K replays using initial 90-second prefill legs failed at about 122.7/122.9 seconds
with `stream_unreachable`: POST acknowledgement succeeded, but no GET heartbeat or model data
arrived. A same-size 303,234-byte padded request with a 16-token prompt passed in 15.6 seconds,
excluding deterministic upload size as the cause. Shortening silent prefill legs to 15 seconds
then passed the actual 87K replay. Buffering is an inference about the cause; these observations
do not establish a documented universal Cloudflare cutoff.

The final replay completed with 87,211 input and 48 reply tokens, all three exact retrieval codes,
98,304/batch 256, full GPU loading, `truncate:false` and `shift:false`. Headers and first chunk
arrived in 16,649 ms, first model output in 322,593 ms, and completion in 331,356 ms. It delivered
43 heartbeats and 711,099 bytes. Fresh chat and vision passed under the same validation lock.
The temporary chat was deleted and the lock released without error.
Evidence: `work/expanded-context-smoke-results.json`.

## Startup and validation

Notebook 12 hit the text, runtime and all four image caches. Runtime startup took 26 seconds;
server readiness took 331 seconds with all 66 layers on GPU. The startup picture check answered
Red. Evidence: `work/version12-startup-safe.json` and `work/profile-smoke-results.json`.

Startup safeguards allow a ten-minute Ollama load stall, retain bounded redacted HTTP-error JSON,
and clear `PROFILE_ID` after load exceptions. Future starts explicitly use `shift:false` for
startup and vision to match website requests and avoid the documented runner reload when options
differ. Notebook 12 began on the previous startup script and was not restarted; current live app
requests with `shift:false` were verified.

- Final frozen npm suite: 168 passed across 17 suites, zero failures/skips/cancellations,
  223,260 ms. Evidence: `work/context-project/jobs-final-prefill-test.log`.
- Adapter coverage includes four new finite-prefill-leg regressions. Startup runtime checks:
  eight passed, two Windows symlink checks skipped; Python compilation passed.
- Earlier Python jobs integration: 23 passed; base streaming proxy: 22 passed;
  Kaggle Linux filesystem: 17 passed. Offline real-cache verification also passed.
- Manual real-browser Compact session passed on an owned near-full fixture. UI input estimate:
  70,399 to 23,829; API preview: 70,468 to 23,898. Eight older messages were summarized and
  four recent messages retained in full. All 12 original messages remained SHA256-identical,
  and recall of ORBIT_913 passed. The fixture was deleted after its recall turn, with 14 messages.
  Evidence: `work/manual-compact-ui-results.json`, `outputs/manual-compaction-before.png`
  and `outputs/manual-compaction.png`.
- Earlier browser Stop checks preserved the prior checkpoint; original transcript/search/export
  behavior and capacity refresh passed.

Final verification and credential/debug cleanup are complete. Seven exact temporary credential,
upload and notebook-metadata artifacts were deleted; the upload probe was archived. The private
D1 backup is preserved. Source synchronization reported zero pending code updates with the
local image selection intact. Operator notes are synchronized and final source checks passed.
