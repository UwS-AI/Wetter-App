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
 *   - höchstens ~30 Bilder pro Sekunde (requestAnimationFrame + Drosselung)
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

  /** Mindestabstand zwischen zwei Bildern in ms (1000 / 30 ≈ 33 → max. 30 fps) */
  const FRAME_MS = 1000 / 30;

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

  let params = null;     // aktuelle Wetterangaben { group, code, isDay, ... }
  let paramsKey = "";    // dieselben Angaben als Text – zum schnellen Vergleichen
  let scene = null;      // alle Teilchen/Ebenen der aktuellen Szene
  let clock = 0;         // eigene Uhr in Sekunden (läuft in Pausen nicht weiter)
  let frames = 0;        // Anzahl gezeichneter Bilder (nur für Tests/Diagnose)

  let rafId = 0;         // Nummer des angeforderten Animationsbilds (0 = keins)
  let lastTs = 0;        // Zeitstempel des letzten gezeichneten Bilds

  let reducedMotion = false;
  let motionQuery = null;

  let updateCalled = false;  // wurde update() schon einmal benutzt?
  let observer = null;       // beobachtet die body-Klassen (Rückfall-Modus)
  let pending = null;        // update()-Angaben, die vor init() kamen

  let sprite = null;     // vorgezeichneter weicher Lichtfleck (für Wolken, Nebel, Flocken)

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

  // ------------------------------------------------------------------
  // Szene aufbauen: aus den Wetterangaben werden Teilchen und Ebenen
  // ------------------------------------------------------------------

  /**
   * Baut die komplette Szene neu auf. Alte Teilchen werden dabei einfach
   * verworfen (der Garbage Collector räumt sie weg) – es sammelt sich nichts an.
   */
  function buildScene() {
    if (!params || !W || !H) { scene = null; return; }

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

    scene = s;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;

    if (!still) clock += dt;
    const s = scene;

    if (s.sun) drawSun(s.sun, still);
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

  /** Sanftes, langsam pulsierendes Sonnenglühen oben rechts */
  function drawSun(strength, still) {
    // Puls: alle ~9 Sekunden einmal etwas heller und wieder dunkler
    const pulse = still ? 1 : 0.88 + 0.12 * Math.sin((clock * 2 * Math.PI) / 9);
    const cx = W * 0.9;
    const cy = H * 0.03;
    const R = Math.max(W, H) * 0.55 * (0.97 + 0.03 * pulse);
    const a = 0.4 * strength * pulse;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, "rgba(" + RGB_SUN + "," + a.toFixed(3) + ")");
    grad.addColorStop(0.18, "rgba(" + RGB_SUN + "," + (a * 0.55).toFixed(3) + ")");
    grad.addColorStop(0.5, "rgba(" + RGB_SUN + "," + (a * 0.15).toFixed(3) + ")");
    grad.addColorStop(1, "rgba(" + RGB_SUN + ",0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  /** Sterne: kleine Punkte, manche funkeln leicht */
  function drawStars(stars, still) {
    ctx.fillStyle = "#ffffff";
    for (const st of stars) {
      const tw = still ? 0 : st.tw * (0.5 + 0.5 * Math.sin(clock * st.f + st.ph));
      ctx.globalAlpha = st.a * (1 - tw);
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Wolkenschleier zeichnen und langsam weiterschieben */
  function drawClouds(clouds, dt, still) {
    if (!sprite) return;
    for (const c of clouds) {
      if (!still) {
        c.x += c.vx * dt;
        // rechts/links hinausgezogen → auf der anderen Seite wieder herein
        const half = c.w;
        if (c.vx > 0 && c.x - half > W) c.x = -half;
        if (c.vx < 0 && c.x + half < 0) c.x = W + half;
      }
      ctx.globalAlpha = c.alpha;
      for (const p of c.puffs) {
        ctx.drawImage(sprite, c.x + p.dx - p.rx, c.y + p.dy - p.ry, p.rx * 2, p.ry * 2);
      }
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
  // Animationsschleife: Start, Stopp, Drosselung auf ~30 fps
  // ------------------------------------------------------------------

  /** Darf gerade animiert werden? */
  function canAnimate() {
    return !!scene && !reducedMotion && !document.hidden;
  }

  function tick(ts) {
    rafId = requestAnimationFrame(tick);
    try {
      if (!lastTs) {           // erstes Bild nach (Neu-)Start
        lastTs = ts;
        drawFrame(0, false);
        return;
      }
      const elapsed = ts - lastTs;
      // Drosselung: Bilder überspringen, bis ~33 ms vergangen sind.
      // (Die 2 ms Toleranz verhindern, dass bei 60 Hz jedes 3. statt 2. Bild kommt.)
      if (elapsed < FRAME_MS - 2) return;
      lastTs = ts;
      // dt begrenzen: nach einem Ruckler springen die Teilchen nicht weit
      drawFrame(Math.min(elapsed / 1000, 0.1), false);
    } catch (e) {
      // Sollte beim Zeichnen etwas schiefgehen: still aufhören statt Fehlerflut
      stop();
    }
  }

  function start() {
    if (rafId || !canAnimate()) return;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
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

  function resize() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width || window.innerWidth || 0);
    const h = Math.round(rect.height || window.innerHeight || 0);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (w === W && h === H && ratio === dpr) return;
    W = w; H = h; dpr = ratio;
    // Das Canvas bekommt „echte“ Pixel (CSS-Größe × Pixeldichte), damit es auf
    // Retina-Bildschirmen scharf ist. Gezeichnet wird weiter in CSS-Pixeln
    // (setTransform in drawFrame skaliert automatisch).
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    buildScene();     // Positionen hängen von der Größe ab → neu aufbauen
    refresh();
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
      running: !!rafId,
      reducedMotion,
      frames,
      size: { w: W, h: H, dpr },
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
