# Contract pack format — spec 1

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
spec = 1                              # format version; absent means 1
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
string, which is a constraint on how you name cases.

### `[files]`

Key → path, resolved relative to `pack.toml`. `..` is allowed and normal: a pack usually
sits in a `contracts/` subdirectory and needs to reach sibling data.

Keys are yours. The harness has no opinion about what a pack contains — `prompt`, `schema`
and `cases` above are conventions of the profile reading them, not of the format. A profile
asking for a key the manifest does not declare gets an error naming every key that *is*
declared.

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

- Breaking: removing a key's meaning, changing a resolution rule, or changing render
  semantics. These bump `spec`.
- Not breaking: adding an optional key, or adding a table the harness ignores.

`SPEC_VERSION` in `src/core/pack.ts` is what the harness reads today.
