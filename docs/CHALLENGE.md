# Regulatory Radar: coding challenge

The brief this repository implements: a synthetic seed dataset, a small labelled evaluation set, a list of public sources and a code snippet for a review (Part B). There is no model solution; what counts is how a loosely specified problem is broken down, decided and built with AI.

## The mission

Chambers of commerce and industry associations across the EU have the same recurring job: tell their member companies, early enough to act, which new rules are coming. Today that usually means people manually scanning EUR-Lex, the European Parliament's agenda, Commission consultations, the national gazette and the national parliament, every week, in several languages. Whoever notices too late misses a consultation deadline or is surprised by a new obligation.

Build a **"Regulatory Radar"**: a self-hostable service that an operator (a chamber, an association, a sector desk) starts with `docker compose up`, configures for **one country and one or more sectors**, and that then shows only the regulatory items from **EU and national channels** that matter to that sector, ranked by how urgently someone should look at them.

The sector taxonomy is **NACE** (the EU's statistical classification of economic activities, e.g. `C24` basic metals, `G47` retail trade). The country is an ISO code (`AT`, `ES`, `PL`, ...). Nothing in your solution may be hard-wired to one country or one sector: a chamber in Tallinn and an association in Lisbon should be able to use the same image with a different configuration.

Provided: a synthetic seed dataset ([`data/items.json`](../data/items.json): 53 items across EU and five national channels, in five languages), three operator profiles ([`data/examples/`](../data/examples/)), a labelled evaluation set for two of them ([`data/eval/labels.json`](../data/eval/labels.json)), an extract of the NACE taxonomy ([`data/nace_extract.csv`](../data/nace_extract.csv)) and a list of public sources with their access status as last checked ([`data/sources.yaml`](../data/sources.yaml)). No domain knowledge needed: all fields are documented in [`data/README.md`](../data/README.md).

> The seed dataset is synthetic and simplified (as of 2026-11). Items, procedure numbers and references are invented. The *sources* in `sources.yaml` are real and public.

### Part A: Build the radar

**Must-haves (the bar):**

1. **One command to run.** `docker compose up` on a clean machine brings up the service. The README gets a reader from clone to running in under 5 minutes. A default run needs **no API key** and **no network** (seed mode); live mode and any LLM provider are switched on via config / env.
2. **Operator setup.** On the page (or via a config file) the operator selects **country** and **sector(s)** as NACE codes at any level (section `C`, division `C24`, group `C24.4`). The selection persists across restarts.
3. **Sector relevance, not keyword lists.** Most real items carry no NACE code at all (see `nace_tags` in the seed: often `null`). Your radar has to decide relevance for items in several languages from title and summary. How you do that (taxonomy descriptions, multilingual embeddings, an LLM classifier, rules, a mix) is your decision. Every shown item carries a short, human-readable **"why relevant"**.
4. **Jurisdiction logic.** Show EU-level items plus national items of the **selected country only**. A German-language item from Germany is not relevant to an Austrian operator, even though the language matches.
5. **One item per procedure.** The same procedure shows up in several channels and language versions, and reactions/feedback to a consultation are not new procedures. Collapse them into one entry with its source trail.
6. **Ranking by actionability.** Order the list so that what needs attention first comes first: open consultation and feedback windows, upcoming votes, standstill periods, then adopted acts. The ordering must be **deterministic** (same input, same output).
7. **One live source.** Implement an adapter against one real public source from `data/sources.yaml` (or another you find), EU-level or national. It sits behind the same interface as the seed loader, so live items flow through the same pipeline (normalisation, jurisdiction, relevance, dedup, ranking). Live mode may be slow or fail; your radar must **show per-source status** (ok / degraded / failed, item count, last fetch) instead of silently showing fewer items. Use the official APIs and feeds; do not work around bot filters, logins or rate limits.
8. **Memory across runs.** The radar runs repeatedly (on a schedule or on demand). It marks what is **new since the last run**, and a procedure that was found relevant once **stays tracked** when a later step's title no longer matches on its own. State survives `docker compose down && up`.
9. **Measured, not claimed.** Run your relevance step against [`data/eval/labels.json`](../data/eval/labels.json) and report **recall and precision per profile** with one command (e.g. `docker compose run radar eval`). Put the numbers in your README, and say which design change moved them most.
10. **A few meaningful tests** (no coverage theatre).
11. **A page to work with.** A plain web page is enough: a policy officer sets country and sectors, reads the ranked list with the "why relevant" of each entry and its source trail, and sees the status of each source, without reading the docs. It is used in the live demo. Clarity counts, looks do not.

**Nice-to-haves (to shine, fully optional):**

- Further live sources: a national channel next to an EU one, ideally of a country whose language you do not speak.
- Weekly digest export (Markdown, e-mail-ready HTML or RSS) per operator profile.
- A structured interface for other tools: a small JSON API or an MCP server (or both on the same core) that returns structured hits, not prose: item, procedure, jurisdiction, stage, deadline, why relevant, source trail, and the **denominator** ("3 hits out of 1,204 items checked").
- Extending the eval set (e.g. labelling the third profile, or labelling a sample of your live items) and showing how a design change moved recall/precision.
- Cross-language consolidation: recognising that a German, a Spanish and an English title belong to the same EU act.

> **The interesting design decisions:** For a chamber, a missed rule is far more expensive than a false alarm, but a list nobody reads is useless too. Where do you put the threshold, and can an LLM ever *remove* an item, or only *add and rank*? How do you map an untagged Polish draft regulation onto NACE? What counts as "the same procedure"? What do you do when a source answers slowly instead of failing? How do you keep the output reproducible when an LLM is in the loop? The reasoning matters, not a prescribed formula.

> An LLM is allowed and probably useful, not required. If you use one, keep the provider behind a seam with a deterministic offline fallback. Think about where the operator's data goes: a chamber may not want its sector profile sent to an arbitrary API. Stack is your choice; the deliverable is a Git repo plus a Docker image buildable from it.

### Part B: Code review (~15 min)

A short, AI-generated Python snippet ([`code-review/snippet.py`](../code-review/snippet.py)). Its docstring promises more than the code delivers. Say what is wrong, which defect you would fix first and why (3–5 sentences), fix that one, and list what else you would not ship as it stands (missing edge cases, questionable assumptions, validation). Work on it the way you work on everything else, with your agent if you like. The point is judging AI output, not just producing it.

## Work agentically

Build the challenge *with* an AI coding agent (Claude Code, Cursor, Copilot agent mode, Codex, Aider, your own) and show how:

- Commit your **agent setup** to the repo, e.g. `AGENTS.md` / `CLAUDE.md` / rules files, specs or plans you gave the agent, custom commands, subagent or MCP configuration.
- Add **transcript notes** (`docs/agent-log.md` or similar): the key prompts, where you steered, how you verified what the agent produced, and at least one place where the agent got it wrong and how you noticed. Excerpts are enough; full transcripts are welcome but optional.
- Remove secrets and API keys from anything you commit. Never commit `.env`.

## Ground rules

- **Timebox: one calendar week.** The week is there to give you flexibility, not to be filled. *(Decision log: 5–10 bullet lines.)*
- **Polish is not expected.** Rough edges are fine, on the page too. Spend your time where the hard problems are (relevance, dedup, live sources, measurement) and say what you left rough and why.
- **Use any AI, any library, search freely.** Expected, not just allowed. Cursor, Claude, Copilot, coding agents: go ahead.
- **The core (A + B) is the bar.** Nice-to-haves are for shining and completely optional. If you cannot finish a must-have, say what is missing and how you would do it; an honest gap beats a faked feature.

> A rough core with clear thinking beats a polished but shallow implementation. Don't over-invest beyond the week.

## Deliverables

1. **Git repository** with code, `Dockerfile` + `docker-compose.yml`, README (including your eval numbers).
2. **Code review answer** (Part B): as a file in the repo or a short doc.
3. **Agent setup + transcript notes** (see above).
4. **Short decision log + key prompts:** 5–10 lines of decisions/trade-offs plus the AI prompts that made the difference.
5. **`THIRD_PARTY.md`:** every dependency, model, dataset and data source you use, with its licence or terms of use (for public sources: the reuse terms of the portal, and any rate limits you respected).
6. **Self-report:** how many hours did you invest? (Honest, no penalty.)

## Presentation

The result is presented in about 45–60 minutes (~20 minutes presentation, then questions and a short live extension), with the running result and the repo. Cover:

1. **How you researched the problem.** What you looked into at the start (domain, data sources, standards and formats), what you learned, and which decisions that research drove.
2. **How you worked agentically.** Your agent setup, the prompts and specs you gave it, how you steered and verified its output, and where the agent failed or misled you.
3. **How you made it work.** Architecture, the main trade-offs, what you deliberately left out and why.
4. **What happens underneath.** Expect deep-dive questions on the code: why a particular line is there, what happens on a given edge case, what you would change first. "The agent wrote that" is a fine starting point for an answer, not the end of one.
5. **A small live extension.** A small new requirement is added; you extend your own code, with your usual AI tools. It is about how you think out loud, not about a perfect result in 10 minutes.
