# Agent log

Agent: Claude Code (one main session plus one parallel sub-agent for the Angular UI). Rules for agents: [AGENTS.md](../AGENTS.md).

## Key inputs (condensed)

1. Solve the challenge: Docker Compose, TypeScript only, newest NestJS + Angular (zoneless, signals), Postgres as the only persistent state, Prisma, Angular Material.
2. Ingestion first. Three streaming sources (file default; one EU and one non-German national source, each toggled in `.env`), a common schema, JSONB with exact-duplicate dedup, optional time filters, a stored watermark.
3. OpenAPI as the source of truth: generated Angular client, API usable without the UI, no auth yet.
4. Pipeline: deterministic import, then LLM translation (keep the originals), then multilingual embeddings, then LangGraph agents that group procedures (with internet and neighbour access), then a second agent that labels country × NACE as relevant/borderline/not relevant, with "why relevant", indexed for fast search.
5. LangChain with one ML/AI provider for chat (tool calling) and multilingual embeddings: Mistral (EU) or OpenAI (US/global); Anthropic was dropped. Offline mode: empty translations and embeddings, deterministic best effort, UI warnings.
6. Biome with warnings as errors, 100 % compodoc coverage, pre-commit hook, clean `npm audit`, a dev-container hint, a README with a mermaid diagram, no bloat.
7. Mid-course corrections:
   - NACE **Rev. 2.1** instead of Rev. 2;
   - MCP server generated from OpenAPI;
   - functional style with minimal mutation, deduplicated code;
   - **two modes with separate Postgres states**;
   - extended eval set plus extra metrics;
   - RFC/ISO standards for data fields;
   - code review (Part B), THIRD_PARTY, decision log, presentation;
   - keep the standard eval set untouched; build the extended set from scratch (all three profiles, `items.json`) with independent sub-agents; offline route must hit 100 % on it; document disagreements;
   - all UI text through Transloco (en-US only for now);
   - native embedding sizes (1024 / 3072), compaction above 8192 tokens, grouping agent with full-text search, read-only SQL and provider web search;
   - stream the seed file in file order; a group is named after its first streamed item (as in `labels.json`); npm 12;
   - grouping agent: procedure-identity rules with examples, review of all groups with re-review on new evidence, pre-computed candidates, jurisdiction and confidence guard in code;
   - classification agent: semantic NACE search over embedded Eurostat notes (once per model), code/title check with correction rounds, pre-computed context and precedents, richer prompt, recall safety net;
   - API: request validation straight from the spec (Ajv), correct RFC 9457 titles and instance, MCP tools with body and output schemas, structured results and method hints;
   - NACE Rev. 2.1 only: Rev. 2 seed tags and example profiles mapped once at the edge with Eurostat's correspondence (precomputed lookup, documented as not 100 % identical); UI presets per example profile; UI fixed and checked with screenshots on desktop and phone.

## How output was verified

- **Real stack:** every backend step was run against `docker compose up` (logs, `curl` of each endpoint, ranked output read by hand), not just compiled.
- **Grouping:** unit tests on the real seed. Grouping reproduces all 8 labelled procedure groups exactly, and group keys stay stable on `items.next.json`.
- **Integration (testcontainers, Postgres 19):** dedup, watermark, ranking determinism and RFC 9457 errors. The online path uses a scripted chat model and hash embeddings, so the LangGraph loops, tools and pgvector were exercised without an API key.
- **Live sources:** a smoke run stored 21 EUR-Lex records and 48 BOE records, and they flowed through grouping and classification.
- **UI:** Playwright E2E (5 tests) plus a screenshot review of the radar page.

- **Extended eval set:** three sub-agents labelled independently without seeing `labels.json` or the code; they agreed on 158 of 159 item labels (53 items × 3 profiles), and a fourth sceptical reviewer changed nothing. Disagreements with the standard set are in [data/eval/disagreements.md](../data/eval/disagreements.md).

## Where the agent got it wrong (and how it was caught)

- **Overfitting.** The offline lexicon is tuned on the same items the eval sets label (as requested: 100 % on the extended set), so its scores are training-set scores. The README says so.
- **Global negative phrases.** Removing "industrial consumers" from the text for every concept (to stop a retail false alarm) also hid the energy-intensive-industry signal for metals. Caught by the extended set; exclusions are now per concept.
- **Wrong test expectation.** A test expected watermark `2026-11-16` (the labels' `as_of`), but the newest seed item was published on `2026-11-15`. The integration test caught it; the code was right, the assumption was wrong.
- **Missing SQL casts.** Raw `INSERT … SELECT` with untyped parameters failed at runtime (`dims` text vs integer). Typecheck passed; only the worker logs showed it.
- **Broken agent conversation.** A first agent-graph draft removed tool-call messages but kept the tool results, which providers reject. It was caught in review and replaced by passing the research as plain notes.
- **Wrong diagnosis.** Testcontainers failures looked like a code problem, but `initdb` reported "No space left on device". The fix was pruning Docker's build cache, not the code.
- **Docker build.** The runtime image failed on husky's `prepare` script, because husky is a dev dependency. Fixed with `husky || true`.
