# The reference pack, task by task

## Eight tasks over four corpora

The reference pack grades eight contracts, and `--task` chooses:

```bash
node src/cli.ts eval --profile clinical --constrain                     # vital-signs, the default
node src/cli.ts eval --profile clinical --constrain --task summary      # a whole record in, three lists out
node src/cli.ts eval --profile clinical --constrain --task note-format  # one note, four sections, every item cited
node src/cli.ts eval --profile clinical --constrain --task transcript   # a dictation, sorted into the same four
node src/cli.ts eval --profile clinical --constrain --task shock        # a JSON exam payload, category + residue
node src/cli.ts eval --profile clinical --constrain --task sepsis       # a qSOFA payload, positive/negative + criteria
node src/cli.ts eval --profile clinical --constrain --task all          # the eight, each gated on its own floor
```

Two tasks are not in that list and are still `--task` values. `shock-extraction` and
`shock-pipeline` are the prose halves of the shock arm — the first graded on its own,
the second end to end — and `sepsis-extraction` is **reviewable but ungraded**: the profile
will run it over a document, and this pack declares no answer key for it, so `--task all`
leaves it out rather than reporting a made-up number. That is why eight tasks are graded
out of nine that exist.

| task | input | what it returns | gate |
|---|---|---|---|
| `vital-signs` | one note | nine nullable readings, each with the fragment it came from | detection recall ≥ 90% |
| `summary` | a **record**: several notes assembled into one message | three bounded sets — history, usual medication, pending | item recall ≥ 80% |
| `note-format` | one note | four sections; every item carries a `quote` and a derived `text` | item recall ≥ 75%, **plus** provenance ≥ 90%, derivation ≥ 90% and *nothing invented* (100%) |
| `transcript` | one **dictated transcript** — speech, out of order, correcting itself | the same four sections, same `quote` and `text` | item recall ≥ 65%, same three sub-gates at 85 / 85 / 100% — **provisional, unmeasured** |
| `shock` | one **JSON exam payload** — vital signs, capillary refill, mental status | category + `indeterminate_reason` + agreement with rule-based reference | agreement ≥ 70%, concordance ≥ 80%, coverage ≥ 90%, format valid 100%, schema valid 100% |
| `shock-extraction` | one **prose shock case** | the `ShockExam` payload the `shock` contract consumes, graded field by field against the same `exam.json` | exact match ≥ 67% — **provisional, 3 cases** |
| `shock-pipeline` | one **prose shock case** — notes describing vitals, exam, history | category, chaining extraction → classification | category agreement ≥ 67%, **plus** pipeline completion 100%, extraction exact ≥ 67%, echo fidelity 100%, not invented 100% — **provisional, unmeasured** |
| `sepsis` | one **qSOFA payload** — respiratory rate, systolic BP, GCS | positive/negative screen + `criteria_met` + agreement with the medprotocol CLI | screen agreement ≥ 84%, echo 100%, criteria fidelity 100%, score fidelity 100% — **provisional, unmeasured** |

Three things about this arrangement are the reason it is worth having, and none of them are
visible in a single-task pack:

**One corpus, three readings — and the rest genuinely different.** The
note-format cases name a case in the vital-signs corpus and read *that* note: 30 notes grade
three tasks, and a note fixed once is fixed for all of them. The summary task brings its own
documents because its unit of input is a patient rather than an encounter. The transcript task
brings its own because a dictation is not a note — the pack declares a second `documents` kind
for it (spec 3) rather than filing speech under a filename that calls it prose. The shock and
sepsis tasks bring their own because a JSON payload is not prose — the pack declares an `exams`
kind for it.

**One structure, two inputs.** `transcript` sends the *note-format schema*, byte for byte,
under its own `json_schema.name`. A clinician reads one structure, and a second schema for it
would be a second thing free to drift in property order — which is what gets compiled into the
grammar. What the task has of its own is the prompt, because speech has failure modes prose
does not: the speaker retracts a dose out loud and the retracted one stays in the transcript,
quotable; they dictate "comma" and "period"; they talk to whoever is typing; the transcriber
writes `[inaudible]` where a number should be. The interesting property is that the harness
needed almost nothing new to grade it — deletion-only derivation, which exists to stop a drug
name drifting, is also exactly the rule that strips a filler.

**The assembly rule is part of the contract.** A record is built into one message under
`[clinical.summaryAssembly]` — per-note cap, running total, line format, marker — because two
runtimes that assemble differently are grading different inputs while appearing to share a
prompt. Same argument as pinning the schema bytes, applied to the input side.

**Every task clears its own floor, and the two quoting tasks have sub-gates.** Averaging would
let a ceiling on the mature task carry the new ones. And a run that finds every expected item while
fabricating the spans it cites has not passed, which one averaged number could not say.

## Quote, then tidy

The note-format contract asks for two fields per item and checks both, because a schema can
guarantee the shape of a citation and the truth of it not at all:

- **`quote`** must be in the note by literal containment (`[clinical.quoteVerification]`).
  Not a regex: a pattern built from the model's own output has to escape every `.`, `(`, `/`
  and `°` it contains, and one unescaped character turns a failed verification into a passing
  one — the single failure mode a verifier must not have.
- **`text`** must be that quote with words **deleted** — every word already in the quote, in
  the same order (`[clinical.textDerivation]`). This is the half that quote verification alone
  does not give you. Measured on a sibling pack: a model emitted a quote reading *"antibiotic
  cover with ceftriaxona 2 g every 24 hours"*, which verifies character for character, beside
  the item *"ceptriaxona 2 g every 24 hours"*. Provenance was perfect and the line a clinician
  reads named a drug that does not exist.

Measured here on the first run of the new task, Qwen3-4B cited *"He takes two 500 mg tablets
up to four times daily"* and labelled it `paracetamol` — a drug name that appears in the
**previous sentence**, not in the span it cited. The quote verified; the derivation check is
what caught it.

## How hard the notes are

Every case rates its **note** from 1 to 5 — how hard the base text is to read, not how many
slots it grades and not how badly some model does on it. The rating is a property of the
corpus, so it does not move when the weights do, and a per-tier score from two models is
comparing the same texts.

| | the text | notes | slots |
|---|---|---|---|
| **1** | labelled and canonical: the sign is named, the figure follows it, one reading per sign | 2 | 6 |
| **2** | one systematic transformation — foreign abbreviations, imperial units, a decimal comma, an implausible value | 4 | 22 |
| **3** | a rule of the contract must be applied: prose, or two candidates for one sign (last, this encounter, stated not derived) | 6 | 27 |
| **4** | rejection before transcription: targets, plans, lab panels, another person's readings, an infant's normals | 10 | 55 |
| **5** | the text fights the reader: a chart instead of sentences, a figure retracted further down, a range around one true reading, a discharge summary made mostly of other numbers | 8 | 45 |

Two thirds of the graded slots — 100 of 155 — sit at 4 and 5. `eval` prints detection per
tier beside the gate, and
`--difficulty 4-5` grades only the hard end while iterating:

```bash
node src/cli.ts eval --profile clinical --constrain --difficulty 4-5
```

The tiers are **reported, never gated**. The floor is one number over the whole corpus,
because a contract ships or does not ship as one thing.
