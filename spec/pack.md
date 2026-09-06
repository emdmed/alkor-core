# Contract pack format — spec 3

A **contract pack** is a directory belonging to your project that holds the prompts,
schemas, vocabularies and eval cases a model is measured against. `medextract` reads it; so,
normally, does your own application. That is the entire point of the format: the artifact
under measurement and the artifact in production are the same bytes.

This document is the interface. It is versioned because a pack may be read by
implementations this repository cannot see.

## The shape

```
your-project/contracts/
  pack.toml            the manifest — the only file medextract knows by name
  prompts/…            whatever your contracts happen to be
  schemas/…
  evals/…
  notes/…
```

Nothing about the contents is known to the harness. Files are read by manifest **key**,
never by path, so moving or renaming a contract is a change to `pack.toml` rather than a
change to code.

## `pack.toml`

```toml
spec = 3                              # format version; absent means 1
name = "clinical"                     # identifies the pack in errors and traces

documents = "notes/{case}.note.txt"   # optional: per-case source documents

[files]                               # key -> path, relative to this file
prompt       = "prompts/vital-signs.md"
schema       = "schemas/vital-signs.schema.json"
schemaGolden = "schemas/vital-signs.golden.json"
cases        = "evals/vital-signs-cases.json"
models       = "models.default.toml"

[include]                             # optional: placeholder -> file key
GLOSSARY = "glossary"

[yourprofile]                         # optional: anything else, ignored by the harness
someRule = true
```

### `spec`

The format version this pack is written against. **Absent means 1**, so a pack written
before versioning existed stays valid and does not need editing.

A pack declaring a version the harness does not read is **refused**, not read under the old
rules. A misunderstood manifest would otherwise produce a number rather than an error, and a
number produced from a misunderstanding is the one outcome an eval must never have.

### `name`

Required. Free-form. Appears in errors and in every trace line, so make it the name you
would want to see in a result you found six months later.

### `documents`

Optional. A path template containing `{case}`, substituted with an eval case's name. This is
how a pack ships one source document per case without listing them all.

The consequence worth knowing: a case's `name` and its document's filename are the same
string, which is a constraint on how you name cases. A template with no `{case}` in it is
**refused** at load: every case would read the same file, and the run that followed would
report a number over a corpus of one.

**Since spec 3 it may instead be a table of kind → template**, for a pack whose tasks read
different KINDS of source document:

```toml
[documents]
default    = "notes/{case}.note.txt"
transcript = "transcripts/{case}.transcript.txt"
```

A bare string means the `default` kind and nothing about it changed, so no existing pack
needs editing. A profile asks for a kind by name; asking for one the pack does not declare is
an **error**, never a fall back to `default` — a task handed the wrong corpus does not fail,
it produces a plausible number for a question nobody asked.

Reach for the table only when the documents really are different things. The reference pack
grades three tasks over written clinical notes and a fourth over transcripts of clinicians
dictating them: the two corpora share no file, answer to different prompts, and filing the
transcripts as `notes/*.note.txt` would mislabel them in the one directory where what a
document is matters most. Two tasks reading the same notes still share one kind — see below.

### `[files]`

Key → path, resolved relative to `pack.toml`. `..` is allowed and normal: a pack usually
sits in a `contracts/` subdirectory and needs to reach sibling data.

Keys are yours. The harness has no opinion about what a pack contains — `prompt`, `schema`
and `cases` above are conventions of the profile reading them, not of the format. A profile
asking for a key the manifest does not declare gets an error naming every key that *is*
declared.

**Several tasks live in one pack by prefixing keys**, not by nesting tables: the reference
pack declares `vitalSignsPrompt`/`vitalSignsSchema`/`vitalSignsCases` beside `summaryPrompt`
and `noteFormatPrompt`. The format grows no concept of a "task" for this, because a task is
a decision of the profile reading the pack — which is also why the flag that selects one
(`--task`) is passed through to the profile untouched, and why a pack may declare which task
runs by default in its own settings table.

Two things the reference pack does that a multi-task pack usually wants:

- **Share the corpus where it is the same corpus.** A second task's cases can name a first
  task's case and read the same file: 30 notes grade three tasks in the reference pack, and a
  note fixed once is fixed for all of them. Where it is NOT the same corpus, declare a second
  `documents` kind rather than bending one filename convention over both.
- **Share the schema where it is the same contract.** Two of that pack's tasks answer the same
  question — what are the four sections a clinician reads — about a written note and about a
  dictation. They send the same schema under different `json_schema.name` labels, because two
  schemas for one structure are two things free to drift in property order, and property order
  is what gets compiled into a grammar. What differs between them is the prompt.
- **State the input rule, not just the prompt.** A task whose input is assembled from several
  documents has an assembly rule — per-document cap, running total, line format — and that
  rule belongs in the manifest beside the prompt. Two runtimes that assemble differently are
  grading different inputs while appearing to share a prompt, and nothing in either codebase
  would show it.

### `[include]`

Optional. Placeholder → file key. When a profile calls `render(key, vars)`, each
`{{PLACEHOLDER}}` in that file is replaced with the whole contents of the file named by the
key, and then with the caller's `vars`.

Substitution is **single-pass per key**: an included file containing `{{X}}` is left alone
rather than expanded recursively. A placeholder that survives substitution is an **error**,
not a warning — a prompt that silently loses a section it was written to carry produces a
run measuring a different prompt.

### Other tables

Any table the harness does not know is ignored. It acts only on `spec`, `name`, `files`,
`documents` and `include`.

Put your profile's own settings here rather than in its code when they are part of the
*contract* — a rule the eval applies and the application does not is a rule that ships
unverified. The reference pack keeps its schema label and its default task this way.

Three rules are worth calling out, because all three were learned by getting them wrong.

**State a verification rule in full; never let it default.** The reference pack declares
`collapseWhitespace`, `caseSensitive` and `accentSensitive` for quote checking, and
`deletionOnly` for derivation, and the loader refuses a pack that omits any of them. A
comparison rule that defaults is a check the pack author believes is running and may not be:
this pack's two quoting tasks silently disagreed about accents for as long as the accent rule
was unstated, so one corpus produced two different provenance numbers and printed them in the
same table.

**Say whether your corpus is synthetic.** A trace holds the completion, the parse error that
quotes it, and the misses that quote the model's spans. The reference profile writes those
verbatim only when the pack sets:

```toml
[clinical]
corpusSynthetic = true
```

A pack that does not say is treated as holding real records and its trace content is elided to
a digest. That default is deliberate and belongs in your own profile too: the failure here is
not an untidy log, and a safety check that has to be switched on is one that was off the first
time it mattered.

**Say which language your corpus negates in.** Set matching refuses a match when a negator
opens the same clause, because plain containment scored the term `diabet` against the item
"No diabetes mellitus" — the opposite fact, counted as a find. The word list is the pack's:

```toml
[clinical.setMatching]
negators = ["no", "not", "never", "denies", "denied", "without",
            "sin", "niega", "ningun", "ninguna", "nunca"]
```

Omitting the table inherits exactly that list, which is **English and Spanish** — the
reference corpus's two languages and nobody else's. A pack in German or Portuguese that says
nothing gets eleven words matching none of its own negations, and every negated item scores as
a find: silently, and in the direction that inflates recall. Unlike the verification rules
above this one has a default, because an absent negator list does not fake a passing check —
it is simply wrong in a way a default fixes rather than hides. Declaring the table and leaving
it empty is refused; that is a typo, not a language without negations.

**A second call is a contract, not an implementation detail.** The clinical pack declares a
medication pass: the same transcript, asked for one section, replacing that section in the
reading. It is four file keys, a schema name, a `[sampling.*]` block, and a table saying which
input shapes take it:

```toml
[clinical.medicationPass]
shapes = ["dictation"]
```

Three things about that table are the general lesson. It is **in the pack**, because the
consuming application makes the same decision on every recording it handles and two runtimes
deciding separately grade different pipelines. Its value is **measured** — dictations gain, the
same pass over two-speaker consultations emits a retracted drug and keeps a superseded dose —
rather than chosen for safety. And **omitting it turns the pass off**, so a pack that has not
measured the boundary gets one call per document, which is what every pack did before the
contract existed.

A second call also changes what a number means, so the eval prints the first-pass gates beside
the final ones on every run and the two halves stay separable. **Write that block before you
decide the default, not after.** It is what caught this pass shipping a drug the speaker had
stopped, and what showed — once fixed — that the pass is worth its call: over the shapes that
take it, item recall 94% → 96% and dose errors 3 → 1, with every gate clear. A second pass
measured only on the cases that motivated it will always look better than it is.

**Say which words your corpus doses in.** A medication item's `text` is the drug name and
nothing else, and that rule is invisible to every other check: `"metformin 500 mg twice daily"`
verifies as a quote, derives from that quote by deletion alone, and matches the expectation
`metformin` by containment. Three green axes over an item that breaks the contract. So a third
check reads `text` as a NAME:

```toml
[clinical.medicationName]
maxWords = 3
doseTokens = ["mg", "g", "daily", "twice", "morning", "night", "required",
              "miligramos", "cada", "veces", "diario", "noche"]
```

It is a rule about **shape, not pharmacology**: a token containing a digit is rejected outright,
a listed dose word is rejected, and a `text` longer than `maxWords` is not a name. A check that
knew which words are drugs would need a list of every drug, which is exactly what a pack in a
new specialty must not have to supply.

Omitting the table inherits the English-and-Spanish list, on the same terms as the negators
above and with the same limit: a pack in a third language inherits words it never uses and
passes every dose-laden name. The failure is one-directional — an unrecognised dose word makes
the check MISS a bad item, never reject a good one — which is why this table defaults at all.
Declaring it and leaving `doseTokens` empty is refused, as is `maxWords` below 1.

The rate is **printed whether or not you gate on it**. Declare `medicationNameFloor` in your
case file once you have measured a number; until then the axis is visible and advisory. An axis
nobody can see is an axis nobody fixes — this one was invisible while four separate
interventions were evaluated against it.

## Goldens: pin bytes, not structure

If your pack ships a schema for constrained decoding, ship a **golden** beside it: the
schema exactly as serialized.

llama.cpp compiles object properties into the GBNF grammar **in the order given**, so
property order decides what the model is forced to emit first. A reordering that deep
equality calls identical changes the output. Measured on one extraction schema, with nothing
different but key order: the domain identifier first produced 6 items and 1625 characters;
alphabetical order — which puts `confidence` first, demanding a confidence score before the
model has committed to anything — produced 77 items and 8902 characters of padding.

So a golden is compared as bytes:

```ts
assert.equal(JSON.stringify(schema), golden.trim())
```

Two more constraints, both measured failures rather than style:

- **Bound every array.** A grammar blocks EOS while an array is open — the model cannot stop
  before `]`, so an unbounded array runs to the token cap. `maxItems` and `uniqueItems` are
  load-bearing; without the second, a model pads to `maxItems` with duplicates instead of
  terminating.
- **Require every property; allow a null value.** An optional property compiles to an
  ordered maybe-branch, which hands the model a legal way to stop early — that is how a run
  comes back as `{}`. `required` plus `anyOf: [<shape>, null]` makes the model visit every
  slot and say something about each.

## What a pack is read by

Two things, and the second is why the format exists.

1. **A profile.** The code that builds the prompt, parses the reply, scores it and decides
   the gate. It may live in this repository or in yours — see `module` in the README.
2. **Your application.** Reading the same prompt and the same schema at runtime is what makes
   an eval number describe the product. If the two diverge, the eval measures something
   adjacent to what ships.

When both exist, pin them to each other: same prompt bytes, same serialized schema, same
request body. A pack whose two readers disagree is worse than a pack with one reader,
because it reports a number for a contract nobody runs.

## Records

A run's trace opens with the conditions (`event: "run"`) and closes with a record
(`event: "record"`) carrying the harness version, the model the **server** reported, and
`contracts` — a sha256 per file the run actually **read**, keyed by path relative to the pack
root.

Read rather than declared, deliberately: the per-case documents are named by a template
rather than by a key, so a record built from `[files]` would pin the answer key and miss the
notes, which are the measured input.

## Versioning this format

- Breaking: removing a key's meaning, changing a resolution rule, changing render
  semantics, or making a previously-optional key **required**. These bump `spec`.
- Not breaking: adding an optional key, or adding a table the harness ignores.

`SPEC_VERSION` in `src/core/pack.ts` is what the harness reads today, and `SPEC_CHANGES`
beside it is what each version added, in the words a pack author needs. A loader that finds
a required key absent quotes that table rather than reporting only the key: "your pack
declares spec 1, this harness reads spec 2, and here is everything that happened in
between" is a fix, where "a table is incomplete" is a second way to be stuck.

### Changelog

**spec 2.** Two keys the reference profile now requires became load-bearing:

- `[clinical.quoteVerification].accentSensitive` — **required**. Without it the profile
  refuses to load. The two tasks that verify quotes had silently disagreed about accents,
  so one pack, one corpus and one declared rule produced two different provenance
  measurements printed side by side.
- `[clinical].corpusSynthetic` — optional, and its **default is the safe one**: a pack that
  does not set it is treated as holding real records, and its traces are elided to a digest
  rather than holding completions verbatim.

Both landed while `spec` still said 1, which is the mistake this section exists to record.
A pack written against spec 1 fails to load with a message naming the version it declares,
the version the harness reads, and the key — not with a bare TOML complaint.

**spec 1.** The format as first written.
