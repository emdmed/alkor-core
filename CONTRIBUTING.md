# Contributing

## The shape of the thing

`alkor` extracts medical data from clinical notes with a small local model, and gates
itself on whether that worked. Most of its rules follow from what the two halves have in
common: **neither a wrong reading nor a wrong measurement looks like an error.** One looks
like a vital sign and the other looks like a score. A crash gets fixed in an hour; a
fabricated blood pressure gets charted, and a denominator that quietly moved gets quoted in
a slide deck.

So the bar for a change is not "does it work" but "can it be wrong without anyone noticing".

## Setup

```bash
npm install
npm test          # no model, no server, no pack required
npm run typecheck # tsc --noEmit; node checks none of the types it strips
npm run check     # both, which is what CI runs
```

Node ≥ 24. The CLI is plain TypeScript run natively — no bundler, no transpile, no build
step. What you read is what runs, and a change is testable the moment you save it.

**Run the typecheck as well as the tests, always.** Node runs this repository by STRIPPING
types, which means it verifies none of them: three signature changes in one afternoon —
`scoreCase`, `renderReading`, `checkQuote` — surfaced as test failures rather than as type
errors, and would have surfaced as runtime errors in any path a test does not happen to walk.
`tsconfig.json` sets `erasableSyntaxOnly`, so the typechecker refuses the constructs Node
cannot strip and the two agree about what this repository is allowed to contain.

To extract anything, or to run an eval, you need a `llama-server` you started yourself:

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/gemma-4-E4B-it-Q4_0.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
node src/cli.ts extract --profile clinical --case vs-en-03-prose --constrain
node src/cli.ts eval    --profile clinical --constrain
```

## The rules that are not negotiable

**No patient data. Ever.** `packs/clinical/notes/` is synthetic and written for this
repository. A note that is derived from, edited from, or "inspired by" a real record does
not belong here, and in a public repository the mistake cannot be taken back. This is the
one rule where a good-faith mistake is still unacceptable.

That fact is also *declared*, as `corpusSynthetic = true` in `pack.toml`, because the trace
writes completions verbatim only for a pack that says so — a pack that is silent has its
trace content elided to a digest. Do not set that key on a pack of real notes to make a trace
easier to read. It is the one line in a manifest that can put a record on disk.

**No number that was not measured.** Figures in `docs/measured.md` and in `RESULTS.md` come from a
run on the corpus in this repository, and name the model, the quantisation and the sampling
that produced them. Do not round up, do not carry a number over from another corpus, and do
not quote a result for contracts that have since changed — that gets a new dated entry, not
an edit.

**A bad result stays.** The `0/46` row in `RESULTS.md` is the most useful line in the file.
Deleting an unflattering measurement is the same act as inventing a flattering one.

**A timing is quoted with its machine, or not at all.** Every eval reports what it cost —
tok/s, latency, cache reuse — from the graded pass itself. Correctness travels between
machines; throughput does not. A speed belongs to a build, a quantisation, a context size, a
slot count and a piece of silicon, which is why the conditions line is read from the server
rather than taken from the pack, why the first (cold-cache) case is named apart, and why
nothing gates on any of it. Do not add a `bench` verb: a timing pass with its own prompts
measures something adjacent to the product, and the request body must stay byte-identical
whether or not anyone is timing it.

**Core names no domain.** Nothing under `src/core/` or `src/modes/` may mention a vital
sign, a clinical concept, or a consuming project. A domain arrives as a pack (its
contracts) and a profile (the code that reads them). If a change needs core to know
something about medicine, that is a sign the profile boundary is in the wrong place — raise
it rather than routing around it.

**The public API is `src/index.ts`.** Everything a profile is written against is exported;
nothing that is itself a profile is. Removing an export is a breaking change for people who
cannot be asked, so `test/package.test.ts` states the contract by name.

## Changing a contract

A pack's prompt, schema or cases are the thing under measurement, so a change to one
invalidates every number measured before it. The reference pack now carries **four** tasks —
`vital-signs`, `summary`, `note-format`, `transcript` — and each has its own prompt, cases and
floor. Schemas are shared where the contract is genuinely one contract: `transcript` sends the
note-format schema under its own label, because a clinician reads one structure and two
schemas for it could drift in property order. Three rules follow:

- **Every task clears its own floor.** Never average them, and never let a new task inherit a
  floor from an old one. `note-format` and `transcript` also carry sub-gates (provenance,
  derivation, nothing-invented), and a run that finds every expected item while fabricating
  the spans it cites must fail.
- **Say when a floor has not been measured.** `transcript`'s four floors were set before any
  model saw its corpus, and its case file says so in as many words. A floor nobody has
  measured looks identical in a report to one somebody has, so the distinction has to be
  written down where the number is — and replaced by a real one after the first graded run.
- **Fix the answer key when the key is wrong, and only then.** These tasks grade set
  extraction over free text, so an expectation is a set of terms and a miss can mean the model
  was wrong OR that the key demanded one of several correct wordings. Read the completion in
  the trace before touching either. Loosening a matcher because a run failed is how a floor
  gets tuned around a corpus defect; the first run of `note-format` produced five failures and
  all five were the model.

- Changing a **schema** means regenerating its golden. Property order is compiled into the
  grammar; see `spec/pack.md`.
- Changing the **corpus** — adding a case, fixing an expectation — means the denominator
  moves. `test/clinical.test.ts` pins it deliberately, so update the pin in the same commit
  and say what moved and why.
- Changing a **prompt** means re-measuring. Say in the commit message what the numbers were
  before and after.

New cases are welcome and the corpus still needs them. The most valuable ones are traps the
prompt does **not** pre-announce — that is the standing weakness, and one measured hint that
it matters is that gemma-3-4b, when it invents a heart rate, reaches for the exact figure in
the prompt's own worked example.

A new case carries a **`difficulty` from 1 to 5**, and the rubric it is rated against is in
`packs/clinical/evals/vital-signs-cases.json` under `_difficulty`. Two things about it are
easy to get wrong:

- It rates **the note, not the answer key and not the model**. A note is not a 5 because it
  grades seven slots, and it does not become a 3 when a bigger model starts getting it
  right. The rating is a property of the text, which is what makes a per-tier score
  comparable across runs.
- **An unrated case will not load.** A default rating would file a case's slots in a bucket
  its author never chose, and the per-tier breakdown would go on printing.

Rate honestly in both directions. A corpus with no 1s cannot tell a broken run from a hard
note, and a corpus with no 5s cannot tell a good extractor from a lucky one.

## Tests

- A test must be able to fail. A scorer test that only exercises the success path proves
  nothing — `test/clinical.test.ts` asserts hallucinations, wrong units, half-right blood
  pressures and fabricated quotes because those are the outcomes that matter.
- The eval LOOP is testable without a model, and is tested. `test/eval-loop.test.ts` runs it
  against a throwaway `node:http` server that counts requests and serves canned replies, which
  is how `--difficulty` was caught reaching two tasks and being read by neither. A flag that
  reaches an options object and is then ignored cannot be caught by a unit test of the thing
  it never reached.
- Nothing in `npm test` may need a model, a server or a private pack. Tests over contracts
  that ship here run; tests over contracts that do not ship **skip** (see `test/pack.ts`).
  A skipped test honestly says "not run"; a failing one claims the contracts disagree, which
  is a different and much more alarming statement.

## Commits and comments

The comments here explain **why**, and often cite the measurement that settled it. That is
deliberate: a rule without its reason gets "cleaned up" by the next person, and this
codebase is mostly rules whose reasons cost a run to learn. If you remove a constraint,
first find the comment saying why it exists.

Commit messages say what changed and what it cost. If a change made a number move, the
message is where the old number goes.
