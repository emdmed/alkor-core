# Writing a profile

A profile is the code that reads a pack: it builds the prompt, parses the output, scores it
and decides the gate.

1. `src/profiles/<name>/profile.ts`, exporting a `PROFILE` that satisfies `ProfileModule`
   (`name`, `mode`, `needsPack`, `runEval`, plus `tools`/`systemPrompt` if agentic, and
   `chatSystemPrompt` to be conversational).
2. A `[<name>]` entry in `profiles.toml`.

`runEval` returns `{pass, summary}` so the CLI decides exit codes in one place, rather than
each profile inventing its own meaning for exit 1.

### Profiles that live in your repository, not this one

A profile does not have to be here. `module` names one, resolved exactly as `pack` is —
relative to `profiles.toml`, overridable with `PROFILE_MODULE_<PROFILE>`:

```toml
[oncology]
mode   = "extract"
module = "harness/oncology/profile.ts"   # your scorer, in your project
pack   = "contracts"                     # and your contracts, beside it
url    = "http://127.0.0.1:8081"
```

`pack` and `module` are two halves of one idea. A pack keeps your prompts, schemas and
cases out of this repository; without `module`, the code that *reads* them — the parser,
the scorer, the floors — would still have to live here. For a proprietary domain those are
the same secret as the prompts, so both halves move together and the harness stays a
runtime with no domain in it.

Such a profile imports the package rather than relative paths:

```ts
import { extract, openTrace, type ProfileModule } from 'alkor'
```

That bare specifier resolves by **installing this repository from a path** — `npm install
file:../alkor`, or `npm link` — which symlinks it. There is no registry package and
there will not be one: Node runs this repository by stripping types, and it refuses to
strip types for files under `node_modules`, so a copy placed there cannot be loaded at all.
A symlink is read through to its real path and loads normally, which is why the path form
is the supported one and a git dependency — which npm copies — is not.

`src/index.ts` is the whole of what a profile may import: core, the modes and the
transport. The profiles themselves and the CLI's wiring are not exported — they consume
that contract rather than being part of it — and `exports` names the entry point and
nothing else, so deep imports are refused rather than quietly supported.
