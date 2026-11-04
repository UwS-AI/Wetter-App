# Architektur der Wetter-App

Diese Datei ist der „Vertrag“ zwischen allen Teilen der App. Jede Datei hält sich
an die hier beschriebenen Namen, damit die Teile zusammenpassen.

## Grundregeln

- Reines HTML, CSS, JavaScript. Kein Build, kein npm, keine ES-Module
  (`index.html` soll auch per Doppelklick / `file://` funktionieren).
- Alle Skripte sind klassische `<script>`-Dateien und hängen ihre Funktionen an
  das globale Objekt `window.Wetter` an:
  ```js
  window.Wetter = window.Wetter || {};
  Wetter.api = { ... };
  ```
- Moderne Syntax ist erlaubt (const/let, async/await, Arrow-Functions,
  Template-Strings). Ziel: Safari auf iPad/iPhone (iOS 16+).
- Code und Kommentare auf **Deutsch** kommentieren (Lernprojekt!), Bezeichner
  dürfen englisch sein.
- Einheiten: Temperatur °C, Wind **km/h**, Niederschlag mm, Luftdruck hPa.
- Keine API-Keys. Datenquellen:
  - Wetter: `https://api.open-meteo.com/v1/forecast`
  - Ortssuche: `https://geocoding-api.open-meteo.com/v1/search`
  - Ortsname zu GPS-Koordinaten: `https://api.bigdatacloud.net/data/reverse-geocode-client` (ohne Key, optional – bei Fehler „Mein Standort“)
  - Radar: RainViewer `https://api.rainviewer.com/public/weather-maps.json`
  - Karte: Leaflet 1.9.4 von `https://unpkg.com/leaflet@1.9.4/dist/` + Kacheln von OpenStreetMap/CARTO.

## Dateien und Ladereihenfolge

```
index.html        Seitenstruktur (alle IDs siehe unten)
css/style.css     Aussehen, Layout iPad quer + iPhone hoch
js/codes.js       Wettercodes (WMO) -> Text, Emoji, Gruppe
js/api.js         Abruf Open-Meteo (Vorhersage + Ortssuche) + Reverse-Geocoding
js/favorites.js   Favoriten + zuletzt gewählter Ort (localStorage)
js/nowcast.js     „Regen in ca. X Minuten“ aus 15-Minuten-Daten
js/radar.js       Radarkarte (Leaflet + RainViewer), Animation, Zeitangaben
js/app.js         Klebstoff: Ereignisse, Rendern aller Bereiche, Start
```

Reihenfolge in `index.html` (am Ende von `<body>`):
leaflet.js (unpkg, mit `defer` NICHT nötig) → codes.js → api.js → favorites.js → nowcast.js → radar.js → app.js

**Leaflet kann fehlen** (offline/blockiert). `radar.js` muss das abfangen
(`typeof L === "undefined"`) und stattdessen im Radarbereich einen Hinweis
anzeigen. Die restliche App muss trotzdem funktionieren.

## Datenmodell (Ausgabe von `Wetter.api.fetchForecast`)

```js
{
  timezone: "Europe/Berlin",
  current: {
    time: Date, temp: 12.3, feels: 10.1, code: 3, isDay: true,
    wind: 18, gusts: 35, windDir: 240,          // km/h, Grad (woher)
    humidity: 80, pressure: 1013, precip: 0.0,  // %, hPa, mm
    uv: 2.1                                     // aktueller UV-Index (aus hourly, kann null sein)
  },
  hourly: [   // ab der aktuellen Stunde, 48 Einträge
    { time: Date, temp, code, isDay, precip, precipProb, wind, gusts }
  ],
  daily: [    // 7 Tage, Index 0 = heute
    { date: Date, code, tMax, tMin, precipSum, precipProb, windMax, gustMax,
      sunrise: Date, sunset: Date }
  ],
  minutely: [ // 15-Minuten-Schritte ab jetzt, ca. 3 Stunden (12 Einträge)
    { time: Date, precip }                       // mm pro 15 min
  ]
}
```

### Zeiten und Zeitzonen

Open-Meteo mit `timezone=auto` und `timeformat=unixtime` abrufen. Dann sind alle
Zeiten Unix-Sekunden → `new Date(sek * 1000)` (ein eindeutiger Zeitpunkt).
Für die **Anzeige** zählt die Ortszeit des Wetterorts, nicht die des Geräts:

- `timezone` (z. B. `"Europe/Berlin"`) ist der **Zeitzonen-Name** des Orts. Er
  ist die bevorzugte Angabe: Der Browser kennt damit die Regeln für Sommer- und
  Winterzeit und rechnet für jeden Zeitpunkt den richtigen Abstand zu UTC.
- `utcOffsetSeconds` (aus `utc_offset_seconds`) ist ein **fester** Abstand zu
  UTC, der nur für „jetzt“ gilt. Er ist nur noch der Rückfall, falls der
  Browser den Namen nicht kennt. (Mit dem festen Offset wären z. B. in der
  Woche vor der Umstellung auf Sommerzeit Wochentage doppelt („So, So“) und
  Stunden-Labels nach der Umstellung um 1 Std. verschoben.)
- `Wetter.api.formatTime(date, zone, opts, fallbackOffset)` formatiert eine Zeit:
  - `zone` als Text (Zeitzonen-Name) → `Intl.DateTimeFormat("de-DE", { ...opts, timeZone: zone })`.
    Ist der Name ungültig (RangeError), wird `fallbackOffset` benutzt, sonst die Gerätezeit.
  - `zone` als Zahl → fester Offset in Sekunden (Verschiebung + `timeZone: "UTC"`, wie früher).
  - `zone` fehlt → Gerätezeit.
- `app.js` übergibt überall `data.timezone` mit `data.utcOffsetSeconds` als
  Rückfall – an `formatTime`, `Wetter.nowcast.analyze` und `Wetter.radar`.
  Wochentage, „Heute“, Stunden- und Nowcast-Labels entstehen ausschließlich über
  diese Formatierung; `app.js` rechnet nirgends selbst mit dem Offset.
  Dauern (Tageslänge, „Untergang in …“) sind Differenzen echter Zeitpunkte und
  brauchen keine Zeitzone.

## Modul-Schnittstellen

### `Wetter.codes`
- `describe(code, isDay = true)` → `{ text: "Leichter Regen", emoji: "🌦️", group }`
  - `group` ∈ `"clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm"`
- `windDirText(deg)` → `"SW"` (16er-Rose: N, NNO, NO, ONO, O, OSO, SO, SSO, S, SSW, SW, WSW, W, WNW, NW, NNW)

### `Wetter.api`
- `async fetchForecast(lat, lon)` → Datenmodell oben (+ `utcOffsetSeconds`, Rückfall zu `timezone`)
- `async searchPlaces(query)` → `[{ id, name, admin1, country, lat, lon }]` (max. 8, `language=de`)
- `async reverseGeocode(lat, lon)` → `"Hamburg"` oder `null` bei Fehler
- `formatTime(date, zone, opts, fallbackOffset)` → String; `zone` = Zeitzonen-Name
  (bevorzugt), Offset in Sekunden oder `undefined` (Gerätezeit), siehe „Zeiten und Zeitzonen“
- Fehler: wirft `Error` mit deutscher, verständlicher Meldung.
- Timeout pro Anfrage 10 s (`AbortController`).

### `Wetter.favorites` (localStorage, Schlüssel `wetter.favorites` / `wetter.last`)
- Ein Ort („Place“): `{ id, name, admin1, country, lat, lon }`. Für GPS-Orte
  `id = "gps"`; GPS-Orte werden nicht als Favorit gespeichert, wohl aber als `last`.
- `list()` → Place[]
- `add(place)`, `remove(id)`, `has(id)` → boolean, `toggle(place)` → boolean (neuer Zustand)
- `getLast()` → Place | null, `setLast(place)`
- localStorage-Zugriffe immer in try/catch (Safari Privatmodus).

### `Wetter.nowcast`
- `analyze(minutely, now = new Date(), zone, fallbackOffset)` →
  (`zone`/`fallbackOffset` wie bei `formatTime` – für die Uhrzeiten im Satz)
  ```js
  { state: "dry" | "starting" | "raining" | "stopping",
    text: "Regen in ca. 30 Min. (ab 14:45)",   // fertiger deutscher Satz
    minutesUntilChange: 30 | null,
    maxIntensity: 0.8 }                         // mm/15 min
  ```
  Schwelle „nass“: `precip >= 0.1` mm pro 15 min.
  Beispiele für `text`: „Kein Niederschlag in den nächsten 3 Stunden“,
  „Regen in ca. 30 Min. (ab 14:45)“, „Es regnet – voraussichtlich bis ca. 15:30“,
  „Es regnet – hält mindestens 3 Stunden an“.
- `intensityLabel(mmPer15)` → „leicht“ | „mäßig“ | „stark“

### `Wetter.radar`
- `init(containerId)` – baut Karte in `#radar-map` und verdrahtet die
  Bedienelemente `#radar-play`, `#radar-slider`, `#radar-time`, `#radar-status`.
- `setLocation(lat, lon, name, timeZone, utcOffsetSeconds)` – zentriert Karte
  (Zoom 8), setzt Marker; `timeZone` (Name, z. B. `"Europe/Berlin"`) und
  `utcOffsetSeconds` (Rückfall) bestimmen die Ortszeit der Radar-Uhrzeiten
  (fehlen beide → Gerätezeit; eine Zahl als 4. Wert gilt als Offset).
- `setTimeZone(timeZone, utcOffsetSeconds)` – nur die Zeitzone der Uhrzeiten
  ändern, Karte bleibt stehen. `app.js` ruft nach **jedem** erfolgreichen Laden
  `setLocation` (neuer Ort) bzw. `setTimeZone` (gleicher Ort) auf.
- Lädt RainViewer-Frames (`radar.past` + `radar.nowcast`), zeigt Uhrzeit je
  Frame, markiert Vorhersage-Frames als „Prognose“. Aktualisiert die Frameliste
  alle 10 Minuten (nur bei sichtbarer Seite) und sofort beim Sichtbarwerden der
  Seite, wenn der letzte erfolgreiche Abruf älter als 5 Minuten ist.
- `invalidateSize()` – nach Layoutwechsel (Drehen des Geräts) aufrufen.

## DOM-IDs in `index.html`

```
body                      Klassen: wx-<group> (z. B. wx-rain) und is-night
#app                      Grid-Container
  aside#sidebar
    form#search-form > input#search-input (type=search)
    ul#search-results
    button#locate-btn     „📍 Mein Standort“
    h3  „Favoriten“
    ul#favorites-list     (li > button.fav-item[data-id] + button.fav-remove)
  main#main
    section#current
      h2#loc-name, button#fav-toggle (☆/★), p#loc-sub (Region, Land)
      div#current-icon, div#current-temp, p#current-desc, p#current-hilo
      div#current-details  (Kacheln: Gefühlt, Wind, Böen, Feuchte, Luftdruck, UV, Sonnenaufgang/-untergang)
    section#nowcast
      p#nowcast-text, div#nowcast-bars   (12 Balken à 15 Min)
    section#hourly
      div#hourly-chart (SVG-Temperaturkurve), div#hourly-strip (horizontal scrollbar)
  section#side
    section#daily  > ul#daily-list
    section#radar  > div#radar-map, div.radar-controls > button#radar-play,
                     input#radar-slider (type=range), span#radar-time, p#radar-status
  div#status (role=status, Lade-/Fehlermeldungen)
p#footer  Quellenangaben (Open-Meteo, RainViewer, OpenStreetMap)
```

## Layout

- **iPad quer (≥ 1024 px breit, Querformat):** 3 Spalten:
  Sidebar ~260 px | Hauptbereich (flexibel) | rechte Spalte ~380 px.
  Alles passt möglichst ohne Seiten-Scroll in 1180×820 (iPad Air) /
  1366×1024 (iPad Pro 12,9″); innerhalb der Spalten darf gescrollt werden.
- **iPad hoch / kleinere Breiten (700–1023 px):** 2 Spalten, Sidebar oben als Leiste.
- **iPhone hoch (< 700 px):** 1 Spalte, Reihenfolge: Suche/Favoriten (einklappbar)
  → Aktuell → Nowcast → Stündlich → 7 Tage → Radar.
- Apple-Wetter-Stil: Farbverlauf als Hintergrund je nach `wx-*`-Klasse und
  `is-night`, halbtransparente „Glas“-Kacheln (`backdrop-filter: blur`),
  weiße Schrift, große dünne Temperatur, abgerundete Ecken (16–20 px).
- Safe Areas beachten (`env(safe-area-inset-*)`, `viewport-fit=cover`).
- Touch-Ziele mind. 44 px.
