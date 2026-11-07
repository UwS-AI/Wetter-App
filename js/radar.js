/*
 * radar.js – Niederschlagsradar (Leaflet + RainViewer)
 * =====================================================
 *
 * Zeigt im Bereich #radar eine Karte mit animiertem Regenradar.
 *
 * Schnittstelle (siehe docs/ARCHITEKTUR.md):
 *   Wetter.radar.init(containerId)          Karte bauen, Bedienelemente verdrahten
 *   Wetter.radar.setLocation(lat, lon, name, timeZone, utcOffsetSeconds)
 *                                           Karte zentrieren (Zoom 8), Marker setzen,
 *                                           Uhrzeiten in Ortszeit anzeigen
 *   Wetter.radar.setTimeZone(timeZone, utcOffsetSeconds)
 *                                           nur die Zeitzone der Uhrzeiten ändern
 *                                           (Karte bleibt, wo sie ist)
 *   Wetter.radar.invalidateSize()           nach Layoutwechsel (z. B. Gerät gedreht)
 *
 * Benutzte DOM-Elemente:
 *   #radar-map     hier kommt die Karte hinein
 *   #radar-play    Play/Pause-Knopf
 *   #radar-slider  Schieberegler (input type=range) für die Zeit
 *   #radar-time    Uhrzeit des angezeigten Bildes
 *   #radar-status  Hinweis- oder Fehlertext (sonst leer)
 *
 * So funktioniert's (Kurzfassung):
 *   1. Leaflet (globale Variable L) baut die Karte mit OpenStreetMap-Kacheln.
 *   2. Von RainViewer holen wir eine Liste von Radarbildern („Frames“):
 *      gemessene Bilder der Vergangenheit (radar.past) und – falls vorhanden –
 *      eine Kurzprognose (radar.nowcast). Jedes Frame hat {time, path}.
 *   3. Für jedes Frame legen wir eine eigene Kachel-Ebene (L.tileLayer) an
 *      und merken sie uns (Cache). Leaflet lädt für JEDE Ebene auf der Karte
 *      bei jedem Verschieben und Zoomen Kacheln – auch für unsichtbare.
 *      Deshalb liegen nur so wenige Ebenen wie nötig auf der Karte:
 *        - Stillstand (Pause, Slider, Tab versteckt): nur das angezeigte Frame
 *        - Wiedergabe: angezeigtes Frame + das nächste (unsichtbar, lädt vor);
 *          schon gezeigte Frames bleiben unsichtbar liegen, damit ab der
 *          zweiten Runde nichts mehr geladen werden muss
 *        - Verschieben/Zoomen während der Wiedergabe: zurück auf
 *          „angezeigt + nächstes“ (sonst würden alle neu laden)
 *   4. Die Animation schaltet reihum weiter: Das vorgeladene Frame wird
 *      sichtbar (opacity 0.75), das vorige unsichtbar (opacity 0).
 *
 * Klassisches Skript (kein import/export): Alles hängt an window.Wetter.
 */

window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------
  const CONFIG = {
    // Liste der verfügbaren Radarbilder
    framesUrl: "https://api.rainviewer.com/public/weather-maps.json",
    // Hintergrundkarte: die freie Standardkarte von OpenStreetMap.
    // Kein API-Schlüssel nötig. Bedingungen: Quellenangabe anzeigen (siehe
    // baseAttribution) und keine Massenabrufe – für eine private App kein Thema.
    // (Früher: CARTO „Voyager“ – das verlangt inzwischen einen API-Schlüssel
    // und blendet sonst „API KEY REQUIRED“ in die Karte ein.)
    baseUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    baseAttribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    radarAttribution: 'Radar: <a href="https://www.rainviewer.com/api.html">RainViewer</a>',
    // Radar-Kacheln: Größe 256, Farbschema 2, geglättet (1), Schnee anzeigen (1)
    radarTileSuffix: "/256/{z}/{x}/{y}/2/1_1.png",
    // Abdeckungskarte von RainViewer: SCHWARZ = hier gibt es kein Wetterradar.
    // Wir legen sie leicht durchscheinend über die Karte, damit man weltweit
    // sieht, ob „keine Farbe“ trocken bedeutet oder „kein Radar vorhanden“.
    coveragePath: "/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png",
    coverageOpacity: 0.3,
    radarOpacity: 0.75,
    // RainViewer liefert Radar nur bis Zoom 7 scharf. Darüber vergrößert
    // Leaflet die Zoom-7-Kacheln einfach (maxNativeZoom).
    radarMaxNativeZoom: 7,
    startZoom: 8,
    maxZoom: 12,
    minZoom: 3,
    // Mitte Deutschlands, falls noch kein Ort gesetzt ist
    defaultCenter: [51.1657, 10.4515],
    frameDelay: 600, // ms pro Bild in der Animation
    endPause: 1500, // ms Pause auf dem letzten Bild, dann von vorn
    maxLoadWaits: 5, // so oft (à frameDelay) auf ein ladendes Bild warten
    refreshInterval: 10 * 60 * 1000, // Frameliste alle 10 Minuten neu laden
    // Wird die Seite wieder sichtbar und ist der letzte erfolgreiche Abruf
    // älter als das, laden wir die Frameliste sofort neu (sonst sähe man nach
    // langer Pause veraltete Radarbilder).
    staleAfter: 5 * 60 * 1000,
    fetchTimeout: 10000, // 10 s, wie bei Wetter.api
    // Schlägt ein Abruf fehl (z. B. WLAN nach dem Aufwecken noch nicht da),
    // versuchen wir es bald erneut: 30 s, 1 min, 2 min, dann alle 5 min.
    retryDelays: [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000],
    // Ist das neueste gemessene Radarbild älter als das, zeigen wir einen Hinweis.
    oldFrameAfter: 30 * 60 * 1000,
  };

  // ---------------------------------------------------------------------
  // Zustand des Moduls (alles an einer Stelle, damit man es leicht findet)
  // ---------------------------------------------------------------------
  const state = {
    initialized: false, // init() schon gelaufen?
    map: null, // die Leaflet-Karte (oder null, wenn Leaflet fehlt)
    els: {}, // gefundene DOM-Elemente
    host: "", // RainViewer-Server, z. B. "https://tilecache.rainviewer.com"
    frames: [], // [{ time: Sekunden, path, isForecast }]
    layers: new Map(), // path → { layer, loaded, onMap } (Kachel-Ebene je Frame, Cache)
    index: -1, // aktuell angezeigtes Frame
    lastPastIndex: -1, // letztes gemessenes Frame (Startposition)
    playing: false,
    timer: null, // setTimeout der Animation
    waits: 0, // wie oft schon auf ein ladendes Bild gewartet wurde
    refreshTimer: null, // setInterval für das Neuladen der Frameliste
    lastFetchAt: 0, // Zeitpunkt (ms) des letzten ERFOLGREICHEN Abrufs der Frameliste
    fetching: false, // läuft gerade ein Abruf? (verhindert doppelte Abrufe)
    coverageLayer: null, // Ebene „kein Radar hier“ (dunkel), siehe ensureCoverageLayer
    coverageUrl: "", // Adresse dieser Ebene (um Server-Wechsel zu erkennen)
    retryTimer: null, // setTimeout für den nächsten Versuch nach einem Fehler
    retryCount: 0, // wie viele Fehlversuche in Folge
    resumeOnVisible: false, // nach dem Zurückkehren in den Tab weiterspielen?
    location: null, // { lat, lon, name } – auch vor init merken
    timeZone: undefined, // Zeitzonen-Name des Orts, z. B. "Europe/Berlin"
    utcOffsetSeconds: undefined, // Rückfall: fester Abstand zu UTC in Sekunden
    marker: null,
  };

  // ---------------------------------------------------------------------
  // Hilfsfunktionen für Texte
  // ---------------------------------------------------------------------

  /**
   * Uhrzeit „14:20“ aus Unix-Sekunden – in der Ortszeit des Wetterorts, falls
   * Zeitzonen-Name oder Offset bekannt sind, sonst in Gerätezeit.
   * Der Name ("Europe/Berlin") ist besser als der Offset, weil der Browser damit
   * auch die Zeitumstellung (Sommer-/Winterzeit) richtig berücksichtigt.
   */
  function formatClock(seconds) {
    const date = new Date(seconds * 1000);
    const opts = { hour: "2-digit", minute: "2-digit" };
    const api = window.Wetter.api;
    const zone = state.timeZone !== undefined ? state.timeZone : state.utcOffsetSeconds;
    if (zone !== undefined && api && typeof api.formatTime === "function") {
      try {
        return api.formatTime(date, zone, opts, state.utcOffsetSeconds);
      } catch (e) {
        /* weiter mit Gerätezeit */
      }
    }
    return date.toLocaleTimeString("de-DE", opts);
  }

  /** Relativer Abstand zu jetzt: „vor 30 Min.“, „in 20 Min.“, „gerade eben“. */
  function relativeText(seconds) {
    const diffMin = Math.round((seconds * 1000 - Date.now()) / 60000);
    const abs = Math.abs(diffMin);
    if (abs < 3) return "gerade eben";
    let amount;
    if (abs < 60) {
      amount = abs + " Min.";
    } else {
      const h = Math.floor(abs / 60);
      const m = abs % 60;
      amount = h + " Std." + (m ? " " + m + " Min." : "");
    }
    return diffMin < 0 ? "vor " + amount : "in " + amount;
  }

  /** Kompletter Text für das Zeitlabel, z. B. „14:50 · Prognose · in 20 Min.“ */
  function frameLabel(frame) {
    const parts = [formatClock(frame.time)];
    if (frame.isForecast) parts.push("Prognose");
    parts.push(relativeText(frame.time));
    return parts.join(" · ");
  }

  function setStatus(text) {
    if (state.els.status) state.els.status.textContent = text || "";
  }

  // ---------------------------------------------------------------------
  // Bedienelemente (Play-Knopf, Slider, Zeitlabel)
  // ---------------------------------------------------------------------

  /** Play-Knopf passend zum Zustand beschriften (Symbol + Text für VoiceOver). */
  function updatePlayButton() {
    const btn = state.els.play;
    if (!btn) return;
    btn.textContent = state.playing ? "⏸" : "▶";
    btn.setAttribute(
      "aria-label",
      state.playing ? "Radar-Animation anhalten" : "Radar-Animation abspielen"
    );
    btn.setAttribute("aria-pressed", state.playing ? "true" : "false");
  }

  /** Bedienelemente an- oder abschalten (z. B. wenn es keine Frames gibt). */
  function setControlsEnabled(enabled) {
    if (state.els.play) state.els.play.disabled = !enabled;
    if (state.els.slider) state.els.slider.disabled = !enabled;
  }

  /** Slider-Grenzen an die Anzahl der Frames anpassen. */
  function updateSliderRange() {
    const slider = state.els.slider;
    if (!slider) return;
    slider.min = "0";
    slider.max = String(Math.max(0, state.frames.length - 1));
    slider.step = "1";
  }

  // ---------------------------------------------------------------------
  // Frames anzeigen
  // ---------------------------------------------------------------------

  /** Kachel-Ebene (und Ladezustand) für ein Frame holen. */
  function entryFor(i) {
    const frame = state.frames[i];
    return frame ? state.layers.get(frame.path) : null;
  }

  /** Nummer des Frames, das in der Animation nach Frame i kommt (am Ende: 0). */
  function nextIndex(i) {
    return i + 1 >= state.frames.length ? 0 : i + 1;
  }

  /** Ebene auf die Karte legen (falls noch nicht dort). */
  function addEntry(entry) {
    if (entry.onMap || !state.map) return;
    entry.onMap = true;
    entry.loaded = false;
    entry.sawLoading = false;
    entry.layer.addTo(state.map);
    // Leaflet meldet „loading“ sofort beim Hinzufügen, wenn Kacheln zu laden
    // sind. Wurde die Ebene früher mitten im Laden entfernt, meldet Leaflet
    // das nicht noch einmal, sagt es aber über isLoading(). Lädt laut beiden
    // nichts (z. B. Karte gerade ohne Größe), gibt es auch nichts abzuwarten –
    // dann gilt die Ebene als fertig, damit die Animation nicht hängt.
    const busy =
      entry.sawLoading ||
      (typeof entry.layer.isLoading === "function" && entry.layer.isLoading());
    if (!busy) entry.loaded = true;
  }

  /** Ebene von der Karte nehmen. Das Objekt bleibt im Cache für später. */
  function removeEntry(entry) {
    if (!entry.onMap) return;
    entry.onMap = false;
    entry.loaded = false;
    if (state.map) state.map.removeLayer(entry.layer);
  }

  /**
   * Dafür sorgen, dass die richtigen Ebenen auf der Karte liegen:
   *   - immer das angezeigte Frame (sichtbar, opacity 0.75)
   *   - während die Animation läuft zusätzlich das nächste Frame
   *     (unsichtbar, opacity 0) – es lädt schon vor
   *   - während die Animation läuft, BLEIBEN außerdem alle Ebenen, die in
   *     dieser Runde schon gezeigt wurden, unsichtbar auf der Karte. Ihre
   *     Kacheln sind dann schon da: Ab der zweiten Runde läuft die Animation
   *     ohne neue Kachelanfragen und ohne kurzes Leerbild.
   * trim = true (bzw. keine Animation): alles außer „angezeigt“ (+ „nächstes“
   * beim Abspielen) von der Karte nehmen. Steht die Animation, liegt also nur
   * EINE Ebene auf der Karte – Leaflet lädt nur für Ebenen auf der Karte
   * Kacheln, beim Verschieben/Zoomen also nur für diese eine.
   */
  function syncLayers(trim) {
    const wanted = new Map(); // Ebenen-Eintrag → gewünschte Deckkraft
    const cur = entryFor(state.index);
    if (cur) wanted.set(cur, CONFIG.radarOpacity);
    if (state.playing && state.frames.length > 1) {
      const next = entryFor(nextIndex(state.index));
      if (next && !wanted.has(next)) wanted.set(next, 0);
    }
    const keepOthers = state.playing && !trim;
    state.layers.forEach((entry) => {
      if (wanted.has(entry)) return;
      if (keepOthers && entry.onMap) entry.layer.setOpacity(0); // bleibt, unsichtbar
      else removeEntry(entry);
    });
    // Gewünschte hinzufügen bzw. Deckkraft setzen.
    wanted.forEach((opacity, entry) => {
      entry.layer.setOpacity(opacity);
      addEntry(entry);
    });
  }

  /**
   * Karte wird verschoben oder gezoomt, während die Animation läuft: Jetzt
   * müssten ALLE Ebenen auf der Karte neue Kacheln laden. Sparsamer: auf
   * „angezeigt + nächstes“ reduzieren; die übrigen werden in der nächsten
   * Runde nach und nach wieder hinzugefügt.
   */
  function onMapMoveStart() {
    if (state.playing) syncLayers(true);
  }

  /** Frame Nummer i anzeigen (Ebene sichtbar), Zeitlabel und Slider setzen. */
  function showFrame(i) {
    if (i < 0 || i >= state.frames.length) return;
    state.index = i;
    syncLayers();

    const label = frameLabel(state.frames[i]);
    if (state.els.time) state.els.time.textContent = label;
    if (state.els.slider) {
      state.els.slider.value = String(i);
      state.els.slider.setAttribute("aria-valuetext", label);
    }
  }

  // ---------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------

  /** Nächsten Animationsschritt einplanen. */
  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(step, delay);
  }

  /** Ein Animationsschritt: zum nächsten Frame weiterschalten. */
  function step() {
    if (!state.playing || state.frames.length === 0) return;
    // Nach dem letzten Bild geht es wieder vorne los.
    const next = nextIndex(state.index);

    // Lädt das nächste Bild noch? Dann kurz warten statt ein leeres Bild
    // zu zeigen (das würde flackern). Nach ein paar Versuchen trotzdem
    // weiter, damit ein kaputtes Bild die Animation nicht blockiert.
    const entry = entryFor(next);
    if (entry && !entry.loaded && state.waits < CONFIG.maxLoadWaits) {
      state.waits++;
      schedule(CONFIG.frameDelay);
      return;
    }
    state.waits = 0;
    showFrame(next);
    // Auf dem letzten Bild etwas länger stehen bleiben.
    schedule(next === state.frames.length - 1 ? CONFIG.endPause : CONFIG.frameDelay);
  }

  function play() {
    if (state.playing || state.frames.length < 2) return;
    state.playing = true;
    state.waits = 0;
    updatePlayButton();
    syncLayers(); // nächstes Frame schon jetzt zum Vorladen auf die Karte
    // Steht man gerade am Ende, nach der Pause von vorn beginnen.
    schedule(state.index >= state.frames.length - 1 ? CONFIG.endPause / 2 : CONFIG.frameDelay);
  }

  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    state.timer = null;
    updatePlayButton();
    syncLayers(true); // ohne Animation: nur noch die angezeigte Ebene
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  /** Tab im Hintergrund → anhalten (spart Akku und Datenvolumen). */
  function onVisibilityChange() {
    if (document.hidden) {
      state.resumeOnVisible = state.playing;
      pause();
    } else {
      // Wieder sichtbar: Zeiten aktualisieren und ggf. weiterspielen.
      if (state.index >= 0) showFrame(state.index);
      if (state.resumeOnVisible) play();
      state.resumeOnVisible = false;
      // Während die Seite versteckt war, lief der 10-Minuten-Takt nicht
      // (siehe init). Ist der letzte Abruf schon länger her, jetzt sofort
      // neue Bilder holen. loadFrames merkt sich, ob die Animation lief,
      // und spielt danach weiter.
      if (Date.now() - state.lastFetchAt > CONFIG.staleAfter) loadFrames();
    }
  }

  // ---------------------------------------------------------------------
  // RainViewer-Daten laden
  // ---------------------------------------------------------------------

  /** fetch mit Zeitlimit (AbortController), liefert das JSON. */
  async function fetchJson(url) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), CONFIG.fetchTimeout) : null;
    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Antwort von RainViewer prüfen und in unsere Frameliste umwandeln. */
  function parseFrames(data) {
    const valid = (f) => f && typeof f.time === "number" && typeof f.path === "string";
    const radar = (data && data.radar) || {};
    const past = (Array.isArray(radar.past) ? radar.past : []).filter(valid);
    const nowcast = (Array.isArray(radar.nowcast) ? radar.nowcast : []).filter(valid);
    return {
      host: data && typeof data.host === "string" ? data.host : "",
      frames: past
        .map((f) => ({ time: f.time, path: f.path, isForecast: false }))
        .concat(nowcast.map((f) => ({ time: f.time, path: f.path, isForecast: true }))),
      pastCount: past.length,
    };
  }

  /**
   * Abdeckungsebene („hier gibt es kein Radar“) einmalig auf die Karte legen.
   * Sie hängt nur vom RainViewer-Server ab, nicht vom einzelnen Radarbild.
   */
  function ensureCoverageLayer() {
    if (!state.map || !state.host) return;
    const url = state.host + CONFIG.coveragePath;
    // Schon vorhanden und vom selben Server? Dann nichts tun.
    if (state.coverageLayer && state.coverageUrl === url) return;
    if (state.coverageLayer) state.map.removeLayer(state.coverageLayer);
    state.coverageUrl = url;
    state.coverageLayer = L.tileLayer(url, {
      opacity: CONFIG.coverageOpacity,
      zIndex: 5, // über der Grundkarte, unter den Radarbildern (zIndex 10)
      tileSize: 256,
      maxNativeZoom: CONFIG.radarMaxNativeZoom,
      maxZoom: CONFIG.maxZoom,
    }).addTo(state.map);
  }

  /**
   * Kachel-Ebene für ein Frame anlegen – nur das Objekt, noch NICHT auf der
   * Karte (dann lädt es auch nichts). Auf die Karte kommt es erst über
   * syncLayers, wenn es angezeigt oder vorgeladen werden soll.
   */
  function createLayer(frame) {
    const layer = L.tileLayer(state.host + frame.path + CONFIG.radarTileSuffix, {
      opacity: 0,
      zIndex: 10,
      tileSize: 256,
      maxNativeZoom: CONFIG.radarMaxNativeZoom,
      maxZoom: CONFIG.maxZoom,
      attribution: CONFIG.radarAttribution,
    });
    const entry = { layer: layer, loaded: false, onMap: false, sawLoading: false };
    // „loading“: Leaflet beginnt Kacheln zu laden (auch nach Verschieben der Karte),
    // „load“: alle sichtbaren Kacheln dieser Ebene sind da.
    layer.on("loading", () => {
      entry.loaded = false;
      entry.sawLoading = true;
    });
    layer.on("load", () => (entry.loaded = true));
    return entry;
  }

  /**
   * Frameliste laden (beim Start und dann alle 10 Minuten).
   * Bereits vorhandene Ebenen werden weiterverwendet, veraltete entfernt.
   */
  async function loadFrames() {
    if (!state.map || state.fetching) return; // kein Doppel-Abruf
    let parsed;
    state.fetching = true;
    try {
      parsed = parseFrames(await fetchJson(CONFIG.framesUrl));
    } catch (err) {
      // Gibt es schon Bilder, bleiben die stehen – nur ein Hinweis.
      setStatus(
        state.frames.length
          ? "Radar konnte nicht aktualisiert werden – neuer Versuch folgt"
          : "Radar momentan nicht erreichbar – neuer Versuch folgt"
      );
      if (!state.frames.length) setControlsEnabled(false);
      scheduleRetry();
      return;
    } finally {
      // „finally“ läuft immer – auch nach dem return oben.
      state.fetching = false;
    }
    if (!parsed.host || parsed.frames.length === 0) {
      if (!state.frames.length) {
        setStatus("Keine Radardaten verfügbar");
        setControlsEnabled(false);
      }
      return;
    }

    // Ab hier haben wir eine brauchbare, frische Liste.
    state.lastFetchAt = Date.now();
    cancelRetry();

    // Merken, was gerade angezeigt wird, um die Position zu behalten.
    const wasAtLastPast = state.index === state.lastPastIndex;
    const currentTime = state.index >= 0 ? state.frames[state.index].time : null;
    const wasPlaying = state.playing;
    pause();

    // Hat sich der Server geändert, alle alten Ebenen verwerfen.
    if (parsed.host !== state.host) {
      state.layers.forEach(removeEntry);
      state.layers.clear();
    }
    state.host = parsed.host;
    ensureCoverageLayer();

    // Nicht mehr benötigte Ebenen entfernen, neue anlegen (noch nicht auf die
    // Karte – das erledigt showFrame unten über syncLayers).
    const neededPaths = new Set(parsed.frames.map((f) => f.path));
    state.layers.forEach((entry, path) => {
      if (!neededPaths.has(path)) {
        removeEntry(entry);
        state.layers.delete(path);
      }
    });
    state.frames = parsed.frames;
    state.frames.forEach((f) => {
      if (!state.layers.has(f.path)) state.layers.set(f.path, createLayer(f));
    });

    // Startposition: letztes GEMESSENES Bild (nicht die Prognose).
    state.lastPastIndex = parsed.pastCount > 0 ? parsed.pastCount - 1 : 0;
    let target = state.lastPastIndex;
    if (!wasAtLastPast && currentTime !== null) {
      const same = state.frames.findIndex((f) => f.time === currentTime);
      if (same >= 0) target = same;
    }
    state.index = -1;
    updateSliderRange();
    setControlsEnabled(true);
    if (state.els.play) state.els.play.disabled = state.frames.length < 2;
    showFrame(target);
    setStatus(oldFrameHint());
    if (wasPlaying) play();
  }

  /**
   * Hinweistext, falls selbst das NEUESTE gemessene Bild schon alt ist
   * (z. B. Störung bei RainViewer). Sonst leerer Text.
   */
  function oldFrameHint() {
    const last = state.frames[state.lastPastIndex];
    if (!last) return "";
    const ageMs = Date.now() - last.time * 1000;
    if (ageMs < CONFIG.oldFrameAfter) return "";
    return "Hinweis: Das neueste Radarbild ist schon " + Math.round(ageMs / 60000) + " Min. alt.";
  }

  /** Nach einem Fehler den nächsten Versuch planen (immer nur EIN Timer). */
  function scheduleRetry() {
    if (state.retryTimer) return;
    const delays = CONFIG.retryDelays;
    const delay = delays[Math.min(state.retryCount, delays.length - 1)];
    state.retryCount++;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      // Versteckte Seite: nicht abrufen – das erledigt onVisibilityChange,
      // sobald die Seite wieder sichtbar ist (letzter Erfolg ist dann „alt“).
      if (!document.hidden) loadFrames();
    }, delay);
  }

  /** Geplanten Wiederholungsversuch verwerfen (nach einem Erfolg). */
  function cancelRetry() {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryCount = 0;
  }

  /** Internet ist wieder da (z. B. WLAN nach dem Aufwecken) → sofort neu laden. */
  function onOnline() {
    if (document.hidden) return;
    if (Date.now() - state.lastFetchAt > CONFIG.staleAfter || !state.frames.length) loadFrames();
  }

  // ---------------------------------------------------------------------
  // Karte, Marker, Legende, Fallback
  // ---------------------------------------------------------------------

  /** Freundlicher Hinweis, wenn Leaflet nicht geladen werden konnte. */
  function showFallback(mapEl) {
    if (mapEl) {
      mapEl.innerHTML = "";
      const hint = document.createElement("div");
      hint.className = "radar-fallback";
      hint.setAttribute("role", "note");
      hint.textContent =
        "Radarkarte konnte nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden.";
      // Minimal-Styling direkt am Element, damit es ohne eigenes CSS gut aussieht.
      hint.style.cssText =
        "display:flex;align-items:center;justify-content:center;text-align:center;" +
        "height:100%;min-height:120px;padding:16px;box-sizing:border-box;" +
        "font-size:14px;line-height:1.4;opacity:0.85;";
      mapEl.appendChild(hint);
    }
    setControlsEnabled(false);
    if (state.els.time) state.els.time.textContent = "";
    setStatus("");
  }

  /**
   * Farblegende „leicht → stark“ unter der Karte einfügen.
   * Die Farben entsprechen ungefähr RainViewer-Farbschema 2 („Universal Blue“):
   * hellblau = leichter Regen … gelb/orange … rot/violett = sehr starker Regen.
   */
  function addLegend(mapEl) {
    const parent = mapEl && mapEl.parentNode;
    if (!parent || parent.querySelector(".radar-legend")) return; // nicht doppelt
    const legend = document.createElement("div");
    legend.className = "radar-legend";
    legend.setAttribute("aria-hidden", "true"); // rein optisch
    legend.style.cssText =
      "display:flex;align-items:center;gap:8px;margin:6px 0 2px;font-size:12px;opacity:0.85;";

    const low = document.createElement("span");
    low.className = "radar-legend-label";
    low.textContent = "leicht";
    const bar = document.createElement("span");
    bar.className = "radar-legend-bar";
    bar.style.cssText =
      "flex:1;height:8px;border-radius:4px;" +
      "background:linear-gradient(90deg,#88ddee,#0099cc,#005588,#ffee00,#ffaa00,#ff4400,#c10000,#ff77ff);";
    const high = document.createElement("span");
    high.className = "radar-legend-label";
    high.textContent = "stark";

    // Zusätzlich: Kästchen „dunkel = kein Radar“ (passt zur Abdeckungsebene)
    const noRadar = document.createElement("span");
    noRadar.className = "radar-legend-label";
    noRadar.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:6px;";
    const swatch = document.createElement("span");
    swatch.style.cssText =
      "width:12px;height:12px;border-radius:3px;background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.4);";
    noRadar.append(swatch, document.createTextNode("kein Radar"));

    legend.append(low, bar, high, noRadar);
    parent.insertBefore(legend, mapEl.nextSibling); // direkt unter die Karte
  }

  /** Marker und Kartenausschnitt für den gespeicherten Ort setzen. */
  function applyLocation() {
    const loc = state.location;
    if (!state.map || !loc) return;
    const latlng = [loc.lat, loc.lon];
    // Sicherheit: Leaflet würde einen Text-Tooltip als HTML deuten. Ein Ortsname
    // aus dem Internet könnte so Schadcode einschleusen. Deshalb bauen wir ein
    // <span> und setzen den Namen per textContent – das ist immer nur Text.
    const label = document.createElement("span");
    label.textContent = loc.name || "Standort";
    if (!state.marker) {
      // Gut sichtbarer Punkt: weißer Rand, kräftige Füllung.
      state.marker = L.circleMarker(latlng, {
        radius: 8,
        color: "#ffffff",
        weight: 3,
        fillColor: "#ff3b30",
        fillOpacity: 1,
      }).addTo(state.map);
      // Dauerhaft sichtbarer Tooltip – auf dem iPad gibt es kein „Hover“.
      state.marker.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -10] });
    } else {
      state.marker.setLatLng(latlng);
      state.marker.setTooltipContent(label);
    }
    state.map.setView(latlng, CONFIG.startZoom);
  }

  // ---------------------------------------------------------------------
  // Öffentliche Funktionen
  // ---------------------------------------------------------------------

  /**
   * Karte bauen und Bedienelemente verdrahten. Mehrfacher Aufruf schadet nicht.
   * @param {string} [containerId] "radar" oder "radar-map" – beides geht.
   */
  function init(containerId) {
    if (state.initialized) {
      invalidateSize();
      return;
    }
    state.initialized = true;

    // Kartenelement finden: entweder ist containerId selbst #radar-map,
    // oder #radar-map liegt darin (bzw. irgendwo im Dokument).
    const root = containerId ? document.getElementById(containerId) : null;
    const mapEl =
      (root && root.id === "radar-map" && root) ||
      (root && root.querySelector("#radar-map")) ||
      document.getElementById("radar-map") ||
      root;

    state.els = {
      map: mapEl,
      play: document.getElementById("radar-play"),
      slider: document.getElementById("radar-slider"),
      time: document.getElementById("radar-time"),
      status: document.getElementById("radar-status"),
    };
    updatePlayButton();

    // Ohne Leaflet keine Karte – Hinweis zeigen, aber NICHT abstürzen.
    if (typeof L === "undefined" || !L || typeof L.map !== "function" || !mapEl) {
      showFallback(mapEl);
      return;
    }

    try {
      const loc = state.location;
      state.map = L.map(mapEl, {
        center: loc ? [loc.lat, loc.lon] : CONFIG.defaultCenter,
        zoom: CONFIG.startZoom,
        minZoom: CONFIG.minZoom,
        maxZoom: CONFIG.maxZoom,
        zoomControl: true,
        attributionControl: true,
      });
      // Verschieben/Zoomen während der Wiedergabe → Ebenen reduzieren
      state.map.on("movestart", onMapMoveStart);
      state.map.on("zoomstart", onMapMoveStart);
      L.tileLayer(CONFIG.baseUrl, {
        maxZoom: CONFIG.maxZoom,
        attribution: CONFIG.baseAttribution,
      }).addTo(state.map);
    } catch (err) {
      console.error("Radarkarte:", err);
      state.map = null;
      showFallback(mapEl);
      return;
    }

    addLegend(mapEl);
    applyLocation(); // falls setLocation schon vorher aufgerufen wurde

    // Bedienelemente verdrahten
    setControlsEnabled(false); // erst wenn Frames da sind
    if (state.els.play) state.els.play.addEventListener("click", togglePlay);
    if (state.els.slider) {
      state.els.slider.addEventListener("input", () => {
        pause(); // wer schiebt, will selbst steuern
        showFrame(Number(state.els.slider.value));
      });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);

    // Frames laden und alle 10 Minuten aktualisieren (nur EIN Intervall).
    setStatus("Radar wird geladen …");
    loadFrames();
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        if (!document.hidden) loadFrames();
      }, CONFIG.refreshInterval);
    }
  }

  /**
   * Zeitzone für die Uhrzeiten merken (ohne Karte und Marker anzufassen).
   * Gibt man als 1. Wert eine ZAHL an, gilt sie als Offset in Sekunden –
   * so funktionieren auch ältere Aufrufe wie setLocation(lat, lon, name, 3600).
   */
  function storeTimeZone(timeZone, utcOffsetSeconds) {
    const isNum = (v) => typeof v === "number" && isFinite(v);
    if (isNum(timeZone)) {
      utcOffsetSeconds = timeZone;
      timeZone = undefined;
    }
    state.timeZone = typeof timeZone === "string" && timeZone ? timeZone : undefined;
    state.utcOffsetSeconds = isNum(utcOffsetSeconds) ? utcOffsetSeconds : undefined;
  }

  /**
   * Ort setzen: Karte zentrieren (Zoom 8) und Marker setzen.
   * Darf auch VOR init aufgerufen werden – dann wird der Ort gemerkt.
   * Fehlen timeZone und utcOffsetSeconds, erscheinen die Uhrzeiten in Gerätezeit.
   * @param {number} lat
   * @param {number} lon
   * @param {string} [name]               Ortsname für den Tooltip
   * @param {string|number} [timeZone]    Zeitzonen-Name des Orts, z. B. "Europe/Berlin"
   *                                      (eine Zahl wird als Offset in Sekunden verstanden)
   * @param {number} [utcOffsetSeconds]   Rückfall, falls der Browser den Namen nicht kennt
   */
  function setLocation(lat, lon, name, timeZone, utcOffsetSeconds) {
    if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) return;
    state.location = { lat: lat, lon: lon, name: name || "" };
    storeTimeZone(timeZone, utcOffsetSeconds);
    try {
      applyLocation();
      if (state.index >= 0) showFrame(state.index); // Uhrzeit ggf. in Ortszeit
    } catch (err) {
      console.error("Radar setLocation:", err);
    }
  }

  /**
   * Nur die Zeitzone der Uhrzeiten setzen – die Karte bleibt, wo sie ist.
   * Gedacht für das erneute Laden desselben Orts (z. B. „Erneut versuchen“
   * oder Auto-Aktualisierung): Hat der Nutzer die Karte verschoben, springt
   * sie dadurch nicht zurück.
   * @param {string|number} [timeZone]    Zeitzonen-Name oder Offset in Sekunden
   * @param {number} [utcOffsetSeconds]   Rückfall-Offset in Sekunden
   */
  function setTimeZone(timeZone, utcOffsetSeconds) {
    storeTimeZone(timeZone, utcOffsetSeconds);
    try {
      if (state.index >= 0) showFrame(state.index); // Zeitlabel neu schreiben
    } catch (err) {
      console.error("Radar setTimeZone:", err);
    }
  }

  /** Nach Größenänderung des Containers die Karte neu vermessen lassen. */
  function invalidateSize() {
    if (state.map) state.map.invalidateSize();
  }

  window.Wetter.radar = {
    init: init,
    setLocation: setLocation,
    setTimeZone: setTimeZone,
    invalidateSize: invalidateSize,
  };
})();
