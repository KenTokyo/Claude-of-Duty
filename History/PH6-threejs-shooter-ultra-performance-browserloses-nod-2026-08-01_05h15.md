# PH6 - Three.js-Shooter Ultra-Performance - Browserloses Node-CLI-Messsystem...

> 2026-08-01T03:15:50.403Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH6)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` muss vollständig performance-optimiert werden — auch auf Ultra — **ohne** Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). Erst nach Abschluss der Optimierung sollen zwei separate Test-Agenten (einer Performance, einer Visuals+Gameplay) gegentesten, die die Änderungen nicht selbst gemacht haben.

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Kein Playwright, kein Headless, auch kein Headed. Alle 22 Tools in `tools/*.mjs` starten Chromium und sind unbenutzbar — auch `capture.mjs`, dessen Pflicht in `ARCHITECTURE.md` von der User-Anweisung überstimmt wird. `tools/launch.mjs` ist obsolet.

**Messsystem `tools/cli/` erweitert und repariert:**

- **`cmdPasses` Doppelzählung gefixt** (Task 1 erledigt). Statt flacher Akkumulation jetzt ein **Stack-Profiler** mit self-time/self-draws (`makeStackProfiler` in `cod.mjs`). Die Phantomzeile `renderer.render(other)` mit 4.64 ms ist weg; verschachtelte Aufrufe erscheinen als `↳ renderer.render <parent>`. Neue Felder `selfMsAccounted` / `selfDrawCallsAccounted` sind die Integritätsprüfung — die Self-Spalten dürfen die Frame-Zeit nie überschreiten.
- **`tools/cli/raster.mjs` neu gebaut** (Task 2 erledigt) — CPU-Rasterizer über den echten Szenengraph. Perspektivisch korrekt, Near-Plane-Clipping in Clip-Space, Z-Buffer, Backface-Cull nach `material.side`, Instancing, three's echte `painterSortStable`-Reihenfolge (renderOrder → **material.id** → z). 640×400 mit 2.3 M Dreiecken in **244 ms**. Auto-Belichtung über das 90. Perzentil der Geometrie-Pixel (Sky wird nicht mitgemessen).
- **Neue CLI-Befehle:** `shot` (PNG-QC), `overdraw` (Falschfarben + Statistik), `drawlist` (Szenenzusammensetzung + Batching-Analyse), `targets` (Framebuffer-Attachments).
- **`gl-mock.mjs` zeichnet jetzt Framebuffer-Attachments auf** (`rec.attachments`), vorher waren `framebufferTexture2D` & Co. No-Ops. Das ist die einzige Möglichkeit, Render-Target-Verdrahtung ohne GPU zu beweisen.

**Messergebnisse (Ultra, Stage `firefight`, Frame 90):**

- Baseline: 1377 Draw-Calls, 9.37 M Dreiecke, CPU median 8.02 ms. CSM 3.64 ms / 927.7 Draws, forward(world) 1.32 ms / 157, prepass 0.71 ms / 140, viewmodel 0.66 ms / 114.
- **Overdraw: `shadedPerPixel` 2.145, `depthPrepassSavesFragmentsPct` 53.4.** Ideales Front-to-Back käme nur auf 2.131 — `sortingCostsFragmentsPct` ist **0.7**, Sortierung ist also bereits ausgereizt und kein Hebel. Die Überzeichnung sitzt *innerhalb* einzelner Meshes (Fassade + eigene Fensterlaibungen), das kann nur ein gefüllter Depth-Buffer lösen.
- Szene: 242 Meshes, davon 187 bereits InstancedMesh, 1.95 M Dreiecke. **Die Welt ist bereits gut gebatcht** — Instancing/LOD sind kein offener Hebel mehr.

**Zwei Optimierungen implementiert:**

1. **`src/render/overridebatch.js` (neu) — Override-Pass-Batching.** three erzeugt pro Geometrie-*Group* einen Draw-Call, auch unter `scene.overrideMaterial`, wo alle Groups dieselbe Depth-Material bekommen. Gemessen: 6 Multi-Material-Meshes (die Soldaten, ~9 Slots) machen aus 242 Meshes 290 Draw-Calls — bezahlt 5× pro Frame (4 Kaskaden + Prepass). `OverrideBatcher.begin/end` tauscht das Material-Array für die Dauer des Passes gegen `mats[0]`, three nimmt dann seinen Single-Material-Zweig und zeichnet die ganze Index-Range in einem Call. Guard: Groups müssen den Index-Buffer exakt kacheln (gemessen: `meshesWhoseGroupsDoNotTile: 0`), alle Slots sichtbar und `allowOverride`. **Ergebnis: 1377 → 1153 Draw-Calls bei IDENTISCHER Dreieckszahl (9 367 815) — das ist der Beweis, dass dieselbe Geometrie eingereicht wird.** Eingehängt in `render/index.js` um `csm.render` und `gb.render`, jeweils mit `try/finally`.

2. **Depth-Prepass-Wiederverwendung (der große GPU-Hebel).** `GBuffer` besitzt jetzt eine echte `THREE.DepthTexture` (`hardwareDepth`) statt eines Renderbuffers; `hdrRt` bekommt in `resize()` dieselbe Textur, der Forward-Pass clearet nur noch Farbe (`renderer.clear(true, !this.reusePrepassDepth, false)`). **Per `cod.mjs targets` verifiziert: `texture#1255` (12.74 MB) hängt als `depth` an zwei Framebuffern (1251 = gbuffer, 1399 = hdrRt), `hdrSharesPrepassDepth: true`.**
   - **Foliage-Blocker gelöst:** `createPrepassMaterial(masked)` erzeugt zwei Varianten; die maskierte hat `discard` gegen `texture(owAlphaMap, uv*owTile.xy+owTile.zw).a < owAlphaTest` und ist DoubleSide. Zwei Materialien statt eines mit Uniform-Branch, weil ein `discard` dem Treiber Early-Z für das *ganze* Programm nimmt — Foliage sind 3 Draws, die anderen 89 dürfen das nicht bezahlen. Belegt in `shader.js`: alle Albedo-Manipulationen fassen nur `alb.rgb` an, `owAlbedo.a` ist der rohe Sample, also ist der Test exakt reproduzierbar (nur für `uvMode: 'mesh'` ohne Parallax — `canPrepassAlphaTest()` prüft das, alles andere fällt sicher nach `_hide` statt approximiert zu werden).
   - **Sicherheits-Bias `OW_PREPASS_DEPTH_BIAS = 0.0012`** (relativ auf `mvPosition.z`, *nach* `vViewDepth` gelesen, damit GTAO/Contact/SSR unberührt bleiben). Beide Pässe erreichen `gl_Position` über dieselbe Chunk-Kette, aber der Bias macht den Pass auch dann korrekt, wenn der Compiler unterschiedlich kontrahiert. 0.12 % = 1.2 mm auf 1 m, 12 cm auf 100 m.
   - Abschaltbar über `q.prepassDepthReuse !== false`; automatisch aus bei `directViewmodel`.
   - `_visit` sortiert Alpha-Cut-Meshes zusätzlich in `_masked`; `_collect` setzt `_nMasked = 0`. Prewarm ruft `gbuffer.render` jetzt mit der Masked-Liste, damit das zweite Programm auf dem Ladebildschirm kompiliert statt als Hitch im ersten Frame.
   - Prepass läuft jetzt als 2 `renderer.render`-Calls (89 + 3), Gesamt-Draws unverändert 92. Programme 100 → 101, Programmwechsel 307 → 308.

**Stand nach beiden Änderungen:** 1153 Draw-Calls, 9.37 M Dreiecke (unverändert), GPU-Speicher 822 → 819.76 MB, CPU-Frame median 6.386 ms (siehe Risiko unten).

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **Regressionslauf sofort nachholen** — der Shot nach den Depth-Änderungen wurde **nicht mehr ausgeführt**. `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod/shot-after.png` und mit `/tmp/cod/shot-base.png` vergleichen (Baseline existiert, wurde aber mit der *alten* `toPNGBuffer` ohne Auto-Belichtung erzeugt — für einen Byte-Vergleich also neu erzeugen). **Der Shot prüft konkret, ob `_hideOthers`/`_restoreOthers` im Prepass leckt** — wenn Objekte dauerhaft unsichtbar bleiben, sieht man es sofort.
2. **CPU-Messung wiederholen.** `frameCpuMs.median` ging 8.024 → 7.858 → **6.386**. Der Sprung von 1.47 ms durch die Depth-Wiederverwendung ist **nicht plausibel erklärt** — Depth-Reuse ist GPU-seitig. Verdacht: Maschinen-Rauschen oder Thermik. **Annahme, ungeprüft.** Zwei bis drei Wiederholungen von `passes --frames=180` fahren; wenn der Wert bleibt, Ursache suchen (three legt für `depthTexture` andere interne Pfade an).
3. **`pnpm build` grün prüfen — seit den Shader-Änderungen NICHT gelaufen.** GLSL steht in JS-Template-Literals, ein Backtick in einem Shader-Kommentar bricht den Build.
4. **`node tools/cli/cod.mjs leak --q=ultra --frames=3000`** — implementiert, **immer noch nie gelaufen**. Deckt „prolonged gameplay must not cause increasing lag or memory usage" ab. Hat jetzt zusätzlichen Wert: die neue `DepthTexture` wird bei jedem adaptiven Resize disposed und neu erzeugt.
5. **100 → 101 Shader-Programme gegen ANGLEs 64er-Pipeline-Cache** (Task 3, unangetastet). 37 darüber, `uniqueFragmentShaders: 91`. `cod.mjs shaders` liefert pro Programm `numPointLights`/`numDirLights`/`fragTextureFetches`. Reine CPU-Arbeit, ohne GPU verifizierbar.
6. **CSM bleibt der größte CPU-Posten: 3.16 ms, 751.9 von 1153 Draws.** Ideen, noch nicht gemessen: Culling nach projizierter Größe in den groben Kaskaden (Objekte kleiner als der PCF-Radius), oder gestaffelte Kaskaden-Updates (Kaskade 2/3 seltener, Matrix einfrieren). **Vor jeder Umsetzung erst per Diagnose zählen, wie viele Caster das entfernen würde** — `csm.casterCounts` und `emptyCascades` existieren bereits als Diagnose-Felder. Die 32-Texel-Marge im Cylinder-Cull **nicht anfassen**.
7. **Presets in getrennten Node-Prozessen messen** (`cmdPresets` hat ein `break`, weil `boot()` pro Prozess einmalig ist). Shell-Wrapper fehlt weiterhin.
8. **Aufräumen:** `tools/_navcheck.mjs`, `tools/_smoke.mjs`, `tools/launch.mjs` löschen.
9. **Ganz zum Schluss** die zwei Test-Agenten fan-outen. Beide brauchen den Hinweis: `q.prepassDepthReuse = false` schaltet die riskanteste Änderung ab, das ist ihr A/B-Schalter.

## 4. Risiken & Edge Cases

- **Die Depth-Wiederverwendung ist die einzige Änderung, die ohne GPU nicht vollständig verifizierbar ist.** Draw-Stream, Attachments und Dreieckszahl sind geprüft; ob es auf echter Hardware Z-Fighting gibt, kann hier niemand sehen. Genau dafür ist der Bias da, und genau dafür gibt es `q.prepassDepthReuse`. **Das dem User klar sagen, nicht als „gemessen" verkaufen.**
- **`shadedPerPixel` 2.145 ist eine Fragment-*Anzahl*, keine Millisekunden.** Wie viel der 53.4 % in ms landen, hängt davon ab, welchen Anteil der Forward-Pass am Pixel-Budget hat. Als **modelliert** kennzeichnen, nie als gemessen.
- **Der Node-Harness misst nur CPU.** Jede GPU-Aussage muss aus dem kalibrierten Modell kommen (`frame = 10 ms + 15.9 ms/MP`) und als modelliert markiert werden.
- **`getProgramParameter` liefert 0 aktive Uniforms** — Uniform-Uploads sind No-Ops. Jede Optimierung, die nur Uniform-Werte ändert, ist im Harness unsichtbar.
- **`boot()` ist pro Prozess nur einmal aufrufbar.**
- **Point-Light-Early-Out ist BESTÄTIGT und fertig** (2.966 ms Median-Paardifferenz, winRate 0.963, signTestZ 16.02, drei übereinstimmende Läufe). **Nicht wiederholen, nicht anfassen.** `pointLightSlots` bleibt bei 20 (gemessener Peak gleichzeitiger Lichter: 14).
- **Niemals pauschales `git stash`** — sonst gehen der Adaptive-Fix in `src/render/adaptive.js` und die fremden Start-Screen-Änderungen in `index.html`/`src/global.css`/`src/main.js` verloren.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()` (trägt den `depth > 0`-Vertrag von GTAO/Contact/SSR), 32-Texel-Marge im CSM-Cylinder-Cull. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048 → 1536 bei Ultra. **Bewusst so:** `contactScale: 1`, `minRenderScale: 0.65`.
- **`tools/gpu-pass-profile.mjs` hat einen Vorbestand-Bug** (trennt über `r.csm.__inCsm`, das Flag existiert nirgends). Ohnehin ein Browser-Tool.
- **Ein Fremdprozess läuft mit:** `chrome-devtools-mcp` spawnt laufend `chrome-headless-shell`. Nicht von uns, aber plausibler Mitverursacher der Laptop-Last.
- **60 fps bei Ultra/3.34 MP sind mit diesem Feature-Set nicht erreichbar** (Faktor ~8 gegenüber der gemessenen Pixelrate). Dem User früh sagen und die Zielmarke abstimmen.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. der Kein-Headless-Zeile und der Forderung nach den zwei Test-Agenten.
- `tools/cli/cod.mjs` — die CLI. Befehle: `probe`, `systems`, `passes`, `shaders`, `fingerprint`, `diff`, `leak`, `presets`, **`shot`**, **`overdraw`**, **`drawlist`**, **`targets`**.
- `tools/cli/raster.mjs` — **neu**, der CPU-Rasterizer. `renderShot()` und `measureOverdraw()` sind die zwei Einstiegspunkte.
- `tools/cli/gl-mock.mjs` — Herzstück. Neu: `rec.attachments` + `recordAttachment()`.
- `src/render/overridebatch.js` — **neu**, das Group-Collapsing. Der Kachel-Guard ist der Korrektheitsbeweis.
- `src/render/prepass.js` — `createPrepassMaterial(masked)`, `canPrepassAlphaTest()`, `hardwareDepth`, `OW_PREPASS_DEPTH_BIAS`, Zwei-Pass-`render()` mit `_hideOthers`/`_restoreOthers`.
- `src/render/index.js` — `reusePrepassDepth` (~Z. 289), `_visit`/`_masked`, `resize()` (gbuffer **vor** hdrRt), Forward-Clear, die zwei `overrideBatcher`-Klammern.
- `src/materials/shader.js:632` — `#ifdef OW_ALPHA_MASK diffuseColor.a *= owAlbedo.a`, die Zeile, die den Prepass-Alphatest rechtfertigt.
- `src/render/materialpatch.js` — der bestätigte Early-Out, `PATCH_VERSION = 11`.

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md` — flüssig auch auf Ultra, ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Tools in `tools/*.mjs` starten Chromium und sind unbenutzbar, auch `capture.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut.

**Benutze das browserlose CLI `tools/cli/cod.mjs`.** Es bootet die echte Engine in Node gegen einen aufzeichnenden WebGL2-Mock (Boot ~4.5 s). Befehle: `probe`, `systems`, `passes`, `shaders`, `fingerprint`, `diff`, `leak`, `shot`, `overdraw`, `drawlist`, `targets`. Beispiel: `node tools/cli/cod.mjs passes --q=ultra --frames=180 2>/dev/null`. Es misst **nur CPU**; jede GPU-Aussage muss aus dem kalibrierten Modell kommen (`frame = 10 ms + 15.9 ms/MP`) und als modelliert gekennzeichnet werden. **`timeout` gibt es auf diesem macOS nicht** — Befehle ohne `timeout` starten.

**Erledigt, nicht wiederholen:** Der Point-Light-Early-Out in `src/render/materialpatch.js` ist bestätigt (2.966 ms, winRate 0.963, signTestZ 16.02). `pointLightSlots` bleibt 20. Ballast-System nicht abschalten. Der Pass-Profiler ist repariert (Stack-basiert, self vs. inclusive). Der CPU-Rasterizer `tools/cli/raster.mjs` ist gebaut und liefert Shots und Overdraw.

**Zwei Optimierungen sind frisch implementiert und brauchen als Erstes eine Regressionsprüfung:**
(a) `src/render/overridebatch.js` kollabiert Multi-Material-Meshes auf einen Draw in den Override-Pässen — 1377 → 1153 Draw-Calls bei identischer Dreieckszahl 9 367 815, verifiziert.
(b) Der Forward-Pass erbt jetzt den Depth-Buffer des Prepasses (`reusePrepassDepth`, `GBuffer.hardwareDepth`, Bias 0.0012, maskiertes Zweitmaterial für Foliage). `cod.mjs targets` bestätigt `hdrSharesPrepassDepth: true`. Begründung: `cod.mjs overdraw` misst `shadedPerPixel` 2.145 und `depthPrepassSavesFragmentsPct` 53.4.

Arbeite in dieser Reihenfolge:

1. **`node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod/shot-after.png`** und das PNG ansehen — prüft, ob `_hideOthers`/`_restoreOthers` im Prepass Objekte dauerhaft versteckt. Erwartung: eine Straße mit Gebäuden beidseits, Sandsäcken, Props und sichtbaren Soldaten.
2. **`pnpm build`** — seit den Shader-Änderungen nicht gelaufen. GLSL steht in Template-Literals, ein Backtick im Shader-Kommentar bricht den Build.
3. **`passes --frames=180` zwei- bis dreimal wiederholen.** `frameCpuMs.median` fiel 8.024 → 6.386; der Sprung ist nicht erklärt und könnte Rauschen sein. **Annahme, ungeprüft.**
4. **`leak --q=ultra --frames=3000`** — implementiert, nie gelaufen, deckt die Auftragsforderung zu Langzeit-Speicher ab.
5. **Shader-Permutationen senken:** 101 Programme gegen ANGLEs 64er-Cache, 91 unique Fragment-Shader.
6. **CSM:** 3.16 ms und 751.9 von 1153 Draws. Erst per `csm.casterCounts` messen, wie viel ein Größen-Culling in den groben Kaskaden entfernen würde, dann entscheiden. Die 32-Texel-Marge im Cylinder-Cull nicht anfassen.
7. **Presets in getrennten Node-Prozessen messen** (`cmdPresets` hat ein `break`, `boot()` ist pro Prozess einmalig).
8. **Aufräumen:** `tools/_navcheck.mjs`, `tools/_smoke.mjs`, `tools/launch.mjs` löschen.

Niemals pauschales `git stash` — sonst gehen der Adaptive-Fix in `src/render/adaptive.js` und fremde Start-Screen-Änderungen in `index.html`/`src/global.css`/`src/main.js` verloren. Sag dem User früh, dass 60 fps bei Ultra und 3.34 MP mit diesem Feature-Set nicht erreichbar sind, und stimme die Zielmarke ab. Sag ihm außerdem ehrlich, dass die Depth-Wiederverwendung die einzige Änderung ist, deren Freiheit von Z-Fighting ohne GPU nicht beweisbar ist — `q.prepassDepthReuse = false` ist der Abschalter. Ganz zum Schluss, erst wenn die Optimierung steht, fahre die zwei vom Auftrag geforderten Test-Agenten aus.
