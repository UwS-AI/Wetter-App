/*
 * codes.js – Wettercodes (WMO) in Text, Emoji und „Gruppe“ übersetzen
 * =====================================================================
 *
 * Open-Meteo liefert das Wetter nicht als Text, sondern als Zahl, den
 * sogenannten WMO-Wettercode (WMO = Weltorganisation für Meteorologie).
 * Beispiel: 61 bedeutet „leichter Regen“, 95 bedeutet „Gewitter“.
 *
 * Dieses Modul übersetzt so einen Code in:
 *   - einen deutschen Text      („Leichter Regen“)
 *   - ein Emoji für Tag/Nacht   (🌦️ bzw. 🌧️)
 *   - eine Gruppe               („rain“) – app.js nutzt die Gruppe z. B. für
 *                               die Hintergrundfarbe (Klasse wx-rain am body).
 *
 * Außerdem gibt es windDirText(): Gradzahl (240°) → Himmelsrichtung („WSW“).
 *
 * Wie alle Dateien der App ist das ein klassisches Skript (kein import/export):
 * Es hängt seine Funktionen an das globale Objekt window.Wetter an.
 */

// Gemeinsames Objekt anlegen, falls es noch nicht existiert.
window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  /*
   * Die Tabelle aller Codes, die Open-Meteo verwendet.
   * Aufbau je Eintrag: Code: [Text, Emoji am Tag, Emoji in der Nacht, Gruppe]
   *
   * Mögliche Gruppen (siehe docs/ARCHITEKTUR.md):
   *   clear | partly | cloudy | fog | drizzle | rain | snow | storm
   */
  const TABLE = {
    0: ["Klar", "☀️", "🌙", "clear"],
    1: ["Überwiegend klar", "🌤️", "🌙", "clear"],
    2: ["Teilweise bewölkt", "⛅", "☁️", "partly"],
    3: ["Bedeckt", "☁️", "☁️", "cloudy"],

    45: ["Nebel", "🌫️", "🌫️", "fog"],
    48: ["Nebel mit Reif", "🌫️", "🌫️", "fog"],

    51: ["Leichter Nieselregen", "🌦️", "🌧️", "drizzle"],
    53: ["Mäßiger Nieselregen", "🌦️", "🌧️", "drizzle"],
    55: ["Starker Nieselregen", "🌧️", "🌧️", "drizzle"],
    56: ["Leichter gefrierender Nieselregen", "🌧️", "🌧️", "drizzle"],
    57: ["Starker gefrierender Nieselregen", "🌧️", "🌧️", "drizzle"],

    61: ["Leichter Regen", "🌦️", "🌧️", "rain"],
    63: ["Mäßiger Regen", "🌧️", "🌧️", "rain"],
    65: ["Starker Regen", "🌧️", "🌧️", "rain"],
    66: ["Leichter gefrierender Regen", "🌧️", "🌧️", "rain"],
    67: ["Starker gefrierender Regen", "🌧️", "🌧️", "rain"],

    71: ["Leichter Schneefall", "🌨️", "🌨️", "snow"],
    73: ["Mäßiger Schneefall", "🌨️", "🌨️", "snow"],
    75: ["Starker Schneefall", "❄️", "❄️", "snow"],
    77: ["Schneegriesel", "🌨️", "🌨️", "snow"],

    80: ["Leichte Regenschauer", "🌦️", "🌧️", "rain"],
    81: ["Mäßige Regenschauer", "🌦️", "🌧️", "rain"],
    82: ["Heftige Regenschauer", "🌧️", "🌧️", "rain"],

    85: ["Leichte Schneeschauer", "🌨️", "🌨️", "snow"],
    86: ["Starke Schneeschauer", "🌨️", "🌨️", "snow"],

    95: ["Gewitter", "⛈️", "⛈️", "storm"],
    96: ["Gewitter mit leichtem Hagel", "⛈️", "⛈️", "storm"],
    99: ["Gewitter mit starkem Hagel", "⛈️", "⛈️", "storm"],
  };

  // Was zurückkommt, wenn ein Code nicht in der Tabelle steht (oder fehlt).
  // Gruppe „cloudy“ ergibt einen neutralen grauen Hintergrund.
  const UNKNOWN = ["Unbekannt", "❔", "❔", "cloudy"];

  /**
   * Beschreibt einen Wettercode.
   *
   * @param {number} code   WMO-Code, z. B. 61
   * @param {boolean} isDay true = Tag (Standard), false = Nacht
   * @returns {{text: string, emoji: string, group: string}}
   *
   * Beispiel: describe(0, false) → { text: "Klar", emoji: "🌙", group: "clear" }
   */
  function describe(code, isDay = true) {
    // Code als Zahl lesen – so funktioniert auch "61" (Text) oder 61.0.
    // null/undefined werden zu NaN und landen damit bei „Unbekannt“.
    const num = code === null || code === undefined || code === "" ? NaN : Number(code);
    const entry = TABLE[num] || UNKNOWN;

    // Nur ein ausdrückliches false bedeutet Nacht. Fehlt die Angabe
    // (undefined oder null), zeigen wir lieber das Tag-Symbol.
    const night = isDay === false;

    // Immer ein neues Objekt zurückgeben, damit niemand aus Versehen
    // die Tabelle verändert.
    return {
      text: entry[0],
      emoji: night ? entry[2] : entry[1],
      group: entry[3],
    };
  }

  // Die 16 Himmelsrichtungen im Uhrzeigersinn, beginnend bei Norden (0°).
  // Deutsch: O = Ost (statt englisch E).
  const DIRECTIONS = [
    "N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];

  /**
   * Wandelt eine Windrichtung in Grad in eine Himmelsrichtung um.
   * Gemeint ist (wie beim Wetterbericht üblich) die Richtung, AUS der der
   * Wind kommt: 240° → „WSW“ = Wind aus West-Südwest.
   *
   * Jede der 16 Richtungen deckt 360 / 16 = 22,5 Grad ab.
   *
   * @param {number} deg Grad (0–360, andere Werte werden umgerechnet)
   * @returns {string} z. B. "SW", oder "" wenn keine Zahl übergeben wurde
   */
  function windDirText(deg) {
    if (deg === null || deg === undefined || deg === "") return "";
    const n = Number(deg);
    if (!Number.isFinite(n)) return "";

    // Auf den Bereich 0 … 359,9 bringen (auch -90 oder 450 funktionieren).
    const normalized = ((n % 360) + 360) % 360;

    // Runden auf den nächsten 22,5°-Schritt. „% 16“ macht aus 360° wieder N.
    const index = Math.round(normalized / 22.5) % 16;
    return DIRECTIONS[index];
  }

  // Öffentliche Schnittstelle des Moduls.
  Wetter.codes = {
    describe,
    windDirText,
  };
})();
