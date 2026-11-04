/*
 * nowcast.js – „Regen in ca. X Minuten“
 * ======================================
 *
 * Dieses Modul wertet die 15-Minuten-Niederschlagsdaten von Open-Meteo aus
 * (Feld `minutely` aus Wetter.api.fetchForecast) und macht daraus einen
 * fertigen deutschen Satz für den Bereich #nowcast, z. B.
 *   „Regen in ca. 30 Min. (ab 14:45)“
 *   „Es regnet – voraussichtlich bis ca. 15:30“
 *
 * Schnittstelle (siehe docs/ARCHITEKTUR.md):
 *   Wetter.nowcast.analyze(minutely, now = new Date(), utcOffsetSeconds)
 *     → { state, text, minutesUntilChange, maxIntensity, available, changeTime }
 *   Wetter.nowcast.intensityLabel(mmPer15) → "leicht" | "mäßig" | "stark"
 *
 * Klassisches Skript (kein import/export): Alles hängt an window.Wetter.
 *
 * ---------------------------------------------------------------------------
 * WICHTIGE ANNAHME: Welchen Zeitraum beschreibt ein 15-Minuten-Eintrag?
 * ---------------------------------------------------------------------------
 * Laut Open-Meteo-Dokumentation ist `precipitation` eine Summe über den
 * VORANGEHENDEN Zeitraum („sum of the preceding hour“ bei stündlichen Daten,
 * entsprechend „preceding 15 minutes“ bei `minutely_15`).
 * Ein Eintrag mit time = 14:45 beschreibt also den Regen von 14:30 bis 14:45,
 * d. h. das Intervall [time − 15 min, time).
 *
 * Diese Annahme steckt in der Konstante PERIOD_ENDS_AT_TIME. Falls sich
 * herausstellt, dass es umgekehrt ist ([time, time + 15 min)), muss man nur
 * diese eine Konstante auf `false` setzen.
 */

window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------

  /** Ab dieser Menge (mm pro 15 min) gilt ein Zeitabschnitt als „nass“. */
  const WET_THRESHOLD = 0.1;

  /** Länge eines Zeitabschnitts in Millisekunden (15 Minuten). */
  const STEP_MS = 15 * 60 * 1000;

  /**
   * true  → Eintrag beschreibt [time − 15 min, time)   (Open-Meteo-Konvention)
   * false → Eintrag beschreibt [time, time + 15 min)
   */
  const PERIOD_ENDS_AT_TIME = true;

  /**
   * Grenzen für intensityLabel in mm pro 15 Minuten.
   * Übliche Einteilung pro Stunde: leicht < 2,5 mm/h, mäßig bis 7,6 mm/h,
   * darüber stark. Geteilt durch 4 ergibt das die Werte pro 15 Minuten.
   */
  const LIGHT_MAX = 2.5 / 4; //  ≈ 0,63 mm / 15 min
  const MODERATE_MAX = 7.6 / 4; // = 1,9  mm / 15 min

  // ---------------------------------------------------------------------
  // Kleine Hilfsfunktionen
  // ---------------------------------------------------------------------

  /** Ist dieser Niederschlagswert „nass“? (null/undefined/NaN zählen als trocken) */
  function isWet(precip) {
    return typeof precip === "number" && !Number.isNaN(precip) && precip >= WET_THRESHOLD;
  }

  /**
   * Wandelt verschiedene Zeitformate robust in ein Date um:
   * Date-Objekt, Unix-Sekunden, Millisekunden oder ISO-Text.
   * Gibt null zurück, wenn es keine gültige Zeit ist.
   */
  function toDate(value) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === "number") {
      // Kleine Zahlen sind (sehr wahrscheinlich) Unix-Sekunden.
      const ms = value < 1e11 ? value * 1000 : value;
      return new Date(ms);
    }
    if (typeof value === "string" && value) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /** Rundet Minuten auf ganze 5 Minuten (z. B. 33 → 35, 32 → 30). */
  function roundTo5(minutes) {
    return Math.max(0, Math.round(minutes / 5) * 5);
  }

  /**
   * Formatiert eine Uhrzeit als „14:45“.
   * Bevorzugt Wetter.api.formatTime (zeigt die Ortszeit des Wetterorts),
   * sonst die Gerätezeit über toLocaleTimeString.
   */
  function formatClock(date, utcOffsetSeconds) {
    const opts = { hour: "2-digit", minute: "2-digit" };
    const api = window.Wetter && window.Wetter.api;
    if (api && typeof api.formatTime === "function") {
      try {
        return api.formatTime(date, utcOffsetSeconds, opts);
      } catch (e) {
        // Falls formatTime scheitert, einfach unten weitermachen.
      }
    }
    return date.toLocaleTimeString("de-DE", opts);
  }

  /**
   * Macht aus Minuten einen kurzen Text:
   *   35  → „ca. 35 Min.“
   *   60  → „ca. 1 Std.“
   *   150 → „ca. 2 Std. 30 Min.“
   */
  function durationText(minutes) {
    if (minutes < 60) return "ca. " + minutes + " Min.";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return "ca. " + h + " Std." + (m ? " " + m + " Min." : "");
  }

  /**
   * Text für den Vorhersage-Zeitraum, z. B. „den nächsten 3 Stunden“.
   * (Wird in „Kein Niederschlag in …“ und „hält mindestens … an“ benutzt.)
   */
  function horizonText(horizonMinutes, forDuration) {
    // Auf halbe Stunden runden, damit z. B. 172 Minuten zu „3 Stunden“ werden.
    const hours = Math.round(horizonMinutes / 30) / 2;
    if (hours >= 1.5) {
      const h = String(hours).replace(".", ",");
      return forDuration ? h + " Stunden" : "den nächsten " + h + " Stunden";
    }
    if (hours >= 1) {
      return forDuration ? "1 Stunde" : "der nächsten Stunde";
    }
    const m = Math.max(15, roundTo5(horizonMinutes));
    return forDuration ? m + " Minuten" : "den nächsten " + m + " Minuten";
  }

  /** Ergebnis, wenn es keine (brauchbaren) Daten gibt. */
  function unavailable() {
    return {
      state: "dry",
      text: "Keine Kurzfristprognose verfügbar",
      minutesUntilChange: null,
      maxIntensity: 0,
      available: false,
      changeTime: null,
    };
  }

  // ---------------------------------------------------------------------
  // Hauptfunktion
  // ---------------------------------------------------------------------

  /**
   * Wertet die 15-Minuten-Daten aus.
   *
   * @param {Array<{time: Date, precip: number|null}>} minutely  Daten aus Wetter.api
   * @param {Date}   [now=new Date()]        „Jetzt“ (für Tests änderbar)
   * @param {number} [utcOffsetSeconds]      Zeitzonen-Versatz des Wetterorts
   * @returns {{state: string, text: string, minutesUntilChange: number|null,
   *            maxIntensity: number, available: boolean, changeTime: Date|null}}
   *
   * state:
   *   "dry"      – kein Niederschlag im ganzen Zeitraum
   *   "starting" – jetzt trocken, Regen kommt
   *   "raining"  – es regnet und hört im Zeitraum nicht auf
   *   "stopping" – es regnet, hört aber im Zeitraum auf
   */
  function analyze(minutely, now, utcOffsetSeconds) {
    const nowDate = toDate(now) || new Date();
    const nowMs = nowDate.getTime();

    if (!Array.isArray(minutely) || minutely.length === 0) {
      return unavailable();
    }

    // 1) Daten aufbereiten: jedem Eintrag Start und Ende seines Intervalls
    //    geben, ungültige Einträge weglassen, nach Zeit sortieren.
    const slots = [];
    for (const entry of minutely) {
      if (!entry) continue;
      const t = toDate(entry.time);
      if (!t) continue;
      const end = PERIOD_ENDS_AT_TIME ? t.getTime() : t.getTime() + STEP_MS;
      const precip =
        typeof entry.precip === "number" && !Number.isNaN(entry.precip) ? entry.precip : null;
      slots.push({ start: end - STEP_MS, end: end, precip: precip });
    }
    slots.sort((a, b) => a.start - b.start);

    // 2) Nur Abschnitte, die noch nicht vorbei sind (Ende liegt nach „jetzt“).
    const upcoming = slots.filter((s) => s.end > nowMs);

    // Keine zukünftigen Daten, oder alle Werte fehlen (null) → nichts sagen.
    if (upcoming.length === 0 || upcoming.every((s) => s.precip === null)) {
      return unavailable();
    }

    // Stärkster Wert im Zeitraum (mm pro 15 min), auf 2 Nachkommastellen.
    const maxIntensity =
      Math.round(Math.max(0, ...upcoming.map((s) => s.precip || 0)) * 100) / 100;

    // Wie weit reicht die Vorhersage ab jetzt? (für „in den nächsten 3 Stunden“)
    const horizonMin = (upcoming[upcoming.length - 1].end - nowMs) / 60000;

    // Regnet es JETZT? Dafür muss der erste Abschnitt „jetzt“ enthalten
    // (Start ≤ jetzt) und nass sein.
    const first = upcoming[0];
    const wetNow = first.start <= nowMs && isWet(first.precip);

    // Hilfsfunktion: fertiges Ergebnis-Objekt bauen.
    function result(state, text, changeMs) {
      const hasChange = typeof changeMs === "number";
      return {
        state: state,
        text: text,
        minutesUntilChange: hasChange ? roundTo5((changeMs - nowMs) / 60000) : null,
        maxIntensity: maxIntensity,
        available: true,
        changeTime: hasChange ? new Date(changeMs) : null,
      };
    }

    if (!wetNow) {
      // --- Fall A: Jetzt trocken. Kommt Regen? ---------------------------
      const firstWet = upcoming.find((s) => isWet(s.precip));
      if (!firstWet) {
        return result("dry", "Kein Niederschlag in " + horizonText(horizonMin, false), null);
      }
      // Beginn des nassen Abschnitts (frühestens „jetzt“).
      const startMs = Math.max(firstWet.start, nowMs);
      const minutes = roundTo5((startMs - nowMs) / 60000);
      const clock = formatClock(new Date(startMs), utcOffsetSeconds);
      const text =
        minutes < 10
          ? "Regen in wenigen Minuten (ab " + clock + ")"
          : "Regen in " + durationText(minutes) + " (ab " + clock + ")";
      return result("starting", text, startMs);
    }

    // --- Fall B: Es regnet jetzt. Hört es auf? -----------------------------
    // Gesucht: der erste trockene Abschnitt nach dem aktuellen.
    // (null-Werte zählen hier als „trocken“ – fehlende Daten sind selten.)
    const firstDry = upcoming.find((s, i) => i > 0 && !isWet(s.precip));
    if (!firstDry) {
      return result(
        "raining",
        "Es regnet – hält mindestens " + horizonText(horizonMin, true) + " an",
        null
      );
    }
    const stopMs = firstDry.start;
    const minutes = roundTo5((stopMs - nowMs) / 60000);
    const clock = formatClock(new Date(stopMs), utcOffsetSeconds);
    const text =
      minutes < 10
        ? "Es regnet – hört in wenigen Minuten auf (ca. " + clock + ")"
        : "Es regnet – voraussichtlich bis ca. " + clock;
    return result("stopping", text, stopMs);
  }

  /**
   * Beschreibt die Stärke des Niederschlags in Worten.
   * @param {number} mmPer15  Millimeter pro 15 Minuten
   * @returns {"leicht"|"mäßig"|"stark"}
   */
  function intensityLabel(mmPer15) {
    const v = typeof mmPer15 === "number" && !Number.isNaN(mmPer15) ? mmPer15 : 0;
    if (v < LIGHT_MAX) return "leicht";
    if (v < MODERATE_MAX) return "mäßig";
    return "stark";
  }

  // Öffentliche Schnittstelle
  window.Wetter.nowcast = {
    analyze: analyze,
    intensityLabel: intensityLabel,
    WET_THRESHOLD: WET_THRESHOLD,
  };
})();
