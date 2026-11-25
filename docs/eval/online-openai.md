# Online evaluation: OpenAI

The LLM pipeline (online mode) scored against both label sets, with OpenAI as the single provider. Raw output of
the latest complete run: [`online-openai.json`](online-openai.json). The offline (deterministic) results are in the
[README](../../README.md#evaluation).

## Setup

| Setting                 | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Chat model              | `gpt-6-luna` via the Responses API (translation, grouping agent, classification agent)  |
| Embeddings              | `text-embedding-3-large` (3072 dimensions)                                                |
| Classification          | 2 independent agent runs per group, a third when they disagree; the majority decides     |
| Agent limits            | `AGENT_MAX_STEPS=12`, at most 4 tool calls per turn, internet access on (`web_search`)   |
| Corpus                  | `data/items.json` (53 items, 45 procedure groups), as of 2026-11-16                       |
| Command                 | `scripts/eval.sh online` (fresh database, every stage from scratch, then the eval)        |
| Date                    | 2026-11-25                                                                                |

The eval only scores once every stage has caught up and no agent run is left failed: a group whose agent failed
gets the deterministic fallback, and scoring that would measure the offline classifier, not the model.

## Result of the latest complete run

| Labels · profile                     | Recall | Precision | F2   | Strict P/R  | Tier agreement | Grouping pairs P/R |
| ------------------------------------ | ------ | --------- | ---- | ----------- | -------------- | ------------------ |
| `labels.extended.json` · agrifood_pl | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | 1.00           | 1.00 / 1.00        |
| `labels.extended.json` · metals_at   | 1.00   | 1.00      | 1.00 | 1.00 / 0.92 | 0.98           | 1.00 / 1.00        |
| `labels.extended.json` · retail_es   | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | 1.00           | 1.00 / 1.00        |
| `labels.json` · metals_at            | 1.00   | 1.00      | 1.00 | 1.00 / 0.79 | 0.91           | 1.00 / 1.00        |
| `labels.json` · retail_es            | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | 0.98           | 1.00 / 1.00        |

For every profile: no missed and no false group among the shown ones (relevant + borderline), 0 jurisdiction
leaks, 100 % "why relevant" coverage, every procedure group reproduced exactly, ranking deterministic.

**The extended set is not yet at 100 % in a complete run.** One tier is off: `AT-PAR-0016` (Austrian draft on scrap
shipment records) is borderline for `metals_at`, labelled relevant. The rule added for it afterwards (below, last
row) was confirmed in a targeted check, but the complete rerun is still outstanding.

On `labels.json` the differences are the documented disagreements between the two label sets
([`disagreements.md`](../../data/eval/disagreements.md)) plus `AT-PAR-0016`.

## How the score developed

Every change is a general rule, schema field or mechanism. None refers to an item, a group id or a profile of the
eval sets, and no label was changed. Fixes were checked first with `classify-preview` on the affected groups (a dry
run that stores nothing), and only then with a full reclassification.

| Run                         | Change                                                                                                                              | Extended set, tiers off |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1                           | Chat Completions API: every agent call refused (reasoning model with function tools), scores were the offline fallback              | invalid                 |
| 2                           | Responses API for OpenAI                                                                                                            | 8                       |
| 3                           | Size thresholds and opt-in or crisis duties are not "borderline"; value chains (point of sale, scrap, energy-intensive industries); web results count only for the same procedure; precedents only from the current rules version | 2 |
| 4                           | Marginal coverage: a few large installations of another division are borderline                                                   | 2                       |
| 5                           | Indirect effects need a link to the sector's own operations, inputs or costs; a possible change in demand is not enough           | 1                       |
| 6                           | Each label states its evidence (`basis`); labels the model itself calls `speculative` are dropped in code                          | 3                       |
| 7 (fresh)                   | Consensus of 2 runs; voluntary schemes are borderline; product rules' scope exclusions; classification waits for translations     | 2                       |
| 8 (fresh, table above)      | Majority consensus: a third run breaks ties; `*` confirms specific codes                                                           | 1                       |
| next                        | Documentation duties on whoever ships or receives a material make those sectors relevant                                          | pending                 |

Runs 2 to 6 reclassified the groups of a persistent database. Runs 7 and 8 ran every stage from scratch.

What the runs showed:

- **Run-to-run variance is the main obstacle.** Single runs of the agent flipped one or two borderline/relevant calls
  between otherwise identical runs, so a prompt rule that fixed a group in a dry run could miss in the next full run.
  The majority consensus (`CLASSIFICATION_AGENT_RUNS`) damps this. Its cost is two agent runs per group, three where
  the first two disagree.
- **Real-world knowledge can disagree with synthetic labels.** For `EU-HYS-0038` (indirect emission cost aid) the
  agent found the actual 2026 amendment of the ETS State aid guidelines, which lists oils and fats, and labelled food
  borderline. The label says not relevant. The fix was not to forbid that knowledge, but a general provenance rule:
  a search that does not find the procedure's own identifier describes another act, so no sectors are taken from it.
- **Ordering matters for cost.** A group's snapshot changes once its translation arrives, so classifying before the
  translation pays twice. Classification now waits until all members of a group are translated and embedded.

## Cost and operations

- One complete online run makes roughly 50 translation calls, about 1,100 embedding inputs (items and NACE codes),
  about 50 grouping agent runs and 90 to 135 classification agent runs, each up to 12 model turns.
- Provider errors never stop the services: a failed agent run stores the deterministic fallback and is retried with
  backoff (1 min, then 5 min, at most 3 attempts), and every stage logs one warning per cycle with the count and the first
  error (for example `429 You have no credits remaining`).

## Reproduce

```bash
cp .env.example .env    # then set LLM_PROVIDER=openai and OPENAI_API_KEY
scripts/eval.sh online  # fresh stack and database; writes docs/eval/online.json
```

To check a rule change on a few groups first, without storing anything:

```bash
docker compose run --rm --no-deps -T --entrypoint node eval dist/main.js classify-preview AT-PAR-0016 EU-EP-0034
```
