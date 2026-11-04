/*
 * favorites.js – Lieblingsorte und zuletzt gewählten Ort merken
 * =============================================================
 *
 * Gespeichert wird im localStorage des Browsers. Das ist ein kleiner
 * Speicher, der auch nach dem Schließen der Seite erhalten bleibt.
 * localStorage kann nur Text speichern – darum wandeln wir unsere Daten
 * mit JSON.stringify in Text um und mit JSON.parse wieder zurück.
 *
 * Schlüssel im localStorage:
 *   "wetter.favorites" → Liste der Favoriten (Place[])
 *   "wetter.last"      → zuletzt angezeigter Ort (Place)
 *
 * Ein Ort („Place“) sieht so aus:
 *   { id: "2911298", name: "Hamburg", admin1: "Hamburg", country: "Deutschland",
 *     lat: 53.55, lon: 9.99 }
 * GPS-Orte haben id = "gps". Sie werden nie als Favorit gespeichert
 * (die Position ändert sich ja), wohl aber als „zuletzt gewählt“.
 *
 * Achtung Safari: Im privaten Modus oder bei vollem Speicher wirft
 * localStorage Fehler. Darum steht jeder Zugriff in try/catch. Klappt das
 * Speichern nicht, merken wir uns die Daten wenigstens im Arbeitsspeicher
 * (bis die Seite neu geladen wird).
 */

window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  const KEY_FAVORITES = "wetter.favorites";
  const KEY_LAST = "wetter.last";

  // Ersatzspeicher, falls localStorage nicht funktioniert.
  const memory = {};

  // ---------------------------------------------------------------------
  // Sicherer Zugriff auf localStorage
  // ---------------------------------------------------------------------

  /** Liest einen Wert und wandelt ihn von JSON zurück. Fehler → null. */
  function load(key) {
    let text = null;
    if (key in memory) {
      // In dieser Sitzung schon geschrieben → der Ersatzspeicher ist aktuell
      // (auch dann, wenn das Schreiben in localStorage gescheitert ist).
      text = memory[key];
    } else {
      try {
        text = window.localStorage.getItem(key);
      } catch (e) {
        // localStorage nicht verfügbar (z. B. Safari Privatmodus).
      }
    }
    if (text === null || text === undefined) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null; // kaputte Daten einfach ignorieren
    }
  }

  /** Speichert einen Wert als JSON (value = null löscht den Eintrag). */
  function save(key, value) {
    const text = value === null ? null : JSON.stringify(value);
    // Ersatzspeicher immer aktuell halten (null = gelöscht).
    memory[key] = text;
    try {
      if (text === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, text);
    } catch (e) {
      // Privatmodus / Speicher voll – dann bleibt es beim Ersatzspeicher.
    }
  }

  // ---------------------------------------------------------------------
  // Orte prüfen und „säubern“
  // ---------------------------------------------------------------------

  /**
   * Prüft, ob etwas wie ein gültiger Ort aussieht, und gibt eine saubere
   * Kopie mit genau den Feldern aus dem Vertrag zurück (sonst null).
   * Die id wird immer als Text gespeichert, damit Vergleiche wie
   * has("2911298") auch mit Zahl-ids klappen.
   */
  function clean(place) {
    if (!place || typeof place !== "object") return null;
    if (place.id === null || place.id === undefined || place.id === "") return null;
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      id: String(place.id),
      name: place.name ? String(place.name) : "",
      admin1: place.admin1 ? String(place.admin1) : "",
      country: place.country ? String(place.country) : "",
      lat,
      lon,
    };
  }

  /** Ist das ein GPS-Ort? */
  function isGps(place) {
    return !!place && String(place.id) === "gps";
  }

  // ---------------------------------------------------------------------
  // Öffentliche Funktionen
  // ---------------------------------------------------------------------

  /** Alle Favoriten als Liste (nie null, im Zweifel []). */
  function list() {
    const data = load(KEY_FAVORITES);
    if (!Array.isArray(data)) return [];
    // Nur gültige Einträge zurückgeben (falls jemand den Speicher verändert hat).
    return data.map(clean).filter((p) => p && !isGps(p));
  }

  /** Ist der Ort mit dieser id ein Favorit? */
  function has(id) {
    if (id === null || id === undefined) return false;
    const wanted = String(id);
    return list().some((p) => p.id === wanted);
  }

  /** Fügt einen Ort hinzu (doppelte und GPS-Orte werden ignoriert). */
  function add(place) {
    const p = clean(place);
    if (!p || isGps(p)) return;
    const favs = list();
    if (favs.some((f) => f.id === p.id)) return; // schon vorhanden
    favs.push(p);
    save(KEY_FAVORITES, favs);
  }

  /** Entfernt den Ort mit dieser id aus den Favoriten. */
  function remove(id) {
    if (id === null || id === undefined) return;
    const wanted = String(id);
    const favs = list();
    const rest = favs.filter((f) => f.id !== wanted);
    if (rest.length !== favs.length) save(KEY_FAVORITES, rest);
  }

  /**
   * Schaltet einen Ort um: Favorit ↔ kein Favorit.
   * @returns {boolean} neuer Zustand (true = ist jetzt Favorit)
   */
  function toggle(place) {
    const p = clean(place);
    if (!p || isGps(p)) return false; // GPS-Orte können kein Favorit sein
    if (has(p.id)) {
      remove(p.id);
      return false;
    }
    add(p);
    return has(p.id);
  }

  /** Zuletzt gewählter Ort (oder null). */
  function getLast() {
    return clean(load(KEY_LAST));
  }

  /** Merkt sich den zuletzt gewählten Ort (auch GPS-Orte). null löscht ihn. */
  function setLast(place) {
    if (place === null || place === undefined) {
      save(KEY_LAST, null);
      return;
    }
    const p = clean(place);
    if (p) save(KEY_LAST, p);
  }

  Wetter.favorites = {
    list,
    add,
    remove,
    has,
    toggle,
    getLast,
    setLast,
  };
})();
