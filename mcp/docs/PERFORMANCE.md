# Retrieval performance benchmark

`scripts/benchmark-retrieval.mjs` is a repeatable, privacy-safe timing harness for the
current `KnowledgeIndex` implementation. It creates a temporary Vault containing only
deterministic synthetic Markdown, runs timed queries, prints one JSON report, and removes
both the temporary Vault and its separate temporary artifact store.

This is a **benchmarking tool, not a performance guarantee or service-level objective**.
Results vary with hardware, filesystem, Node.js build, corpus shape, query mix, and gateway
implementation. The cached-query measurement uses the in-process `KnowledgeIndex` snapshot
after a complete source-metadata validation pass on every request; a separate reopened-runtime
measurement verifies and loads the current persistent
generation. Neither proves that an unchanged real Vault will always respond within five seconds.

## Run it

Node.js 20 or newer is required. The script exercises compiled production code, so build it
before running the benchmark:

```bash
pnpm run build
node scripts/benchmark-retrieval.mjs
```

Example with an explicit workload:

```bash
node scripts/benchmark-retrieval.mjs \
  --files 5000 \
  --queries 200 \
  --long-file 1000000
```

Options:

| Option | Meaning | Default | Allowed range |
| --- | --- | ---: | ---: |
| `--files N` | Number of ordinary synthetic Markdown notes | `1000` | `1`–`249000` |
| `--queries N` | Total timed searches, including the first search | `100` | `1`–`100000` |
| `--long-file N` | Character target for one additional long note; `0` disables it | `250000` | `0`–`19000000` |

`--files` does not include the optional long file. The generated notes are placed below a
synthetic `30-Shared-Knowledge/` path and explicitly marked `sensitivity: sanitized`. The
script never reads `OBSIDIAN_VAULT_PATH` and never opens a real Vault.

## Workload and timing model

The first timed query constructs the initial snapshot and attempts to publish it. The remaining timed queries
revalidate all source metadata and reuse that snapshot when unchanged; they are reported as
cached queries. One additional query creates
a new `KnowledgeIndex`, verifies unchanged source metadata, and loads the local generation if
publication succeeded; it is reported separately as `reopenedUnchangedQuery`. The deterministic query mix
contains:

- unique-token hits spread across ordinary notes;
- common two-term hits shared by most ordinary notes, which require the full eight-result page when at least eight ordinary notes exist and guard against narrowing below one result page;
- long-document tail hits when `--long-file` is enabled; and
- explicit no-hit queries that exercise safe abstention.

Each timing begins immediately before `KnowledgeIndex.search()` and ends when its promise
resolves. Vault generation is measured separately. The harness therefore measures local index
construction, verified persistent reuse, or in-memory reuse plus search and result assembly. It
does not include an MCP transport,
the editable transmission review, user approval, network access, or downstream model generation.

The five-second counter uses a strict `duration > 5000 ms` comparison. A slow result is counted
and reported, but it does not make the process exit unsuccessfully: the tool is descriptive and
does not claim that the current implementation satisfies a five-second requirement.

## JSON report

The script writes one JSON object to standard output. Important fields are:

- `workload`: requested file/query counts, actual query mix, and the `5000 ms` threshold;
- `vault`: synthetic generation time plus indexed note, chunk, and link counts;
- `timingsMs.firstQuery`: initial query time, including the first snapshot build;
- `timingsMs.reopenedUnchangedQuery`: a new runtime loading the verified persistent generation if initial publication succeeded, or rebuilding otherwise;
- `timingsMs.cachedQueries`: cached-query `p50`, `p95`, `p99`, minimum, and maximum;
- `timingsMs.cachedQueriesByKind`: the same cached statistics separated by unique, broad common-term, long-tail, and no-hit query kind;
- `timingsMs.allQueries`: the same percentiles across first and cached queries;
- `violationsOver5s`: first-query, reopened, cached-query, and total violation counts;
- `validation`: known-hit/no-hit checks plus confirmation that reopening reused the same generation.

Percentiles use linear interpolation over the sorted observed timings. Small `--queries` values
are convenient for smoke tests but are not statistically useful. Use at least 100 total queries
for a local comparison and keep the hardware, power state, Node.js version, build, and workload
arguments fixed between runs.

## Interpreting results

Use this harness to compare revisions on the same machine, not to extrapolate a universal limit.
A future five-second acceptance claim needs a separate product specification that freezes at
least:

1. the lowest supported hardware and storage;
2. maximum eligible notes, chunks, and source bytes;
3. warm versus cold-start timing boundaries;
4. the representative query and corpus distribution;
5. accuracy, abstention, provenance, and authorization checks; and
6. the required percentile and allowed failure rate.

Performance is not valid if it is achieved by returning the wrong note, leaking an ineligible
scope, skipping provenance, or silently truncating an incomplete Vault. The synthetic validation
block is only a basic guard; the gateway's retrieval and security test suites remain authoritative.
