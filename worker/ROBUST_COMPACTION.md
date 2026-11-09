# Durable compaction and long-reasoning recovery

## Follow-up audit hardening — 29 October 2026

The audit reproduced a case where an empty model extraction advanced past a newly corrected
port despite adding no memory. Empty and duplicate-only extraction now retry within a fixed
limit and then fail without changing the checkpoint. Genuinely filler-only chunks may therefore
refuse compaction instead of being marked covered without useful evidence.

Source chunks now carry JSON message fragments with role, message ID, original offset and
bounded preceding context. Word/paragraph cuts and provenance survive smaller retries, protecting
exact identifiers and nearby negations. Original source text is reconstructable from fragments.
The extraction instruction explicitly prioritizes user requirements over rejected assistant
suggestions, preserves multilingual preferences, and distinguishes failed, pending and completed
work. This is still model judgment; schema validation cannot establish truth or completeness.

Context preview is prepared before writing the checkpoint. A dropped browser connection now
reports uncertain completion and refreshes context instead of claiming that nothing was saved.
The interface also states that important image details need a text description: compaction
does not analyze image pixels. Originals remain saved but are not automatically retrieved.

The original release record below predates these audit changes.

Release: 29 October 2026 (Asia/Kuala_Lumpur). Worker
`c0033f66-7f0a-481f-a01c-08405f3565b2`, using cached Kaggle notebook version 13.
The same 27B Q5_K_P model runs at 98,304 context, batch 256, fully on GPU.

Compaction now extracts structured notes for goals, constraints, decisions, exact facts,
code and files, next tasks, and corrections. Each successful update preserves the previous
memory verbatim and appends distinct new notes with source ranges. It no longer repeatedly
rewrites a lifetime of notes into one short summary. Later explicit corrections take
precedence over earlier statements.

The model receives bounded source chunks and a closed thinking prefix through raw generation.
JSON-schema output and validation reject malformed notes, placeholders and reasoning text.
Only a completed, useful update that saves input space is committed. Token overflows and
truncated extraction retry smaller chunks within fixed limits. Stop, invalid output, concurrent
edits and failed requests preserve the prior checkpoint and all original messages.

Durable memory has a context-dependent safety budget, up to 60,000 characters at the current
profile. If new notes cannot fit, the operation reports the limit and keeps the previous
memory; it does not silently delete saved facts. Initial extraction remains a model judgment,
so this is not a guarantee of perfect recall of every detail. The full original transcript
remains searchable and exportable.

Finish answer is available on an unfinished reply with reasoning. It closes thinking mode,
omits the old reasoning from the next model request, and uses a bounded answer allowance.
The original reasoning remains saved, and the answer appends to the same assistant message.
Ordinary Continue retains its existing behavior. For a huge unfinished thought in a short
chat, use Finish answer; compaction keeps the two most recent user turns in full.

Verification: 181 automated tests passed with zero failures or skips. This includes repeated
memory preservation, exact values and paths, correction ordering, invalid/truncated output,
Stop and editing behavior, and oversized-reasoning recovery. Real-model quality verification
also passed: a 140,000-character thought was preserved while Finish answer produced the answer;
two compactions preserved previous memory and all 20 original messages; recall returned the
exact project code, latest corrected port, budget, branch, path, deadline and model constraint.
Compactions took 31.25 and 18.00 seconds. Both synthetic chats were removed. Evidence:
`work/memory-quality-live-results.json` and `work/context-project/reasoning-memory-tests.log`.
Existing user chats were untouched. Final source synchronization and whitespace checks passed.

The fixes run in the Cloudflare Worker and apply to the running Kaggle session immediately.
Kaggle version 13 was saved and launched through the existing app. Startup hit every model
and runtime cache, loaded all 66 layers on GPU, and became ready in 441 seconds.
