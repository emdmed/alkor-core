# Contract packs, verification and traces

## Contract packs

A pack is a **directory belonging to your project**, holding its prompts, schemas,
vocabularies and eval cases. It describes itself with a `pack.toml` manifest, and the
harness reads files by manifest **key** — never by path.

```toml
# your-project/contracts/pack.toml
spec = 3
name = "vitals"
documents = "notes/{case}.note.txt"

[files]
prompt       = "prompts/vital-signs.md"
schema       = "schemas/vital-signs.schema.json"
schemaGolden = "schemas/vital-signs.golden.json"
cases        = "evals/vital-signs-cases.json"
```

Point a profile at it:

```toml
[vitals]
mode = "extract"
pack = "../your-project/contracts"
url  = "http://127.0.0.1:8081"
```

Override the root with `PACK_ROOT_VITALS` or `--pack DIR`.

**Packs are not copied into this repository.** The typical pack owner is another runtime
evaluating the same model against the same contracts, and a copy is a divergence waiting to
happen. What actually drifts between two implementations is prompts, schemas and scoring
rules — all data. So the data is shared and the runtime stays native to each side. When a
pack ships goldens, the profile pins its assembled prompt and schema against them
byte-for-byte, which is what makes a cross-runtime comparison mean anything.

`spec` is the pack format version. Absent means 1. A pack declaring a version this harness
does not read is refused rather than read under the old rules — a misunderstood manifest
would otherwise produce a number instead of an error.

The format is documented in full in [`spec/pack.md`](../spec/pack.md), including goldens, the
`[include]` rules, and the three constrained-decoding constraints a schema has to respect.

## Verification

Verification operates at three levels:

1. **Provenance** (no LLM) — after every extraction, `verifyQuote()` checks whether each
   field's `quote` appears in the source document by literal containment (whitespace/case
   accent normalization). `verifyDerivation()` checks whether the `text` field is a word
   subsequence of the `quote`. These run inside the profile as post-processing, no
   additional model call.

2. **Model-based** (`src/profiles/verifier/`) — a separate LLM instance that receives the
   original document and the extraction JSON, then checks every field's quote against the
   document. Reports `hallucination`, `modified_quote`, `missing_quote`, or
   `unsupported_value`. This is the second step of the `clinical-verified` workflow.

3. **Rule-based** (eval shortcut) — checks that every numeric value in the extraction
   appears somewhere in the document. Conservative, fast, no GPU.

## Traces

Every run writes JSONL to `${XDG_STATE_HOME:-~/.local/state}/alkor/traces/<profile>/`
— **outside any repository**, deliberately. A trace line contains the raw prompt and the
raw completion, which for a clinical profile means the note. A profile that handles patient
data supplies a `redact` hook and must set one before tracing anything real.
