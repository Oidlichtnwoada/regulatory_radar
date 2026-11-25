# Third-party components, models, data and sources

This project is licensed under Apache-2.0 (see `LICENSE`). Everything below is used under terms compatible with that.

## Data sources (live adapters)

| Source                                                                                                  | Used for                                                                                                                              | Terms of reuse                                                                                                                                                                                   | Rate limits we respect                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EUR-Lex via the Publications Office CELLAR SPARQL endpoint (`publications.europa.eu/webapi/rdf/sparql`) | EU adapter `eurlex`: titles, CELEX numbers, dates and EuroVoc subjects of adopted acts (sector 3) and Commission proposals (sector 5) | © European Union. Free reuse with acknowledgement of the source under Commission Decision 2011/833/EU ([EUR-Lex legal notice](https://eur-lex.europa.eu/content/legal-notice/legal-notice.html)) | No published limit. We send one query per day page, wait 1 s between days, poll every 30 min (configurable), use a descriptive User-Agent, and back off on 429/5xx |
| Boletín Oficial del Estado open-data API (`boe.es/datosabiertos/api/boe/sumario/YYYYMMDD`)              | National adapter `es_boe`: daily summary, section I (general provisions) by default                                                   | Free reuse with attribution under Ley 37/2007 and Real Decreto 1495/2011 ([BOE aviso legal](https://www.boe.es/informacion/aviso_legal/index.php))                                               | One request per day of the window, 1 s pause, hourly polling, backoff on 429/5xx                                                                                   |

No bot filter, login or rate limit is worked around. Requests that answer 403 or 401 fail visibly and appear as `failed` on the sources page.

## Datasets

| Dataset                                                                                                                  | Use                                                       | Licence                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| Challenge seed data (`data/items*.json`, `data/eval/labels.json`, `data/examples`, `data/sources.yaml`)                  | File source, evaluation                                   | Apache-2.0 (challenge repository)                             |
| NACE Rev. 2.1 codelist, Eurostat SDMX `ESTAT/NACE_R2_1` → `data/nace_rev2_1.csv`                                         | Sector taxonomy (all 1,047 codes)                         | © European Union, reuse under Commission Decision 2011/833/EU |
| NACE Rev. 2.1 explanatory notes, EU Vocabularies (`data.europa.eu/ux2/nace2.1`, English) → `data/nace_rev2_1_notes.json` | Agent NACE search. Embedded online (861 codes have notes) | © European Union, reuse under Commission Decision 2011/833/EU |
| NACE Rev. 2 → Rev. 2.1 correspondence, Eurostat `NACE2_NACE2.1` (EU Vocabularies) → `data/nace_rev2_to_rev2_1.csv`       | Mapping Rev. 2 seed tags and example profiles to Rev. 2.1 | © European Union, reuse under Commission Decision 2011/833/EU |
| `data/eval/labels.extended.json`                                                                                         | Extended evaluation                                       | Our own labels, Apache-2.0                                    |

## Models (online mode only, switched on by the operator)

| Provider                                                                                                        | Models (defaults, configurable)                                                                                                                        | Terms                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Mistral AI, La Plateforme, global endpoint `api.mistral.ai` (optional EU regional endpoint `api.eu.mistral.ai`) | `mistral-small-2603` (chat), `mistral-embed` (multilingual embeddings, 1024 dims), Conversations API `web_search` (global endpoint only)               | [Mistral terms of use](https://mistral.ai/terms)            |
| OpenAI API (US/global inference)                                                                                | `gpt-6-luna` (chat with tool calling via the Responses API), `text-embedding-3-large` (multilingual embeddings, 3072 dims), Responses API `web_search` | [OpenAI terms](https://openai.com/policies/business-terms/) |

In online mode the titles, summaries and NACE codes of public regulatory items are sent to the chosen provider. The agents' `web_search` queries go to the same provider. The operator's profile is never sent: classification is profile-independent.

## Runtime and build dependencies (direct)

| Package(s)                                                                                                                                                                                      | Licence           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Angular 22 (`@angular/*`, CDK, Material, CLI, build)                                                                                                                                            | MIT               |
| NestJS 12 (`@nestjs/*`)                                                                                                                                                                         | MIT               |
| Prisma 7 (`prisma`, `@prisma/client`, `@prisma/adapter-pg`)                                                                                                                                     | Apache-2.0        |
| LangChain / LangGraph (`@langchain/core`, `@langchain/langgraph`, `@langchain/mistralai`, `@langchain/openai`)                                                                                  | MIT               |
| `@modelcontextprotocol/sdk`                                                                                                                                                                     | MIT               |
| `pg`, `zod`, `js-tiktoken`, `@jsverse/transloco`, `swagger-ui-express`, `supertest`, `jsdom`, `husky`, `vitest`, `unplugin-swc`, `openapi-typescript`, `@testcontainers/postgresql`, `@types/*` | MIT               |
| `yaml`                                                                                                                                                                                          | ISC               |
| `rxjs`, `reflect-metadata`, `typescript`, `@swc/core`, `@playwright/test`, `@openapitools/openapi-generator-cli` (+ openapi-generator 7.27 JAR)                                                 | Apache-2.0        |
| `tslib`                                                                                                                                                                                         | 0BSD              |
| `@biomejs/biome`                                                                                                                                                                                | MIT OR Apache-2.0 |
| `@compodoc/compodoc`                                                                                                                                                                            | MIT               |

Transitive dependencies are pinned in `package-lock.json`, and `npm audit` reports 0 vulnerabilities. Overrides in `package.json` lift `effect` (via Prisma), `glob` (via testcontainers) and `i18next` (via compodoc) to patched versions.

## Container images

| Image                                                                   | Licence                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| `pgvector/pgvector:0.8.7-pg19-trixie` (PostgreSQL 19 + pgvector)        | PostgreSQL Licence                                  |
| `node:26.13.1-trixie-slim`                                              | MIT (Node.js), Debian packages under their licences |
| `nginx:1.30.7-alpine`                                                   | BSD-2-Clause                                        |
| `openapitools/openapi-generator` (via the npm wrapper, build time only) | Apache-2.0                                          |
