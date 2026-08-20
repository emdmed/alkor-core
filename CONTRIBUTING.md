# Contributing

## The shape of the thing

`medextract` is a measuring instrument. Most of its rules follow from one property: **a
wrong measurement does not look like an error, it looks like a score.** A crash gets fixed
in an hour; a denominator that quietly moved gets quoted in a slide deck.

So the bar for a change is not "does it work" but "can it be wrong without anyone noticing".

## Setup

```bash
npm install
npm test        # no model, no server, no pack required
```

Node ≥ 24. The CLI is plain TypeScript run natively — no bundler, no transpile, no build
step. What you read is what runs, and a change is testable the moment you save it.

To run an eval you need a `llama-server` you started yourself:

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/Qwen3-4B-Q4_K_M.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
node src/cli.ts eval --profile clinical --constrain
```

## The rules that are not negotiable

**No patient data. Ever.** `packs/clinical/notes/` is synthetic and written for this
repository. A note that is derived from, edited from, or "inspired by" a real record does
not belong here, and in a public repository the mistake cannot be taken back. This is the
one rule where a good-faith mistake is still unacceptable.

**No number that was not measured.** Figures in the README and in `RESULTS.md` come from a
run on the corpus in this repository, and name the model, the quantisation and the sampling
that produced them. Do not round up, do not carry a number over from another corpus, and do
not quote a result for contracts that have since changed — that gets a new dated entry, not
an edit.

**A bad result stays.** The `0/46` row in `RESULTS.md` is the most useful line in the file.
Deleting an unflattering measurement is the same act as inventing a flattering one.

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
invalidates every number measured before it.

- Changing a **schema** means regenerating its golden. Property order is compiled into the
  grammar; see `spec/pack.md`.
- Changing the **corpus** — adding a case, fixing an expectation — means the denominator
  moves. `test/clinical.test.ts` pins it deliberately, so update the pin in the same commit
  and say what moved and why.
- Changing a **prompt** means re-measuring. Say in the commit message what the numbers were
  before and after.

New cases are welcome and the corpus needs them: Qwen3-4B currently saturates it. The most
valuable ones are traps the prompt does **not** pre-announce — that is the current weakness,
and one measured hint that it matters is that gemma-3-4b, when it invents a heart rate,
reaches for the exact figure in the prompt's own worked example.

## Tests

- A test must be able to fail. A scorer test that only exercises the success path proves
  nothing — `test/clinical.test.ts` asserts hallucinations, wrong units, half-right blood
  pressures and fabricated quotes because those are the outcomes that matter.
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
