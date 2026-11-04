/*
 * api.js – Daten aus dem Internet holen
 * =====================================
 *
 * Dieses Modul spricht mit drei kostenlosen Diensten (alle ohne API-Key):
 *
 *   1. Open-Meteo Vorhersage  → fetchForecast(lat, lon)
 *   2. Open-Meteo Ortssuche   → searchPlaces("Hamb")
 *   3. BigDataCloud           → reverseGeocode(lat, lon)  (GPS → Ortsname)
 *
 * Wichtigste Aufgabe ist das „Normalisieren“: Open-Meteo liefert viele
 * parallele Listen (eine Liste Zeiten, eine Liste Temperaturen, …).
 * Wir bauen daraus eine Liste von Objekten, mit der app.js bequem arbeiten
 * kann – genau im Format, das in docs/ARCHITEKTUR.md beschrieben ist.
 *
 *   Vorher (Open-Meteo):  hourly: { time: [t1, t2], temperature_2m: [5, 6] }
 *   Nachher (unsere App): hourly: [ { time: Date, temp: 5 }, { time: Date, temp: 6 } ]
 */

window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------

  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

  // Wie viele Einträge app.js je Liste bekommt (siehe Vertrag).
  const HOURLY_COUNT = 48; // 48 Stunden
  const DAILY_COUNT = 7; //   7 Tage
  const MINUTELY_COUNT = 12; // 12 × 15 Minuten = 3 Stunden

  // Open-Meteo liefert die 15-Minuten-Werte ab Beginn der laufenden
  // Viertelstunde. Wir fragen 16 Werte an (= 4 Stunden), damit nach dem
  // Herausfiltern bereits vergangener Zeitfenster sicher 12 übrig bleiben.
  const MINUTELY_REQUEST = 16;

  // Die Werte, die wir bei Open-Meteo bestellen (durch Komma getrennt).
  const CURRENT_VARS = [
    "temperature_2m", "apparent_temperature", "weather_code", "is_day",
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
    "relative_humidity_2m", "pressure_msl", "precipitation",
  ].join(",");

  const HOURLY_VARS = [
    "temperature_2m", "weather_code", "is_day", "precipitation",
    "precipitation_probability", "wind_speed_10m", "wind_gusts_10m", "uv_index",
  ].join(",");

  const DAILY_VARS = [
    "weather_code", "temperature_2m_max", "temperature_2m_min",
    "precipitation_sum", "precipitation_probability_max",
    "wind_speed_10m_max", "wind_gusts_10m_max", "sunrise", "sunset",
  ].join(",");

  // ---------------------------------------------------------------------
  // Hilfsfunktion: JSON laden – mit Zeitlimit und deutschen Fehlermeldungen
  // ---------------------------------------------------------------------

  /**
   * Lädt eine URL und gibt die Antwort als JavaScript-Objekt zurück.
   *
   * Warum nicht einfach fetch()? Weil fetch() von sich aus
   *   - ewig warten kann (kein Zeitlimit) und
   *   - nur englische, technische Fehler liefert („Failed to fetch“).
   * Hier bekommt jede Anfrage ein Zeitlimit (Wetter.api.TIMEOUT_MS, 10 s),
   * und jeder Fehler wird in einen verständlichen deutschen Satz übersetzt.
   *
   * @param {string} url
   * @returns {Promise<any>} die geparste JSON-Antwort
   * @throws {Error} mit deutscher Meldung
   */
  async function fetchJson(url) {
    // Ist das Gerät erkennbar offline, brauchen wir es gar nicht zu versuchen.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("Keine Internetverbindung. Bitte Verbindung prüfen und erneut versuchen.");
    }

    // Der AbortController kann eine laufende Anfrage abbrechen.
    // Nach Ablauf des Zeitlimits rufen wir controller.abort() auf.
    const controller = new AbortController();
    const timeoutMs = Wetter.api.TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) {
        throw new Error(
          "Zeitüberschreitung: Der Server hat nicht innerhalb von " +
            Math.round(timeoutMs / 1000) + " Sekunden geantwortet."
        );
      }
      // Alle anderen fetch-Fehler bedeuten: Verbindung kam nicht zustande.
      throw new Error("Keine Verbindung zum Server. Bist du offline?");
    }

    try {
      // Antwort ist da, aber mit Fehlerstatus (z. B. 404 oder 500)?
      if (!response.ok) {
        // Open-Meteo schickt bei Fehlern oft { error: true, reason: "…" }.
        let reason = "";
        try {
          const body = await response.json();
          if (body && body.reason) reason = ": " + body.reason;
        } catch (e) {
          // Kein JSON im Fehlerfall – dann eben ohne Begründung.
        }
        throw new Error("Serverfehler (HTTP " + response.status + ")" + reason);
      }

      let data;
      try {
        data = await response.json();
      } catch (e) {
        // Auch das Lesen des Inhalts kann am Zeitlimit scheitern.
        if (timedOut) {
          throw new Error("Zeitüberschreitung beim Laden der Daten.");
        }
        throw new Error("Ungültige Antwort vom Server (kein JSON).");
      }

      // Manche Dienste antworten mit Status 200, melden aber trotzdem einen Fehler.
      if (data && data.error === true) {
        throw new Error("Serverfehler" + (data.reason ? ": " + data.reason : ""));
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------
  // Kleine Helfer für das Normalisieren
  // ---------------------------------------------------------------------

  /** Wert an Position i einer Liste – oder null, falls Liste/Wert fehlt. */
  function at(list, i) {
    if (!Array.isArray(list)) return null;
    const v = list[i];
    return v === undefined ? null : v;
  }

  /** Unix-Sekunden → Date (null bleibt null). */
  function toDate(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }

  /** Open-Meteo-„is_day“ (1/0) → true/false (null bleibt null). */
  function toBool(v) {
    if (v === null || v === undefined) return null;
    return v === 1 || v === true;
  }

  /**
   * Sucht in einer Zeitliste (Unix-Sekunden, aufsteigend) den ersten Eintrag,
   * dessen Zeitfenster noch nicht vorbei ist – also das Fenster, das „jetzt“
   * enthält, oder (falls „jetzt“ vor allen Einträgen liegt) den ersten Eintrag.
   *
   * Ein Fenster reicht von times[i] bis zum nächsten Eintrag times[i+1].
   * Beim letzten Eintrag nehmen wir die normale Schrittweite stepSec an.
   * (So klappt das auch an Tagen mit Zeitumstellung, die 23 oder 25 Std. haben.)
   *
   * @returns {number} Index, oder times.length wenn alles in der Vergangenheit liegt
   */
  function startIndex(times, nowSec, stepSec) {
    for (let i = 0; i < times.length; i++) {
      const end = i + 1 < times.length ? times[i + 1] : times[i] + stepSec;
      if (end > nowSec) return i;
    }
    return times.length;
  }

  /** Liefert die Zeitliste eines Blocks (oder eine leere Liste). */
  function timesOf(block) {
    return block && Array.isArray(block.time) ? block.time : [];
  }

  // ---------------------------------------------------------------------
  // Normalisieren: Open-Meteo-Antwort → Datenmodell der App
  // ---------------------------------------------------------------------

  /**
   * Baut aus der Roh-Antwort von Open-Meteo das Datenmodell aus dem Vertrag.
   * Als Wetter.api._normalize exportiert, damit man es ohne Internet testen kann.
   *
   * @param {object} raw  JSON-Antwort von /v1/forecast (timeformat=unixtime)
   * @param {Date} now    „Jetzt“ – Standard: aktuelle Uhrzeit
   */
  function normalize(raw, now = new Date()) {
    raw = raw || {};
    const nowSec = now.getTime() / 1000;

    const h = raw.hourly || {};
    const d = raw.daily || {};
    const m = raw.minutely_15 || {};
    const c = raw.current || {};

    // --- Stündlich: ab der aktuellen Stunde, 48 Einträge ---
    const hTimes = timesOf(h);
    const hStart = startIndex(hTimes, nowSec, 3600);
    const hourly = [];
    for (let i = hStart; i < hTimes.length && hourly.length < HOURLY_COUNT; i++) {
      hourly.push({
        time: toDate(hTimes[i]),
        temp: at(h.temperature_2m, i),
        code: at(h.weather_code, i),
        isDay: toBool(at(h.is_day, i)),
        precip: at(h.precipitation, i),
        precipProb: at(h.precipitation_probability, i),
        wind: at(h.wind_speed_10m, i),
        gusts: at(h.wind_gusts_10m, i),
        uv: at(h.uv_index, i), // zusätzlich zum Vertrag, schadet nicht
      });
    }

    // --- Täglich: 7 Tage, Index 0 = heute ---
    const dTimes = timesOf(d);
    const dStart = startIndex(dTimes, nowSec, 86400);
    const daily = [];
    for (let i = dStart; i < dTimes.length && daily.length < DAILY_COUNT; i++) {
      daily.push({
        date: toDate(dTimes[i]),
        code: at(d.weather_code, i),
        tMax: at(d.temperature_2m_max, i),
        tMin: at(d.temperature_2m_min, i),
        precipSum: at(d.precipitation_sum, i),
        precipProb: at(d.precipitation_probability_max, i),
        windMax: at(d.wind_speed_10m_max, i),
        gustMax: at(d.wind_gusts_10m_max, i),
        sunrise: toDate(at(d.sunrise, i)),
        sunset: toDate(at(d.sunset, i)),
      });
    }

    // --- 15 Minuten: ab der laufenden Viertelstunde, 12 Einträge ---
    const mTimes = timesOf(m);
    const mStart = startIndex(mTimes, nowSec, 900);
    const minutely = [];
    for (let i = mStart; i < mTimes.length && minutely.length < MINUTELY_COUNT; i++) {
      minutely.push({
        time: toDate(mTimes[i]),
        precip: at(m.precipitation, i), // mm pro 15 Minuten
      });
    }

    // --- Aktuelles Wetter ---
    // Den UV-Index gibt es bei Open-Meteo nicht als „current“-Wert.
    // Wir nehmen ihn aus der Stunde, in der die aktuelle Messung liegt.
    const currentSec = typeof c.time === "number" ? c.time : nowSec;
    const uvIndex = startIndex(hTimes, currentSec, 3600);
    // Nur übernehmen, wenn diese Stunde wirklich schon begonnen hat
    // (sonst wäre es ein Wert aus der Zukunft).
    const uv = uvIndex < hTimes.length && hTimes[uvIndex] <= currentSec
      ? at(h.uv_index, uvIndex)
      : null;

    const current = {
      time: toDate(c.time),
      temp: c.temperature_2m ?? null,
      feels: c.apparent_temperature ?? null,
      code: c.weather_code ?? null,
      isDay: toBool(c.is_day),
      wind: c.wind_speed_10m ?? null,
      gusts: c.wind_gusts_10m ?? null,
      windDir: c.wind_direction_10m ?? null,
      humidity: c.relative_humidity_2m ?? null,
      pressure: c.pressure_msl ?? null,
      precip: c.precipitation ?? null,
      uv: uv,
    };

    return {
      timezone: raw.timezone || null,
      // Abstand der Ortszeit zu UTC in Sekunden (z. B. 3600 für MEZ).
      // Fehlt er, bleibt er undefined → formatTime nimmt die Gerätezeit.
      utcOffsetSeconds:
        typeof raw.utc_offset_seconds === "number" ? raw.utc_offset_seconds : undefined,
      current,
      hourly,
      daily,
      minutely,
    };
  }

  // ---------------------------------------------------------------------
  // Öffentliche Funktionen
  // ---------------------------------------------------------------------

  /**
   * Holt die Wettervorhersage für einen Ort.
   * @returns {Promise<object>} Datenmodell laut docs/ARCHITEKTUR.md
   */
  async function fetchForecast(lat, lon) {
    // URLSearchParams baut den Teil hinter dem „?“ und kodiert Sonderzeichen.
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      timezone: "auto", // Zeitzone des Ortes automatisch bestimmen
      timeformat: "unixtime", // Zeiten als Sekunden seit 1970 (UTC)
      wind_speed_unit: "kmh",
      forecast_days: String(DAILY_COUNT),
      forecast_minutely_15: String(MINUTELY_REQUEST),
      current: CURRENT_VARS,
      hourly: HOURLY_VARS,
      daily: DAILY_VARS,
      minutely_15: "precipitation",
    });

    const raw = await fetchJson(FORECAST_URL + "?" + params.toString());
    return normalize(raw, new Date());
  }

  /**
   * Sucht Orte nach Namen (z. B. „Mün“ → München, Münster, …).
   * @returns {Promise<Array<{id, name, admin1, country, lat, lon}>>}
   */
  async function searchPlaces(query) {
    const q = String(query || "").trim();
    // Erst ab 2 Buchstaben suchen – sonst kommen nur zufällige Treffer.
    if (q.length < 2) return [];

    const params = new URLSearchParams({
      name: q,
      count: "8",
      language: "de",
      format: "json",
    });
    const data = await fetchJson(GEOCODING_URL + "?" + params.toString());

    // Ohne Treffer fehlt „results“ in der Antwort ganz.
    if (!data || !Array.isArray(data.results)) return [];

    return data.results
      .filter((r) => r && typeof r.latitude === "number" && typeof r.longitude === "number")
      .slice(0, 8)
      .map((r) => ({
        // Die id als Text speichern: So passt sie auch zu data-id-Attributen
        // im HTML (die sind immer Text) und zu "gps".
        id: String(r.id != null ? r.id : r.latitude + "," + r.longitude),
        name: r.name || "",
        admin1: r.admin1 || "", // Bundesland / Region
        country: r.country || "",
        lat: r.latitude,
        lon: r.longitude,
      }));
  }

  /**
   * Findet zu GPS-Koordinaten einen Ortsnamen (z. B. „Hamburg“).
   * Wirft NIE einen Fehler – im Zweifel kommt null zurück und die App
   * zeigt dann „Mein Standort“ an.
   * @returns {Promise<string|null>}
   */
  async function reverseGeocode(lat, lon) {
    try {
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        localityLanguage: "de",
      });
      const data = await fetchJson(REVERSE_URL + "?" + params.toString());
      if (!data) return null;
      const name = data.city || data.locality || data.principalSubdivision;
      return name ? String(name) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Formatiert eine Zeit in der Ortszeit des Wetterorts.
   *
   * Trick: Wir verschieben die Zeit um den UTC-Abstand des Ortes und lassen
   * sie dann als „UTC“ formatieren. Beispiel Tokio (+9 Std.):
   *   12:00 UTC + 9 Std. = 21:00 → als UTC formatiert: „21:00“ = Ortszeit Tokio.
   * So stimmt die Uhrzeit auch, wenn das iPad in einer anderen Zeitzone ist.
   *
   * @param {Date} date
   * @param {number} [utcOffsetSeconds] fehlt er, wird die Gerätezeit benutzt
   * @param {object} [opts] Optionen für Intl.DateTimeFormat,
   *                        Standard: Stunde und Minute („14:45“)
   * @returns {string} formatierte Zeit, "" bei ungültigem Datum
   */
  function formatTime(date, utcOffsetSeconds, opts) {
    const d = date instanceof Date ? date : new Date(date);
    if (date === null || date === undefined || isNaN(d.getTime())) return "";

    const options = opts || { hour: "2-digit", minute: "2-digit" };

    if (typeof utcOffsetSeconds !== "number" || !Number.isFinite(utcOffsetSeconds)) {
      // Kein Offset bekannt → in der Zeitzone des Geräts anzeigen.
      return new Intl.DateTimeFormat("de-DE", options).format(d);
    }
    const shifted = new Date(d.getTime() + utcOffsetSeconds * 1000);
    return new Intl.DateTimeFormat("de-DE", { ...options, timeZone: "UTC" }).format(shifted);
  }

  Wetter.api = {
    TIMEOUT_MS: 10000, // Zeitlimit je Anfrage in Millisekunden
    fetchForecast,
    searchPlaces,
    reverseGeocode,
    formatTime,
    // Nur für Tests gedacht (Unterstrich = „intern“):
    _normalize: normalize,
    _fetchJson: fetchJson,
  };
})();
