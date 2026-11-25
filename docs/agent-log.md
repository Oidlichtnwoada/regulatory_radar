# Agent log

Agent: Claude Code (one main session, sub-agents for the Angular UI and for blind labelling). Rules: [AGENTS.md](../AGENTS.md).

## Key prompts (condensed)

1. **Stack:** Docker Compose, TypeScript only, newest NestJS + Angular (zoneless, signals), Postgres as the only state, Prisma, Angular Material.
2. **Ingestion first:** three streaming sources behind one interface (seed file by default; one EU and one non-German national source, toggled in `.env`), a common schema, JSONB with exact-duplicate dedup, a stored watermark.
3. **Contract:** OpenAPI as the source of truth; generated Angular client; MCP server generated from the same spec.
4. **Pipeline:** deterministic import → LLM translation (originals kept) → multilingual embeddings → LangGraph grouping agent (internet and neighbour access) → classification agent (country × NACE, relevant/borderline/not relevant, "why relevant"), indexed for fast search.
5. **Provider:** one LangChain provider for chat and embeddings, Mistral (EU) or OpenAI; offline mode with empty translations, deterministic best effort and a UI warning.
6. **Quality bar:** Biome with warnings as errors, 100 % compodoc, functional style, deduplicated code, clean `npm audit`, pre-commit hook.
7. **Eval:** keep `labels.json` untouched; build an extended set from scratch for all three profiles with independent sub-agents; offline must reach 100 % on it; then run the same improvement loop online "until 100 % on the extended set", with general rules only.

## Where I steered

- **NACE Rev. 2.1** instead of Rev. 2, mapped once at the edge with Eurostat's correspondence.
- **Two modes, two databases**, so offline and online results never mix.
- **OpenAI Responses API:** I switched OpenAI from Chat Completions to the Responses API after the first online run showed every agent call refused (reasoning model with function tools).
- **Consensus:** the idea of several independent agent runs with a majority vote was mine, to damp run-to-run variance; a third run only breaks ties.
- **No overfitting:** every prompt change had to be a general rule, never an item or group id; labels were never edited.
- **Token frugality:** targeted dry runs (`classify-preview`) before each full run; retry backoff 1 min, then 5 min.

## How output was verified

- **Real stack:** every step ran against `docker compose up` (logs, `curl`, ranked output read by hand).
- **Tests:** unit tests on the real seed, testcontainers with Postgres 19 (the online path with a scripted LLM), Playwright including the phone layout.
- **Live sources:** a smoke run stored 21 EUR-Lex and 48 BOE records, which flowed through grouping and classification.
- **Eval:** offline and full online runs with OpenAI and Mistral, each scored against both label sets ([docs/eval](eval/)).

## Where the agent got it wrong

- **Overfitting:** it tuned the offline lexicon on the eval items; the README labels these as training-set scores.
- **Global negative phrases:** removing "industrial consumers" everywhere hid the energy-intensive signal for metals; caught by the extended set.
- **Wrong NACE mapping:** its first Rev. 2 mapping kept `G47` as `G47`; replaced by the official correspondence.
- **Broken agent conversation:** a draft removed tool calls but kept their results, which providers reject.
- **Missing SQL casts:** passed typecheck, failed at runtime; only the worker logs showed it.
- **Wrong diagnosis:** "failing tests" were a full Docker disk (`initdb`: no space left).
- **Rate limits:** with Mistral a single 429 threw away a whole agent run; fixed with a shared, paced fetch that retries 429s.
