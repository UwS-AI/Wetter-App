/*
 * effects.js – dezente Wetteranimationen im Hintergrund
 * ======================================================
 *
 * Hinter allen Kacheln liegt ein einziges <canvas id="wx-effects">. Darauf
 * zeichnen wir passend zum aktuellen Wetter ruhige, halbtransparente Effekte:
 *
 *   clear    Tag: warmes Sonnenglühen oben rechts · Nacht: funkelnde Sterne
 *   partly   wenige Wolkenschleier (+ schwaches Sonnenglühen bzw. Sterne)
 *   cloudy   mehrere große, weiche Wolkenschleier
 *   fog      wabernde, waagerechte Nebelbänder
 *   drizzle  wenige feine, kurze Tropfen
 *   rain     Regenstriche – Dichte nach Code bzw. Niederschlagsmenge,
 *            Schräglage nach Wind
 *   snow     taumelnde Flocken (77 = kleine Schneegriesel-Körner)
 *   storm    Regen + gelegentliche sanfte Blitze (96/99 zusätzlich Hagel)
 *
 * Benutzung (aus app.js):
 *   Wetter.effects.update({ code: 61, isDay: true, windSpeed: 18, windDir: 240, precip: 0.4 });
 *     code       WMO-Wettercode (siehe codes.js)
 *     isDay      true = Tag, false = Nacht
 *     windSpeed  km/h
 *     windDir    Grad, Richtung AUS der der Wind kommt (240 = aus WSW)
 *     precip     aktueller Niederschlag in mm/h (optional)
 *
 * Solange update() nie aufgerufen wurde, schaut das Modul selbst auf die
 * Klassen am <body> (wx-<gruppe>, is-night), die app.js ohnehin setzt, und
 * zeigt eine Standard-Animation dieser Gruppe. Sobald update() einmal
 * aufgerufen wurde, gelten nur noch dessen (genauere) Angaben.
 *
 * Rücksicht auf Akku und Nutzer:
 *   - Bildrate je Szene: Regen/Schnee/Hagel ~30 Bilder pro Sekunde, ruhige
 *     Szenen (Sonne, Sterne, Wolken, Nebel) nur ~10 – dort bewegt sich ohnehin
 *     kaum etwas. Jedes neue Canvas-Bild zwingt den Browser außerdem, alle
 *     Glas-Kacheln darüber (backdrop-filter: blur) neu zu verwischen.
 *   - Weiche Ebenen (Sonnenglühen, Wolkenschleier, Sterne) werden EINMAL in
 *     kleine unsichtbare Canvas-Flächen vorgezeichnet („vorrendern“) und pro
 *     Bild nur noch gestempelt (drawImage + globalAlpha).
 *   - Ruhige Szenen ohne feine Linien/Punkte zeichnen mit normaler statt
 *     Retina-Auflösung (4× weniger Pixel) – weiche Verläufe sehen gleich aus.
 *   - Ändert sich nur die Höhe ein wenig (Safari-Leiste beim Scrollen auf dem
 *     iPhone), bleibt die Szene stehen; nur bei neuer Breite (Drehen) wird
 *     sie neu aufgebaut.
 *   - Anzahl der Teilchen hängt von der Bildschirmfläche ab und ist begrenzt
 *   - Pause, solange der Tab/die App im Hintergrund ist (document.hidden)
 *   - „Bewegung reduzieren“ (prefers-reduced-motion) → nur ein ruhiges
 *     Standbild ohne Regen/Schnee/Blitze, keine Bewegung
 *
 * Fehlt das Canvas oder kann der Browser nicht zeichnen, passiert einfach
 * nichts – dieses Modul wirft nie einen Fehler.
 */

window.Wetter = window.Wetter || {};

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Einstellungen (zum Ausprobieren gut geeignet)
  // ------------------------------------------------------------------

  /**
   * Mindestabstand zwischen zwei Bildern in ms.
   * FAST: fallende Teilchen (Regen, Schnee, Hagel) und Blitze → max. 30 fps
   * CALM: nur ruhige Ebenen (Sonne, Sterne, Wolken, Nebel)    → max. 10 fps
   *       (Wolken ziehen höchstens 20 px pro Sekunde – bei 10 Bildern pro
   *       Sekunde sind das 2 px je Bild, bei so weichen Flecken unsichtbar.)
   */
  const FRAME_MS_FAST = 1000 / 30;
  const FRAME_MS_CALM = 1000 / 10;

  /**
   * Ändert sich nur die Höhe um weniger als so viele Pixel (Breite gleich),
   * bauen wir die Szene NICHT neu auf. Typischer Fall: Auf dem iPhone blendet
   * Safari beim Scrollen seine Adressleiste ein/aus (ca. 50–120 px).
   */
  const HEIGHT_TOLERANCE = 150;

  /** Auflösung der vorgezeichneten weichen Ebenen (Anteil der CSS-Pixel) */
  const SUN_LAYER_SCALE = 0.25;    // Sonnenglühen: sehr weicher Verlauf
  const CLOUD_LAYER_SCALE = 0.5;   // Wolkenschleier

  /** Bezugsfläche für die Teilchenzahl: iPad Air quer (1180 × 820) */
  const REF_AREA = 1180 * 820;

  /** Obergrenzen, egal wie groß der Bildschirm ist */
  const MAX_DROPS = 160;
  const MAX_FLAKES = 130;
  const MAX_HAIL = 30;
  const MAX_STARS = 140;

  /** Größte Schräglage des Regens in Grad (bei starkem Wind) */
  const MAX_TILT_DEG = 20;

  /** Standard-Code je Gruppe – für den Fall, dass nur die body-Klasse bekannt ist */
  const DEFAULT_CODE = {
    clear: 0, partly: 2, cloudy: 3, fog: 45,
    drizzle: 53, rain: 63, snow: 73, storm: 95,
  };

  /** Wie viele Regentropfen je Code (bei Bezugsfläche, vor der Obergrenze) */
  const DROPS_BY_CODE = {
    51: 26, 53: 40, 55: 58, 56: 30, 57: 52,          // Niesel (auch gefrierend)
    61: 60, 63: 100, 65: 150, 66: 65, 67: 130,       // Regen (auch gefrierend)
    80: 70, 81: 110, 82: 160,                        // Schauer
    95: 110, 96: 110, 99: 130,                       // Gewitter
  };

  /** Wie viele Schneeflocken je Code */
  const FLAKES_BY_CODE = { 71: 50, 73: 80, 75: 120, 77: 90, 85: 60, 86: 110 };

  // Farben (R, G, B) – passend zum Farbschema „Petrol & Türkis“
  const RGB_RAIN = "205, 232, 236";      // weiß mit einem Hauch Türkis
  const RGB_FREEZE = "222, 238, 255";    // bläulich-weiß (gefrierender Regen)
  const RGB_SUN = "233, 196, 106";       // warmes Gelb #e9c46a
  const RGB_FLASH = "220, 236, 255";     // kühles Blitzlicht

  // ------------------------------------------------------------------
  // Zustand des Moduls
  // ------------------------------------------------------------------

  let canvas = null;     // das <canvas>-Element
  let ctx = null;        // sein 2D-Zeichenkontext
  let W = 0, H = 0;      // Größe in CSS-Pixeln
  let dpr = 1;           // Pixeldichte (Retina = 2), höchstens 2
  let scale = 1;         // tatsächliche Zeichen-Auflösung: dpr oder 1 (ruhige, weiche Szene)

  let params = null;     // aktuelle Wetterangaben { group, code, isDay, ... }
  let paramsKey = "";    // dieselben Angaben als Text – zum schnellen Vergleichen
  let scene = null;      // alle Teilchen/Ebenen der aktuellen Szene
  let clock = 0;         // eigene Uhr in Sekunden (läuft in Pausen nicht weiter)
  let frames = 0;        // Anzahl gezeichneter Bilder (nur für Tests/Diagnose)
  let builds = 0;        // wie oft die Szene neu aufgebaut wurde (Tests/Diagnose)
  let builtW = 0, builtH = 0;  // Größe, für die die aktuelle Szene gebaut wurde

  let rafId = 0;         // Nummer des angeforderten Animationsbilds (0 = keins)
  let timerId = 0;       // Wartezeit vor dem nächsten Bild in ruhigen Szenen (setTimeout)
  let lastTs = 0;        // Zeitstempel des letzten gezeichneten Bilds

  let reducedMotion = false;
  let motionQuery = null;

  let updateCalled = false;  // wurde update() schon einmal benutzt?
  let observer = null;       // beobachtet die body-Klassen (Rückfall-Modus)
  let pending = null;        // update()-Angaben, die vor init() kamen

  let sprite = null;     // vorgezeichneter weicher Lichtfleck (für Wolken, Nebel, Flocken)
  let starSprite = null; // vorgezeichneter kleiner, scharfer Punkt (für Sterne)

  // ------------------------------------------------------------------
  // Kleine Hilfsfunktionen
  // ------------------------------------------------------------------

  /** Zahl oder null (für fehlende/kaputte Werte) */
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * Zufallszahlen mit festem Startwert („seed“). Vorteil: Sterne und Wolken
   * stehen nach jedem Neuaufbau an denselben Stellen und springen nicht.
   * (Verfahren „mulberry32“ – kurz, schnell und für Grafik völlig ausreichend.)
   */
  function makeRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Zufallszahl zwischen a und b (mit gegebenem Zufallsgenerator) */
  function between(rnd, a, b) {
    return a + rnd() * (b - a);
  }

  /** Gruppe zu einem Code – über Wetter.codes, mit Rückfall „cloudy“ */
  function groupOf(code) {
    try {
      if (Wetter.codes && typeof Wetter.codes.describe === "function") {
        return Wetter.codes.describe(code).group || "cloudy";
      }
    } catch (e) { /* ignorieren */ }
    return "cloudy";
  }

  /**
   * Ein weicher, runder Lichtfleck (weiß in der Mitte, nach außen durchsichtig).
   * Wir malen ihn EINMAL auf ein kleines unsichtbares Canvas und stempeln ihn
   * danach nur noch (drawImage) – das ist viel schneller, als jedes Mal einen
   * neuen Farbverlauf zu berechnen.
   */
  function makeSprite() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.7)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.22)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return c;
  }

  /**
   * Ein kleiner weißer Punkt mit glattem Rand – unser „Stern-Stempel“.
   * STAR_SPRITE_R = Radius des Punkts im Stempel (in Stempel-Pixeln).
   * Er wird beim Zeichnen auf die Sterngröße verkleinert.
   */
  const STAR_SPRITE_SIZE = 16;
  const STAR_SPRITE_R = 7;
  function makeStarSprite() {
    const c = document.createElement("canvas");
    c.width = c.height = STAR_SPRITE_SIZE;
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(STAR_SPRITE_SIZE / 2, STAR_SPRITE_SIZE / 2, STAR_SPRITE_R, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  /**
   * Eine neue unsichtbare Zeichenfläche („Offscreen-Canvas“) für eine
   * vorgezeichnete Ebene. w/h in CSS-Pixeln, k = Auflösung (0,25 = ein Viertel).
   * Liefert { c: Canvas, g: Zeichenkontext } oder null.
   */
  function makeLayer(w, h, k) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w * k));
    c.height = Math.max(1, Math.ceil(h * k));
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(k, 0, 0, k, 0, 0);   // ab jetzt in CSS-Pixeln zeichnen
    return { c, g };
  }

  // ------------------------------------------------------------------
  // Szene aufbauen: aus den Wetterangaben werden Teilchen und Ebenen
  // ------------------------------------------------------------------

  /**
   * Baut die komplette Szene neu auf. Alte Teilchen werden dabei einfach
   * verworfen (der Garbage Collector räumt sie weg) – es sammelt sich nichts an.
   */
  function buildScene() {
    if (!params || !W || !H) { scene = null; return; }
    builds++;
    builtW = W;
    builtH = H;

    const p = params;
    const code = p.code;
    const g = p.group;
    const night = !p.isDay;
    const rnd = makeRandom(1000 + (code || 0) * 7 + (night ? 1 : 0));

    // Flächenfaktor: kleiner Bildschirm → weniger Teilchen (iPhone ≈ 0,35)
    const area = clamp((W * H) / REF_AREA, 0.25, 1.4);

    // --- Wind: Schräglage und Richtung -------------------------------
    // windDir sagt, WOHER der Wind kommt. Wind aus Westen (270°) treibt nach
    // Osten, also auf dem Bildschirm nach rechts. Die Ost-West-Komponente ist
    // -sin(Richtung): 270° → +1 (nach rechts), 90° → -1 (nach links),
    // 0°/180° (Nord/Süd) → 0 (keine Schräglage).
    const speed = p.windSpeed !== null ? Math.max(0, p.windSpeed) : 10;
    const side = p.windDir !== null
      ? -Math.sin((p.windDir * Math.PI) / 180)
      : 0.6;                                   // unbekannt: leichter Westwind
    const tiltDeg = Math.min(MAX_TILT_DEG, speed * 0.5) * side;
    const tilt = (tiltDeg * Math.PI) / 180;    // im Bogenmaß
    // Richtung, in die Wolken/Nebel ziehen (+1 = nach rechts, -1 = nach links)
    const drift = side >= 0 ? 1 : -1;

    const s = {
      sun: 0,          // Stärke des Sonnenglühens (0 = keins)
      sunLayer: null,  // vorgezeichnetes Sonnenglühen (Offscreen-Canvas)
      stars: [],
      clouds: [],
      fog: [],
      drops: [], dropRGB: RGB_RAIN, sinA: Math.sin(tilt), cosA: Math.cos(tilt),
      flakes: [], grains: false, snowDrift: 0,
      hail: [],
      lightning: false, flash: null, nextFlash: 0,
    };

    // --- Himmel: Sonne, Sterne, Wolken -------------------------------
    if (g === "clear") {
      if (night) addStars(s, rnd, Math.round(95 * area));
      else s.sun = 1;
      if (code === 1) addClouds(s, rnd, 1, night ? 0.05 : 0.07, drift, speed);  // „überwiegend klar“
    } else if (g === "partly") {
      if (night) addStars(s, rnd, Math.round(40 * area));
      else s.sun = 0.5;
      addClouds(s, rnd, 2, night ? 0.06 : 0.09, drift, speed);
    } else if (g === "cloudy") {
      addClouds(s, rnd, 4, night ? 0.06 : 0.1, drift, speed);
    } else if (g === "fog") {
      addFog(s, rnd, night ? 0.1 : 0.15, drift);
    } else if (g === "drizzle" || g === "rain" || g === "storm" || g === "snow") {
      // Bei Niederschlag nur zwei sehr schwache Schleier oben – mehr Tiefe
      addClouds(s, rnd, 2, night ? 0.035 : 0.05, drift, speed, 0.35);
    }

    // --- Niederschlag ------------------------------------------------
    if (g === "drizzle" || g === "rain" || g === "storm") {
      let n = DROPS_BY_CODE[code] || (g === "drizzle" ? 40 : 100);
      // Aktuelle Niederschlagsmenge (mm/h) einbeziehen, wenn bekannt und > 0:
      // 0,5 mm/h ≈ 60 Tropfen … 10 mm/h ≈ 160 Tropfen (logarithmisch).
      if (p.precip !== null && p.precip > 0) {
        const byPrecip = 40 + 120 * clamp(Math.log1p(p.precip) / Math.log1p(10), 0, 1);
        n = (n + byPrecip) / 2;
      }
      if (g === "drizzle") n = Math.min(n, 70);     // Niesel bleibt fein
      n = Math.min(MAX_DROPS, Math.round(n * area));

      const freezing = code === 56 || code === 57 || code === 66 || code === 67;
      if (freezing) s.dropRGB = RGB_FREEZE;
      addDrops(s, rnd, n, g === "drizzle", freezing, night);
    }

    if (g === "storm") {
      s.lightning = true;
      s.nextFlash = clock + between(Math.random, 3, 8);   // erster Blitz etwas früher
      if (code === 96 || code === 99) {
        const n = Math.min(MAX_HAIL, Math.round((code === 99 ? 26 : 14) * area));
        addHail(s, rnd, n);
      }
    }

    if (g === "snow") {
      const n = Math.min(MAX_FLAKES, Math.round((FLAKES_BY_CODE[code] || 80) * area));
      s.grains = code === 77;
      s.snowDrift = side * Math.min(speed, 40) * 1.2;   // px/s seitlich
      addFlakes(s, rnd, n, s.grains, night);
    }

    // --- Weiche Ebenen einmal vorzeichnen ------------------------------
    if (s.sun) s.sunLayer = renderSunLayer(s.sun);
    for (const c of s.clouds) renderCloudLayer(c);

    // Ruhige Szene ohne feine Striche/Punkte (keine Sterne, kein Niederschlag)?
    // Dann reicht normale Auflösung: Weiche Verläufe sehen auch mit 1× scharf
    // genug aus, und es sind auf Retina-Bildschirmen 4× weniger Pixel.
    s.soft = !s.stars.length && !s.drops.length && !s.flakes.length && !s.hail.length;

    scene = s;
  }

  /**
   * Sonnenglühen EINMAL vorzeichnen: ein großer, weicher Farbverlauf oben
   * rechts. Früher wurde er bei jedem Bild neu berechnet – das kostet bei
   * Bildschirmgröße sehr viel. Jetzt zeichnen wir ihn in geringer Auflösung
   * (ein Viertel) auf eine unsichtbare Fläche; beim Stempeln vergrößert der
   * Browser ihn weich, was man bei einem so sanften Verlauf nicht sieht.
   * Die Fläche ist HEIGHT_TOLERANCE höher als der Bildschirm, damit auch nach
   * einer kleinen Höhenänderung (ohne Neuaufbau) unten nichts fehlt.
   */
  function renderSunLayer(strength) {
    const lh = H + HEIGHT_TOLERANCE;
    const layer = makeLayer(W, lh, SUN_LAYER_SCALE);
    if (!layer) return null;
    const cx = W * 0.9;
    const cy = H * 0.03;
    const R = Math.max(W, H) * 0.55;
    const a = 0.4 * strength;          // volle Stärke; das Pulsieren macht später globalAlpha
    const grad = layer.g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, "rgba(" + RGB_SUN + "," + a.toFixed(3) + ")");
    grad.addColorStop(0.18, "rgba(" + RGB_SUN + "," + (a * 0.55).toFixed(3) + ")");
    grad.addColorStop(0.5, "rgba(" + RGB_SUN + "," + (a * 0.15).toFixed(3) + ")");
    grad.addColorStop(1, "rgba(" + RGB_SUN + ",0)");
    layer.g.fillStyle = grad;
    layer.g.fillRect(0, 0, W, lh);
    return { c: layer.c, w: W, h: lh };
  }

  /**
   * Eine Wolke EINMAL vorzeichnen: alle ihre Flecken („Puffs“) auf eine kleine
   * unsichtbare Fläche. Danach ist jede Wolke pro Bild nur noch EIN drawImage
   * statt 3–5. Wir zeichnen die Flecken gleich mit der Wolken-Durchsichtigkeit
   * (alpha), damit Überlappungen genauso aussehen wie vorher.
   */
  function renderCloudLayer(c) {
    if (!sprite) return;
    // Umriss (Bounding Box) aller Flecken relativ zur Wolkenmitte bestimmen
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of c.puffs) {
      x0 = Math.min(x0, p.dx - p.rx); x1 = Math.max(x1, p.dx + p.rx);
      y0 = Math.min(y0, p.dy - p.ry); y1 = Math.max(y1, p.dy + p.ry);
    }
    const layer = makeLayer(x1 - x0, y1 - y0, CLOUD_LAYER_SCALE);
    if (!layer) return;
    layer.g.globalAlpha = c.alpha;
    for (const p of c.puffs) {
      layer.g.drawImage(sprite, p.dx - p.rx - x0, p.dy - p.ry - y0, p.rx * 2, p.ry * 2);
    }
    c.layer = layer.c;
    c.ox = x0; c.oy = y0;                  // Versatz der Fläche zur Wolkenmitte
    c.lw = x1 - x0; c.lh = y1 - y0;        // Größe in CSS-Pixeln
  }

  /** Sterne: feste Positionen in den oberen 60 % des Bildschirms */
  function addStars(s, rnd, n) {
    n = Math.min(MAX_STARS, n);
    for (let i = 0; i < n; i++) {
      s.stars.push({
        x: rnd() * W,
        y: rnd() * H * 0.6,
        r: between(rnd, 0.5, 1.3),
        a: between(rnd, 0.3, 0.8),
        // nur manche Sterne funkeln deutlich, die meisten kaum
        tw: rnd() < 0.3 ? between(rnd, 0.35, 0.6) : between(rnd, 0, 0.15),
        f: between(rnd, 0.6, 1.8),        // Funkel-Geschwindigkeit
        ph: rnd() * Math.PI * 2,          // Startpunkt im Funkel-Rhythmus
      });
    }
  }

  /**
   * Wolkenschleier: jede Wolke besteht aus einigen sich überlappenden weichen
   * Flecken („Puffs“) und zieht langsam seitwärts.
   * maxY = bis zu welchem Anteil der Höhe Wolken vorkommen dürfen.
   */
  function addClouds(s, rnd, count, alpha, drift, windSpeed, maxY = 0.7) {
    const v = Math.min(20, 5 + windSpeed * 0.25);  // px pro Sekunde
    for (let i = 0; i < count; i++) {
      const w = between(rnd, 0.35, 0.6) * W;
      const h = between(rnd, 0.14, 0.24) * H;
      const puffs = [];
      const np = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < np; k++) {
        puffs.push({
          dx: between(rnd, -0.35, 0.35) * w,
          dy: between(rnd, -0.25, 0.25) * h,
          rx: between(rnd, 0.3, 0.5) * w,
          ry: between(rnd, 0.35, 0.6) * h,
        });
      }
      s.clouds.push({
        // gleichmäßig über die Breite verteilt, damit sie nicht aufeinander liegen
        x: ((i + between(rnd, 0.1, 0.9)) / count) * (W + w) - w / 2,
        y: between(rnd, 0.05, maxY) * H,
        w, puffs,
        vx: drift * v * between(rnd, 0.7, 1.2),
        alpha: alpha * between(rnd, 0.8, 1.2),
      });
    }
  }

  /** Nebelbänder: breite, flache Flecken, die hin und her wabern */
  function addFog(s, rnd, alpha, drift) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      s.fog.push({
        cx: between(rnd, 0.2, 0.8) * W,
        y: ((i + 0.5) / n) * H * 1.05 + between(rnd, -0.05, 0.05) * H,
        w: between(rnd, 1.1, 1.7) * W,
        h: between(rnd, 0.1, 0.18) * H,
        amp: between(rnd, 0.08, 0.18) * W * drift,   // wie weit es seitlich wabert
        f: between(rnd, 0.04, 0.09),                 // sehr langsam
        ph: rnd() * Math.PI * 2,
        alpha: alpha * between(rnd, 0.7, 1.2),
      });
    }
  }

  /**
   * Regen-/Nieseltropfen. Jeder Tropfen gehört zu einer von drei „Tiefen“
   * (hinten / Mitte / vorn): hinten kürzer, langsamer und blasser.
   */
  function addDrops(s, rnd, n, drizzle, freezing, night) {
    const base = drizzle
      ? { len: [5, 9], speed: [380, 520], alpha: [0.16, 0.24, 0.32], width: [0.8, 1, 1.1] }
      : { len: [12, 24], speed: [720, 980], alpha: [0.14, 0.22, 0.32], width: [0.9, 1.1, 1.4] };
    const boost = (freezing ? 1.2 : 1) * (night ? 0.85 : 1);
    s.dropAlpha = base.alpha.map((a) => Math.min(0.5, a * boost));
    s.dropWidth = base.width;
    for (let i = 0; i < n; i++) {
      const layer = i % 3;                  // 0 = hinten, 2 = vorn
      const depth = 0.7 + layer * 0.15;     // 0,7 … 1,0
      s.drops.push({
        x: rnd() * W,
        y: rnd() * H,                       // gleich über den Schirm verteilt – keine „Startwelle“
        len: between(rnd, base.len[0], base.len[1]) * depth,
        v: between(rnd, base.speed[0], base.speed[1]) * depth * (H / 820 * 0.4 + 0.6),
        layer,
      });
    }
  }

  /** Hagelkörner: helle Kügelchen, schneller als Regen, hüpfen unten kurz auf */
  function addHail(s, rnd, n) {
    for (let i = 0; i < n; i++) {
      s.hail.push(newHailstone(rnd, true));
    }
  }

  function newHailstone(rnd, anywhere) {
    return {
      x: rnd() * W,
      y: anywhere ? rnd() * H : -between(rnd, 5, 120),
      r: between(rnd, 1.3, 2.4),
      vy: between(rnd, 950, 1250),
      vx: 0,
      bounced: false,
    };
  }

  /** Schneeflocken (bzw. Graupel-/Griesel-Körner bei Code 77) */
  function addFlakes(s, rnd, n, grains, night) {
    for (let i = 0; i < n; i++) {
      const layer = i % 3;
      const depth = 0.65 + layer * 0.175;   // 0,65 … 1,0
      s.flakes.push({
        bx: rnd() * W,                      // „Grundposition“ – dazu kommt das Taumeln
        y: rnd() * H,
        r: (grains ? between(rnd, 0.9, 1.6) : between(rnd, 1.6, 3.6)) * depth,
        vy: (grains ? between(rnd, 90, 140) : between(rnd, 28, 60)) * depth,
        amp: grains ? between(rnd, 0.5, 2) : between(rnd, 6, 18) * depth,
        f: grains ? between(rnd, 1, 2) : between(rnd, 0.4, 1.1),
        ph: rnd() * Math.PI * 2,
        a: (grains ? 0.6 : 0.45 + layer * 0.15) * (night ? 0.8 : 1),
      });
    }
  }

  // ------------------------------------------------------------------
  // Zeichnen
  // ------------------------------------------------------------------

  /**
   * Ein Bild zeichnen.
   * dt     = vergangene Zeit seit dem letzten Bild in Sekunden
   * still  = true → Standbild für „Bewegung reduzieren“: nur ruhige Ebenen
   *          (Sonne, Sterne, Wolken, Nebel), kein Regen/Schnee/Blitz
   */
  function drawFrame(dt, still) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;

    if (!still) clock += dt;
    const s = scene;

    if (s.sunLayer) drawSun(s.sunLayer, still);
    if (s.stars.length) drawStars(s.stars, still);
    if (s.clouds.length) drawClouds(s.clouds, dt, still);
    if (s.fog.length) drawFog(s.fog, still);

    if (!still) {
      if (s.drops.length) drawDrops(s, dt);
      if (s.hail.length) drawHail(s.hail, dt);
      if (s.flakes.length) drawFlakes(s, dt);
      if (s.lightning) drawLightning(s);
    }
    ctx.globalAlpha = 1;
    frames++;
  }

  /**
   * Sanftes, langsam pulsierendes Sonnenglühen oben rechts.
   * Der Verlauf ist vorgezeichnet (renderSunLayer) – hier wird er nur noch
   * gestempelt. Das Pulsieren (alle ~9 Sekunden etwas heller und wieder
   * dunkler) erledigt globalAlpha: Alle Farbstopps werden gleichmäßig
   * schwächer, genau wie vorher, als die Stärke in den Verlauf eingerechnet war.
   */
  function drawSun(layer, still) {
    const pulse = still ? 1 : 0.88 + 0.12 * Math.sin((clock * 2 * Math.PI) / 9);
    ctx.globalAlpha = pulse;
    ctx.drawImage(layer.c, 0, 0, layer.w, layer.h);
  }

  /**
   * Sterne: kleine Punkte, manche funkeln leicht. Jeder Stern ist ein
   * gestempelter, vorgezeichneter Punkt (starSprite) – schneller als für jeden
   * Stern einen Kreis-Pfad zu bauen. Die Helligkeit kommt über globalAlpha.
   */
  function drawStars(stars, still) {
    if (!starSprite) return;
    // Der Punkt im Stempel hat den Radius STAR_SPRITE_R von STAR_SPRITE_SIZE/2
    // → Stempel so groß zeichnen, dass der Punkt den Sternradius r bekommt.
    const k = STAR_SPRITE_SIZE / STAR_SPRITE_R;
    for (const st of stars) {
      const tw = still ? 0 : st.tw * (0.5 + 0.5 * Math.sin(clock * st.f + st.ph));
      ctx.globalAlpha = st.a * (1 - tw);
      const d = st.r * k;
      ctx.drawImage(starSprite, st.x - d / 2, st.y - d / 2, d, d);
    }
  }

  /** Wolkenschleier: vorgezeichnete Wolken stempeln und langsam weiterschieben */
  function drawClouds(clouds, dt, still) {
    // Die Durchsichtigkeit steckt schon in der vorgezeichneten Fläche
    ctx.globalAlpha = 1;
    for (const c of clouds) {
      if (!still) {
        c.x += c.vx * dt;
        // rechts/links hinausgezogen → auf der anderen Seite wieder herein
        const half = c.w;
        if (c.vx > 0 && c.x - half > W) c.x = -half;
        if (c.vx < 0 && c.x + half < 0) c.x = W + half;
      }
      if (c.layer) ctx.drawImage(c.layer, c.x + c.ox, c.y + c.oy, c.lw, c.lh);
    }
  }

  /** Nebelbänder: wabern langsam hin und her und „atmen“ in der Helligkeit */
  function drawFog(bands, still) {
    if (!sprite) return;
    for (const b of bands) {
      const t = still ? 0 : clock;
      const x = b.cx + Math.sin(t * b.f * 2 * Math.PI + b.ph) * b.amp;
      const y = b.y + Math.sin(t * b.f * 1.3 + b.ph) * H * 0.015;
      ctx.globalAlpha = b.alpha * (0.8 + 0.2 * Math.sin(t * 0.25 + b.ph * 2));
      ctx.drawImage(sprite, x - b.w / 2, y - b.h / 2, b.w, b.h);
    }
  }

  /**
   * Regentropfen als kurze Striche. Alle Striche einer Tiefe werden in EINEM
   * Pfad gesammelt und mit einem einzigen stroke() gezeichnet (schnell!).
   */
  function drawDrops(s, dt) {
    const { sinA, cosA } = s;
    const pad = Math.abs((sinA / cosA) * H) + 30;   // Rand, damit schräger Regen den ganzen Schirm füllt
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgb(" + s.dropRGB + ")";
    for (let layer = 0; layer < 3; layer++) {
      ctx.globalAlpha = s.dropAlpha[layer];
      ctx.lineWidth = s.dropWidth[layer];
      ctx.beginPath();
      for (const d of s.drops) {
        if (d.layer !== layer) continue;
        d.x += d.v * sinA * dt;
        d.y += d.v * cosA * dt;
        if (d.y - d.len > H) {
          // unten heraus → oben neu starten, an zufälliger Stelle
          d.y = -Math.random() * 60;
          d.x = -pad + Math.random() * (W + 2 * pad);
        } else if (d.x < -pad) {
          d.x += W + 2 * pad;
        } else if (d.x > W + pad) {
          d.x -= W + 2 * pad;
        }
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * sinA, d.y - d.len * cosA);
      }
      ctx.stroke();
    }
  }

  /** Hagel: fällt schnell, springt unten einmal kurz hoch, dann neu oben */
  function drawHail(hail, dt) {
    const GRAVITY = 2400;   // px/s² – nur für den kleinen Hüpfer
    ctx.fillStyle = "rgb(238, 246, 255)";
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (let i = 0; i < hail.length; i++) {
      const h = hail[i];
      if (h.bounced) h.vy += GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      if (!h.bounced && h.y >= H - h.r) {
        // Aufprall am unteren Rand: kleiner Hüpfer nach oben (ca. 10–20 px)
        h.y = H - h.r;
        h.vy = -h.vy * between(Math.random, 0.16, 0.24);
        h.vx = between(Math.random, -60, 60);
        h.bounced = true;
      } else if (h.bounced && h.y > H + h.r) {
        hail[i] = newHailstone(Math.random, false);
        continue;
      }
      ctx.moveTo(h.x + h.r, h.y);
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  /** Schneeflocken: fallen langsam und taumeln seitlich (Sinus-Schwingung) */
  function drawFlakes(s, dt) {
    const flakes = s.flakes;
    if (s.grains) {
      // Schneegriesel: kleine, klare Körner – einfache Kreise reichen
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
    }
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.bx += s.snowDrift * dt;
      if (f.y - f.r > H) {
        f.y = -f.r - Math.random() * 30;
        f.bx = Math.random() * W;
      }
      if (f.bx < -20) f.bx += W + 40;
      else if (f.bx > W + 20) f.bx -= W + 40;
      const x = f.bx + Math.sin(clock * f.f + f.ph) * f.amp;
      if (s.grains) {
        ctx.moveTo(x + f.r, f.y);
        ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
      } else if (sprite) {
        // weicher Fleck, etwa doppelt so groß wie der Radius → zarter Rand
        ctx.globalAlpha = f.a;
        const d = f.r * 3;
        ctx.drawImage(sprite, x - d / 2, f.y - d / 2, d, d);
      }
    }
    if (s.grains) {
      ctx.globalAlpha = flakes.length ? flakes[0].a : 0.5;
      ctx.fill();
    }
  }

  /**
   * Blitze: alle 6–15 Sekunden (zufällig) hellt sich der ganze Hintergrund
   * sanft auf – ein- oder zweimal kurz hintereinander („Flackern“).
   */
  function drawLightning(s) {
    if (!s.flash && clock >= s.nextFlash) {
      const peak = between(Math.random, 0.1, 0.16);
      const pulses = [{ at: 0, dur: 0.28, peak }];
      if (Math.random() < 0.6) {
        pulses.push({ at: between(Math.random, 0.18, 0.35), dur: 0.45, peak: peak * between(Math.random, 0.6, 0.9) });
      }
      s.flash = { start: clock, pulses };
    }
    if (!s.flash) return;

    const t = clock - s.flash.start;
    let a = 0;
    let busy = false;
    for (const p of s.flash.pulses) {
      const u = t - p.at;
      if (u < 0) { busy = true; continue; }
      if (u > p.dur) continue;
      busy = true;
      // schnell an (60 ms), dann weich ausklingen
      const env = u < 0.06 ? u / 0.06 : Math.pow(1 - (u - 0.06) / (p.dur - 0.06), 2);
      a = Math.max(a, p.peak * env);
    }
    if (!busy) {
      s.flash = null;
      s.nextFlash = clock + between(Math.random, 6, 15);
      return;
    }
    if (a > 0.002) {
      // oben etwas heller als unten – wie Licht hinter den Wolken
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(" + RGB_FLASH + ",1)");
      grad.addColorStop(1, "rgba(" + RGB_FLASH + ",0.4)");
      ctx.globalAlpha = a;
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ------------------------------------------------------------------
  // Animationsschleife: Start, Stopp, Drosselung (30 bzw. 10 fps)
  // ------------------------------------------------------------------

  /** Darf gerade animiert werden? */
  function canAnimate() {
    return !!scene && !reducedMotion && !document.hidden;
  }

  /**
   * Gewünschter Abstand zwischen zwei Bildern für die aktuelle Szene:
   * schnell (30 fps), wenn etwas fällt oder gerade ein Blitz leuchtet,
   * sonst ruhig (10 fps).
   */
  function frameInterval() {
    const s = scene;
    if (s && (s.drops.length || s.flakes.length || s.hail.length || s.flash)) return FRAME_MS_FAST;
    return FRAME_MS_CALM;
  }

  function tick(ts) {
    rafId = 0;
    try {
      if (!lastTs) {           // erstes Bild nach (Neu-)Start
        lastTs = ts;
        drawFrame(0, false);
      } else {
        const elapsed = ts - lastTs;
        // Drosselung: erst zeichnen, wenn genug Zeit vergangen ist.
        // (Die 2 ms Toleranz verhindern, dass bei 60 Hz jedes 3. statt 2. Bild kommt.)
        if (elapsed >= frameInterval() - 2) {
          lastTs = ts;
          // dt begrenzen: nach einem Ruckler springen die Teilchen nicht weit
          drawFrame(Math.min(elapsed / 1000, 0.25), false);
        }
      }
      scheduleNext();
    } catch (e) {
      // Sollte beim Zeichnen etwas schiefgehen: still aufhören statt Fehlerflut
      stop();
    }
  }

  /**
   * Nächstes Bild bestellen. Bei 30 fps fragen wir einfach bei jedem
   * Bildschirm-Takt (requestAnimationFrame) nach. In ruhigen Szenen (10 fps)
   * wäre das Verschwendung – das Skript würde 60× pro Sekunde geweckt, nur um
   * meistens nichts zu tun. Dort warten wir mit setTimeout, bis das nächste
   * Bild fast fällig ist, und bestellen erst dann den Bildschirm-Takt.
   */
  function scheduleNext() {
    if (!canAnimate()) return;
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    const wait = frameInterval() - (now - lastTs);
    if (wait > 50) {
      timerId = setTimeout(() => {
        timerId = 0;
        if (canAnimate()) rafId = requestAnimationFrame(tick);
      }, wait - 10);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  function start() {
    if (rafId || timerId || !canAnimate()) return;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    if (timerId) clearTimeout(timerId);
    rafId = 0;
    timerId = 0;
  }

  /**
   * Nach jeder Änderung (neues Wetter, Größe, Sichtbarkeit, Bewegungs-
   * Einstellung) entscheiden: animieren, Standbild zeigen oder pausieren.
   */
  function refresh() {
    try {
      if (canAnimate()) {
        start();
      } else {
        stop();
        // Bei „Bewegung reduzieren“ ein ruhiges Standbild zeigen.
        // (Ist der Tab nur versteckt, bleibt das letzte Bild einfach stehen.)
        if (reducedMotion && ctx) drawFrame(0, true);
      }
    } catch (e) { /* nie werfen */ }
  }

  // ------------------------------------------------------------------
  // Größe des Canvas an den Bildschirm anpassen
  // ------------------------------------------------------------------

  /**
   * Zeichenfläche (echte Pixel) an Größe und Auflösung anpassen.
   * Das Canvas bekommt „echte“ Pixel (CSS-Größe × Auflösung), damit es auf
   * Retina-Bildschirmen scharf ist. Gezeichnet wird weiter in CSS-Pixeln
   * (setTransform in drawFrame skaliert automatisch).
   * Ruhige, weiche Szenen kommen mit Auflösung 1 aus (siehe buildScene).
   * Liefert true, wenn sich etwas geändert hat. Achtung: Jede Änderung von
   * canvas.width/height löscht den Inhalt – danach sofort neu zeichnen!
   */
  function applyCanvasSize() {
    scale = scene && scene.soft ? Math.min(dpr, 1) : dpr;
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    if (canvas.width === cw && canvas.height === ch) return false;
    canvas.width = cw;
    canvas.height = ch;
    return true;
  }

  /** Nach einer Änderung der Zeichenfläche sofort ein Bild malen (kein Leerbild). */
  function redrawNow() {
    if (ctx && scene && !document.hidden) drawFrame(0, reducedMotion);
  }

  function resize() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width || window.innerWidth || 0);
    const h = Math.round(rect.height || window.innerHeight || 0);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (w === W && h === H && ratio === dpr) return;

    // Nur die Höhe hat sich ein wenig geändert (Breite und Pixeldichte gleich)?
    // Das passiert auf dem iPhone ständig: Safari blendet beim Scrollen seine
    // Leiste ein und aus. Dann behalten wir die Szene – sonst würden Wolken
    // springen und kurz ein leeres Bild erscheinen. Wir vergleichen mit der
    // Höhe beim letzten Aufbau, damit sich viele kleine Änderungen nicht
    // unbemerkt zu einer großen aufsummieren.
    const onlyHeight = scene && w === W && ratio === dpr &&
      w === builtW && Math.abs(h - builtH) < HEIGHT_TOLERANCE;

    const oldH = H;
    W = w; H = h; dpr = ratio;

    if (onlyHeight) {
      if (H < oldH) clampToHeight(scene);
      applyCanvasSize();
      redrawNow();      // gleiche Szene sofort wieder zeigen (Größenänderung hat gelöscht)
      refresh();
      return;
    }

    buildScene();     // Positionen hängen von der Größe ab → neu aufbauen
    applyCanvasSize();
    redrawNow();
    refresh();
  }

  /**
   * Nach dem Schrumpfen der Höhe: Teilchen, die jetzt unterhalb des Bildes
   * liegen, auf eine zufällige Höhe im sichtbaren Bereich verteilen. (Sonst
   * würden sie alle gleichzeitig oben neu starten – eine sichtbare „Welle“.)
   */
  function clampToHeight(s) {
    for (const d of s.drops) if (d.y - d.len > H) d.y = Math.random() * H;
    for (const f of s.flakes) if (f.y - f.r > H) f.y = Math.random() * H;
    for (const h of s.hail) {
      if (h.y > H) { h.y = Math.random() * H; h.bounced = false; h.vx = 0; h.vy = between(Math.random, 950, 1250); }
    }
  }

  let resizeQueued = false;
  function queueResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    // Mehrere resize-Ereignisse kurz hintereinander zu einem zusammenfassen
    requestAnimationFrame(() => {
      resizeQueued = false;
      try { resize(); } catch (e) { /* nie werfen */ }
    });
  }

  // ------------------------------------------------------------------
  // Wetterangaben übernehmen
  // ------------------------------------------------------------------

  /** Neue Angaben setzen; baut die Szene nur neu, wenn sich etwas geändert hat. */
  function setParams(next) {
    const key = JSON.stringify(next);
    if (key === paramsKey && scene) return;
    params = next;
    paramsKey = key;
    buildScene();
    // Ruhige/bewegte Szene kann eine andere Auflösung brauchen → ggf. anpassen
    // und dann sofort zeichnen, damit kein leeres Bild aufblitzt.
    if (canvas && applyCanvasSize()) redrawNow();
    refresh();
  }

  /** Rückfall-Modus: Gruppe und Tag/Nacht aus den body-Klassen lesen */
  function readBodyClasses() {
    if (updateCalled || !document.body) return;
    let group = null;
    for (const cls of document.body.classList) {
      if (cls.indexOf("wx-") === 0 && DEFAULT_CODE.hasOwnProperty(cls.slice(3))) {
        group = cls.slice(3);
      }
    }
    if (!group) group = "cloudy";
    setParams({
      group,
      code: DEFAULT_CODE[group],
      isDay: !document.body.classList.contains("is-night"),
      windSpeed: null,
      windDir: null,
      precip: null,
    });
  }

  /**
   * Öffentliche Funktion: genaue Wetterangaben übernehmen.
   * Ab dem ersten Aufruf ignorieren wir die body-Klassen (der Beobachter wird
   * abgeschaltet) – die Angaben hier sind genauer (Wind, Menge, genauer Code).
   */
  function update(info) {
    try {
      info = info || {};
      if (!ctx) { pending = info; return; }    // noch nicht bereit → merken

      updateCalled = true;
      if (observer) { observer.disconnect(); observer = null; }

      const code = num(info.code);
      const group = groupOf(code);
      // isDay: true/1 = Tag, false/0 = Nacht; fehlt die Angabe, entscheidet die body-Klasse
      let isDay;
      if (info.isDay === true || info.isDay === 1) isDay = true;
      else if (info.isDay === false || info.isDay === 0) isDay = false;
      else isDay = !(document.body && document.body.classList.contains("is-night"));

      setParams({
        group,
        code: code !== null ? code : DEFAULT_CODE[group],
        isDay,
        windSpeed: num(info.windSpeed),
        windDir: num(info.windDir),
        precip: num(info.precip),
      });
    } catch (e) { /* nie werfen */ }
  }

  /** Diagnose für Tests: was läuft gerade? (verändert nichts) */
  function info() {
    const s = scene || { drops: [], flakes: [], hail: [], stars: [], clouds: [], fog: [] };
    return {
      ready: !!ctx,
      source: updateCalled ? "update" : "body",
      group: params ? params.group : null,
      code: params ? params.code : null,
      isDay: params ? params.isDay : null,
      running: !!(rafId || timerId),
      reducedMotion,
      frames,
      builds,
      fps: scene ? Math.round(1000 / frameInterval()) : 0,
      size: { w: W, h: H, dpr, scale },
      counts: {
        drops: s.drops.length, flakes: s.flakes.length, hail: s.hail.length,
        stars: s.stars.length, clouds: s.clouds.length, fog: s.fog.length,
      },
    };
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------

  function init() {
    try {
      canvas = document.getElementById("wx-effects");
      if (!canvas || typeof canvas.getContext !== "function") return;
      ctx = canvas.getContext("2d");
      if (!ctx) return;
      sprite = makeSprite();
      starSprite = makeStarSprite();

      // „Bewegung reduzieren“ beachten – und auf Änderungen reagieren
      if (window.matchMedia) {
        motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        reducedMotion = motionQuery.matches;
        const onMotionChange = () => { reducedMotion = motionQuery.matches; refresh(); };
        if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
        else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);  // ältere Safari
      }

      // Tab/App im Hintergrund → Pause; wieder sichtbar → weiter
      document.addEventListener("visibilitychange", refresh);

      // Größenänderung und Drehen des Geräts. iOS meldet nach dem Drehen
      // manchmal erst etwas später die neue Größe – daher zusätzlich verzögert.
      window.addEventListener("resize", queueResize);
      window.addEventListener("orientationchange", () => {
        queueResize();
        setTimeout(queueResize, 350);
      });

      resize();

      if (pending) {
        // update() wurde schon vor dem Start aufgerufen
        const p = pending;
        pending = null;
        update(p);
      } else {
        // Rückfall: auf die body-Klassen schauen, bis update() kommt
        readBodyClasses();
        if (window.MutationObserver && document.body) {
          observer = new MutationObserver(readBodyClasses);
          observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        }
      }
    } catch (e) {
      // Irgendetwas ging schief → einfach ohne Effekte weiter
      stop();
      ctx = null;
    }
  }

  // Öffentliche Schnittstelle – existiert immer, auch wenn das Canvas fehlt
  Wetter.effects = { update, info };

  // Das Skript steht am Ende von <body>, das Canvas existiert also schon.
  // Zur Sicherheit trotzdem auf das fertige Dokument warten, falls nötig.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
