# Online evaluation: Mistral

The LLM pipeline (online mode) scored against both label sets, with Mistral as the single provider. Raw output of the
final complete run: [`online-mistral.json`](online-mistral.json). The OpenAI run is in
[`online-openai.md`](online-openai.md), the offline (deterministic) results are in the
[README](../../README.md#evaluation).

## Setup

| Setting        | Value                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Chat model     | `mistral-small-2603` (Mistral Small 4) on the global endpoint (translation, grouping and classification agents) |
| Embeddings     | `mistral-embed` (1024 dimensions)                                                                      |
| Web search     | Mistral's built-in `web_search` (Conversations API)                                                    |
| Classification | 2 independent agent runs per group, a third when they disagree; the majority decides                   |
| Agent limits   | `AGENT_MAX_STEPS=12`, at most 4 tool calls per turn, internet access on                                |
| Rate limit     | `LLM_MIN_REQUEST_INTERVAL_MS=1000` (the plan limits requests per second); 429 answers retried with backoff |
| Corpus         | `data/items.json` (53 items, 45 procedure groups), as of 2026-11-16                                    |
| Command        | `scripts/eval.sh online` (fresh database, every stage from scratch, then the eval)                     |
| Date           | 2026-11-25                                                                                             |

## Result of the final complete run

| Labels · profile                     | Recall | Precision | F2   | Strict P/R  | Tier agreement | Grouping pairs P/R |
| ------------------------------------ | ------ | --------- | ---- | ----------- | -------------- | ------------------ |
| `labels.extended.json` · agrifood_pl | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | **1.00**       | 1.00 / 1.00        |
| `labels.extended.json` · metals_at   | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | **1.00**       | 1.00 / 1.00        |
| `labels.extended.json` · retail_es   | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | **1.00**       | 1.00 / 1.00        |
| `labels.json` · metals_at            | 1.00   | 1.00      | 1.00 | 1.00 / 0.86 | 0.93           | 1.00 / 1.00        |
| `labels.json` · retail_es            | 1.00   | 1.00      | 1.00 | 1.00 / 1.00 | 0.98           | 1.00 / 1.00        |

**The extended set is at 100 %** for every profile, borderline included: no missed and no false group, every tier
exact, every procedure group reproduced under the same name, 0 jurisdiction leaks, 100 % "why relevant" coverage,
ranking deterministic and tiers ordered.

One caveat: 44 of the 45 groups were scored on the classification agent's answer. For `ES-BOE-0044` (Spanish draft
royal decree: shops must accept cash) the agent failed three times to give a well-formed final answer (see below), so
that group was scored on the deterministic fallback, which is correct. A separate dry run of the agent on that group
(`classify-preview ES-BOE-0044`) gave the labelled tiers (relevant for `retail_es`, not relevant for the others).

On `labels.json` the differences are exactly the four documented disagreements between the two label sets
([`disagreements.md`](../../data/eval/disagreements.md)): `EU-LEX-0004` and `EU-CON-0007` borderline, `EU-EP-0034` and
`ES-BOE-0050` relevant.

## How the score developed

Every change is a general rule, schema handling or mechanism; none refers to an item, a group id or a profile of the
eval sets, and no label was changed. Rule changes were checked first with `classify-preview` on the affected groups and
on control groups the rule could tip (a dry run that stores nothing), and only then in a complete run.

| Run                      | Change                                                                                                                                                                                       | Extended set, tiers off       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1                        | Plan without quota for the chat model (0 requests/minute): every call refused                                                                                                                | invalid                       |
| 2 (baseline)             | Rate-limited provider fetch; translations without a summary no longer ask for a null field; final answers checked against the schema and corrected instead of crashing                    | 3                             |
| 3 (final, table above)   | Prompt: energy-intensive industries named with their NACE divisions; packaging rules on use versus on manufacture; classification criteria without duties (taxonomy, eco-labels) borderline | **0** (1 group on the fallback) |

Run 2 was patched while it ran (worker rebuilt on the same database), so its baseline is approximate; run 3 ran every
stage from scratch with the final code.

What the runs showed:

- **Rate limits decide whether an agent run survives.** The plan limits requests per second. Without pacing, a 429 in
  the middle of an agent run threw the run away together with the tokens it had already used. Each provider now has
  one shared fetch that spaces requests (`LLM_MIN_REQUEST_INTERVAL_MS`) and retries a 429 with backoff, honouring
  `Retry-After`; rejected requests are not billed.
- **Mistral Small leaves out fields and sometimes the whole answer.** It omits a field that must be null, answers in
  text instead of calling the `final_answer` tool, or sends an invalid enum value. Each final answer is now checked
  against its schema (the raw tool call or a JSON object in the text is used when LangChain's parser yields nothing),
  and the problem goes back to the model as a correction: one line per problem with its path and the value sent.
- **A smaller model needs the rules more explicit.** Rules GPT-6 Luna followed from a short hint ("energy-intensive
  industries", "packaging rules hit packers and retailers") had to be spelled out: with NACE divisions, and with the
  difference between rules on how something is used and rules on how it is made.

## Open issue

In the final run 9 of 53 classification attempts (on 6 groups) failed because the model gave no well-formed final
answer even after two correction rounds. Most of these answers had neither `whyRelevant` nor `labels`, so they were
most likely wrapped in another object (for example `{"name": "final_answer", "arguments": {...}}`); one missed the
`rationale` of some labels. Five groups succeeded on a retry; `ES-BOE-0044` used up its three
attempts. The next step is to unwrap such answers before the schema check.

## Cost and operations

- One complete run makes roughly 50 translation calls, about 1,100 embedding inputs (items and NACE codes), about 50
  grouping agent runs and 90 to 135 classification agent runs, each up to 12 model turns. At one request per second the
  classification stage takes about 30 to 40 minutes.
- Provider errors never stop the services: a failed agent run stores the deterministic fallback and is retried with
  backoff (1 min, then 5 min, at most 3 attempts), and every stage logs one warning per cycle with the count and the
  first error.

## Reproduce

```bash
cp .env.example .env    # then set LLM_PROVIDER=mistral, MISTRAL_API_KEY and LLM_MIN_REQUEST_INTERVAL_MS=1000
scripts/eval.sh online  # fresh stack and database; writes docs/eval/online.json
```

To check a rule change on a few groups first, without storing anything:

```bash
docker compose run --rm --no-deps -T --entrypoint node eval dist/main.js classify-preview EU-HYS-0005 EU-LEX-0004
```
