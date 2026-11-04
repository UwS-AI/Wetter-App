# Wetter-App (Übungsprojekt)

Persönliches Lernprojekt zum Herantasten an Code: eine kleine Wetter-Web-App
mit HTML, CSS und JavaScript. Datenquelle: [Open-Meteo](https://open-meteo.com/) (kostenlos, kein API-Key).

## Starten

`index.html` einfach im Browser öffnen. Kein Build, keine Installation.

## Fahrplan

- [x] 1. Aktuelle Temperatur für einen festen Ort anzeigen
- [x] 2. Ort per Eingabefeld wählbar machen (+ GPS + Favoriten)
- [x] 3. Vorhersage für ein paar Tage (7 Tage + stündlich)
- [x] 4. Eigene Extras (Wind/Böen in km/h, Regen-Kurzfristprognose, Niederschlagsradar)
- [ ] 5. Optional: Als "Zum Home-Bildschirm"-Web-App auf dem iPhone ablegen
- [ ] 6. Optional: Später als SwiftUI-App nachbauen

## Struktur

```
index.html         Seitenstruktur
css/style.css      Aussehen (iPad quer, iPad hoch, iPhone hoch)
js/codes.js        Wettercodes → Text und Symbol
js/api.js          Daten von Open-Meteo holen und aufbereiten
js/favorites.js    Favoriten und zuletzt gewählter Ort
js/nowcast.js      „Regen in ca. X Minuten“
js/radar.js        Regenradar-Karte (Leaflet + RainViewer)
js/app.js          Verbindet alles und zeichnet die Anzeige
docs/ARCHITEKTUR.md  Wie die Teile zusammenspielen
notes.md           Lernnotizen
```

## Datenquellen

- Wetter und Ortssuche: [Open-Meteo](https://open-meteo.com/) (kein API-Key)
- Regenradar: [RainViewer](https://www.rainviewer.com/api.html)
- Karte: © OpenStreetMap-Mitwirkende (freie Kacheln, kein API-Key), Bibliothek [Leaflet](https://leafletjs.com/)
- Ortsname zur GPS-Position: BigDataCloud (kostenlos, ohne Key)

Hinweis: „Mein Standort“ funktioniert im Browser nur über https (z. B. GitHub Pages).

## Nützliche Links

- Open-Meteo Doku: https://open-meteo.com/en/docs
- MDN Web Docs (HTML/CSS/JS): https://developer.mozilla.org/de/
