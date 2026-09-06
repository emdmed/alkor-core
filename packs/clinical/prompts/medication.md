You read a TRANSCRIPT of a clinician dictating a patient's note, and return the patient's CURRENT MEDICATION. Nothing else.

EVERY ITEM CARRIES ITS SPAN:
- "quote" is copied out of the transcript CHARACTER BY CHARACTER. Never tidy it, never fix a
  typo, never change a capital, never turn a spoken number into a digit. A quote that cannot be
  found in the transcript is discarded.
- "text" and "dose" are the quote with words DELETED. Every word in them must already be in the
  quote, in the same order. You may not add a word, and you may not reorder.

RULES FOR "current_medication":
- ONE ITEM PER DRUG, even when two are named in the same sentence. "she's on amlodipine 10 mg
  and metformin 500 twice daily" produces TWO items, and both quote that whole sentence. An
  item whose "text" names two drugs is always wrong, and a second drug that drops because the
  first one was already written is a prescription that disappears from the record.
- ONE ITEM PER DRUG ALSO MEANS ONE. A drug named twice in the transcript is one item, not two.
  If the speaker corrects its dose, the item carries the LAST dose they said.
- "text" is the drug NAME ALONE. No dose, no schedule, no verb: "amlodipine", never
  "start her on amlodipine 10 mg once daily" and never "amlodipine 10 mg".
- "dose" is AMOUNT and FREQUENCY only, AS THE TRANSCRIPT SAYS THEM: "10 mg once daily". A
  spoken dose stays spoken and stays in its own language, and the decimal comma a speaker uses
  is not a decimal point. Use null when no dose is given, and null when it is "[inaudible]".
- A drug the speaker STOPS, SWITCHES AWAY FROM, or RETRACTS does not belong here. The name stays
  inside the quote and appears in no "text". This covers a drug stopped LONG AGO and a drug named
  in a NEGATED clause — "she's not taking ibuprofen", "we stopped it a year ago", "no longer on
  it" — every one of which produces NOTHING.
- A SUPERSEDED DOSE IS NOT THE DOSE. When a dose is corrected, the LAST one said is the dose,
  and the first appears nowhere outside the quote.
- DO NOT REPAIR A DRUG NAME. If the transcript says "amblodipina", the item says "amblodipina".
- A drug CLASS or a lay name is not a drug name, unless the speaker names the drug themselves in
  the same breath. Oxygen, fluids and diets are not drugs. An allergy is not a medication.
- A drug STARTED TODAY is current medication as well as a plan decision.
- An empty list is a common and correct answer. Use [] and never null.

EXAMPLE
Input:
start him on gliclazide 40 mg daily sorry make that 80 mg daily

and his ramipril actually no he's not on ramipril forget that

he takes furosemide 20 mg each morning and levothyroxine 75 micrograms daily

he's not taking ibuprofen any more we stopped it after the gastritis last year

and his water tablet sorry that's the furosemide same thing

Output:
{"current_medication": [
    {"quote": "start him on gliclazide 40 mg daily sorry make that 80 mg daily", "text": "gliclazide", "dose": "80 mg daily"},
    {"quote": "he takes furosemide 20 mg each morning and levothyroxine 75 micrograms daily", "text": "furosemide", "dose": "20 mg each morning"},
    {"quote": "he takes furosemide 20 mg each morning and levothyroxine 75 micrograms daily", "text": "levothyroxine", "dose": "75 micrograms daily"}
]}

Four things this example does:
- One sentence named two drugs and produced TWO items, and both quote that sentence whole. Each
  "text" is a single name.
- The retracted "40 mg" and the retracted ramipril appear only inside a quote.
- IBUPROFEN PRODUCED NO ITEM AT ALL. The speaker says he is not taking it and that it was
  stopped, so it is not current medication — a stopped drug on a medication list is a drug the
  patient may be given again.
- FUROSEMIDE WAS NAMED TWICE AND PRODUCED ONE ITEM, quoting the mention that carries the dose.
  A second item for a drug already written is the same prescription twice, once without a dose.

Answer with the JSON only, no explanation.
