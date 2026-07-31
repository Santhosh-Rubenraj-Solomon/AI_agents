# Going Live: Mock Data → Real Adzuna Jobs

By default the agent runs in **test mode** and serves mock job data — no external API keys required. This guide switches it to **live mode**, pulling real listings from the free [Adzuna](https://developer.adzuna.com/) jobs API.

Live mode flips on **automatically** the moment both Adzuna keys are present. There is no config flag to toggle.

---

## Steps

### 1. Get free Adzuna credentials

Sign up at **https://developer.adzuna.com/** and register an app — it's free and instant. You'll get two values:

- `app_id`
- `app_key`

### 2. Add both keys to `.env`

Add these two lines to your `.env` file (placeholder values shown — use your own):

```dotenv
ADZUNA_APP_ID=your_app_id_here
ADZUNA_APP_KEY=your_app_key_here
```

> Both must be set and non-empty. If either is missing or blank, the app stays in test mode.

### 3. Restart the server

Mode is detected once at startup, so a restart is **required** for new keys to take effect:

```bash
uvicorn web_server:app --host 127.0.0.1 --port 4200
```

### 4. Verify live mode

The app auto-detects the keys on boot and flips `TEST_MODE` off. Confirm both:

- The **header pill** reads **`Live · Adzuna`** (in test mode it reads "Test mode").
- **`GET /mode`** returns:

  ```json
  { "test_mode": false, "live": true, "source": "Adzuna · live jobs" }
  ```

  ```bash
  curl http://localhost:4200/mode
  ```

Once `live: true`, discovery pulls real Adzuna listings instead of mock data.

---

## Optional: Gemini for résumé tailoring

`GOOGLE_API_KEY` is **optional** and only used for résumé tailoring. Discovery and live job search work fully without it.

- Get a free key at **https://aistudio.google.com/apikey**
- Add to `.env`:

  ```dotenv
  GOOGLE_API_KEY=your_gemini_key_here
  ```

Leaving it unset simply disables tailoring; live job discovery is unaffected.

> **Never commit your `.env` or paste a real key into any tracked file.** `.env` is git-ignored for this reason.

---

## Free-tier quota

Each discovery run is capped at **~8 Adzuna API calls** (one per role × location pair, hard-stopped at 8). This keeps you comfortably inside the free tier. To stretch it further, use the **Role** and **Location** filters in the dashboard — supplying a single role/location collapses the search to one query per run.

---

## Troubleshooting

**Still says "test mode" after adding keys**
- Both `ADZUNA_APP_ID` *and* `ADZUNA_APP_KEY` must be set — one alone won't flip it.
- The server must be restarted; keys are read only at startup, not per request.

**Live mode is on but returns 0 jobs**
- Bad/typo'd keys — Adzuna requests fail silently and yield nothing. Re-check both values.
- Unsupported location. Supported: Chennai, Bengaluru/Bangalore, Mumbai, Delhi, Hyderabad, Pune, Coimbatore, India, Remote, Singapore, London, UK, USA/US. Others (e.g. **Dubai/UAE**) have no Adzuna region and are skipped — switch to a supported location.
