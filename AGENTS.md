# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, ...) working in this repository. Humans: see `README.md`.

## What this is

Regulatory Radar: a self-hosted service that streams regulatory items from EU and national sources, stores them in a common schema, then translates, embeds, groups them per procedure and classifies relevance per (EU country × NACE Rev. 2.1 code). An Angular UI and a JSON/MCP API rank the results by actionability. The brief is in `docs/CHALLENGE.md`.

## Layout

| Path                   | Content                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi/openapi.yaml` | **Source of truth** of the HTTP API. Server types and the Angular client are generated from it                                                     |
| `apps/api`             | NestJS 12 (ESM): ingestion, pipeline, REST, MCP. `src/domain` = pure logic, `src/pipeline` = stages + LangGraph agents, `src/radar` = read queries |
| `apps/api/prisma`      | Prisma schema + SQL migrations (read models, ranking function, indexes)                                                                            |
| `apps/web`             | Angular 22, zoneless, signals only, Angular Material                                                                                               |
| `e2e`                  | Playwright tests against the running compose stack                                                                                                 |
| `data`                 | Seed items, eval labels, NACE Rev. 2.1 taxonomy, source list                                                                                       |
| `scripts/eval.sh`      | Evaluation runs (offline / online) against `data/eval/labels.json` (standard) and `labels.extended.json` (ours)                                    |

## Commands

```bash
npm ci                                   # install with npm 12 (allowScripts: only approved install scripts run)
docker compose up --build                # whole stack on http://localhost:8080
npm run generate                         # after editing openapi.yaml: server types + Angular client
npm run prisma:generate -w apps/api      # after editing schema.prisma
npm run check                            # Biome lint + format, warnings are errors
npm run typecheck
npm run test:unit -w apps/api && npm run test -w apps/web
npm run test:integration -w apps/api     # needs Docker (testcontainers, Postgres 19)
npm run test -w e2e                      # needs the stack running (offline mode)
npm run docs:coverage                    # compodoc, 100 % required
docker compose run --rm eval             # precision/recall of the running stack against data/eval
scripts/eval.sh offline|online|both      # the same on a fresh stack; writes docs/eval/<mode>.json
npm run precommit                        # everything the git hook runs
```

## Rules

- **Concise and deduplicated.** Before writing code, search for an existing helper (`apps/api/src/common/fp.ts`, `domain/*`, `pipeline/repository.ts`, `apps/web/src/app/shared/*`) and reuse it. One concept, one implementation: ranking lives only in the SQL function `radar_actionability`, NACE hierarchy logic only in `domain/nace.ts`, every SQL read in `pipeline/repository.ts` or `radar/*.ts`. Refactor instead of copying.
- **Functional style, minimal mutation.** Pure functions, `readonly` types, `map`/`filter`/`reduce`, spread instead of mutation. Allowed exceptions: loops inside Nest services that drive I/O, and contained local state inside one function (e.g. union-find). Mark such spots with a comment.
- **The database is append-only and the only state.** Never `UPDATE` or `DELETE` domain rows; write a new row (latest by `created_at` wins) and derive "current" through the materialized views (`refresh_read_models()`). No state in files, memory caches or the browser beyond UI conveniences.
- **Spec first.** Change `openapi/openapi.yaml`, run `npm run generate`, then implement. Never edit `apps/web/src/app/api-client` or `apps/api/src/generated` by hand. Request rules (types, formats, enums, limits) live only in the spec: controllers validate with `spec.validate.query/path/body` (`http/openapi.ts`); code adds only checks the spec cannot express. MCP tools are derived from the same spec, never written by hand.
- **Deterministic core.** Ingestion, normalisation, deterministic grouping, ranking and the offline classifier must not depend on ML or time of day (pass `asOf`). LLM steps store their engine id (temperature 0 where the model supports it).
- **One ML/AI provider.** Mistral (EU) or OpenAI (US/global), selected by `LLM_PROVIDER` plus its key, serves the tool-calling chat model, the multilingual embeddings (mistral-embed 1024 or text-embedding-3-large 3072 dimensions, one partial HNSW index per size; inputs over 8192 tokens are compacted once) and the provider-native `web_search` tool. Code only uses LangChain's `BaseChatModel` and `EmbeddingsInterface`; provider classes appear only in `llm/providers.ts` (one factory entry per provider).
- **Two modes, two databases.** `LLM_PROVIDER=none` (or a missing key) is offline and uses `radar_offline`; a provider with a key is online and uses `radar_online`. Never mix their results.
- **Standards.** ISO 3166-1 alpha-2 countries, ISO 639-1 languages, ISO 8601 dates, NACE Rev. 2.1 codes in dotted notation, RFC 9457 problem details, UUIDv7 ids.
- **NACE Rev. 2.1 only.** Everything after the edge works with Rev. 2.1. Rev. 2 codes (seed tags, example profiles, a model's answer) are mapped once, where they enter, with `mapRev2Code` (`domain/nace-rev2.ts`, Eurostat correspondence, precomputed lookup). Never compare or store Rev. 2 codes elsewhere. See `docs/nace-rev2-to-rev2.1.md`.
- **No hardcoded UI text.** Every user-visible string in `apps/web` goes through Transloco (`apps/web/src/i18n/en-US.json`, nested keys per feature; en-US is the only language for now). API data stays untranslated.
- **Eval sets.** Never edit `data/eval/labels.json` (the challenge's set). `labels.extended.json` is ours; the offline route must reproduce its tiers exactly, borderline included (unit test and `scripts/eval.sh offline`), and label changes go with an entry in `data/eval/disagreements.md` when they contradict the standard set.
- **Documentation.** Every exported and internal symbol has a JSDoc comment (compodoc must stay at 100 %). Keep comments short: say why, not what.
- **Tests.** Meaningful tests only. Domain logic gets unit tests on the real seed data, DB-touching code an integration test (testcontainers), user flows a Playwright test.
- **Schema changes.** Edit `schema.prisma`, then create a new folder under `prisma/migrations` (`npx prisma migrate diff --from-migrations ... --to-schema ... --script`). Add hand-written SQL (views, functions, GiST/HNSW indexes) in the same migration. Prisma does not manage the materialized views, so never run `prisma migrate dev --create-only` blindly: it would try to drop them.
- **Security.** Never commit `.env` or keys. New dependencies: newest stable, exact version, `npm audit` must stay at 0. Approve install scripts explicitly (`npm install-scripts approve <pkg>`). Live sources: official APIs only, never bypass bot filters or rate limits.
- **Formatting.** Biome decides; run `npm run fix`.

## Definition of done

`npm run precommit` is green, the stack starts with `docker compose up`, `scripts/eval.sh offline` does not regress, and the README's eval table is updated when metrics change.
