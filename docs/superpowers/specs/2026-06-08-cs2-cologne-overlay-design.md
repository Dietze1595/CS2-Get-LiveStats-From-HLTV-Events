# CS2 Cologne Major — Live Scoreboard Overlay (Design)

**Date:** 2026-06-08
**Status:** Approved
**Scope:** Backend für das bestehende `index.html`-Overlay, das Live-Matches des CS2 Cologne Major (Stage 2 + Stage 3) anzeigt.

## Ziel

Ein lokaler Node-Server, der

1. Live-Matches von HLTV holt (Primary: `hltv` npm-Paket, Fallback: `fanden/hltv-match-api` auf `localhost:8080`),
2. nach Event-Name auf "Cologne Major Stage 2/3" filtert,
3. die existierende `index.html` und die Team-Logos statisch ausliefert,
4. unter `GET /live.json` einen Snapshot im Format liefert, das das Overlay bereits erwartet — abzüglich der Team-Namen.

## Nicht-Ziel

- Keine Tests jenseits manueller Smoke-Checks.
- Keine UI-Änderungen am Overlay außer dem Entfernen des Initialen-Fallbacks.
- Keine Persistenz, keine DB, kein Auth.
- Keine Unterstützung für andere Events / andere Spiele.

## Architektur

```
                ┌──────────────────────────────────────────┐
Browser/OBS ──► │  server.js  (Node, Port 3000)            │
   GET /        │  ─ static: index.html, /logos/*          │
   GET /live.json│  ─ /live.json: cached snapshot          │
                │  ─ poller:  alle 8s → fetcher.fetch()    │
                └─────────┬────────────────────────────────┘
                          ▼
                ┌────────────────────────┐
                │ fetcher                │
                │  1. tryNpmHltv()  ◄── primary (hltv npm) │
                │  2. tryFanden()   ◄── fallback (:8080)   │
                │  → unified Match[]                       │
                └─────────┬────────────────────────────────┘
                          ▼
                ┌────────────────────────┐
                │ filter:                │
                │  event matches EVENT_FILTER regex        │
                │  default: /cologne.*stage\s*[23]/i       │
                └─────────┬────────────────────────────────┘
                          ▼
                ┌────────────────────────┐
                │ logoResolver(name)     │
                │  teams.json → slug →   │
                │  first existing /logos/{slug}.{svg|png|…}│
                └────────────────────────┘
```

## Komponenten

### `server.js`

- Node, single file, nur stdlib (`http`, `fs`, `path`, `url`) + `hltv` als einzige npm-Abhängigkeit.
- HTTP-Server auf Port aus `PORT` (default `3000`).
- Routen:
  - `GET /` → liefert `index.html`
  - `GET /logos/<file>` → liefert Dateien aus `./logos/` (404 wenn nicht vorhanden, kein Directory-Listing)
  - `GET /live.json` → liefert den letzten gecachten Snapshot mit `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`
  - Alles andere → 404
- Startet beim Boot den Poller (`setInterval(8000ms)`), der `fetcher.fetch()` ruft und den Cache aktualisiert.

### `fetcher.js`

Sequenzielle Strategie:

1. `tryNpmHltv()` mit 6 s Timeout: `HLTV.getMatches()` + für jedes Live-Match `HLTV.getMatch({id})` zur Ergänzung von Map-Name und Map-Position.
2. Bei Fehler/Timeout: `tryFanden()` mit 6 s Timeout: `fetch('http://localhost:8080/api/matches/live')`.
3. Bei beiden Fehlern: `throw` → server.js bleibt beim letzten Cache-Stand und setzt `error`-Feld.

**Primary-Backoff:** Drei Fehlschläge der Primary-Quelle in Folge skippen die Primary für 60 s. Counter und Sperrzeitpunkt leben im Modul-Scope von `fetcher.js`.

Interne Normalform pro Match:

```js
{
  matchId, event, status,
  teamAName, teamBName,           // intern, nur für Logo-Lookup
  mapScoreA, mapScoreB,           // aktuelle Map (kann null sein)
  mapsWonA, mapsWonB,             // Serie (kann null sein)
  map,                            // Map-Name oder null
  mapPosition,                    // berechnet: (mapsWonA + mapsWonB + 1) wenn Quelle nicht liefert
  maxMaps,                        // aus format: "bo1"→1, "bo3"→3, "bo5"→5
  source                          // "hltv-npm" | "fanden"
}
```

### `filter.js`

- Reine Funktion: `(matches, regex) => filtered`.
- Default-Regex: `/cologne.*stage\s*[23]/i`, überschreibbar via `EVENT_FILTER` env-var.
- Loggt einmal pro Minute eine Liste aller in der letzten Minute gesehenen `event`-Strings auf der Konsole, damit Event-Naming-Abweichungen sofort sichtbar sind.

### `logos.js`

- Lädt `logos/teams.json` einmal beim Start in eine Map: `nameLower → currentFile`, zusätzlich `hltvId → currentFile`.
- `resolve(name, hltvId?)`: erst `hltvId`-Lookup, dann case-insensitive Name-Lookup, sonst `null`.
- Liefert relative URL `/logos/<currentFile>` oder `null`.

### `mapper.js`

Wandelt Normalform → Overlay-Format. Wichtig: **keine** `teamA`/`teamB`-Felder mehr.

```js
{
  source: 'hltv-npm' | 'fanden' | 'cache',
  matches: [{
    teamALogo,   // string|null
    teamBLogo,   // string|null
    mapScoreA, mapScoreB,
    mapsWonA, mapsWonB,
    map, mapPosition, maxMaps,
    status
  }],
  error?: string   // nur gesetzt wenn aktueller Poll fehlschlug und Cache stale ist
}
```

### `index.html`-Anpassung

Das bestehende Overlay erwartet `m.teamA`/`m.teamB`. Anpassungen:

- Die `logo(url, name)`-Funktion wird zu `logo(url)`:
  - Bei `url`: `<div class="logoBox"><img src="…" onerror="this.parentNode.innerHTML=''"></div>` (leere Box bei Bildfehler, kein Initialen-Fallback)
  - Ohne `url`: einfach `<div class="logoBox"></div>`
- Aufrufstellen entsprechend kürzen.
- Demo-Mode (`?demo=1|2`) wird so umgestellt, dass die Demo-Matches direkt fertige `teamALogo`/`teamBLogo`-URLs setzen (keine Ableitung mehr aus dem Namen). `demoLogoFallback` entfällt.

## Konfiguration (Env-Vars)

| Var | Default | Bedeutung |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `EVENT_FILTER` | `cologne.*stage\s*[23]` | Regex (case-insensitive), gegen `event` jedes Matches |
| `POLL_INTERVAL_MS` | `8000` | Poller-Tick |
| `FANDEN_URL` | `http://localhost:8080` | Base-URL des Fallback-Backends |
| `MOCK_LIVE` | unset | Wenn gesetzt: liest `mock-live.json` statt HLTV → für lokales Testen |

## Data Flow & Error Handling

```
[8s Tick] → fetcher.tryNpmHltv()
            ├─ success → normalize → filter → mapResponse → cache.set + log
            └─ throw   → fetcher.tryFanden()
                        ├─ success → normalize → filter → mapResponse → cache.set + log
                        └─ throw   → cache.peek() unverändert lassen,
                                     attach error-String an nächste /live.json-Antwort
```

- **Cache:** ein Objekt im Modul-Scope von `server.js` — `{ payload, fetchedAt }`. Erstes erfolgreiches Fetch initialisiert.
- **Stale-while-error:** Solange Cache existiert, wird er weiter ausgeliefert. `error` informiert das Overlay (zeigt den existierenden roten Hinweis-Streifen).
- **CORS:** `Access-Control-Allow-Origin: *` auf `/live.json`.
- **Logging:** Jeder Poll loggt `[ISO-Zeit] source=<x> ok=<bool> matches=<n> elapsed=<ms>`. Filter loggt einmal pro Minute alle gesehenen Event-Namen.

## Testing

Keine Unit-Tests. Drei manuelle Smoke-Checks:

1. **Demo-Modus** (`http://localhost:3000/?demo=2`) — unabhängig vom Backend, sollte zwei Hardcoded-Matches zeigen.
2. **Mock-Modus** (`MOCK_LIVE=1 node server.js`) — lädt eine eingecheckte `mock-live.json` mit zwei Beispiel-Matches, deren `event`-Strings den Default-Filter treffen (z.B. `"BLAST Open Cologne 2026 - Stage 2"`, `"BLAST Open Cologne 2026 - Stage 3"`). Testet Filter + Mapping + Logo-Resolver ohne Internet.
3. **Live-Smoke-Test** — wenn das Major läuft: `curl http://localhost:3000/live.json` prüfen. Falls leer trotz laufender Matches: Konsole nach Event-Namen ansehen und `EVENT_FILTER` anpassen.

## Setup-Schritte (für Implementierung)

1. `package.json` mit `hltv` als Dependency.
2. `npm install` einmalig.
3. `node server.js` startet alles.
4. Optional vorab: fanden/hltv-match-api per Docker hochfahren, sonst übernimmt der Primary-Pfad allein.
5. Overlay-URLs für OBS:
   - Default: `http://localhost:3000/`
   - Kompakt: `http://localhost:3000/?compact=1`
   - Demo: `http://localhost:3000/?demo=2`

## Risiken / Bekannte Schwächen

- **HLTV-Naming:** Wir kennen den exakten Event-String des Cologne Major nicht vorab. Der Default-Filter ist eine Vermutung. Mitigation: Konsolen-Log + überschreibbares Regex per Env.
- **HLTV-Captcha/Cloudflare:** Das `hltv` npm-Paket scheitert bei aktivierten Anti-Bot-Maßnahmen. Mitigation: fanden als Fallback.
- **Fehlende Map-Daten bei fanden:** Wenn Primary tot ist und Fallback läuft, fehlt der aktuelle Map-Name. Overlay zeigt dann das `map`-Feld leer. Akzeptiert.
- **Logo-Drift:** Neue Teams oder umbenannte Teams haben kein Logo-File. Bewusst: leere Logo-Box, kein Initialen-Fallback.
