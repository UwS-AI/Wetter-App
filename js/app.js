/*
 * app.js – der „Klebstoff“ der Wetter-App
 * ========================================
 *
 * Die anderen Dateien in js/ liefern jeweils einen Baustein:
 *   Wetter.codes      Wettercode → Text/Emoji/Gruppe, Windrichtung als Text
 *   Wetter.api        Daten von Open-Meteo holen, Orte suchen, Zeiten formatieren
 *   Wetter.favorites  Favoriten + zuletzt gewählten Ort speichern
 *   Wetter.nowcast    „Regen in ca. X Minuten“ ausrechnen
 *   Wetter.radar      Regenradar-Karte
 *
 * Diese Datei verbindet alles:
 *   1. Sie reagiert auf Eingaben (Suche, Standort, Favoriten, …).
 *   2. Sie lädt die Wetterdaten für den gewählten Ort.
 *   3. Sie füllt die Bereiche der Seite (index.html) mit den Daten („rendern“).
 *
 * Wichtige Grundsätze in diesem Code:
 *   - DEFENSIV: Fehlt ein Wert (null/undefined), zeigen wir „–“ statt abzustürzen.
 *     Fehlt ein ganzes Modul, läuft der Rest trotzdem weiter.
 *   - SICHER: Ortsnamen kommen aus dem Internet. Wir setzen sie NUR mit
 *     textContent ein (nie mit innerHTML) – so kann kein fremdes HTML/JavaScript
 *     in unsere Seite gelangen.
 */

// Gemeinsames Objekt aller Module (siehe docs/ARCHITEKTUR.md)
window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  const W = window.Wetter;

  /* ================================================================== */
  /* Einstellungen                                                        */
  /* ================================================================== */

  /** Ort, der beim allerersten Start angezeigt wird (noch nichts gespeichert). */
  const FALLBACK_PLACE = {
    id: "2950159",          // Open-Meteo-ID von Berlin als Text (wie in der Suche)
    name: "Berlin",
    admin1: "Berlin",
    country: "Deutschland",
    lat: 52.52,
    lon: 13.405,
  };

  const DASH = "–";                         // Platzhalter für fehlende Werte
  const SEARCH_DEBOUNCE_MS = 300;           // Wartezeit nach dem Tippen
  const REFRESH_INTERVAL_MS = 15 * 60 * 1000;   // alle 15 Minuten neu laden
  const REFRESH_ON_RETURN_MS = 2 * 60 * 1000;   // beim Zurückkehren: nur wenn älter als 2 Min.
  const HOURS_SHOWN = 24;                   // Stunden in der Stundenleiste
  const HOUR_W = 56;                        // Breite einer Stundenspalte in px (wie im CSS)

  /* ================================================================== */
  /* Zustand der App (was gerade angezeigt wird)                          */
  /* ================================================================== */

  const state = {
    // ANGEZEIGTER Ort { id, name, admin1, country, lat, lon }. Er passt immer
    // zu state.data: Ein neuer Ort wird erst übernommen, wenn seine Daten da sind.
    place: null,
    pendingPlace: null,   // Ort, der gerade geladen wird (bzw. zuletzt gewünscht war)
    data: null,           // zuletzt geladene Wetterdaten (Datenmodell aus api.js)
    loadSeq: 0,           // Zähler, um veraltete Antworten zu erkennen
    loading: false,       // läuft gerade ein Ladevorgang?
    lastLoadedAt: 0,      // Zeitpunkt (ms) der letzten erfolgreichen Ladung
    searchSeq: 0,         // dasselbe für die Ortssuche
    searchTimer: null,    // Timer für das „Debounce“ der Suche
    searchResults: [],    // letzte Treffer der Suche …
    searchQuery: "",      // … und der Suchbegriff, zu dem sie gehören
    locateSeq: 0,         // Zähler für die GPS-Ortung (jede andere Ortswahl erhöht ihn)
    locateActive: 0,      // Nummer der Ortung, die gerade läuft (0 = keine)
    radarReady: false,    // wurde Wetter.radar.init erfolgreich aufgerufen?
  };

  /* ================================================================== */
  /* Kleine Hilfsfunktionen                                               */
  /* ================================================================== */

  /** Kurzform für document.getElementById */
  const $ = (id) => document.getElementById(id);

  /** true, wenn v eine echte, endliche Zahl ist (nicht null, NaN, "abc" …) */
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  /** Macht aus Date, Zahl (ms) oder Text ein gültiges Date – oder null. */
  function toDate(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === "number" || typeof v === "string") {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /** Temperatur als „12°“ – oder „–“, wenn kein Wert da ist. */
  function fmtTemp(t) {
    return isNum(t) ? Math.round(t) + "°" : DASH;
  }

  /** Zahl gerundet als Text – oder „–“. */
  function fmtNum(v, digits = 0) {
    if (!isNum(v)) return DASH;
    return v.toLocaleString("de-DE", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  /**
   * Neues HTML-Element bauen – mit Klasse und (sicherem) Text.
   * Beispiel: el("span", "tile-label", "Wind") → <span class="tile-label">Wind</span>
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** SVG-Elemente brauchen einen eigenen „Namensraum“ – sonst zeigt der Browser nichts. */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  /** Alle Kinder eines Elements entfernen. */
  function clear(node) {
    if (node) node.replaceChildren();
  }

  /** Text in ein Element schreiben (nur wenn es das Element gibt). */
  function setText(id, text) {
    const node = $(id);
    if (node) node.textContent = text === undefined || text === null || text === "" ? DASH : String(text);
  }

  /** Untertitel eines Orts: „Region, Land“ (doppelte Angaben weglassen) */
  function placeSub(place) {
    if (!place) return "";
    if (place.id === "gps") {
      // Bei GPS-Orten zusätzlich die Genauigkeit der Ortung (falls bekannt)
      const acc = accuracyText(place.accuracy);
      return "📍 Aktueller Standort" + (acc ? " · " + acc : "");
    }
    const parts = [];
    for (const part of [place.admin1, place.country]) {
      if (part && part !== place.name && !parts.includes(part)) parts.push(part);
    }
    return parts.join(", ");
  }

  /* ---------- Sichere Aufrufe der anderen Module ----------------------
   * Jedes Modul könnte fehlen (Datei nicht geladen) oder einen Fehler werfen.
   * Diese kleinen „Wrapper“ fangen das ab und liefern einen sinnvollen Ersatz.
   */

  /** Wettercode beschreiben → { text, emoji, group } */
  function describe(code, isDay) {
    try {
      if (W.codes && typeof W.codes.describe === "function") {
        const d = W.codes.describe(code, isDay);
        if (d) return d;
      }
    } catch (err) {
      console.warn("codes.describe fehlgeschlagen:", err);
    }
    return { text: DASH, emoji: "", group: "cloudy" };
  }

  /** Windrichtung in Grad → „SW“ */
  function windDirText(deg) {
    try {
      if (W.codes && typeof W.codes.windDirText === "function") return W.codes.windDirText(deg) || "";
    } catch (err) {
      console.warn("codes.windDirText fehlgeschlagen:", err);
    }
    return "";
  }

  /**
   * Zeitzone des angezeigten Wetterorts.
   *   zone   = Zeitzonen-Name wie "Europe/Berlin" (falls bekannt), sonst der Offset
   *   offset = fester Abstand zu UTC in Sekunden (Rückfall, kann undefined sein)
   * Der NAME ist wichtig: Nur damit stimmen Uhrzeiten und Wochentage auch über
   * eine Zeitumstellung (Sommer-/Winterzeit) hinweg. Der Offset gilt nur für „jetzt“.
   */
  function placeZone() {
    const data = state.data || {};
    const offset = isNum(data.utcOffsetSeconds) ? data.utcOffsetSeconds : undefined;
    const name = typeof data.timezone === "string" && data.timezone ? data.timezone : undefined;
    return { zone: name !== undefined ? name : offset, name, offset };
  }

  /**
   * Zeit in der ORTSZEIT des Wetterorts formatieren (z. B. „14:30“).
   * Nutzt Wetter.api.formatTime; falls das fehlt, rechnen wir selbst
   * (erst mit dem Zeitzonen-Namen, sonst mit dem festen Offset).
   */
  function fmtTime(date, opts) {
    const d = toDate(date);
    if (!d) return DASH;
    const { zone, name, offset } = placeZone();
    try {
      if (W.api && typeof W.api.formatTime === "function") {
        const s = W.api.formatTime(d, zone, opts, offset);
        if (s) return s;
      }
    } catch (err) {
      console.warn("api.formatTime fehlgeschlagen:", err);
    }
    // Ersatz, falls api.js fehlt: zuerst mit Zeitzonen-Namen …
    if (name !== undefined) {
      try {
        return d.toLocaleString("de-DE", Object.assign({}, opts, { timeZone: name }));
      } catch (err) {
        /* unbekannte Zeitzone → weiter mit Offset */
      }
    }
    // … sonst Zeit um den Offset verschieben und als „UTC“ anzeigen.
    try {
      if (offset === undefined) return d.toLocaleString("de-DE", opts);
      const shifted = new Date(d.getTime() + offset * 1000);
      return shifted.toLocaleString("de-DE", Object.assign({}, opts, { timeZone: "UTC" }));
    } catch (err) {
      return DASH;
    }
  }

  /** Nur Uhrzeit „14:05“ */
  const fmtClock = (date) => fmtTime(date, { hour: "2-digit", minute: "2-digit", hour12: false });

  /** Volle Stunde „14 Uhr“ (wie bei Apple Wetter auf Deutsch) */
  function fmtHour(date) {
    const clock = fmtClock(date);
    const match = /^(\d{1,2})/.exec(clock);
    return match ? match[1] + " Uhr" : clock;
  }

  /** Kurzer Wochentag „Mo“ (Intl liefert „Mo.“ – den Punkt lassen wir weg) */
  function fmtWeekdayShort(date) {
    return fmtTime(date, { weekday: "short" }).replace(/\.$/, "");
  }

  /**
   * Farbe für eine Temperatur (für Balken und Kurve).
   * Zwischen den Stützpunkten wird die Farbe stufenlos gemischt.
   */
  const TEMP_COLORS = [
    [-15, [130, 110, 255]],  // violett
    [-5, [90, 150, 255]],    // blau
    [3, [90, 200, 250]],     // hellblau
    [10, [100, 215, 150]],   // grün
    [17, [255, 214, 10]],    // gelb
    [24, [255, 159, 10]],    // orange
    [32, [255, 69, 58]],     // rot
  ];
  function tempColor(t) {
    if (!isNum(t)) return "rgb(255,255,255)";
    const first = TEMP_COLORS[0];
    const last = TEMP_COLORS[TEMP_COLORS.length - 1];
    if (t <= first[0]) return "rgb(" + first[1].join(",") + ")";
    if (t >= last[0]) return "rgb(" + last[1].join(",") + ")";
    for (let i = 1; i < TEMP_COLORS.length; i++) {
      const [t1, c1] = TEMP_COLORS[i];
      const [t0, c0] = TEMP_COLORS[i - 1];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);   // 0 … 1 zwischen den beiden Stützpunkten
        const mix = c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
        return "rgb(" + mix.join(",") + ")";
      }
    }
    return "rgb(255,255,255)";
  }

  /* ================================================================== */
  /* Statusanzeige (Laden / Fehler) in #status                            */
  /* ================================================================== */

  function showLoading(text) {
    const box = $("status");
    if (!box) return;
    box.classList.remove("is-error");
    clear(box);
    box.append(el("span", "spinner"), el("span", "status-text", text || "Lade Wetterdaten …"));
    box.hidden = false;
  }

  /**
   * Fehlermeldung anzeigen. Wird retry übergeben, gibt es einen Knopf
   * „Erneut versuchen“, der diese Funktion aufruft.
   */
  function showError(message, retry) {
    const box = $("status");
    if (!box) return;
    box.classList.add("is-error");
    clear(box);
    box.append(el("span", "status-text", "⚠️ " + (message || "Unbekannter Fehler")));
    if (typeof retry === "function") {
      const btn = el("button", "status-retry", "Erneut versuchen");
      btn.type = "button";
      btn.addEventListener("click", () => {
        hideStatus();
        retry();
      });
      box.append(btn);
      // Zusätzlich ein ✕ zum Schließen, damit die Meldung nichts dauerhaft verdeckt
      const close = el("button", "status-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Meldung schließen");
      close.addEventListener("click", hideStatus);
      box.append(close);
    } else {
      // Meldungen ohne Knopf verschwinden nach ein paar Sekunden von selbst
      const shown = box.lastChild;
      setTimeout(() => {
        if (box.contains(shown)) hideStatus();
      }, 6000);
    }
    box.hidden = false;
  }

  function hideStatus() {
    const box = $("status");
    if (!box) return;
    box.hidden = true;
    box.classList.remove("is-error");
    clear(box);
  }

  /* ================================================================== */
  /* Wetter laden                                                         */
  /* ================================================================== */

  /**
   * Einen Ort laden und – sobald seine Daten da sind – anzeigen.
   *
   * Wichtig: Der neue Ort wird erst übernommen, wenn das Laden GEKLAPPT hat.
   * Bis dahin bleiben Kopfzeile, Stern, Radar und alle Daten beim alten Ort
   * (die Statuszeile zeigt „Lade Wetter für …“). Schlägt das Laden fehl, passt
   * alles weiterhin zusammen – und „Erneut versuchen“ lädt den gewünschten Ort.
   *
   * @param {object} place  Ort { id, name, admin1, country, lat, lon }
   * @param {object} [opts] { silent: true } = Hintergrund-Aktualisierung ohne Ladeanzeige
   */
  async function loadPlace(place, opts = {}) {
    if (!place || !isNum(place.lat) || !isNum(place.lon)) return;

    // Die Nummer dieses Ladevorgangs merken. Kommt eine ältere Antwort erst
    // NACH einer neueren an (z. B. schnell zweimal Ort gewechselt), ignorieren wir sie.
    const seq = ++state.loadSeq;
    state.loading = true;
    state.pendingPlace = place;

    // Beim allerersten Laden gibt es noch keinen alten Ort – dann zeigt die
    // Kopfzeile schon den gewünschten Ort (siehe renderPlaceHeader).
    if (!state.place) renderPlaceHeader();

    if (!opts.silent) {
      showLoading("Lade Wetter für " + (place.name || "Ort") + " …");
      document.body.classList.add("is-loading");
    }

    try {
      if (!W.api || typeof W.api.fetchForecast !== "function") {
        throw new Error("Das Datenmodul (js/api.js) wurde nicht geladen.");
      }
      const data = await W.api.fetchForecast(place.lat, place.lon);
      if (seq !== state.loadSeq) return;          // veraltet → verwerfen
      if (!data || typeof data !== "object") throw new Error("Keine Wetterdaten erhalten.");

      // Erfolg: JETZT erst den neuen Ort übernehmen – zusammen mit seinen Daten.
      const isNewPlace = !state.place || state.place.lat !== place.lat || state.place.lon !== place.lon;
      state.place = place;
      state.data = data;
      state.lastLoadedAt = Date.now();

      // Merken, damit beim nächsten Start dieser Ort kommt
      try {
        if (W.favorites && W.favorites.setLast) W.favorites.setLast(place);
      } catch (err) {
        console.warn("favorites.setLast fehlgeschlagen:", err);
      }

      renderAll();          // enthält auch die Kopfzeile mit Stern
      renderFavorites();    // markiert den aktuellen Ort in der Favoritenliste
      hideStatus();

      // Radar: Bei neuem Ort Karte zentrieren + Marker setzen, sonst nur die
      // Zeitzone auffrischen (die Karte springt dann nicht zurück, falls der
      // Nutzer sie verschoben hat). Beides mit Zeitzonen-Name + Offset als
      // Rückfall, damit die Radar-Uhrzeiten in Ortszeit erscheinen.
      const { zone, offset } = placeZone();
      if (isNewPlace) radarCall("setLocation", place.lat, place.lon, place.name, zone, offset);
      else radarCall("setTimeZone", zone, offset);
    } catch (err) {
      if (seq !== state.loadSeq) return;
      console.warn("Laden fehlgeschlagen:", err);
      const msg = (err && err.message) || "Die Wetterdaten konnten nicht geladen werden.";
      // „Erneut versuchen“ lädt den GEWÜNSCHTEN Ort (nicht den angezeigten).
      showError(msg, () => loadPlace(place));
    } finally {
      if (seq === state.loadSeq) {
        state.loading = false;
        document.body.classList.remove("is-loading");
      }
    }
  }

  /**
   * Aktuellen Ort im Hintergrund neu laden (Auto-Aktualisierung).
   * Läuft gerade schon ein Ladevorgang (z. B. der Nutzer hat eben einen neuen
   * Ort gewählt), tun wir nichts – sonst würde die Aktualisierung des ALTEN
   * Orts den neuen Ladevorgang verdrängen.
   */
  function refresh() {
    if (state.loading) return;
    if (state.place) loadPlace(state.place, { silent: true });
  }

  /**
   * Der Nutzer wählt selbst einen Ort (Suche, Favorit). Eine evtl. noch
   * laufende GPS-Ortung ist damit hinfällig und darf den Ort später nicht
   * mehr überschreiben.
   */
  function selectPlace(place) {
    cancelLocate();
    loadPlace(place);
  }

  /* ================================================================== */
  /* Rendern: Daten → Seite                                               */
  /* ================================================================== */

  /**
   * Alle Bereiche neu zeichnen. Jeder Bereich läuft in einem eigenen
   * try/catch: Hat ein Bereich ein Problem, erscheinen die anderen trotzdem.
   */
  function renderAll() {
    const parts = [
      ["Hintergrund", renderTheme],
      ["Kopfzeile", renderPlaceHeader],
      ["Aktuell", renderCurrent],
      ["Details", renderDetails],
      ["Nowcast", renderNowcast],
      ["Stündlich", renderHourly],
      ["7 Tage", renderDaily],
    ];
    for (const [name, fn] of parts) {
      try {
        fn();
      } catch (err) {
        console.warn("Fehler beim Anzeigen von „" + name + "“:", err);
      }
    }
    // Die Inhalte können die Höhe der Radar-Karte verändert haben (Grid/Flex).
    // Leaflet muss das wissen, sonst sitzt der Ortsmarker nicht in der Mitte.
    requestAnimationFrame(() => radarCall("invalidateSize"));
  }

  /** Hintergrund-Verlauf passend zum Wetter (Klassen wx-<gruppe> und is-night am body) */
  function renderTheme() {
    const cur = (state.data && state.data.current) || {};
    const group = describe(cur.code, cur.isDay).group || "cloudy";
    const body = document.body;

    // Alte wx-*-Klassen entfernen, neue setzen
    for (const cls of Array.from(body.classList)) {
      if (cls.startsWith("wx-")) body.classList.remove(cls);
    }
    body.classList.add("wx-" + group);
    body.classList.toggle("is-night", cur.isDay === false);

    // Hintergrund-Animation (Regen, Schnee, Sterne …) mit den echten Daten füttern.
    // Open-Meteo liefert den aktuellen Niederschlag als Summe der letzten
    // 15 Minuten – mal 4 ergibt ungefähr mm pro Stunde.
    if (Wetter.effects) {
      try {
        Wetter.effects.update({
          code: cur.code, isDay: cur.isDay, windSpeed: cur.wind, windDir: cur.windDir,
          precip: typeof cur.precip === "number" ? cur.precip * 4 : null,
        });
      } catch (err) { console.warn("Animation:", err); }
    }

    // Farbe der Safari-Leiste an den oberen Verlaufston anpassen
    const meta = document.querySelector('meta[name="theme-color"]');
    const top = getComputedStyle(body).getPropertyValue("--bg-top").trim();
    if (meta && top) meta.setAttribute("content", top);
  }

  /**
   * Ortsname, Region und Favoriten-Stern.
   * Gezeigt wird der Ort, dessen Daten auf dem Bildschirm stehen (state.place).
   * Nur ganz am Anfang, solange noch gar nichts geladen ist, zeigen wir den
   * Ort, der gerade geladen wird – dann gibt es keine „alten“ Daten, die nicht
   * dazu passen würden. Der Stern erscheint aber erst, wenn Daten da sind.
   */
  function renderPlaceHeader() {
    const place = state.place || state.pendingPlace;
    setText("loc-name", place && place.name);
    const sub = $("loc-sub");
    if (sub) sub.textContent = placeSub(place);

    const star = $("fav-toggle");
    if (star) {
      // GPS-Orte können kein Favorit sein (siehe Vertrag) → Stern ausblenden
      const canFav = !!state.place && place.id !== "gps" && !!W.favorites;
      star.hidden = !canFav;
      const isFav = canFav && favHas(place.id);
      star.textContent = isFav ? "★" : "☆";
      star.setAttribute("aria-pressed", String(isFav));
      star.setAttribute("aria-label", isFav ? "Aus Favoriten entfernen" : "Als Favorit speichern");
      star.title = star.getAttribute("aria-label");
    }
  }

  /** Großer Block oben: Symbol, Temperatur, Beschreibung, Höchst/Tiefst */
  function renderCurrent() {
    const data = state.data || {};
    const cur = data.current || {};
    const today = (Array.isArray(data.daily) && data.daily[0]) || {};
    const desc = describe(cur.code, cur.isDay);

    setText("current-icon", desc.emoji);
    setText("current-temp", fmtTemp(cur.temp));
    setText("current-desc", desc.text);
    setText("current-hilo", "H: " + fmtTemp(today.tMax) + "  T: " + fmtTemp(today.tMin));

    const updated = $("current-updated");
    if (updated) {
      const t = toDate(cur.time);
      updated.textContent = t ? "Stand " + fmtClock(t) + " Uhr (Ortszeit)" : "";
    }

    // Auch der Tab-Titel zeigt Temperatur und Ort, z. B. „12° Berlin · Wetter“
    if (state.place) document.title = fmtTemp(cur.temp) + " " + state.place.name + " · Wetter";
  }

  /* ---------- Detailkacheln ---------- */

  /**
   * Eine Kachel bauen.
   * @param {string} label  Überschrift mit kleinem Symbol („💨 Wind“)
   * @param {string} value  großer Wert („18“)
   * @param {string} unit   Einheit („km/h“) – darf leer sein
   * @param {string} sub    kleine Zusatzzeile – darf leer sein
   * @param {Node}   [extra] zusätzliches Element neben dem Wert (z. B. Windpfeil)
   */
  function tile(label, value, unit, sub, extra) {
    const box = el("div", "detail-tile");
    box.append(el("span", "tile-label", label));
    box.title = label.replace(/^\S+\s/, "");   // Tooltip: Überschrift ohne Emoji

    const valueLine = el("span", "tile-value");
    if (extra) valueLine.append(extra);
    valueLine.append(document.createTextNode(value));
    if (unit && value !== DASH) valueLine.append(el("span", "tile-unit", unit));
    box.append(valueLine);

    box.append(el("span", "tile-sub", sub || " "));   //   = geschütztes Leerzeichen (hält die Höhe)
    return box;
  }

  /**
   * Windpfeil als kleines SVG. Die Windrichtung (Grad) gibt an, WOHER der Wind
   * kommt. Der Pfeil soll zeigen, WOHIN er zieht → wir drehen um 180° mehr.
   * Ohne Drehung zeigt der Pfeil nach oben (= nach Norden).
   */
  function windArrow(deg) {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", class: "wind-arrow", "aria-hidden": "true" });
    svg.append(svgEl("path", {
      d: "M12 2 L19 20 L12 16 L5 20 Z",
      fill: "currentColor",
    }));
    svg.style.transform = "rotate(" + ((deg + 180) % 360) + "deg)";
    return svg;
  }

  /** UV-Index → Einstufung (nach WHO) */
  function uvLabel(uv) {
    if (!isNum(uv)) return "";
    if (uv < 3) return "Niedrig";
    if (uv < 6) return "Mäßig";
    if (uv < 8) return "Hoch";
    if (uv < 11) return "Sehr hoch";
    return "Extrem";
  }

  /** Dauer in ms → „9 h 12 min“ (kurz, passt in die Kacheln) */
  function fmtDuration(ms) {
    if (!isNum(ms) || ms < 0) return "";
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? h + " h " + m + " min" : m + " min";
  }

  function renderDetails() {
    const box = $("current-details");
    if (!box) return;
    const data = state.data || {};
    const cur = data.current || {};
    const days = Array.isArray(data.daily) ? data.daily : [];
    const today = days[0] || {};

    const tiles = [];

    // Gefühlte Temperatur + kurzer Vergleich mit der gemessenen
    let feelsSub = "";
    if (isNum(cur.feels) && isNum(cur.temp)) {
      const diff = cur.feels - cur.temp;
      // kurz halten – die Kacheln sind auf dem iPad quer recht schmal
      feelsSub = diff <= -2 ? Math.round(-diff) + "° kälter" : diff >= 2 ? Math.round(diff) + "° wärmer" : "Wie gemessen";
    }
    tiles.push(tile("🌡️ Gefühlt", fmtTemp(cur.feels), "", feelsSub));

    // Wind: Stärke + Richtung (Text + gedrehter Pfeil)
    const dirText = windDirText(cur.windDir);
    const arrow = isNum(cur.windDir) ? windArrow(cur.windDir) : null;
    const windTile = tile("💨 Wind", fmtNum(cur.wind), "km/h", dirText ? "aus " + dirText : "", arrow);
    if (dirText) windTile.title = "Wind aus " + dirText + " (" + Math.round(cur.windDir) + "°), Pfeil zeigt die Zugrichtung";
    tiles.push(windTile);

    // Böen (+ Tageshöchstwert)
    const gustSub = isNum(today.gustMax) ? "Heute max. " + fmtNum(today.gustMax) : "";
    tiles.push(tile("🌬️ Böen", fmtNum(cur.gusts), "km/h", gustSub));

    // Luftfeuchtigkeit
    tiles.push(tile("💧 Feuchte", fmtNum(cur.humidity), "%", ""));

    // Luftdruck
    tiles.push(tile("⏲️ Luftdruck", fmtNum(cur.pressure), "hPa", ""));

    // UV-Index
    tiles.push(tile("😎 UV-Index", fmtNum(cur.uv), "", uvLabel(cur.uv)));

    // Sonnenaufgang (+ Tageslänge) und Sonnenuntergang (+ „in X Std.“)
    const rise = toDate(today.sunrise);
    const set = toDate(today.sunset);
    const dayLength = rise && set ? "Tag: " + fmtDuration(set - rise) : "";
    tiles.push(tile("🌅 Aufgang", rise ? fmtClock(rise) : DASH, "", dayLength));

    let setSub = "";
    if (set) {
      const now = toDate(cur.time) || new Date();
      const untilSet = set - now;
      setSub = untilSet > 0 ? "in " + fmtDuration(untilSet) : "Schon vorbei";
    }
    tiles.push(tile("🌇 Untergang", set ? fmtClock(set) : DASH, "", setSub));

    box.replaceChildren(...tiles);
  }

  /* ---------- Nowcast: Regen in den nächsten 3 Stunden ---------- */

  function renderNowcast() {
    const data = state.data || {};
    const minutely = Array.isArray(data.minutely) ? data.minutely.slice(0, 12) : [];
    const textBox = $("nowcast-text");
    const bars = $("nowcast-bars");

    // 1. Satz („Regen in ca. 30 Min.“) von Wetter.nowcast holen
    let result = null;
    try {
      if (W.nowcast && typeof W.nowcast.analyze === "function" && minutely.length) {
        // 3./4. Wert: Zeitzone des Orts (Name, Rückfall Offset),
        // damit Uhrzeiten im Satz in Ortszeit stehen
        const { zone, offset } = placeZone();
        result = W.nowcast.analyze(minutely, new Date(), zone, offset);
      }
    } catch (err) {
      console.warn("nowcast.analyze fehlgeschlagen:", err);
    }
    if (textBox) {
      if (result && result.text) textBox.textContent = result.text;
      else textBox.textContent = minutely.length ? DASH : "Keine Kurzfrist-Daten verfügbar";
    }

    if (!bars) return;

    // 2. Zwölf Balken à 15 Minuten. Die Höhe wächst mit der Wurzel der Menge –
    //    so ist leichter Regen gut sichtbar und starker sprengt nicht die Skala.
    const MAX_MM = 2;   // ab 2 mm pro 15 Min. ist der Balken voll
    const cols = [];
    let lastLabelIndex = -10;

    for (let i = 0; i < 12; i++) {
      const entry = minutely[i] || {};
      const p = isNum(entry.precip) ? entry.precip : null;
      const time = toDate(entry.time);

      const col = el("div", "nc-col");
      const track = el("div", "nc-track");
      const fill = el("div", "nc-fill");
      const ratio = p ? Math.sqrt(Math.min(p, MAX_MM) / MAX_MM) : 0;
      fill.style.height = p > 0 ? "max(3px, " + Math.round(ratio * 100) + "%)" : "0";
      if (p !== null && intensity(p) === "stark") fill.classList.add("is-heavy");
      track.append(fill);
      col.append(track);

      // Beschriftung: nur zu vollen Stunden („15:00“), damit es nicht zu voll wird.
      // Ganz links „Jetzt“, falls die erste volle Stunde weit genug entfernt ist.
      let label = "";
      const clock = time ? fmtClock(time) : "";
      if (clock.endsWith(":00") && i - lastLabelIndex >= 2) label = clock;
      else if (i === 0 && !isFullHourSoon(minutely)) label = "Jetzt";
      if (label) lastLabelIndex = i;
      col.append(el("span", "nc-label", label));

      // Tooltip mit genauer Menge (Maus / langes Drücken)
      if (time) col.title = clock + " Uhr: " + (p === null ? DASH : fmtNum(p, 1) + " mm");
      cols.push(col);
    }
    bars.replaceChildren(...cols);
  }

  /** Ist in Balken 1 schon eine volle Stunde? Dann kein „Jetzt“ (Platzmangel). */
  function isFullHourSoon(minutely) {
    const second = minutely[1] && toDate(minutely[1].time);
    return !!second && fmtClock(second).endsWith(":00");
  }

  /** Stärke des Niederschlags als Wort (über Wetter.nowcast, sonst eigene Schätzung) */
  function intensity(mm) {
    try {
      if (W.nowcast && typeof W.nowcast.intensityLabel === "function") return W.nowcast.intensityLabel(mm);
    } catch (err) {
      /* Ersatz unten */
    }
    return mm >= 1 ? "stark" : mm >= 0.3 ? "mäßig" : "leicht";
  }

  /* ---------- Stündliche Vorhersage: Kurve + Leiste ---------- */

  function renderHourly() {
    const data = state.data || {};
    const hours = (Array.isArray(data.hourly) ? data.hourly : []).slice(0, HOURS_SHOWN);
    renderHourlyStrip(hours);
    renderHourlyChart(hours);
  }

  /** Die wischbare Leiste: Uhrzeit, Symbol, Regenwahrscheinlichkeit, Temperatur */
  function renderHourlyStrip(hours) {
    const strip = $("hourly-strip");
    if (!strip) return;
    strip.style.setProperty("--hour-w", HOUR_W + "px");

    const cols = hours.map((h, i) => {
      h = h || {};
      const col = el("div", "hour" + (i === 0 ? " is-now" : ""));
      const d = describe(h.code, h.isDay);

      col.append(el("span", "hour-time", i === 0 ? "Jetzt" : fmtHour(h.time)));
      col.append(el("span", "hour-icon", d.emoji || DASH));

      const prob = el("span", "hour-prob", isNum(h.precipProb) ? Math.round(h.precipProb) + " %" : DASH);
      if (!isNum(h.precipProb) || h.precipProb < 20) prob.classList.add("is-low");
      col.append(prob);

      col.append(el("span", "hour-temp", fmtTemp(h.temp)));
      col.title = d.text + (isNum(h.precipProb) ? ", Regenwahrscheinlichkeit " + Math.round(h.precipProb) + " %" : "");
      return col;
    });

    if (!cols.length) cols.push(el("p", "search-info", "Keine Stundenwerte verfügbar"));
    strip.replaceChildren(...cols);
  }

  /**
   * Temperaturkurve als SVG – ganz ohne Bibliothek.
   * Jede Stunde bekommt eine Spalte von HOUR_W Pixeln (genau wie die Leiste
   * darunter), der Punkt sitzt in der Spaltenmitte. So liegt die Kurve exakt
   * über den passenden Stunden.
   */
  function renderHourlyChart(hours) {
    const box = $("hourly-chart");
    if (!box) return;

    const temps = hours.map((h) => (h && isNum(h.temp) ? h.temp : null));
    const valid = temps.filter(isNum);
    if (valid.length < 2) {     // zu wenig Daten für eine Kurve
      clear(box);
      return;
    }

    // Maße der Zeichenfläche
    const width = hours.length * HOUR_W;
    const height = 62;
    const padTop = 17;      // Platz für die Beschriftung des Höchstwerts
    const padBottom = 18;   // Platz für die Beschriftung des Tiefstwerts

    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;    // „|| 1“ verhindert Division durch 0 bei flacher Kurve

    // Umrechnung: Stunde → x-Pixel, Temperatur → y-Pixel (oben = warm)
    const x = (i) => i * HOUR_W + HOUR_W / 2;
    const y = (t) => padTop + ((max - t) / span) * (height - padTop - padBottom);

    // Punkte sammeln; bei fehlenden Werten beginnt ein neues Teilstück
    const segments = [];
    let current = [];
    temps.forEach((t, i) => {
      if (isNum(t)) current.push([x(i), y(t)]);
      else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);

    const svg = svgEl("svg", {
      width: String(width),
      height: String(height),
      viewBox: "0 0 " + width + " " + height,
      role: "img",
    });

    // Farbverläufe definieren: Linie (warm oben → kalt unten) und Fläche darunter
    const defs = svgEl("defs");
    const lineGrad = svgEl("linearGradient", {
      id: "hourly-line-grad", gradientUnits: "userSpaceOnUse",
      x1: "0", y1: String(padTop), x2: "0", y2: String(height - padBottom),
    });
    lineGrad.append(
      svgEl("stop", { offset: "0", "stop-color": tempColor(max) }),
      svgEl("stop", { offset: "1", "stop-color": tempColor(min) })
    );
    const areaGrad = svgEl("linearGradient", { id: "hourly-area-grad", x1: "0", y1: "0", x2: "0", y2: "1" });
    areaGrad.append(
      svgEl("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": "0.28" }),
      svgEl("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": "0" })
    );
    defs.append(lineGrad, areaGrad);
    svg.append(defs);

    // Jedes Teilstück: weiche Kurve + Fläche darunter
    for (const pts of segments) {
      const d = smoothPath(pts);
      if (pts.length > 1) {
        const area = d + " L" + pts[pts.length - 1][0] + "," + height + " L" + pts[0][0] + "," + height + " Z";
        svg.append(svgEl("path", { d: area, fill: "url(#hourly-area-grad)" }));
      }
      svg.append(svgEl("path", { d, class: "chart-line", stroke: "url(#hourly-line-grad)" }));
    }

    // Punkt „Jetzt“ (erste Stunde)
    if (isNum(temps[0])) {
      svg.append(svgEl("circle", { cx: x(0), cy: y(temps[0]), r: "4.5", class: "chart-dot" }));
    }

    // Höchst- und Tiefstwert beschriften (jeweils das erste Vorkommen)
    const iMax = temps.indexOf(max);
    const iMin = temps.indexOf(min);
    const label = (i, t, isMin) => {
      const text = svgEl("text", {
        x: String(x(i)),
        y: String(isMin ? y(t) + 14 : y(t) - 7),
        "text-anchor": "middle",
        class: "chart-label" + (isMin ? " is-min" : ""),
      });
      text.textContent = fmtTemp(t);
      return text;
    };
    if (iMax >= 0) svg.append(svgEl("circle", { cx: x(iMax), cy: y(max), r: "3", class: "chart-dot" }), label(iMax, max, false));
    if (iMin >= 0 && max !== min) svg.append(svgEl("circle", { cx: x(iMin), cy: y(min), r: "3", class: "chart-dot" }), label(iMin, min, true));

    box.replaceChildren(svg);

    // Kurve an die aktuelle Scroll-Position der Leiste anpassen
    const strip = $("hourly-strip");
    if (strip) box.scrollLeft = strip.scrollLeft;
  }

  /**
   * Weiche Kurve durch Punkte (Catmull-Rom → Bézier).
   * Für jedes Stück zwischen zwei Punkten berechnen wir zwei „Anfasser“ aus den
   * Nachbarpunkten. Ergebnis ist ein SVG-Pfad wie „M x,y C … “.
   */
  function smoothPath(pts) {
    if (!pts.length) return "";
    const r = (n) => Math.round(n * 10) / 10;   // auf 0,1 px runden – kürzerer Pfad
    let d = "M" + r(pts[0][0]) + "," + r(pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += " C" + r(c1x) + "," + r(c1y) + " " + r(c2x) + "," + r(c2y) + " " + r(p2[0]) + "," + r(p2[1]);
    }
    return d;
  }

  /* ---------- 7-Tage-Vorhersage ---------- */

  function renderDaily() {
    const list = $("daily-list");
    if (!list) return;
    const data = state.data || {};
    const days = (Array.isArray(data.daily) ? data.daily : []).slice(0, 7);
    const curTemp = data.current && data.current.temp;

    // Wochenspanne: kältester Tiefstwert bis wärmster Höchstwert.
    // Daran messen wir alle Balken – wie bei Apple Wetter.
    const all = [];
    for (const day of days) {
      if (day && isNum(day.tMin)) all.push(day.tMin);
      if (day && isNum(day.tMax)) all.push(day.tMax);
    }
    if (isNum(curTemp)) all.push(curTemp);
    const weekMin = all.length ? Math.min(...all) : 0;
    const weekMax = all.length ? Math.max(...all) : 1;
    const weekSpan = weekMax - weekMin || 1;
    const pct = (t) => ((t - weekMin) / weekSpan) * 100;   // Temperatur → Position in %

    const rows = days.map((day, i) => {
      day = day || {};
      const li = el("li", "day");
      const desc = describe(day.code, true);   // Tagesübersicht immer mit Tag-Symbol

      // Wochentag
      li.append(el("span", "day-name", i === 0 ? "Heute" : fmtWeekdayShort(day.date)));

      // Symbol + Regenwahrscheinlichkeit (ab 10 %)
      const icon = el("span", "day-icon");
      icon.append(el("span", "day-emoji", desc.emoji || DASH));
      if (isNum(day.precipProb) && day.precipProb >= 10) {
        icon.append(el("span", "day-prob", Math.round(day.precipProb) + " %"));
      }
      li.append(icon);

      // Tiefstwert
      li.append(el("span", "day-min", fmtTemp(day.tMin)));

      // Temperaturbalken
      const bar = el("div", "temp-bar");
      if (isNum(day.tMin) && isNum(day.tMax)) {
        const fill = el("div", "temp-bar-fill");
        const left = pct(day.tMin);
        const right = pct(day.tMax);
        fill.style.left = left + "%";
        fill.style.width = Math.max(right - left, 2) + "%";
        fill.style.backgroundImage = "linear-gradient(90deg, " + tempColor(day.tMin) + ", " + tempColor(day.tMax) + ")";
        bar.append(fill);

        // Heute: weißer Punkt bei der aktuellen Temperatur
        if (i === 0 && isNum(curTemp)) {
          const dot = el("span", "temp-bar-now");
          dot.style.left = pct(curTemp) + "%";
          bar.append(dot);
        }
      }
      li.append(bar);

      // Höchstwert
      li.append(el("span", "day-max", fmtTemp(day.tMax)));

      // Vorlesetext für Screenreader (die Einzelteile allein sind schwer verständlich)
      const dayName = i === 0 ? "Heute" : fmtTime(day.date, { weekday: "long" });
      li.setAttribute("aria-label",
        dayName + ": " + desc.text +
        (isNum(day.precipProb) ? ", Regenwahrscheinlichkeit " + Math.round(day.precipProb) + " %" : "") +
        ", " + fmtTemp(day.tMin) + " bis " + fmtTemp(day.tMax));
      return li;
    });

    if (!rows.length) rows.push(el("li", "fav-empty", "Keine Tageswerte verfügbar"));
    list.replaceChildren(...rows);
  }

  /* ================================================================== */
  /* Favoriten                                                            */
  /* ================================================================== */

  /** Sichere Abfrage: Ist die ID ein Favorit? */
  function favHas(id) {
    try {
      return !!(W.favorites && W.favorites.has(id));
    } catch (err) {
      return false;
    }
  }

  function favList() {
    try {
      const list = W.favorites && W.favorites.list();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.warn("favorites.list fehlgeschlagen:", err);
      return [];
    }
  }

  /** Favoritenliste in der Sidebar neu aufbauen */
  function renderFavorites() {
    const ul = $("favorites-list");
    if (!ul) return;

    if (!W.favorites) {
      ul.replaceChildren(el("li", "fav-empty", "Favoriten sind nicht verfügbar."));
      return;
    }

    const favs = favList();
    if (!favs.length) {
      ul.replaceChildren(el("li", "fav-empty", "Noch keine Favoriten. Tippe auf ☆ neben dem Ortsnamen."));
      return;
    }

    const items = favs.map((place) => {
      const li = el("li");

      // Hauptknopf: Ort anzeigen
      const btn = el("button", "fav-item");
      btn.type = "button";
      btn.dataset.id = String(place.id);
      btn.append(el("span", "fav-name", place.name || DASH));
      const sub = placeSub(place);
      if (sub) btn.append(el("span", "fav-sub", sub));
      if (state.place && String(state.place.id) === String(place.id)) {
        btn.setAttribute("aria-current", "true");
      }

      // Entfernen-Knopf
      const remove = el("button", "fav-remove", "✕");
      remove.type = "button";
      remove.dataset.id = String(place.id);
      remove.setAttribute("aria-label", (place.name || "Ort") + " aus Favoriten entfernen");
      remove.title = "Entfernen";

      li.append(btn, remove);
      return li;
    });
    ul.replaceChildren(...items);
  }

  /** Klick in der Favoritenliste (ein Listener für alle Knöpfe = „Event-Delegation“) */
  function onFavoritesClick(event) {
    const btn = event.target.closest("button[data-id]");
    if (!btn) return;
    // data-id ist immer Text – den passenden Ort in der Liste suchen
    const place = favList().find((p) => String(p.id) === btn.dataset.id);
    if (!place) return;

    if (btn.classList.contains("fav-remove")) {
      try {
        W.favorites.remove(place.id);
      } catch (err) {
        console.warn("favorites.remove fehlgeschlagen:", err);
      }
      renderFavorites();
      renderPlaceHeader();
    } else {
      collapseSidebarOnPhone();
      selectPlace(place);
    }
  }

  /** Stern neben dem Ortsnamen: Favorit an/aus */
  function onFavToggle() {
    const place = state.place;
    if (!place || place.id === "gps" || !W.favorites) return;
    try {
      W.favorites.toggle(place);
    } catch (err) {
      console.warn("favorites.toggle fehlgeschlagen:", err);
      showError("Favorit konnte nicht gespeichert werden.");
    }
    renderPlaceHeader();
    renderFavorites();
  }

  /* ================================================================== */
  /* Ortssuche                                                            */
  /* ================================================================== */

  function closeResults() {
    const ul = $("search-results");
    if (!ul) return;
    ul.hidden = true;
    clear(ul);
    state.searchResults = [];
    state.searchQuery = "";
    const input = $("search-input");
    if (input) input.setAttribute("aria-expanded", "false");
  }

  /** Einen Info-Text in der Trefferliste zeigen („Suche …“, „Nichts gefunden“) */
  function showSearchInfo(text) {
    const ul = $("search-results");
    if (!ul) return;
    ul.replaceChildren(el("li", "search-info", text));
    ul.hidden = false;
  }

  /**
   * Alte Treffer verwerfen. Danach kann Enter keinen Treffer übernehmen,
   * der zu einem früheren Suchbegriff gehört.
   */
  function forgetResults() {
    state.searchResults = [];
    state.searchQuery = "";
    const input = $("search-input");
    if (input) input.setAttribute("aria-expanded", "false");
  }

  /** Eingabe im Suchfeld: erst 300 ms Ruhe abwarten („Debounce“), dann suchen */
  function onSearchInput() {
    clearTimeout(state.searchTimer);
    const query = $("search-input").value.trim();
    if (query.length < 2) {      // leer oder zu kurz → Liste schließen
      state.searchSeq++;         // laufende Suche verwerfen
      closeResults();
      return;
    }
    // Neuer Suchbegriff → die alten Treffer passen nicht mehr. Wir zeigen
    // gleich „Suche …“, damit niemand versehentlich einen alten Treffer
    // antippt (oder per Enter übernimmt). Kommt nur z. B. ein Leerzeichen
    // am Ende dazu, bleibt der Begriff gleich und die Treffer bleiben stehen.
    if (query === state.searchQuery) return;   // Treffer passen noch
    state.searchSeq++;           // eine evtl. noch laufende Suche ist veraltet
    forgetResults();
    showSearchInfo("Suche …");
    state.searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(query) {
    const seq = ++state.searchSeq;
    forgetResults();             // bis die neuen Treffer da sind, gilt keiner
    showSearchInfo("Suche …");
    try {
      if (!W.api || typeof W.api.searchPlaces !== "function") {
        throw new Error("Suche nicht verfügbar (js/api.js fehlt).");
      }
      const results = await W.api.searchPlaces(query);
      if (seq !== state.searchSeq) return;   // inzwischen wurde weitergetippt
      renderSearchResults(Array.isArray(results) ? results : [], query);
    } catch (err) {
      if (seq !== state.searchSeq) return;
      forgetResults();
      showSearchInfo("Suche fehlgeschlagen: " + ((err && err.message) || "Unbekannter Fehler"));
    }
  }

  /**
   * Trefferliste anzeigen.
   * @param {Array} results  gefundene Orte
   * @param {string} query   Suchbegriff, zu dem die Treffer gehören
   */
  function renderSearchResults(results, query) {
    const ul = $("search-results");
    if (!ul) return;
    state.searchResults = results;
    state.searchQuery = query;
    if (!results.length) {
      showSearchInfo("Keine Orte gefunden.");
      return;
    }
    const items = results.map((place, i) => {
      const li = el("li");
      li.setAttribute("role", "presentation");
      const btn = el("button", "search-result");
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.dataset.index = String(i);
      btn.append(el("span", "search-result-name", place.name || DASH));
      const sub = placeSub(place);
      if (sub) btn.append(el("span", "search-result-sub", sub));
      li.append(btn);
      return li;
    });
    ul.replaceChildren(...items);
    ul.hidden = false;
    $("search-input").setAttribute("aria-expanded", "true");
  }

  /** Einen Treffer übernehmen */
  function choosePlace(place) {
    if (!place) return;
    const input = $("search-input");
    input.value = "";
    input.blur();               // Tastatur auf dem iPhone schließen
    clearTimeout(state.searchTimer);
    state.searchSeq++;          // evtl. noch laufende Suche verwerfen
    closeResults();
    collapseSidebarOnPhone();
    selectPlace(place);
  }

  function onResultsClick(event) {
    const btn = event.target.closest(".search-result");
    if (!btn) return;
    choosePlace(state.searchResults[Number(btn.dataset.index)]);
  }

  /**
   * Enter im Suchfeld: ersten Treffer nehmen bzw. sofort suchen.
   * Übernommen wird nur ein Treffer, der zum JETZT eingegebenen Begriff gehört –
   * nie ein alter Treffer von vorhin.
   */
  function onSearchSubmit(event) {
    event.preventDefault();      // Seite nicht neu laden!
    const query = $("search-input").value.trim();
    if (state.searchResults.length && state.searchQuery === query) {
      choosePlace(state.searchResults[0]);
    } else if (query.length >= 2) {
      clearTimeout(state.searchTimer);
      runSearch(query);
    }
  }

  /** Tastatur: Escape schließt, Pfeiltasten wandern durch die Treffer */
  function onSearchKeydown(event) {
    const buttons = Array.from(document.querySelectorAll("#search-results .search-result"));
    const index = buttons.indexOf(document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      closeResults();
      $("search-input").focus();
    } else if (event.key === "ArrowDown" && buttons.length) {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)].focus();
    } else if (event.key === "ArrowUp" && buttons.length) {
      event.preventDefault();
      if (index <= 0) $("search-input").focus();
      else buttons[index - 1].focus();
    }
  }

  /* ================================================================== */
  /* „Mein Standort“ (GPS)                                                */
  /* ================================================================== */

  /**
   * Fehlercodes der Geolocation-API in hilfreiche deutsche Sätze übersetzen.
   * Hintergrund: Das iPad hat keinen GPS-Chip. Es ortet über WLAN – oder über
   * einen externen Bluetooth-GPS-Empfänger, falls einer verbunden ist.
   */
  function geoErrorText(err) {
    switch (err && err.code) {
      case 1: // PERMISSION_DENIED – Nutzer (oder Einstellungen) erlauben es nicht
        return "Standortzugriff verweigert – in den iOS-Einstellungen unter Chrome/Safari → Standort erlauben.";
      case 2: // POSITION_UNAVAILABLE – keine Ortung möglich (kein WLAN, kein GPS)
        return "Standort nicht ermittelbar – ohne GPS-Chip braucht das iPad WLAN oder einen externen GPS-Empfänger. Nutze sonst die Ortssuche.";
      case 3: // TIMEOUT – hat länger als 20 Sekunden gedauert
        return "Ortung dauert zu lange – bitte erneut versuchen oder Ort suchen.";
      default:
        return "Standort konnte nicht ermittelt werden. Nutze sonst die Ortssuche.";
    }
  }

  /**
   * Darf die Seite überhaupt orten? Browser erlauben das nur in einer
   * „sicheren Umgebung“: https://, localhost oder eine lokale Datei (file://).
   */
  function canUseGeolocation() {
    const proto = location.protocol;
    const host = location.hostname;
    return window.isSecureContext === true ||
      proto === "https:" || proto === "file:" ||
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }

  /** Genauigkeit in Metern → „Genauigkeit ± 35 m“ bzw. „± 2,1 km“ */
  function accuracyText(meters) {
    if (!isNum(meters) || meters <= 0) return "";
    if (meters > 1000) return "Genauigkeit ± " + fmtNum(meters / 1000, 1) + " km";
    return "Genauigkeit ± " + Math.round(meters) + " m";
  }

  const LOCATE_LABEL = "📍 Mein Standort";

  /** Standort-Knopf wieder in den Normalzustand bringen. */
  function resetLocateButton() {
    const btn = $("locate-btn");
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = LOCATE_LABEL;
  }

  /**
   * Eine laufende Ortung „abbestellen“, weil der Nutzer inzwischen selbst
   * einen Ort gewählt hat. Die Ortung selbst lässt sich nicht stoppen – aber
   * durch den neuen Zähler-Stand erkennt ihr Callback später, dass er veraltet
   * ist, und lädt den GPS-Ort dann NICHT mehr.
   */
  function cancelLocate() {
    state.locateSeq++;
    if (state.locateActive) {
      state.locateActive = 0;
      resetLocateButton();
    }
  }

  function onLocate() {
    const btn = $("locate-btn");

    // 1. Kann der Browser überhaupt orten?
    if (!("geolocation" in navigator) || !navigator.geolocation) {
      showError("Dieser Browser kann den Standort nicht bestimmen. Bitte nutze die Ortssuche.");
      return;
    }
    if (!canUseGeolocation()) {
      showError("Ortung ist nur über eine sichere Verbindung (https) möglich. Öffne die App per https:// oder nutze die Ortssuche.");
      return;
    }

    // 2. Diese Ortung bekommt eine eigene Nummer („Token“). Wählt der Nutzer
    //    zwischendurch selbst einen Ort, erhöht cancelLocate() den Zähler –
    //    dann passt die Nummer nicht mehr und das Ergebnis wird verworfen.
    const token = ++state.locateSeq;
    state.locateActive = token;
    const isCurrent = () => token === state.locateSeq;

    // 3. Knopf sperren, solange die Ortung läuft (WLAN/externes GPS kann dauern)
    btn.disabled = true;
    btn.textContent = "📍 Orte …";
    showLoading("Bestimme Standort …");

    // Knopf zurücksetzen – aber nur, wenn nicht schon eine NEUERE Ortung läuft
    const done = () => {
      if (state.locateActive === token) {
        state.locateActive = 0;
        resetLocateButton();
      }
    };

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (!isCurrent()) {        // inzwischen anderer Ort gewählt → nichts tun
          done();
          return;
        }
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;   // 4 Nachkommastellen reichen (~10 m)
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        const accuracy = pos.coords.accuracy;                           // Radius in Metern

        // Ortsnamen ermitteln – klappt das nicht, heißt der Ort „Mein Standort“
        let name = null;
        try {
          if (W.api && typeof W.api.reverseGeocode === "function") name = await W.api.reverseGeocode(lat, lon);
        } catch (err) {
          console.warn("reverseGeocode fehlgeschlagen:", err);
        }
        done();
        // Während wir auf den Ortsnamen gewartet haben, kann der Nutzer einen
        // anderen Ort gewählt haben. Dann darf GPS ihn NICHT überschreiben.
        if (!isCurrent()) return;
        collapseSidebarOnPhone();
        // accuracy ist eine Zusatzangabe nur für die Anzeige in #loc-sub
        loadPlace({ id: "gps", name: name || "Mein Standort", admin1: "", country: "", lat, lon, accuracy });
      },
      (err) => {
        done();
        // Fehlermeldung nur, wenn diese Ortung noch gefragt ist
        if (isCurrent()) showError(geoErrorText(err), onLocate);
      },
      {
        enableHighAccuracy: true,   // externes GPS bzw. beste WLAN-Ortung nutzen
        timeout: 20000,             // 20 s – WLAN-Ortung / Bluetooth-GPS braucht Zeit
        maximumAge: 60000,          // eine bis zu 1 Minute alte Position ist ok
      }
    );
  }

  /* ================================================================== */
  /* Sidebar auf dem iPhone ein-/ausklappen                               */
  /* ================================================================== */

  // Gilt die iPhone-Ansicht (schmaler als 700 px)? – passend zum CSS
  const phoneQuery = window.matchMedia("(max-width: 699px)");

  function setSidebarOpen(open) {
    const sidebar = $("sidebar");
    const toggle = $("sidebar-toggle");
    if (!sidebar || !toggle) return;
    sidebar.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  }

  function collapseSidebarOnPhone() {
    if (phoneQuery.matches) setSidebarOpen(false);
  }

  /* ================================================================== */
  /* Radar (alle Aufrufe abgesichert – die App läuft auch ohne Radar)     */
  /* ================================================================== */

  function radarCall(method, ...args) {
    try {
      if (method !== "init" && !state.radarReady) return;
      if (W.radar && typeof W.radar[method] === "function") W.radar[method](...args);
    } catch (err) {
      console.warn("Radar (" + method + ") fehlgeschlagen:", err);
    }
  }

  function initRadar() {
    try {
      if (W.radar && typeof W.radar.init === "function") {
        W.radar.init("radar-map");
        state.radarReady = true;
      } else {
        const status = $("radar-status");
        if (status) status.textContent = "Radar nicht verfügbar.";
      }
    } catch (err) {
      console.warn("Radar konnte nicht gestartet werden:", err);
      const status = $("radar-status");
      if (status) status.textContent = "Radar konnte nicht gestartet werden.";
    }
  }

  /* ================================================================== */
  /* Start                                                                */
  /* ================================================================== */

  /** Gespeicherten Ort lesen – nur wenn er brauchbar ist (Koordinaten als Zahl) */
  function startPlace() {
    try {
      const last = W.favorites && W.favorites.getLast();
      if (last && isNum(last.lat) && isNum(last.lon)) return last;
    } catch (err) {
      console.warn("favorites.getLast fehlgeschlagen:", err);
    }
    return FALLBACK_PLACE;
  }

  /** Alle Ereignisse (Klicks, Tippen, …) mit ihren Funktionen verbinden */
  function bindEvents() {
    // Suche
    $("search-form").addEventListener("submit", onSearchSubmit);
    $("search-input").addEventListener("input", onSearchInput);
    $("search-form").addEventListener("keydown", onSearchKeydown);
    $("search-results").addEventListener("click", onResultsClick);

    // Klick/Tipp außerhalb der Suche schließt die Trefferliste
    document.addEventListener("pointerdown", (event) => {
      const form = $("search-form");
      if (form && !form.contains(event.target)) closeResults();
    });

    // Standort, Favoriten, Stern
    $("locate-btn").addEventListener("click", onLocate);
    $("favorites-list").addEventListener("click", onFavoritesClick);
    $("fav-toggle").addEventListener("click", onFavToggle);

    // Sidebar ein-/ausklappen (iPhone)
    $("sidebar-toggle").addEventListener("click", () => {
      const open = !$("sidebar").classList.contains("is-open");
      setSidebarOpen(open);
      if (open) $("search-input").focus();
    });

    // Kurve und Stundenleiste gemeinsam seitlich scrollen
    const strip = $("hourly-strip");
    const chart = $("hourly-chart");
    strip.addEventListener("scroll", () => { chart.scrollLeft = strip.scrollLeft; }, { passive: true });
    chart.addEventListener("scroll", () => { strip.scrollLeft = chart.scrollLeft; }, { passive: true });

    // Gerät gedreht / Fenstergröße geändert → Karte neu vermessen.
    // Kleine Verzögerung („Debounce“), weil resize sehr oft hintereinander feuert.
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => radarCall("invalidateSize"), 200);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    // Zurück in den Tab (oder App aus dem Hintergrund) → aktualisieren,
    // wenn die Daten älter als 2 Minuten sind
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - state.lastLoadedAt > REFRESH_ON_RETURN_MS) {
        refresh();
      }
    });

    // Wieder online → neu laden
    window.addEventListener("online", refresh);

    // Alle 15 Minuten aktualisieren (nur wenn die Seite sichtbar ist)
    setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_INTERVAL_MS);
  }

  function start() {
    try {
      bindEvents();
    } catch (err) {
      console.warn("Ereignisse konnten nicht verbunden werden:", err);
    }
    renderFavorites();
    initRadar();
    loadPlace(startPlace());
  }

  // Die Skripte stehen am Ende von <body>, das DOM ist also fertig.
  // Zur Sicherheit trotzdem prüfen.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
