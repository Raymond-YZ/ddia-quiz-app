# QA Report — DDIA Study web app

**Date:** 2026-10-09 · **Method:** static serving via `python3 run.py` on :8124 (curl header/body checks); node harness driving the app's exported `DDIA` test API (`app.js` exposes pure functions on `globalThis`); code review of render paths. Live-browser DOM assertions are out of scope here — covered by the separate smoke test.

**Harness:** 49/49 assertions pass (`/tmp/ddia-qa/harness.js`).

## 1. Content integrity — PASS
- All 12 `content/chNN.json` parse; each has exactly 12 questions (7 `single` + 5 `multi`).
- Every question: exactly 4 options, answer indices are in-range ints (single = 1 index, multi = 2–3), non-empty `question`, `explanation`, `bookRef`.
- Every summary: non-empty `overview`, ≥2 sections, each with ≥2 takeaways.
- `content/capstone.json`: 4 cases × 5 questions; every rubric has non-empty `keyPoints`, `strongAnswer`, `commonMistakes`, `fiveVsThree`; all 61 keyPoints cite chapters 1–12.

## 2. Quiz scoring — PASS
- Single-select: exact match → true; wrong option / extra selection / empty → false.
- Multi-select: exact set in any order → true; subset / superset / disjoint → false. **No partial credit**, enforced across all 60 multi-selects in all 12 chapters (exact=true, drop-one=false, add-one=false for each).
- `gradeChapter` on real `ch01.json`: all-correct → 12/12, 100%; all-wrong → 0/12; half → 6/12, 50%; empty answers → 0 correct.

## 3. Explanations / bookRef rendering — PASS (code review)
- `renderChapter`'s checked branch renders a per-question `.explain` div containing the explanation text plus `Find it in the book: <strong><bookRef></strong>`. Data side verified non-empty for all 144 questions in area 1. Live DOM assertion deferred to the browser smoke test.

## 4. Progress persistence — PASS
- Simulated state (ch1 answers + checked + best 91.7 + attempts 2; ch2 partial answers; one capstone attempt; settings.apiKey) → serialized to backend → fresh harness loading the same bytes (close/reopen simulation) → answers, best scores, checked flags, capstone attempts, and settings all survive intact.
- Corrupt localStorage (`garbage{{{not json`) → clean defaults, no throw.
- Malformed-but-valid JSON (`chapters:null`, `attempts:"oops"`, `apiKey:42`) → sanitized to defaults.

## 5. Capstone gating — PASS
- 11/12 chapters complete → `allChaptersDone` false; `missingChapters` names exactly the missing chapter (12).
- 12/12 → unlocked. 0/12 → locked with all 12 named.

## 6. Interview flow (stubbed network) — PASS (request-shape harness + code review)
- `gradingRequest`: URL `https://api.openai.com/v1/chat/completions`, `Authorization: Bearer <key>`, body pins `gpt-4o-mini`; system prompt contains the rubric key points, the transcripts, the case title, the `1–5` scale with labels (`5 = exceptional … 1 = fail`), and the JSON-only contract (`rating`/`feedback`/`missedConcepts`).
- `parseGradingResult`: canned `{"rating":4,"feedback":"…","missedConcepts":[…]}` parses correctly; clamps 99→5, 0→1, non-numeric→1; invalid JSON throws (UI catches it → "Grading failed" with Retry / self-grade options).
- `whisperRequest`: URL `https://api.openai.com/v1/audio/transcriptions`, Bearer auth, `FormData` body with the audio blob bytes (verified byte-identical) + `model=whisper-1`.
- `RATING_LABELS` match the user's scale (5 exceptional, 4 pass, 3 maybe, 2 needs work, 1 fail); the result card prints the scale legend.
- No-key path (code review): `renderGradeStage` branches to the self-grade checklist when no key is set — tick rubric points → suggested rating via `suggestSelfRating` (thresholds verified: 9/10→5, 7/10→4, 5/10→3, 3/10→2, 1/10→1) → user-confirmed 1–5 buttons → save persists the attempt with `method:'self'`.

## 7. Settings / API key handling — FAIL (one finding)
- Key is never `console.log`ged (0 occurrences). Key is sent **only** to `api.openai.com` (3 endpoints: `/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/models`), always via `Authorization: Bearer` header, never in a URL. Content fetches are same-origin with no key attached. All rendered strings go through `esc()` (30 call sites).
- **FINDING:** the key IS rendered into the DOM. `renderSettings` (`app.js:767`) writes the saved key into the password input's `value` attribute: `<input type="password" id="apikey" value="<raw key>">`. It is masked on screen and HTML-escaped, so practical severity is low in this static single-origin app — but the raw key string sits in `innerHTML`/DOM, violating the "never rendered in the DOM" criterion.
  - **Repro:** save any key in Settings → DevTools → inspect `#apikey` → the `value` attribute contains the full key.
  - **Suggested fix:** render the field empty with a "saved ✓" indicator (or a masked placeholder) instead of the real value; only overwrite the stored key when the user types a new one.

## 8. run.py — PASS
- `/` → `text/html`; `/app.js` → `text/javascript`; `/styles.css` → `text/css`; `/content/ch01.json` and `/content/capstone.json` → `application/json` **with `Cache-Control: no-store`** (verified live).

## 9. Syntax + runtime-error scan — PASS with one minor note
- `node --check app.js`: clean.
- **NOTE (minor, no crash):** `stopInterviewMedia` (`app.js:212`) calls `IV.mr.abort()`, but `MediaRecorder` has no `abort()` method (that belongs to `SpeechRecognition`, correctly used on line 214). It sits inside `try/catch` so it fails silently; mic tracks are still stopped on the next line. Suggested: call `IV.mr.stop()` and guard the `onstop` handler against a torn-down session (today a mid-recording route change lets `onRecordingDone` run against a detached DOM node — harmless, but untidy).

## Out of scope for this pass
Live-browser DOM assertions (check-answers rendering, record/stop UI, waveform, TTS auto-ask) — covered by the separate smoke test.
