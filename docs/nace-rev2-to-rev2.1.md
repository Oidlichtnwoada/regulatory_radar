# NACE Rev. 2 → Rev. 2.1

The radar works only with **NACE Rev. 2.1**. The challenge data is partly written in **Rev. 2**:

- the `nace_tags` of the seed items (`data/items*.json`, e.g. `K64`, `G47`);
- the three example profiles (`data/examples/*.yaml`).

Rev. 2 codes are mapped to Rev. 2.1 at the very edge, so everything behind it (database, pipeline, agents, API, UI) sees Rev. 2.1 only:

| Where Rev. 2 appears                               | Mapped where                                                                        | Stored                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Seed item tags                                     | when a record is normalised during ingestion (`sources/file.source.ts`)             | Rev. 2.1 codes on the finding; the original tags stay in `attributes.naceTagsOriginal` and the raw payload |
| Example profiles                                   | when the API starts (`domain/presets.ts`, served as `GET /api/v1/profiles/presets`) | Rev. 2.1 selection used by the UI presets and by the eval                                                  |
| A Rev. 2 code answered by the classification agent | in the code check (`naceLabelProblems`)                                             | not stored: the agent is asked to correct it, with the Rev. 2.1 codes as a hint                            |

## How the mapping works

There is one mapping function, `mapRev2Code` in `apps/api/src/domain/nace-rev2.ts`, used in all three places.

- **Source:** Eurostat's official correspondence table **NACE2_NACE2.1** (EU Vocabularies, `http://data.europa.eu/ux2/nace2/NACE2_NACE2.1`), stored at class level in `data/nace_rev2_to_rev2_1.csv`. It has 974 links between the 615 Rev. 2 classes and 650 Rev. 2.1 classes.
- **Method:** a Rev. 2 code (division, group or class) takes every Rev. 2.1 class that its Rev. 2 classes moved to.
  - **Recall first:** partly moved activities are included, so nothing the operator meant to watch is lost.
  - **Compressed:** the result is reduced to whole groups or divisions where all their classes are included.
- **Exactness:** the function also reports whether the result is **exact**. It is not exact when a selected Rev. 2.1 code also receives activities from other Rev. 2 codes.
- **Speed:** all Rev. 2 divisions, groups and classes are precomputed when the taxonomy is loaded (about 65 ms), so mapping a tag is one map lookup (about 0.15 µs).
- **Limit:** bare Rev. 2 sections (a single letter) are not mapped, because the correspondence is defined per class.

## The example profiles: the mapping is not 100 % the same

| Profile       | Rev. 2 (example file) | Rev. 2.1 (preset, eval)            | Exact? | What differs                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------- | ---------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metals_at`   | `C24`, `C25`          | `C24`, `C25`, `C28.21`             | no     | `C24` is identical. Part of Rev. 2 25.21 (central heating radiators and boilers) moved to `C28.21` (ovens, furnaces and permanent household heating equipment), which also contains Rev. 2 28.21.                                                                                                                                                                                                               |
| `retail_es`   | `G47`                 | `G47.1`–`G47.7`, `G47.9`, `J60.39` | no     | Rev. 2.1 `G47` also covers motor-vehicle retail (`G47.8`, formerly `G45`), so `G47.8` is not selected. Intermediation for retail sale (`G47.9`) and sporting-goods retail (`G47.63`) also receive Rev. 2 45.x and 82.99. Part of Rev. 2 47.91 (online sale of downloadable content) moved to `J60.39`, which also contains Rev. 2 63.11/63.12. Rev. 2 online retail (47.91) is spread over the product classes. |
| `agrifood_pl` | `A01`, `C10`          | `A01`, `C10`, `C11.07`             | no     | Part of Rev. 2 03.22 (freshwater aquaculture) flows into `A01.48`. Part of Rev. 2 10.89 moved to `C11.07` (soft drinks and bottled waters), which also contains Rev. 2 11.07.                                                                                                                                                                                                                                   |

**What this means:** the Rev. 2.1 selections cover everything the Rev. 2 profiles meant, plus some neighbouring activities that share a Rev. 2.1 class. It is a little broader, by design. The UI shows this note next to each preset.

**The eval scores the Rev. 2.1 selections**, the same ones the UI presets select. The labels refer to procedures, so their meaning doesn't change.

A unit test checks that each preset equals the mapping of its example file, so the UI, the eval and the ingestion can't drift apart.
