# DDIA Study App

A supplemental study web app for *Designing Data-Intensive Applications* by Martin Kleppmann (O'Reilly).

- **12 chapter quizzes** — each chapter gets a summary (overview + per-section takeaways) and 12 questions (7 single-choice multiple choice + 5 multi-select). Every question explains the answer and names the book section it came from, so you can flip straight to it.
- **Capstone interviews** — 4 system-design case studies (social-media timeline feed, distributed rate limiter, exactly-once payment ledger, multi-region key-value store). Each case asks 5 questions aloud via text-to-speech; you answer by voice, and your answers are graded 1–5 against a rubric (5 exceptional, 4 pass, 3 maybe, 2 needs work, 1 fail). Unlocks after all 12 chapter quizzes are done.
- **Progress saved locally** — quiz answers, best scores, and capstone attempts persist in the browser (localStorage) across close/reopen.

## Run it

```sh
python3 run.py        # serves http://127.0.0.1:8123/
```

No build step, no dependencies — static HTML/CSS/JS + JSON content files.

## Voice interviews

Speaking the questions needs nothing. Transcribing your answers and grading them uses one OpenAI API key, entered in the app's Settings tab:

- The key is stored **only** in your browser's local storage and is sent **only** to `api.openai.com` (Whisper for transcription, a chat model for grading). Nothing else ever sees it. The Settings screen never redisplays the saved key.
- No key? You can type answers instead of recording, and grade yourself against the rubric checklist.

## Layout

- `index.html`, `styles.css`, `app.js` — the app shell
- `content/ch01.json` … `content/ch12.json` — chapter summaries + quizzes
- `content/capstone.json` — interview cases + grading rubrics
- `run.py` — tiny static file server
- `design/` — UI mockups (local only)

Color scheme follows the book's O'Reilly cover: paper white, O'Reilly red, black.
