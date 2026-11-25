# Seed dataset: fields & notes

> ⚠️ **The dataset is synthetic and simplified (as of 2026-11).** All items, procedure numbers, references and organisations are invented. They follow the semantics of real public channels (EUR-Lex, the European Parliament agenda, Commission consultations, TRIS, national gazettes and consultation portals), but no item describes a real procedure. No domain knowledge needed: the fields below are understandable without prior knowledge. Treat the data as play material, not as legal reality.

## Contents

| File | Content |
|---|---|
| `items.json` | 53 regulatory items from EU and national channels, 5 languages (en, de, es, pl, fr) |
| `items.csv` | The same data as CSV, easy to open in Excel/Sheets |
| `items.next.json` / `items.next.csv` | The same channels one week later (61 items), for a second run (see [Second run](#second-run-itemsnextjson)) |
| `examples/profile_*.yaml` | 3 operator profiles (country + NACE codes) |
| `eval/labels.json` | Relevance labels for two of the profiles (`metals_at`, `retail_es`) |
| `nace_extract.csv` | The NACE codes used in this repo with short English titles |
| `sources.yaml` | Real public sources (EU and national) with access notes, for your live adapter |

`items.json` and `items.csv` contain the same data, as do `items.next.json` and `items.next.csv`. Every JSON entry carries a `_note` field with the synthetic disclaimer. *(The CSV starts directly with the header row; lists are joined with `|`; in `nace_tags` an empty cell means `null` and `[]` means an explicitly empty list.)*

> **Notes on the dataset:**
> - **The data is deliberately messy, like the real channels.** Most items have `nace_tags = null`, some have no `summary`, some procedures appear in two channels, some acts appear in two language versions, and some items are reactions to another item (`related_to`). That is intended.
> - **`jurisdiction` is not the channel.** TRIS is an EU portal, but its items are national drafts of the notifying country.
> - **You don't have to use every field.** Choose what makes sense for your pipeline and briefly justify it.

## Schema (`items.json` / `items.csv`)

| Field | Type | Meaning |
|---|---|---|
| `_note` | string | Synthetic disclaimer (JSON only) |
| `id` | string | Unique item id |
| `channel` | string | Where the item was found: `eu_eurlex`, `eu_parliament_agenda`, `eu_consultation`, `eu_council`, `eu_research_service`, `eu_tris`, `national_gazette`, `national_parliament`, `national_draft_consultation` |
| `jurisdiction` | string | `EU` or ISO country code of the rule-maker |
| `language` | string | ISO 639-1 language of `title`/`summary` |
| `doc_type` | string | e.g. `legislative_proposal`, `delegated_act`, `implementing_act`, `plenary_vote`, `public_consultation`, `council_position`, `ministerial_draft`, `ministerial_order`, `government_bill`, `act`, `regulation`, `decree`, `royal_decree`, `technical_regulation_notification`, `study`, `feedback_statement` |
| `stage` | string | `information`, `proposal`, `consultation_open`, `standstill`, `in_procedure`, `adopted` |
| `title` | string | Title in `language` |
| `summary` | string\|null | Short description; `null` if the channel gives none |
| `published` | string (ISO date) | When the channel published the item |
| `deadline` | string\|null (ISO date) | Last day to act (see `deadline_kind`) |
| `deadline_kind` | string\|null | `feedback`, `consultation`, `amendments`, `standstill_end` |
| `event_date` | string\|null (ISO date) | Scheduled event, e.g. plenary vote |
| `ref` | string\|null | Procedure / document reference (invented); shared refs mean the same procedure or act |
| `related_to` | string\|null | Item id this item reacts to (feedback, statement) |
| `nace_tags` | string[]\|null | NACE codes given by the channel. `null` = channel gives no sector information. `[]` = channel states it is not sector-specific (see the note below) |
| `topics` | string[] | Topic tags of the channel, in the channel's language |

> **`nace_tags = []` does not decide relevance.** An empty list only says that the rule does not target a particular sector. It does not say that the rule matters to every sector. A cap on payment terms between businesses (`EU-EP-0009`) applies to every company and is labelled relevant for both profiles; an amendment to the law on the efficiency of the courts (`ES-BOE-0026`) does not target a sector either, but it changes how the justice service is organised, not what a shop has to do, and is labelled not relevant for `retail_es`. Both carry `[]` on purpose: whether such an item matters has to come from its title and summary, like for untagged items.

Reference date for "upcoming" and "open": **2026-11-16** (`as_of` in `eval/labels.json`).

## Second run (`items.next.json`)

The radar runs repeatedly, so there is a second snapshot: what the same channels return one week later, reference date **2026-11-23**. It has the same schema and contains all 53 items of `items.json` unchanged plus 8 items published after 2026-11-16 (`AT-PAR-0054` to `DE-GAZ-0061`). Run the radar on `items.json`, then on `items.next.json`, to see what your radar does with a second run. Among the new items are:

- later steps of procedures that are already in `items.json` (same `ref`), whose title and summary no longer name the sector on their own;
- new procedures, relevant to one of the labelled profiles or to none of them;
- a reaction to an existing consultation (`related_to`), which is a new item but not a new procedure.

`eval/labels.json` covers `items.json` only; the new items carry no labels.

## Operator profiles (`examples/profile_*.yaml`)

| Field | Type | Meaning |
|---|---|---|
| `profile_id` | string | Matches the key in `eval/labels.json` |
| `operator` | string | Who runs the radar (fictional) |
| `country` | string | ISO country code |
| `nace_codes` | string[] | Sector selection, any NACE level |
| `languages` | string[] | Languages the operator reads |
| `notes` | string | Free-text context, as an operator might describe their members |

## Evaluation labels (`eval/labels.json`)

For each labelled profile, every **procedure group** is in exactly one list: `relevant`, `borderline` (not scored either way) or `not_relevant`. `procedure_groups` maps a group id to the item ids that belong to it (duplicates, language versions, reactions); an item not listed there is its own group. Report recall and precision on `relevant` vs `not_relevant`; how you treat `borderline` and how you count a group that you showed twice is your call, write it down.

The labels are our judgment, made for this synthetic data. If you disagree with a label, say so and why; that is a good signal, not a bad one.

## Live data (required: one adapter, EU-level or national)

`sources.yaml` lists real public EU and national sources with a note on how they answered a plain request on 2026-11-18. The list is a starting point, not a limit. Some block plain requests or answer slowly; handling that gracefully is part of the job, getting around it is not: use the official APIs and feeds and do not work around bot filters, logins or rate limits. Respect the terms and rate limits of each source and list what you use in `THIRD_PARTY.md`.
