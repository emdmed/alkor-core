# Demo prompts

Synthetic inputs for exercising the harness by hand. None of this is patient data, and none of
it is the measured corpus — the pack's own notes and exams stay under `packs/clinical/`. These
exist to be piped into a running `llama-server` and to show roughly what each contract is for.

Start the clinical model first (the one-command pipeline needs all three):

```bash
LLAMA_PORT=8081 LLAMA_MODEL=~/models/gemma-4-E4B-it-Q4_0.gguf scripts/llama-server.sh \
  -ngl 99 --no-webui --parallel 1
```

Every `extract` command reads the whole document from stdin through `--note -`, so each prompt
can be pasted directly.

---

## 1. Vital signs (auto-routed)

A plain ward-round note in the corpus's voice. The clinical profile's internal router sees the
vitals abbreviations and picks the `vital-signs` contract by itself — no `--task` needed.

```text
78-year-old man, admitted with dizziness and falls at home. BP 148/86, HR 88, Temp 37.1 C, SpO2 97% on room air, RR 16, weight 74 kg, height 172 cm.
```

```bash
node src/cli.ts extract --profile clinical --note - --constrain --json <<'EOF'
78-year-old man, admitted with dizziness and falls at home. BP 148/86, HR 88, Temp 37.1 C, SpO2 97% on room air, RR 16, weight 74 kg, height 172 cm.
EOF
```

---

## 2. Dialogue transcript (auto-routed)

A two-speaker consultation. The router sees the speaker labels and selects the `transcript`
contract, including the medication pass.

```text
Doctor: Good morning, Mrs. Alvarez. What brings you in today?
Patient: About a week now, I've been short of breath, especially at night.
Doctor: Do you have a cough?
Patient: Some, and my ankles have been swelling.
Doctor: Are you taking any new medicines?
Patient: No, the same ones. My husband reads the boxes to me.
Doctor: Thank you. I'll examine you now.
```

```bash
node src/cli.ts extract --profile clinical --note - --constrain --json <<'EOF'
Doctor: Good morning, Mrs. Alvarez. What brings you in today?
Patient: About a week now, I've been short of breath, especially at night.
Doctor: Do you have a cough?
Patient: Some, and my ankles have been swelling.
Doctor: Are you taking any new medicines?
Patient: No, the same ones. My husband reads the boxes to me.
Doctor: Thank you. I'll examine you now.
EOF
```

---

## 3. Shock extraction (prose in, ShockExam payload out)

A note describing a classic cardiogenic picture. The `shock-extraction` contract turns the prose
into the structured payload the shock rule consumes, and the deterministic gateway confirms shock
from systolic < 90 or shock index > 0.7.

Expected payload: systolic 68 / diastolic 50, 120 min, HR 115, cool skin, elevated JVP, brisk
refill, bilateral crackles → **cardiogenic** along the two-finding rule.

```text
74-year-old man, hypotensive for two hours after acute chest pain. BP 68/50. Heart rate 115 bpm, tachycardic. Skin cool. Jugular venous pressure elevated. Capillary refill brisk. Bilateral crackles on lung examination.
```

```bash
node src/cli.ts extract --profile clinical --task shock-extraction --note - --constrain --json <<'EOF'
74-year-old man, hypotensive for two hours after acute chest pain. BP 68/50. Heart rate 115 bpm, tachycardic. Skin cool. Jugular venous pressure elevated. Capillary refill brisk. Bilateral crackles on lung examination.
EOF
```

---

## 4. The entire shock pipeline

This one prompt runs the whole chain, **prose note → extraction → reasoning → (optionally verify)**.
The note is a hypovolemic picture: hypotension and tachycardia trigger the shock-suspicion shape,
the extraction pass reads the findings, and the shock contract classifies from the two rule
findings. **Expected category: hypovolemic** (cool skin + JVP normal_to_low in the studied cohort).

```text
64-year-old woman, hypotensive for three hours after a day of profuse watery diarrhoea. BP 75/50. Heart rate 125 bpm, tachycardic. Skin cool. Jugular venous pressure normal to low. Capillary refill delayed. Pulse thready. Lungs clear.
```

### 4a. Two steps inside the clinical profile

Extract the payload, then classify it. The second command consumes exactly what the first
produces: `systolic 75 / diastolic 50, 180 min, HR 125, cool, normal_to_low JVP`.

```bash
node src/cli.ts extract --profile clinical --task shock-extraction --note - --constrain --json <<'EOF'
64-year-old woman, hypotensive for three hours after a day of profuse watery diarrhoea. BP 75/50. Heart rate 125 bpm, tachycardic. Skin cool. Jugular venous pressure normal to low. Capillary refill delayed. Pulse thready. Lungs clear.
EOF
```

```bash
node src/cli.ts extract --profile clinical --task shock --note - --constrain --json <<'EOF'
{
  "hypotension": { "systolic": 75, "diastolic": 50, "duration_minutes": 180 },
  "heart_rate": 125,
  "skin_temperature": "cool",
  "jugular_venous_pressure": "normal_or_low",
  "capillary_refill": "delayed",
  "pulse_volume": "thready",
  "lung_exam": "clear"
}
EOF
```

### 4b. One command through the verified clinical workflow

`extract → verify`, orchestrated by the pipeline step table. The clinical profile performs
its own rule-based task routing. This needs the clinical and verifier models running on ports
8081 and 8085:

```bash
node src/cli.ts pipeline --profile clinical-verified --input "$(cat <<'EOF'
64-year-old woman, hypotensive for three hours after a day of profuse watery diarrhoea. BP 75/50. Heart rate 125 bpm, tachycardic. Skin cool. Jugular venous pressure normal to low. Capillary refill delayed. Pulse thready. Lungs clear.
EOF
)"
```

---

## 5. Shock reasoning (payload in, category out), edge cases

The `shock` contract reads the fixed payload and applies the two-finding rule. The three payloads
below cover the outcomes a category can take — determined, the refused square, and the failed gate.

### 5a. The unassigned square — indeterminate

Warm skin with an elevated JVP is the one cell the published table leaves empty: vasodilation and
volume overload at once. The correct answer is `indeterminate` (reason `discordant_primary_findings`).

```json
{
  "hypotension": { "systolic": 88, "diastolic": 46, "duration_minutes": 35 },
  "heart_rate": 109,
  "skin_temperature": "warm",
  "jugular_venous_pressure": "elevated",
  "capillary_refill": "brisk",
  "pulse_volume": "bounding",
  "lung_exam": "clear"
}
```

### 5b. Outside the studied cohort — indeterminate

A perfectly good hypovolemic pattern that the gate rejects: systolic 96 is not below 90, so the
rule was never derived here. Answer is `indeterminate` (reason `outside_studied_cohort`),
and it must NOT become `hypovolemic`.

```json
{
  "hypotension": { "systolic": 96, "diastolic": 64, "duration_minutes": 240 },
  "heart_rate": 92,
  "skin_temperature": "cool",
  "jugular_venous_pressure": "normal_or_low",
  "capillary_refill": "delayed",
  "pulse_volume": "thready",
  "lung_exam": "clear"
}
```

```bash
node src/cli.ts extract --profile clinical --task shock --note - --constrain --json <<'EOF'
{
  "hypotension": { "systolic": 88, "diastolic": 46, "duration_minutes": 35 },
  "heart_rate": 109,
  "skin_temperature": "warm",
  "jugular_venous_pressure": "elevated",
  "capillary_refill": "brisk",
  "pulse_volume": "bounding",
  "lung_exam": "clear"
}
EOF
```

Run either payload through the same `--task shock` command; swap the JSON and the gate stays the
same — this is the two-finding rule with agreement scored against `classify`.
