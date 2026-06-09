# CS2 Major Live Stats — Overlay

A lightweight live overlay for Counter-Strike 2 matches, designed as a **browser source in OBS**. The Node server pulls the current matches from [HLTV](https://www.hltv.org/matches), enriches live games with the round-by-round score, and serves a transparent HTML overlay plus a JSON feed.

At startup you interactively choose **which events** to track — no more hardcoded tournament.

## Screenshots
![https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/LiveMatches.png](https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/LiveMatches.png)
![https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/scheduled.png](https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/scheduled.png)
![https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/Events.png](https://github.com/Dietze1595/CS2-Get-LiveStats-From-HLTV-Events/blob/main/images/Events.png)


## Features

- **Interactive event selection at startup** — the tournaments currently listed on HLTV are shown as a numbered list; you pick one or more (matching is exact, by HLTV `eventId`).
- **Live score enrichment** — for live matches of the selected events, the round score, maps won, and the full map list (played / live / upcoming) are pulled from the HLTV scorebot via headless Chromium.
- **Upcoming matches** — fills empty cards with the next scheduled match (including start time).
- **OBS overlay** — transparent background, shows up to 2 matches at once, scalable.
- **Robustness** — Cloudflare bypass via got-scraping with a Playwright fallback, backoff on repeated failures, last-known-good cache during tech pauses / halftime.

## Requirements

- **Node.js ≥ 20** (tested with 24)
- **Playwright browser** (Chromium) — install once:
  ```bash
  npm install
  npx playwright install chromium
  ```

## Running

```bash
npm start
# or
node server.js
```

At startup the event selection appears, e.g.:

```
Available events:
  1) IEM Cologne Major 2026 Stage 2  (2 live, 3 upcoming)
  2) CCT 2026 Europe Series 4  (8 upcoming)
  3) ESEA Advanced Season 57 Europe  (4 upcoming)

Which events to track? (e.g. 1,3):
```

Enter e.g. `1`, or `1,3` for multiple events. The selection is saved to **`selected-events.json`** and can be reused on the next start.

The server then runs at **http://localhost:3000**.

### Skipping the prompt

| Variant | Effect |
|---|---|
| `node server.js --lastEvent` | Skips the prompt and uses the last saved selection from `selected-events.json`. |
| `EVENT_IDS=9029,9218 node server.js` | Sets the event IDs directly (headless, no prompt). |
| `MOCK_LIVE=1 node server.js` | Test mode without network — uses `mock-live.json`, no prompt. |

> PowerShell: set env variables first, e.g. `$env:EVENT_IDS='9029'; node server.js`

## Configuration (env variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port of the server. |
| `POLL_INTERVAL_MS` | `16000` | Interval between two HLTV polls (ms). |
| `UPCOMING_WINDOW_HOURS` | `24` | How far ahead an upcoming match may be to fill an empty card. |
| `EVENT_IDS` | – | Comma-separated list of HLTV event IDs; skips the prompt. |
| `MOCK_LIVE` | – | If set: mock data instead of HLTV, no prompt. |
| `FANDEN_URL` | `http://localhost:8080` | Optional fallback data source (local API). Provides no event IDs, so it is not shown in real operation. |

## Setting up OBS

1. **Add source → Browser**.
2. URL: `http://localhost:3000/`
3. Width ≈ **560**, height as needed (e.g. 320).
4. Background is transparent — no further setting needed.

### Overlay parameters (append to the URL)

| Parameter | Example | Effect |
|---|---|---|
| `scale` | `?scale=0.8` | Scales the overlay (0.8 = 80%). |
| `demo` | `?demo=2` | Shows 1 or 2 demo matches without live data (for positioning). |

Example: `http://localhost:3000/?scale=0.9`

The overlay polls `/live.json` every 5 seconds on its own — no reload needed.

## Team logos

Logos live in the [`logos/`](logos/) folder and are mapped to a team via `logos/teams.json` (by HLTV ID, name, or slug).

> **Currently only Tier-1 teams are bundled.** For all other teams (Tier 2/3, regional leagues, etc.) you need to add the logos yourself in the `logos/` folder — otherwise the overlay shows an empty placeholder for those teams.

To add a new logo:

1. Drop the image file (`.png`/`.svg`) into `logos/`.
2. Add an entry in `logos/teams.json` with `hltvId`/`name`/`slug` and `currentFile`.

If a logo is missing, the overlay shows an empty placeholder — not an error.

## Endpoints

| Path | Content |
|---|---|
| `/` | The HTML overlay. |
| `/live.json` | Current match state as JSON (polled by the overlay). |
| `/logos/<file>` | Static logo files. |

## Troubleshooting

- **"no events found on HLTV index"** at startup → HLTV was briefly unreachable (Cloudflare). Start again, or skip the prompt with `EVENT_IDS=<id>`.
- **No live scores, only map names** → the scorebot sends no score between rounds/maps and during tech pauses; the last known value is held. Should fill back in on its own.
- **Overlay stays empty** → is the server running? Does the log show `[server] listening …` and a `[poll] … shown=N` line? With `shown=0` there is currently no displayable match for the selected events.
- **Playwright error at startup** → run `npx playwright install chromium`.

## Project structure (overview)

```
server.js              HTTP server, poll loop, startup event selection
index.html             The overlay frontend
selected-events.json   Last selected events (created at startup)
src/
  events.js            Event discovery, interactive prompt, persistence
  filter.js            Filters matches by selected event IDs
  fetcher.js           Source orchestration (HLTV → fanden → mock)
  mapper.js            Match data → overlay format
  display.js           Selects which matches to show (live/upcoming)
  logos.js             Team logo resolution
  sources/
    hltvScraper.js     HLTV index + live score scraping
    playwrightLive.js  Headless Chromium enrichment
    fanden.js          Optional fallback (local API)
logos/                 Team logos + teams.json
```
