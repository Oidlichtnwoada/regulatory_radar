# Regulatory Radar: AI:AT Challenge

Version 1.0 · 2026-11 · Contact: AI:AT Hiring Team (questions about this brief: aiandbusinessgrowth@ai-at.eu)

Great to have you here. This repo contains everything you need to get started: the brief, a synthetic seed dataset, a small labelled evaluation set, a list of public sources and the code snippet for Part B.

> This is not a trick test. It is a small, real piece of venture-studio work: using AI to quickly build something valuable. There is no model solution you have to hit. We look at how you break down a loosely specified problem, make decisions and use AI sensibly.

> **This challenge was assigned to you.** We run several challenges of comparable difficulty in parallel and decide who works on which one. You do not need to look at the others; everything you need is in this repo.

> **Language.** This brief is in English. You may write your submission and give your presentation in **German or English**, whichever you prefer; it does not affect the evaluation.

## The mission

Chambers of commerce and industry associations across the EU have the same recurring job: tell their member companies, early enough to act, which new rules are coming. Today that usually means people manually scanning EUR-Lex, the European Parliament's agenda, Commission consultations, the national gazette and the national parliament, every week, in several languages. Whoever notices too late misses a consultation deadline or is surprised by a new obligation.

Build a **"Regulatory Radar"**: a self-hostable service that an operator (a chamber, an association, a sector desk) starts with `docker compose up`, configures for **one country and one or more sectors**, and that then shows only the regulatory items from **EU and national channels** that matter to that sector, ranked by how urgently someone should look at them.

The sector taxonomy is **NACE** (the EU's statistical classification of economic activities, e.g. `C24` basic metals, `G47` retail trade). The country is an ISO code (`AT`, `ES`, `PL`, ...). Nothing in your solution may be hard-wired to one country or one sector: a chamber in Tallinn and an association in Lisbon should be able to use the same image with a different configuration.

We provide a synthetic seed dataset ([`data/items.json`](./data/items.json): 53 items across EU and five national channels, in five languages), three operator profiles ([`data/examples/`](./data/examples/)), a labelled evaluation set for two of them ([`data/eval/labels.json`](./data/eval/labels.json)), an extract of the NACE taxonomy ([`data/nace_extract.csv`](./data/nace_extract.csv)) and a list of public sources with their access status as we last checked it ([`data/sources.yaml`](./data/sources.yaml)). No domain knowledge needed: all fields are documented in [`data/README.md`](./data/README.md).

> Seed dataset is synthetic / simplified, as of 2026-11, not an official AI:AT position. Items, procedure numbers and references are invented. The *sources* in `sources.yaml` are real and public.

### Part A: Build the radar

**Must-haves (the bar):**

1. **One command to run.** `docker compose up` on a clean machine brings up the service. Your README gets us from clone to running in under 5 minutes. A default run needs **no API key** and **no network** (seed mode); live mode and any LLM provider are switched on via config / env.
2. **Operator setup.** On the page (or via a config file) the operator selects **country** and **sector(s)** as NACE codes at any level (section `C`, division `C24`, group `C24.4`). The selection persists across restarts.
3. **Sector relevance, not keyword lists.** Most real items carry no NACE code at all (see `nace_tags` in the seed: often `null`). Your radar has to decide relevance for items in several languages from title and summary. How you do that (taxonomy descriptions, multilingual embeddings, an LLM classifier, rules, a mix) is your decision. Every shown item carries a short, human-readable **"why relevant"**.
4. **Jurisdiction logic.** Show EU-level items plus national items of the **selected country only**. A German-language item from Germany is not relevant to an Austrian operator, even though the language matches.
5. **One item per procedure.** The same procedure shows up in several channels and language versions, and reactions/feedback to a consultation are not new procedures. Collapse them into one entry with its source trail.
6. **Ranking by actionability.** Order the list so that what needs attention first comes first: open consultation and feedback windows, upcoming votes, standstill periods, then adopted acts. The ordering must be **deterministic** (same input, same output).
7. **One live source.** Implement an adapter against one real public source from `data/sources.yaml` (or another you find), EU-level or national. It sits behind the same interface as the seed loader, so live items flow through the same pipeline (normalisation, jurisdiction, relevance, dedup, ranking). Live mode may be slow or fail; your radar must **show per-source status** (ok / degraded / failed, item count, last fetch) instead of silently showing fewer items. Use the official APIs and feeds; do not work around bot filters, logins or rate limits.
8. **Memory across runs.** The radar runs repeatedly (on a schedule or on demand). It marks what is **new since the last run**, and a procedure that was found relevant once **stays tracked** when a later step's title no longer matches on its own. State survives `docker compose down && up`.
9. **Measured, not claimed.** Run your relevance step against [`data/eval/labels.json`](./data/eval/labels.json) and report **recall and precision per profile** with one command (e.g. `docker compose run radar eval`). Put the numbers in your README, and say which design change moved them most.
10. **A few meaningful tests** (no coverage theatre).
11. **A page to work with.** A plain web page is enough: a policy officer sets country and sectors, reads the ranked list with the "why relevant" of each entry and its source trail, and sees the status of each source, without reading the docs. We use it in the live demo. Clarity counts, looks do not.

**Nice-to-haves (to shine, fully optional):**

- Further live sources: a national channel next to an EU one, ideally of a country whose language you do not speak.
- Weekly digest export (Markdown, e-mail-ready HTML or RSS) per operator profile.
- A structured interface for other tools: a small JSON API or an MCP server (or both on the same core) that returns structured hits, not prose: item, procedure, jurisdiction, stage, deadline, why relevant, source trail, and the **denominator** ("3 hits out of 1,204 items checked").
- Extending the eval set (e.g. labelling the third profile, or labelling a sample of your live items) and showing how a design change moved recall/precision.
- Cross-language consolidation: recognising that a German, a Spanish and an English title belong to the same EU act.

> **The interesting design decisions:** For a chamber, a missed rule is far more expensive than a false alarm, but a list nobody reads is useless too. Where do you put the threshold, and can an LLM ever *remove* an item, or only *add and rank*? How do you map an untagged Polish draft regulation onto NACE? What counts as "the same procedure"? What do you do when a source answers slowly instead of failing? How do you keep the output reproducible when an LLM is in the loop? We look at your reasoning, not at a prescribed formula. This is exactly where we see your judgment.

> An LLM is allowed and probably useful, not required. If you use one, keep the provider behind a seam with a deterministic offline fallback. Think about where the operator's data goes: a chamber may not want its sector profile sent to an arbitrary API. Stack is your choice; the deliverable is a Git repo plus a Docker image buildable from it.

### Part B: Code review (~15 min)

We give you a short, AI-generated Python snippet ([`code-review/snippet.py`](./code-review/snippet.py)). Its docstring promises more than the code delivers. Tell us what is wrong, which defect you would fix first and why (3–5 sentences), fix that one, and list what else you would not ship as it stands (missing edge cases, questionable assumptions, validation). Work on it the way you work on everything else, with your agent if you like. In the presentation we go through your answer together and ask you to defend it: we want to see whether you can judge AI output, not just produce it.

## Work agentically (expected)

We hire people who build *with* AI coding agents (Claude Code, Cursor, Copilot agent mode, Codex, Aider, your own). Build this challenge that way, and show us how:

- Commit your **agent setup** to the repo, e.g. `AGENTS.md` / `CLAUDE.md` / rules files, specs or plans you gave the agent, custom commands, subagent or MCP configuration.
- Add **transcript notes** (`docs/agent-log.md` or similar): the key prompts, where you steered, how you verified what the agent produced, and at least one place where the agent got it wrong and how you noticed. Excerpts are enough; full transcripts are welcome but optional.
- Remove secrets and API keys from anything you commit. Never commit `.env`.

## Ground rules

- **Timebox: one calendar week.** The week is there to give you flexibility, not to be filled. *(Decision log: 5–10 bullet lines.)*
- **We do not expect polish.** Rough edges are fine, on the page too. Spend your time where the hard problems are (relevance, dedup, live sources, measurement) and say what you left rough and why.
- **Use any AI, any library, search freely.** Expected, not just allowed. Cursor, Claude, Copilot, coding agents: go ahead.
- **The core (A + B) is the bar.** Nice-to-haves are for shining and completely optional. If you cannot finish a must-have, tell us what is missing and how you would do it; an honest gap beats a faked feature.

> **Important:** A rough core with clear thinking beats a polished but shallow implementation. We mean it, please don't over-invest beyond the week. More hours do not mean more points with us; we evaluate the core result, not the time spent.

AI Factory Austria stands for equal opportunity. If you need support or adjustments in the process, let us know, we'll help. University, bootcamp or self-taught: what counts is how you think and work with AI.

## What you submit

1. **Repo link** (GitHub/GitLab) with code, `Dockerfile` + `docker-compose.yml`, README (including your eval numbers).
2. **Code review answer** (Part B): as a file in the repo or a short doc.
3. **Agent setup + transcript notes** (see "Work agentically").
4. **Short decision log + key prompts:** 5–10 lines of decisions/trade-offs plus the AI prompts that made the difference.
5. **`THIRD_PARTY.md`:** every dependency, model, dataset and data source you use, with its licence or terms of use (for public sources: the reuse terms of the portal, and any rate limits you respected).
6. **Self-report:** how many hours did you invest? (Honest, no penalty.)

## Licensing of your submission

We want to be able to build on what you create, and publish it as part of AI Factory Austria's open outputs. By submitting, you:

- license your submission (code, documentation, configuration, eval data you add) under the **Apache License 2.0**, the same licence as this repo (see [`LICENSE`](./LICENSE));
- confirm that the submission is your own work (built with AI tools, which is expected) and that you have the right to license it this way;
- confirm that any third-party code, models and data you include or call are used under licences or terms compatible with that, and are listed in `THIRD_PARTY.md`.

This allows AI:AT to use, modify and publish your submission. If we publish something based on it, we will credit you by name if you want that, and leave you out if you don't; tell us in your submission e-mail. If you cannot accept these terms, please talk to us before you start.

## How we evaluate (transparent)

| Dimension | Weight |
|---|---|
| Functionality (does it run, does it meet the core) | 20% |
| Decomposition & judgment (ambiguity resolved sensibly, good trade-offs) | 20% |
| AI collaboration / process (how you leveraged & verified AI) | 20% |
| Code quality & taste (readable, maintainable, AI "slop" recognised) | 15% |
| Communication / docs (README, decision log) | 15% |
| Tests (meaningful tests, no coverage theatre) | 10% |

**Overall weighting:** submission 60 %, presentation 40 %. The page is assessed as part of Functionality and in the live demo.

> Part B (code review) does not count towards the weighting above. It is a separate signal with especially high information value about your judgment of AI code and can tip the balance in close decisions.

## Submission & timeline

- **Deadline:** The accompanying e-mail states the binding submission date (one calendar week from receipt).
- **Submission:** by e-mail to aiandbusinessgrowth@ai-at.eu.
- **Feedback:** We get back to you within ~10 working days, with a date for the presentation or a short reply.

> The concrete dates (submission date, upload link if any) are in the e-mail accompanying this brief.

## Presentation

After the submission you present your result to us (about 45–60 minutes: ~20 minutes of your presentation, the rest questions and a short live extension). Bring your running result and your repo. We ask you to cover:

1. **How you researched the problem.** What you looked into at the start (domain, data sources, standards and formats), what you learned, and which decisions that research drove.
2. **How you worked agentically.** Your agent setup, the prompts and specs you gave it, how you steered and verified its output, and where the agent failed or misled you.
3. **How you made it work.** Architecture, the main trade-offs, what you deliberately left out and why.
4. **What happens underneath.** Expect deep-dive questions on your own code: why a particular line is there, what happens on a given edge case, what you would change first. "The agent wrote that" is a fine starting point for an answer, not the end of one.
5. **A small live extension.** We add a small new requirement and watch how you extend your own code, with your usual AI tools. It is about how you think out loud, not about a perfect result in 10 minutes.

The presentation counts 40 % of the overall score (see How we evaluate).

| Presentation dimension | Weight |
|---|---|
| Problem research (domain, sources, standards understood and used) | 20% |
| Agentic practice (setup, steering, verification, honest account of failures) | 25% |
| Solution reasoning (architecture and trade-offs explained) | 20% |
| Depth of understanding (answers on own code, edge cases, live extension) | 25% |
| Communication (clear, structured, fitted to the audience) | 10% |

Afterwards we show you our own approach and talk about it openly. Everyone gets feedback, however it turns out.

> **Fair and transparent.** This challenge is unpaid; in return we show you our own approach after the debrief, with real decisions, prompts and trade-offs. That is our "learn" promise in action. And: structured, honest feedback for every person, however the process ends. No ghosting, ever.

## Data protection

> **Data protection.** We use your materials (repo link, documents, prompts, recordings) for the hiring decision and, under the licence above, for building on the submitted work. We do not pass your personal data on to uninvolved third parties and delete the personal data from your application (contact details, recordings, assessment notes) no later than **six months** after the selection procedure ends (or earlier at your request), in accordance with the GDPR. The legal basis is the initiation of a possible employment relationship (Art. 6 GDPR); you can request access or deletion at any time. The licence to your submitted code and documentation is separate from your personal data and continues after deletion. You may keep your repo private and give us access; your presentation is seen only internally. Hosting services you choose (e.g. GitHub) are subject to their own privacy policies. Questions: aiandbusinessgrowth@ai-at.eu.

## Appendix A: Code snippet (Part B)

This is the snippet for Part B: say what is wrong, fix what matters most, critique the rest. It is also in the repo: [`code-review/snippet.py`](./code-review/snippet.py).

```python
"""
select_for_operator: picks the radar items an operator should see.

An item is shown if
  1. its jurisdiction is "EU" or the operator's country, and
  2. it concerns the operator's sector: one of its NACE tags equals one of the
     operator's codes, or is a broader or narrower code in the same branch
     (an item tagged "C24" concerns an operator on "C24.4", and vice versa).
     Items without any NACE tag are horizontal rules (late payments, SME
     reporting, ...) and concern every sector, so they are always shown.

Result is sorted by deadline, soonest first; items without a deadline last.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class Item:
    id: str
    jurisdiction: str
    title: str
    nace_tags: list[str] = field(default_factory=list)
    deadline: date | None = None


@dataclass
class Operator:
    country: str
    nace_codes: list[str]


def _same_branch(a: str, b: str) -> bool:
    return a.startswith(b) or b.startswith(a)


def select_for_operator(items: list[Item], operator: Operator) -> list[Item]:
    selected = []
    for item in items:
        if item.jurisdiction not in ("EU", operator.country):
            continue
        if not any(
            _same_branch(tag, code)
            for tag in item.nace_tags
            for code in operator.nace_codes
        ):
            continue
        selected.append(item)

    return sorted(selected, key=lambda i: i.deadline or date.max)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    items = [
        Item("X1", "EU", "Anti-dumping duty on cold-rolled steel", ["C24.1"], date(2026, 12, 1)),
        Item("X2", "EU", "Late payments in commercial transactions", [], date(2026, 12, 9)),
        Item("X3", "AT", "Scrap shipment amendment", ["C24"], date(2026, 12, 5)),
        Item("X4", "DE", "Steel recycling quotas", ["C24"], date(2026, 12, 3)),
        Item("X5", "EU", "Toy safety: online marketplaces", ["G47"], None),
    ]
    operator = Operator(country="AT", nace_codes=["C24.4", "C25"])

    for it in select_for_operator(items, operator):
        print(f"{it.id}  {it.deadline}  {it.title}")
```

*AI:AT Hiring Team*
