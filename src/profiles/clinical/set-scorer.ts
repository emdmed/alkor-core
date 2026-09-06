/**
 * Scoring set extraction — the summary and note-format tasks.
 *
 * The vital-signs scorer compares a transcribed number with an expected one. Neither task
 * here can do that: "type 2 diabetes diagnosed six years ago" and "T2DM" are the same fact,
 * and an eval that demanded one wording would measure phrasing. So an expectation is a set
 * of TERMS, and the matching rule is stated in the case files rather than here.
 *
 * The asymmetry from the vital-signs task carries over unchanged, and for the same reason: a
 * missed problem is invisible to the clinician while a spurious one is deleted in a click.
 * Item recall gates; everything else is measured, printed and never gates — except the two
 * provenance sub-gates on note formatting, which gate because a run that finds every item
 * while fabricating the spans it cites has not passed, and one averaged number would let a
 * good recall hide it.
 */
import type { SetExpect, SetExpectation } from './cases.ts'
import { norm } from './scorer.ts'
import { verifyDerivation, verifyQuote, type DerivationRule, type QuoteRule } from '../../core/verify.ts'
import type { FormatItem, MedicationItem, NoteFormat, PatientSummary } from './extraction.ts'

/**
 * Words a clinical item can be introduced by that REVERSE it.
 *
 * This is a DEFAULT, not the rule. The list is English and Spanish because that is what the
 * reference corpus is written in, and while it lived here as a constant that fact was code
 * rather than contract: a pack in German or Portuguese got these eleven words, matched none
 * of its own negations, and scored "keine Diabetes" as a find — silently, in the direction
 * that inflates recall. A pack states its own list in `[clinical.setMatching].negators`; this
 * is what it inherits if it says nothing, and the limit is now written down in the pack format
 * rather than discoverable only by reading the scorer.
 *
 * Deliberately short and literal either way: every entry is a word that turns the clause it
 * opens into a statement that the fact is not so.
 */
export const DEFAULT_NEGATORS = [
  'no',
  'not',
  'never',
  'denies',
  'denied',
  'without',
  'sin',
  'niega',
  'ningun',
  'ninguna',
  'nunca',
]

/** How items are matched against an answer key. Supplied by the pack; see settings.ts. */
export interface SetMatchRule {
  /** Words that reverse the clause they open. `DEFAULT_NEGATORS` when the pack says nothing. */
  negators: string[]
}

export const DEFAULT_SET_MATCHING: SetMatchRule = { negators: DEFAULT_NEGATORS }

/**
 * Words that make a string a DOSE rather than a drug name.
 *
 * A DEFAULT on the same terms as `DEFAULT_NEGATORS`, and English and Spanish for the same
 * reason: the reference corpus is. A pack in another language states its own list, and one
 * that says nothing inherits these — which is safe in the direction that matters, because an
 * unrecognised dose word makes this check MISS a bad item rather than reject a good one.
 *
 * Every entry is a word that belongs in `dose` and can never be part of a drug's name. Route
 * words ("oral", "inhalada") are deliberately absent: they are wrong in `text` too, but they
 * appear inside real drug names often enough that a check built on them would fail good items.
 */
export const DEFAULT_DOSE_TOKENS = [
  'mg',
  'g',
  'mcg',
  'ml',
  'microgram',
  'micrograms',
  'milligram',
  'milligrams',
  'miligramo',
  'miligramos',
  'microgramo',
  'microgramos',
  'gramo',
  'gramos',
  'daily',
  'weekly',
  'once',
  'twice',
  'morning',
  'night',
  'nightly',
  'hourly',
  'hours',
  'times',
  'required',
  'prn',
  'diario',
  'diaria',
  'dia',
  'noche',
  'manana',
  'horas',
  'veces',
  'cada',
  'semanal',
  'precisa',
]

/**
 * What a medication item's `text` may contain.
 *
 * THE CHECK EXISTS BECAUSE THE OTHER TWO CANNOT SEE THIS FAILURE. `"metformin five hundred
 * milligrams twice daily"` verifies as a quote, derives from that quote by deletion alone, and
 * matches the expectation `metformin` by containment — three green axes over an item that
 * breaks the contract's plainest medication rule. It was found on a dictated transcript where
 * the model, pushed to split a merged item, split it into three items that each still carried
 * their dose: the pack recorded the merge as fixed and the reading was still wrong.
 *
 * It is a rule about SHAPE, not a drug dictionary, and it cannot be otherwise: a check that
 * knew which words are drugs would need a list of every drug, which is the thing a pack in a
 * new specialty must never have to supply. What it can say is that a drug name is short and
 * contains no dose — which is enough to catch every failure of this kind seen so far, and
 * cheap enough that a pack inherits it without asking.
 */
export interface MedicationNameRule {
  /**
   * How many words a drug name may be. Three, because "folic acid" is two and "alendronic
   * acid" is two, and a combination written as "co-amoxiclav 500/125" is one. A cap rather
   * than a match: the failure this catches is a name with a dose stapled to it, which is
   * always longer than the name.
   */
  maxWords: number
  /** Words that belong in `dose` and never in a name. `DEFAULT_DOSE_TOKENS` if unstated. */
  doseTokens: string[]
}

export const DEFAULT_MEDICATION_NAME: MedicationNameRule = {
  maxWords: 3,
  doseTokens: DEFAULT_DOSE_TOKENS,
}

export type NameVerdict =
  | { ok: true }
  /** A dose word, or a number, inside the name. The offending token is reported. */
  | { ok: false; reason: 'dose-in-name'; token: string }
  /** No dose word, but too many words to be a drug name — a phrase, or two drugs joined. */
  | { ok: false; reason: 'not-a-name'; token: string }

/**
 * Is this medication `text` a drug name and nothing else?
 *
 * Numbers count as dose tokens whatever they are: no drug name in this corpus contains a
 * digit, and one that did ("B12") would be caught by nothing else here anyway — the token is
 * reported, so a pack that hits that case can see exactly what tripped it.
 */
export const verifyMedicationName = (text: string, rule: MedicationNameRule): NameVerdict => {
  const tokens = norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const dose = new Set(rule.doseTokens.map((w) => norm(w)))
  for (const t of tokens) {
    if (/\d/.test(t)) return { ok: false, reason: 'dose-in-name', token: t }
    if (dose.has(t)) return { ok: false, reason: 'dose-in-name', token: t }
  }
  if (tokens.length > rule.maxWords) return { ok: false, reason: 'not-a-name', token: tokens.slice(rule.maxWords).join(' ') }
  return { ok: true }
}

/** Where one clause ends and the next begins, for the negation scan below. */
const CLAUSE_BREAK = /[.;:,]/

/**
 * Is `term` present in the already-normalised `hay`, at a word boundary, un-negated?
 *
 * Two rules, both paid for by a false positive rather than by taste:
 *
 * - **Word START.** Plain containment credited the dose expectation `500` against the item
 *   "1500 mg" — a tenfold error scored as correct. So a term must begin where a word begins.
 *   The END is deliberately left open, because the case files use stems on purpose: `diabet`
 *   is one term covering "diabetes", "diabetic" and "diabético", and requiring a full-word
 *   match would break every one of them.
 * - **Not negated.** Containment also credited the expectation `diabet` against the item
 *   "No diabetes mellitus" — the opposite fact, counted as a find. So a match is refused when
 *   a negator opens the same clause. The scan stops at the nearest clause break before the
 *   match, which is what keeps "No allergies. Diabetes type 2" a legitimate find while "No
 *   known history of diabetes" is not.
 */
const containsTerm = (hay: string, term: string, negators: Set<string>): boolean => {
  const t = norm(term)
  if (!t) return false
  for (let from = 0; ; ) {
    const at = hay.indexOf(t, from)
    if (at === -1) return false
    const before = at === 0 ? '' : hay[at - 1]!
    if (!before || !/[\p{L}\p{N}]/u.test(before)) {
      if (!negatedAt(hay, at, negators)) return true
    }
    from = at + 1
  }
}

/** Does a negator open the clause this match sits in? */
const negatedAt = (hay: string, at: number, negators: Set<string>): boolean => {
  const before = hay.slice(0, at)
  let clauseStart = 0
  for (let i = before.length - 1; i >= 0; i--) {
    if (CLAUSE_BREAK.test(before[i]!)) {
      clauseStart = i + 1
      break
    }
  }
  return before
    .slice(clauseStart)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .some((w) => negators.has(w))
}

/**
 * Does any of the model's items satisfy this expectation?
 *
 * `norm` is the vital-signs scorer's own normaliser — accent- and case-insensitive — reused
 * deliberately: "fibrilación" and "fibrilacion" are the same word, and a corpus written in
 * two languages produces both spellings within one case file.
 *
 * The containment rule underneath is `containsTerm` above, not `String.includes`, and the two
 * false positives that forced the change are named there.
 */
export const matchesAny = (
  items: string[],
  alternatives: string[][],
  rule: SetMatchRule = DEFAULT_SET_MATCHING,
): string | undefined => {
  // Normalised the same way the items are, so a pack may write its negators with accents and
  // capitals as its language spells them rather than in the scorer's internal form.
  const negators = new Set(rule.negators.map((n) => norm(n)))
  return items.find((item) => {
    const hay = norm(item)
    return alternatives.some((group) => group.every((term) => containsTerm(hay, term, negators)))
  })
}

export interface SetTally {
  /** `present` expectations: the gated denominator. */
  required: number
  found: number
  /** `absent` expectations the model violated, plus items in a section that must be empty. */
  hallucinations: number
  /** Items the model emitted, in total. Not gated — context for the two rates below. */
  items: number
  failedRuns: number
}

export const emptySetTally = (): SetTally => ({ required: 0, found: 0, hallucinations: 0, items: 0, failedRuns: 0 })

export const absorbSet = (into: SetTally, o: SetTally): void => {
  into.required += o.required
  into.found += o.found
  into.hallucinations += o.hallucinations
  into.items += o.items
  into.failedRuns += o.failedRuns
}

export interface SetMiss {
  case: string
  field: string
  reason: 'missed' | 'hallucination' | 'not-empty' | 'quote' | 'derivation' | 'dose' | 'name' | 'duplicate'
  detail: string
}

export interface SetScore {
  tally: SetTally
  misses: SetMiss[]
}

/** Score one case against a model's sets, keyed by field name. */
export const scoreSet = (
  caseName: string,
  fields: SetExpectation[],
  got: Record<string, string[]>,
  matching: SetMatchRule = DEFAULT_SET_MATCHING,
): SetScore => {
  const tally = emptySetTally()
  const misses: SetMiss[] = []
  for (const list of Object.values(got)) tally.items += list.length

  for (const e of fields) {
    const items = got[e.field] ?? []
    const expect: SetExpect = e.expect

    if (expect.kind === 'empty') {
      // Stronger than a list of `absent`s, and the only expectation that can catch an
      // invention nobody thought to name in advance.
      if (items.length) {
        tally.hallucinations += items.length
        misses.push({
          case: caseName,
          field: e.field,
          reason: 'not-empty',
          detail: `must be empty, got ${items.length}: ${items.slice(0, 3).map((i) => `'${i}'`).join(', ')}`,
        })
      }
      continue
    }

    if (expect.kind === 'absent') {
      const hit = matchesAny(items, expect.match, matching)
      if (hit !== undefined) {
        tally.hallucinations++
        misses.push({
          case: caseName,
          field: e.field,
          reason: 'hallucination',
          detail: `must not appear (${describe(expect.match)}), got '${hit}'`,
        })
      }
      continue
    }

    tally.required++
    if (matchesAny(items, expect.match, matching) !== undefined) tally.found++
    else misses.push({ case: caseName, field: e.field, reason: 'missed', detail: `nothing matched ${describe(expect.match)}` })
  }

  return { tally, misses }
}

/** A whole case lost. Every `present` expectation is a miss, never a skip. */
export const scoreFailedSet = (caseName: string, fields: SetExpectation[]): SetScore => {
  const tally = emptySetTally()
  tally.failedRuns = 1
  tally.required = fields.filter((f) => f.expect.kind === 'present').length
  return { tally, misses: [{ case: caseName, field: '*', reason: 'missed', detail: 'run failed' }] }
}

const describe = (alternatives: string[][]): string => alternatives.map((g) => g.join('+')).join(' | ')

// --- Note formatting: the same scoring, plus provenance -----------------------------------

export interface FormatTally extends SetTally {
  /** Quotes checked, and how many were genuinely in the note. */
  quotes: number
  quotesVerified: number
  /**
   * Of the failures: found once a capital or an accent is ignored. A model being tidy, not a
   * model inventing a sentence — still a failure under a strict rule, but a different one.
   */
  quotesEditedOnly: number
  /** Derived fields checked (`text`, and a medication's `dose`), and how many survived. */
  derivations: number
  derivationsOk: number
  /** A dose expectation the model got wrong, or supplied where the note gives none. */
  doseErrors: number
  /**
   * Medication `text` fields checked, and how many were a drug name and nothing else. Its own
   * pair rather than a fold into `derivations`, because the two ask different questions of the
   * same string and a dose-laden name passes derivation every time.
   */
  names: number
  namesOk: number
  /**
   * Medication items naming a drug some earlier item already named — the same prescription
   * twice, usually once with a dose and once without.
   *
   * Counted because NOTHING ELSE SEES IT, and because it does not merely look untidy: on
   * `tr-en-05` a run emitted `furosemide` with the dose "[inaudible] milligrams in the morning",
   * which the contract says must be null, and `furosemide` again with null — and the answer
   * key's doseNull expectation was satisfied by the second item while the first stood. A wrong
   * dose and a right one, scored as correct. `uniqueItems` in the schema cannot catch this: the
   * two items differ, in the field that makes one of them wrong.
   */
  duplicateDrugs: number
}

export const emptyFormatTally = (): FormatTally => ({
  ...emptySetTally(),
  quotes: 0,
  quotesVerified: 0,
  quotesEditedOnly: 0,
  derivations: 0,
  derivationsOk: 0,
  doseErrors: 0,
  names: 0,
  namesOk: 0,
  duplicateDrugs: 0,
})

export const absorbFormat = (into: FormatTally, o: FormatTally): void => {
  absorbSet(into, o)
  into.quotes += o.quotes
  into.quotesVerified += o.quotesVerified
  into.quotesEditedOnly += o.quotesEditedOnly
  into.derivations += o.derivations
  into.derivationsOk += o.derivationsOk
  into.doseErrors += o.doseErrors
  into.names += o.names
  into.namesOk += o.namesOk
  into.duplicateDrugs += o.duplicateDrugs
}

/** The four sections flattened to `field -> texts`, which is what the set scorer reads. */
export const formatTexts = (got: NoteFormat): Record<string, string[]> => ({
  presenting_complaint: got.presenting_complaint ? [got.presenting_complaint.text] : [],
  history: got.history.map((i) => i.text),
  plan: got.plan.map((i) => i.text),
  current_medication: got.current_medication.map((i) => i.text),
})

/**
 * Score one note-format case: the sets, then provenance over EVERY item the model emitted.
 *
 * Provenance is checked on every item rather than on the expected ones, and that is the
 * point: an item nobody wrote an expectation for is exactly where a fabricated citation
 * hides. An expectation-only check would report perfect provenance for a reply that invented
 * six extra findings and cited them all.
 */
export const scoreFormatCase = (
  caseName: string,
  fields: SetExpectation[],
  got: NoteFormat,
  note: string,
  rules: { quote: QuoteRule; derivation: DerivationRule; matching?: SetMatchRule; medicationName?: MedicationNameRule },
): { tally: FormatTally; misses: SetMiss[] } => {
  const set = scoreSet(caseName, fields, formatTexts(got), rules.matching ?? DEFAULT_SET_MATCHING)
  const tally: FormatTally = { ...emptyFormatTally(), ...set.tally }
  const misses = [...set.misses]

  const check = (section: string, item: FormatItem | MedicationItem): void => {
    tally.quotes++
    const v = verifyQuote(item.quote, note, rules.quote)
    if (v.ok) tally.quotesVerified++
    else {
      if (v.drift !== 'absent') tally.quotesEditedOnly++
      misses.push({
        case: caseName,
        field: section,
        reason: 'quote',
        detail:
          v.drift === 'absent'
            ? `quote is not in the note: '${clip(item.quote)}'`
            : `quote differs from the note only in ${v.drift}: '${clip(item.quote)}'`,
      })
    }

    // Derivation is checked against the quote the model GAVE, even when that quote failed
    // verification. The two questions are independent — "is the span real" and "is the item
    // an edit of the span" — and skipping the second for a failed first would report a
    // derivation rate over only the well-behaved items.
    for (const [what, value] of [
      ['text', item.text],
      ['dose', 'dose' in item ? item.dose : null],
    ] as const) {
      if (value === null) continue
      tally.derivations++
      const d = verifyDerivation(value, item.quote, rules.derivation)
      if (d.ok) tally.derivationsOk++
      else
        misses.push({
          case: caseName,
          field: section,
          reason: 'derivation',
          detail: `${what} '${clip(value)}' ${d.reason === 'introduced' ? 'introduces' : 'reorders'} '${d.token}', which its quote does not support`,
        })
    }
  }

  if (got.presenting_complaint) check('presenting_complaint', got.presenting_complaint)
  for (const i of got.history) check('history', i)
  for (const i of got.plan) check('plan', i)
  for (const m of got.current_medication) check('current_medication', m)

  // One drug, one item — checked across the section rather than on an item, which is why it is
  // not in the loop below. Compared by the SAME normaliser the answer key uses, so "Furosemide"
  // and "furosemide" are one drug and a pack whose corpus capitalises differently does not read
  // as duplicate-free by accident.
  const namedAlready = new Set<string>()
  for (const m of got.current_medication) {
    const drug = norm(m.text)
    if (!drug) continue
    if (namedAlready.has(drug)) {
      tally.duplicateDrugs++
      misses.push({
        case: caseName,
        field: 'current_medication',
        reason: 'duplicate',
        detail: `'${clip(m.text)}' was already emitted — one drug is one item, and the second carries dose ${m.dose === null ? 'null' : `'${clip(m.dose)}'`}`,
      })
    }
    namedAlready.add(drug)
  }

  // The third check on a medication item, and the only one that reads `text` as a NAME rather
  // than as an edit of a span. Run over every item the model emitted, for the same reason
  // provenance is: an item nobody wrote an expectation for is where this failure hides.
  for (const m of got.current_medication) {
    tally.names++
    const n = verifyMedicationName(m.text, rules.medicationName ?? DEFAULT_MEDICATION_NAME)
    if (n.ok) tally.namesOk++
    else
      misses.push({
        case: caseName,
        field: 'current_medication',
        reason: 'name',
        detail:
          n.reason === 'dose-in-name'
            ? `'${clip(m.text)}' is not a drug name alone — '${n.token}' belongs in dose`
            : `'${clip(m.text)}' is too long to be a drug name — '${clip(n.token)}' is past the limit`,
      })
  }

  // Dose expectations: attached to a `present` medication expectation, scored apart from it.
  // A drug found with the wrong dose is a different failure from a drug not found, and one
  // column reporting both would hide which of them a prompt change fixed.
  for (const e of fields) {
    if (e.expect.kind !== 'present' || e.field !== 'current_medication') continue
    if (!e.expect.dose && !e.expect.doseNull) continue
    const med = got.current_medication.find((m) =>
      matchesAny([m.text], (e.expect as { match: string[][] }).match, rules.matching ?? DEFAULT_SET_MATCHING),
    )
    if (!med) continue // already counted as a miss by the set scorer
    if (e.expect.doseNull) {
      if (med.dose !== null) {
        tally.doseErrors++
        misses.push({ case: caseName, field: 'current_medication', reason: 'dose', detail: `'${med.text}' has no dose in the note, model wrote '${med.dose}'` })
      }
      continue
    }
    if (!med.dose || !matchesAny([med.dose], e.expect.dose!, rules.matching ?? DEFAULT_SET_MATCHING)) {
      tally.doseErrors++
      misses.push({
        case: caseName,
        field: 'current_medication',
        reason: 'dose',
        detail: `'${med.text}' dose expected ${describe(e.expect.dose!)}, got ${med.dose === null ? 'null' : `'${med.dose}'`}`,
      })
    }
  }

  return { tally, misses }
}

const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

/** A whole note-format case lost, in the shape the aggregate expects. */
export const scoreFailedFormat = (caseName: string, fields: SetExpectation[]): { tally: FormatTally; misses: SetMiss[] } => {
  const set = scoreFailedSet(caseName, fields)
  return { tally: { ...emptyFormatTally(), ...set.tally }, misses: set.misses }
}

/** Summary sets, keyed the way the scorer reads them. */
export const summaryTexts = (got: PatientSummary): Record<string, string[]> => got
