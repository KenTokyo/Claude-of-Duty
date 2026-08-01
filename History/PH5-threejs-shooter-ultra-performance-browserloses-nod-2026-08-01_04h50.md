# PH5 - Three.js-Shooter Ultra-Performance - Browserloses Node-CLI-Messsystem...

> 2026-08-01T02:50:56.251Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH5)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` muss vollständig performance-optimiert werden — auch auf Ultra — **ohne** Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). Erst nach Abschluss sollen zwei separate Test-Agenten (Performance / Visuals+Gameplay) gegentesten, die die Änderungen nicht selbst gemacht haben.

## 2. Was wurde bereits erledigt

**Die harte neue Randbedingung: KEIN BROWSER, in keiner Form.** Der User hat das mehrfach und ausdrücklich verschärft: kein Playwright, kein Headless, auch **kein Headed** — sein Laptop stürzt sonst ab. Die letzte Zeile des Auftrags in `Notes/optimize-game-loop-current-notes.md` sagt dasselbe. Alle 22 Tools in `tools/*.mjs` starten aber Chromium und sind damit **ab sofort unbenutzbar**. Ersatz wurde gebaut (siehe unten).

**Point-Light-Early-Out ist BESTÄTIGT und fertig — diese Messung nicht wiederholen.**
- Gemessen mit `tools/ab-gpu.mjs` auf echter GPU-Zeit, **bevor** die Kein-Browser-Regel kam. Drei unabhängige Läufe: 3.345 / 2.976 / 3.001 ms.
- Endergebnis: **medianDeltaMs 2.966, paired IQR 1.821, winRate 0.963, signTestZ 16.02** bei n=299 Paaren. Das ist eindeutig. **~3.0 ms GPU-Forward-Zeit bei Ultra/3.34 MP, ≈8 %.**
- Zwei Bugs in `ab-gpu.mjs` dabei gefunden und gefixt: (a) die Settle-Schleife ließ `record=true`/`state='off'` stehen und kippte 234 Extra-Samples in den `off`-Topf (`off.n=294` gegen `on.n=60`); (b) der Vergleich Median-gegen-IQR ist der falsche Test — jetzt paart das Tool benachbarte Frames und rechnet Vorzeichentest, das ist die richtige Statistik für ein Frame-alternierendes Design.
- **Nebenbefund von hohem Wert:** headless lieferte Spread 109.8 ms, headed IQR 1.1–1.5 ms. Die gesamte Messstreuung der Vorschichten war ein Headless-Artefakt.

**Konsequenz für `pointLightSlots`: bleibt bei 20.** Tote Slots kosten mit dem Early-Out fast nichts mehr, die Sicherheitsmarge bleibt. Gemessener Peak gleichzeitiger Lichter ist 14 (`tools/lightcount.mjs`, 1.1 M Samples), 12 würde nur den Ratchet in `world/index.js:306` auslösen. **Ballast-System in keinem Fall abschalten.**

**Neu gebaut: ein vollständiges browserloses CLI-Messsystem in `tools/cli/`.** Es bootet die **echte** Engine in Node gegen einen aufzeichnenden WebGL2-Mock — gleiche Engine, gleiche Systeme, gleiche Config, gleiche Weltgenerierung. Boot dauert 4.3 s, `unmodelledGlCalls` ist leer (der Mock ist für diese Last vollständig).
- `dom-shim.mjs` — DOM/Canvas/Audio-Shim. Node besitzt `navigator` als Getter, daher wird jedes Global einzeln per `defineProperty` gesetzt. Der Quelltext ruft `addEventListener` (21×), `innerWidth` (14×), `location.search` (9×) **bar ohne `window.`** — die müssen als echte Globals existieren.
- `gl-mock.mjs` — WebGL2-Mock mit **echten** GL-Konstantenwerten (three vergleicht nicht überall gegen `gl.<CONST>`). Zählt Draw-Calls, Dreiecke, Programme, Programmwechsel, VRAM pro Objekt, GL-Objekt-Lebensdauer. Ein Proxy vivifiziert Unbekanntes zu No-Ops und listet es unter `unknownCalls`, statt zu crashen.
- `harness.mjs` — pumpt Frames deterministisch über `engine.step(t)` mit synthetischen Timestamps.
- `cod.mjs` — CLI mit `probe`, `shaders`, `fingerprint`, `diff`, `leak`, `systems`, `passes`.

**Erste Messergebnisse aus dem neuen System (Ultra, Stage `firefight`):**
- **CPU 7.6–8.0 ms/Frame** — davon **7.48 ms allein in `render.render`**. Gameplay zusammen nur ~2.4 ms (physics 1.10, ai 0.76, Rest < 0.2).
- Pass-Aufschlüsselung: **`csm.render` 3.88 ms CPU bei 928 Draw-Calls**, `forward(world)` 1.21 ms bei 156 Calls, `gbuffer(prepass)` 0.73 ms bei 140 Calls, `forward(viewmodel)` 0.58 ms bei 114 Calls. **Die vier Schattenkaskaden sind 67 % aller Draw-Calls.**
- **1377 Draw-Calls, 9.37 M Dreiecke, 307 Programmwechsel/Frame.**
- **100 Shader-Programme** — ANGLEs Metal-Pipeline-Cache fasst 64. **36 darüber.** Das erklärt die „Overflowed the render pipeline cache limit"-Warnung der Vorschicht und ist ein echter Stall-Verdacht.
- **822 MB GPU-Speicher** (Texturen 543, Renderbuffer 207, Buffer 72).
- Live-GL-Objekte: 1430 Buffer, 469 VAOs, 132 Texturen, 130 Framebuffer, 100 Programme.

**Achtung, ein Messartefakt im `passes`-Output:** die Zeile `renderer.render(other)` mit 4.64 ms / 1103.7 Draw-Calls / 40.99 Calls pro Frame ist **keine eigene Phase**, sondern enthält die CSM-Kaskaden doppelt — `csm.render` ruft intern `renderer.render` je Kaskade auf, und beide Wrapper zählen mit. Nicht addieren. Die Zuordnung müsste um ein „bereits gezählt"-Flag ergänzt werden.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **`renderer.render(other)`-Doppelzählung in `cmdPasses` (`tools/cli/cod.mjs`) reparieren**, sonst ist jede Pass-Zahl irreführend. Ein Reentranz-Zähler reicht: wenn `csm.render` gerade läuft, die inneren `renderer.render`-Aufrufe nicht separat verbuchen.
2. **Software-Rasterizer bauen — `tools/cli/raster.mjs` (Task #6, noch nicht angefangen).** Der User verlangt ausdrücklich ein CLI-Screenshot-System für die Qualitätskontrolle. `pngjs` ist bereits Dependency. Zwei Zwecke: (a) echte PNG-Shots aus Szenengraph + Kamera für visuelle QC, (b) **Overdraw-Statistik der opaken Geometrie — die sagt die Größe des Depth-Prepass-Gewinns direkt voraus.** Auf ~480×312 rastern und Dreiecke subsamplen, sonst zu langsam. `shot` und `overdraw` als Subcommands in `cod.mjs` einhängen (im Usage-String stehen sie schon, implementiert sind sie nicht).
3. **Visuelles Gate für den Early-Out über `cod.mjs fingerprint` + `diff` fahren** (Task #2). Das alte Pixel-Gate über `shotset.mjs`/`imagediff.mjs` ist wegen der Browser-Regel tot. Ablauf: `git stash push -- <konkrete Dateiliste>` → `fingerprint --out=/tmp/base.json` → `git stash pop` → `fingerprint --out=/tmp/opt.json` → `diff --a= --b=`. Der Early-Out ist bit-exakt hergeleitet, also müssen `drawStreamHash` und `sceneHash` **identisch** sein; `shaderSetHash` darf abweichen (der Guard steht im Shader-Text). **Niemals pauschales `git stash`** — sonst verlierst du den Adaptive-Fix in `src/render/adaptive.js` und die fremden Start-Screen-Änderungen in `index.html`, `src/global.css`, `src/main.js`.
4. **Die 100 Shader-Programme senken (neuer, gut belegter Hebel).** 36 über ANGLEs 64er-Limit; `cod.mjs shaders` liefert `uniqueFragmentShaders: 91` und pro Programm `numPointLights`/`numDirLights`/`fragTextureFetches`. Permutationen zusammenlegen ist reine CPU-Arbeit und ohne GPU verifizierbar.
5. **Depth-Prepass-Wiederverwendung** (Task #3) — Analyse der Vorschicht gilt unverändert: `_visit` (`render/index.js:1071`) hält Transparente und `owNoPrepass` schon draußen, `hdrRt` ist nicht MSAA und größengleich. Blocker bleibt Foliage (`materials/library.js:334-335`, `alphaTest: 0.45`, Konsumenten `palm_frond`/`shrub`/`weeds` in `world/props.js:980-982`) — **zwei Overrides in zwei Durchgängen**, nicht ein `discard` für alle. Danach `gbuffer.setSize` in `resize()` vor die `hdrRt`-Erzeugung, `hdrRt` mit `depthTexture`, Zeile 1520 nur noch Farbe clearen, vorher `invariant gl_Position` in **beiden** Shadern (Prepass GLSL3 vs. Stock GLSL ES 1.00). **Erst Overdraw messen (Punkt 2), dann entscheiden.**
6. **CSM-CPU-Kosten angehen** — 3.88 ms CPU und 928 Draw-Calls für vier Kaskaden ist der größte CPU-Posten überhaupt. Kaskaden-Culling und Wiederverwendung statischer Kaskaden prüfen. **Nicht anfassen:** die 32-Texel-Marge im Cylinder-Cull von `csm.js`.
7. **Leak-Test fahren:** `node tools/cli/cod.mjs leak --q=ultra --frames=3000`. Ist implementiert, aber **noch nie gelaufen**. Deckt die Auftragsforderung „prolonged gameplay must not cause increasing lag or memory usage" ab.
8. **Alle vier Presets neu messen** (Task #4) über das Node-CLI. **Warnung:** `cmdPresets` hat ein `break` nach dem ersten Preset, weil der DOM-Shim prozessweit nur einmal installiert wird — Presets müssen in **getrennten Node-Prozessen** laufen. Ein Shell-Wrapper fehlt noch. Alle alten fps-Zahlen (low 132 / medium 56 / high 29 / ultra 23; Ultra 30 nach Batch 1) stammen aus Headless-Läufen und sind **verdächtig**.
9. **`pnpm build` grün halten.** `node tools/capture.mjs` ist laut `ARCHITECTURE.md` Pflicht, startet aber einen Browser — **Konflikt mit der User-Anweisung; die User-Anweisung gewinnt.** Ersatz ist `cod.mjs fingerprint`.
10. **Aufräumen und Erwartungsmanagement** (Task #5): `tools/_navcheck.mjs` und `tools/_smoke.mjs` löschen. Dem User sagen, wo die Grenze liegt: 60 fps bei Ultra/3.34 MP bräuchte bei ~10 ms Fixkosten ~2 ms/MP statt gemessener 15.9 — Faktor 8, das ist eine Neuentwicklung. **Ganz zum Schluss** die zwei Test-Agenten fan-outen.

## 4. Risiken & Edge Cases

- **Die Browser-Regel ist absolut.** Ich habe zu Beginn dieser Schicht noch headed Chromium laufen lassen (bevor die Verschärfung kam) und dafür `tools/launch.mjs` gebaut, das alle Tools auf headed umstellt. **Das ist jetzt obsolet und darf nicht benutzt werden.** Entweder `launch.mjs` löschen oder klar als tot markieren.
- **Der Node-Harness misst nur CPU. Fragment-Kosten gibt es dort nicht.** Jede GPU-Aussage muss aus dem kalibrierten Modell kommen (`frame = 10 ms + 15.9 ms/MP`, plus die bestätigten 3.0 ms des Early-Outs) und **als modelliert gekennzeichnet** werden, nicht als gemessen.
- **`getProgramParameter` liefert 0 aktive Uniforms**, also sind Uniform-Uploads im Mock No-Ops. Für Draw-Stream, Zählungen und Allokationen ist das folgenlos — aber **jede Optimierung, die nur Uniform-Werte ändert, ist im Harness unsichtbar.** Genau deshalb ist die Early-Out-Messung nicht wiederholbar.
- **`boot()` ist pro Prozess nur einmal aufrufbar** (`installDom` ist idempotent und gibt beim zweiten Aufruf den alten Handle zurück). Mehrere Qualitätsstufen ⇒ mehrere Prozesse.
- **Ein Fremdprozess läuft mit:** `chrome-devtools-mcp` spawnt laufend `chrome-headless-shell` (4 Prozesse, 645 MB, respawnend). Nicht von mir, nicht angefasst — aber ein plausibler Mitverursacher der Laptop-Last, über die der User klagt. Erwähnenswert.
- **GLSL steht in JS-Template-Literals — ein Backtick in einem Shader-Kommentar bricht den Build.** In der Vorschicht genau einmal passiert.
- **`withPointLightSkip` deaktiviert sich leise** (nur `[materialpatch]`-Konsolenwarnung), wenn ein three-Upgrade `lights_fragment_begin` verschiebt. `PATCH_VERSION` steht auf 11.
- **`tools/gpu-pass-profile.mjs` hat einen Vorbestand-Bug:** trennt den Forward-Pass über `r.csm.__inCsm`, **dieses Flag existiert nirgends**. Alle Zahlen daraus sind Kaskaden+Forward gemittelt. Nicht repariert, und ohnehin ein Browser-Tool.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()` (trägt den `depth > 0`-Vertrag von GTAO/Contact/SSR), 32-Texel-Marge im CSM-Cylinder-Cull. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048 → 1536 bei Ultra. **Bewusst so:** `contactScale: 1`, `minRenderScale: 0.65` bei Ultra.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut, inklusive der Kein-Headless-Zeile und der Forderung nach den zwei Test-Agenten.
- `ARCHITECTURE.md` — Engine-Vertrag; seine `capture.mjs`-Pflicht kollidiert mit der Browser-Regel.
- `tools/cli/gl-mock.mjs` — **Herzstück.** Echte GL-Konstanten, Draw-/VRAM-/Objekt-Buchhaltung, Proxy-Auffangnetz.
- `tools/cli/dom-shim.mjs` — Globals per `defineProperty`, `search`-Option ersetzt die alte URL-Query.
- `tools/cli/harness.mjs` — `boot()` + `run()`, deterministische Frames über `engine.step(t)`.
- `tools/cli/cod.mjs` — die CLI. `cmdPasses` hat die Doppelzählung, `cmdPresets` das `break`, `shot`/`overdraw` fehlen noch.
- `src/render/materialpatch.js` — der Early-Out: `POINT_SKIP_PARS`, `withPointLightSkip()`, Uniform `owLightSkip`, `PATCH_VERSION = 11`.
- `tools/ab-gpu.mjs` — jetzt mit Paar-Statistik und Settle-Fix; **Browser-Tool, nur noch als Beleg**.
- `tools/launch.mjs` — von mir gebaut, durch die Verschärfung obsolet.
- `src/render/index.js` — `render()` 1380, Forward 1519-1521, `resize()` ab 964, `_visit`/`_collect` ab 1053.
- `src/core/config.js` — `pointLightSlots` 20, `aoScale` 0.5, `contactScale` 1.

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md` — flüssig auch auf Ultra, ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed. Der User hat das mehrfach verschärft, sein Laptop stürzt sonst ab. Alle 22 Tools in `tools/*.mjs` starten Chromium und sind damit unbenutzbar — auch `capture.mjs`, dessen Pflicht in `ARCHITECTURE.md` hier von der User-Anweisung überstimmt wird. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut.

**Benutze stattdessen das browserlose CLI `tools/cli/cod.mjs`.** Es bootet die echte Engine in Node gegen einen aufzeichnenden WebGL2-Mock (Boot 4.3 s, `unmodelledGlCalls` leer). Befehle: `probe`, `systems`, `passes`, `shaders`, `fingerprint`, `diff`, `leak`. Beispiel: `node tools/cli/cod.mjs passes --q=ultra --frames=240 2>/dev/null`. Es misst **nur CPU** — Fragment-Kosten existieren dort nicht, jede GPU-Aussage muss aus dem kalibrierten Modell kommen (`frame = 10 ms + 15.9 ms/MP`) und als modelliert gekennzeichnet werden.

**Erledigt und nicht zu wiederholen:** Der Point-Light-Early-Out in `src/render/materialpatch.js` (`withPointLightSkip()`, Uniform `owLightSkip`, `PATCH_VERSION 11`) ist bestätigt — 2.966 ms Median-Paardifferenz, winRate 0.963, signTestZ 16.02, drei übereinstimmende Läufe. Deshalb bleibt `pointLightSlots` bei 20 (gemessener Peak gleichzeitiger Lichter ist 14, tote Slots kosten jetzt fast nichts, Marge bleibt). Ballast-System nicht abschalten.

Arbeite in dieser Reihenfolge:

1. **Repariere die Doppelzählung in `cmdPasses`** (`tools/cli/cod.mjs`): `csm.render` ruft intern `renderer.render` je Kaskade auf, beide Wrapper zählen mit, deshalb steht dort eine Phantomzeile `renderer.render(other)` mit 4.64 ms und 1103.7 Draw-Calls. Reentranz-Flag setzen.
2. **Baue `tools/cli/raster.mjs`** — CPU-Rasterizer über Szenengraph und Kamera. Zwei Zwecke: PNG-Shots für die vom User geforderte visuelle QC (`pngjs` ist Dependency) und **Overdraw-Statistik der opaken Geometrie**, die den Depth-Prepass-Gewinn direkt vorhersagt. Auf ~480×312 rastern. `shot` und `overdraw` in `cod.mjs` einhängen — im Usage-String stehen sie schon.
3. **Fahre das visuelle Gate** über `fingerprint` + `diff` statt des toten Pixel-Gates: `git stash push -- <konkrete Dateiliste>` (**niemals pauschales `git stash`**, sonst verlierst du den Adaptive-Fix in `src/render/adaptive.js` und die fremden Start-Screen-Änderungen in `index.html`/`src/global.css`/`src/main.js`), beide Arme fingerprinten, dann `diff`. `drawStreamHash` und `sceneHash` müssen identisch sein, `shaderSetHash` darf abweichen.
4. **Neuer, gut belegter Hebel: 100 Shader-Programme gegen ANGLEs 64er-Pipeline-Cache.** 36 darüber, 91 unique Fragment-Shader. Permutationen zusammenlegen ist reine CPU-Arbeit und ohne GPU verifizierbar. `cod.mjs shaders` liefert die Aufschlüsselung.
5. **Zweiter Hebel: CSM.** 3.88 ms CPU und 928 der 1377 Draw-Calls gehen für vier Kaskaden drauf — der größte CPU-Posten des Frames. Kaskaden-Culling und Wiederverwendung statischer Kaskaden prüfen. Die 32-Texel-Marge im Cylinder-Cull von `csm.js` nicht anfassen.
6. **Depth-Prepass-Wiederverwendung** erst nach der Overdraw-Messung. Blocker ist Foliage (`materials/library.js:334-335`, `alphaTest: 0.45`) — zwei Overrides in zwei Durchgängen, kein `discard` für alle. Dann `gbuffer.setSize` in `resize()` vor die `hdrRt`-Erzeugung, `hdrRt` mit `depthTexture`, `invariant gl_Position` in beiden Shadern.
7. **Fahre `node tools/cli/cod.mjs leak --q=ultra --frames=3000`** — implementiert, nie gelaufen, deckt die Auftragsforderung zu Langzeit-Speicher ab.
8. **Presets neu messen** in **getrennten Node-Prozessen** (`boot()` ist pro Prozess einmalig, `cmdPresets` hat deshalb ein `break`). Alle alten fps-Zahlen stammen aus Headless-Läufen und sind verdächtig.

Halte `pnpm build` grün. Vorsicht: GLSL steht in JS-Template-Literals, ein Backtick in einem Shader-Kommentar bricht den Build. Lösche zum Schluss `tools/_navcheck.mjs`, `tools/_smoke.mjs` und das durch die Browser-Regel obsolete `tools/launch.mjs`. Sag dem User früh, dass 60 fps bei Ultra und 3.34 MP mit diesem Feature-Set nicht erreichbar sind (Faktor 8 gegenüber der gemessenen Pixelrate), und stimme die Zielmarke ab. Ganz zum Schluss, erst wenn die Optimierung steht, fahre die zwei vom Auftrag geforderten Test-Agenten aus — einer Performance, einer visuelle Qualität und Gameplay-Regressionen.
