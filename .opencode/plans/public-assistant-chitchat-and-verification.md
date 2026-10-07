# Plan: Public-assistant chitchat fix + completed verification

## Status snapshot (already verified live before plan mode)
- Backend `GET /api/assistant/public/health` -> 200 `{"status":"ok","gateway":"groq"}`
- Unauth session create (201) + grounded Q&A with evidence citations
- Live sweep 5 easy / 5 avg / 5 hard / 1 injection: grounded->evidence, off-topic->honest abstention, injection refused, no system-prompt leak
- Rate limit: burst -> 15x200 then 429 at 16th in-window msg (limit 15/120s); counters visible in shared Postgres `ai_public_rate_limit_counter` via separate connection (DB-backed, cross-worker)
- Targeted tests green: `test_public_assistant.py` 15/15, +abstention+kb-access 34/34
- `npm run build` PASS; widget ESLint clean; full-repo ESLint = 242 problems (37 errors/205 warnings) all PRE-EXISTING
- CORS: real widget POSTs echo `access-control-allow-origin: http://localhost:3000`
- Deployment applied to shared Neon DB: `alembic upgrade head` (3 ai_public_* tables) + `seed_knowledge.py` (16 public docs)
- Next.js dev server on :3000; "Ask Zoiko" widget markup confirmed on / and /pricing

## Bug: bare/greeting chats like "hii" are not recognized
User report: typing `hii` in the website chatbot.

Current behavior: `I don't have a confirmed answer for that yet...` (abstention).
Expected: canned greeting `Hi! I'm the Zoiko Billing assistant...`

Root cause (`backend/app/modules/chatbot/public_assistant.py:84-89`): the `\b`
after `hi` demands a word boundary, but `"hii"` has another `i` at position 2, so
the regex fails and the message falls through to retrieval -> abstention. Affects
`hii`, `helloo`, `heyy`, `yoo`, `thx!`, `bye!` etc.

## Fix (2 files, ~10 lines)
1. `backend/app/modules/chatbot/public_assistant.py`:
   - `_FAREWELL_RE`  : `(?:bye+|goodbye+|see\s+(?:ya|you)|gtg)\b`
   - `_GRATITUDE_RE` : `(?:thanks+|thank\s+you|thx+|ty)\b`
   - `_GREETING_RE`  : `(?:hi+|hello+|hey+|yo+|howdy|hola|good\s+(?:morning|afternoon|evening))\b`
   The `+` lets casual elongation match; the existing `remainder` guard
   (`len < 3`) still routes real questions ("hippo" -> remainder "ppo" -> retrieval).
2. `backend/tests/ai_assistant/test_public_assistant.py` (TestChitchat): add
   - `"hii"` -> `_GREETING_ANSWER`
   - `"helloo"` -> `_GREETING_ANSWER`
   - `"hippo"` -> NOT canned (real question path)
   - `"thx!"` -> `_GRATITUDE_ANSWER`

## Execution steps (after plan mode is exited)
1. Apply the 2-file fix above.
2. Re-run `tests/ai_assistant/test_public_assistant.py` (expect all pass, incl. new cases).
3. Live-verify `hii` against running backend (new session, assert canned greeting).
4. Full backend suite `pytest tests/` with large timeout (earlier run hit the 120s cap).
5. Browser e2e (playwright-core + installed Chrome): open widget, ask real question, assert grounded answer + Source line.
6. localStorage persistence: reload -> history resumes (idempotent session resume).
7. localStorage unavailable: inject throwing getItem/setItem -> widget still answers.
8. Widget-on-every-page SSR check across ~8 routes (/, /pricing, /invoices, /multi-currency, /global-billing, /developers-api-overview, /product, /contact).
9. Full-repo ESLint classification + `npm run build` (re-record for report).
10. Consolidated PASS/FAIL report per spec items.

## Notes
- No new features, no refactoring; the deployment steps (migration + KB seed) and
  `zoiko-billing-nextjs/.env` (gitignored) stay.
- Blockers: none code-wise; plan mode must be turned off to apply edits.