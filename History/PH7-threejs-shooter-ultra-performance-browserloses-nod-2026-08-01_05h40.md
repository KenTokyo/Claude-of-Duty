# PH7 - Three.js-Shooter Ultra-Performance - Browserloses Node-CLI-Messsystem...

> 2026-08-01T03:40:59.820Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH7)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` muss vollständig performance-optimiert werden — auch auf Ultra — **ohne** Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). Erst nach Abschluss der Optimierung sollen zwei separate Test-Agenten (einer Performance, einer Visuals+Gameplay) gegentesten, die die Änderungen nicht selbst gemacht haben.

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Kein Playwright, kein Headless, auch kein Headed. Alle Tools in `tools/*.mjs` starten Chromium und sind unbenutzbar, auch `capture.mjs`. Gearbeitet wird ausschließlich mit `tools/cli/cod.mjs`.

**Regressionsprüfung der beiden Vorgänger-Optimierungen abgeschlossen:**

- **`shot --q=ultra` gelaufen und das PNG angesehen.** Straße mit Gebäuden beidseits, Sandsäcken, Props, sichtbaren Soldaten — vollständig. `_hideOthers`/`_restoreOthers` im Prepass leckt **nicht**. 141 opaque + 10 transparent Items, 129 frustum-gecullt, 2 316 515 Dreiecke eingereicht.
- **`pnpm build` grün** (2.15 s, 147 Module). Die Shader-Template-Literals sind unbeschädigt.

**Die „1.7 ms CPU-Ersparnis" aus PH6 war Maschinen-Drift — korrigiert.** Drei aufeinanderfolgende `passes`-Läufe ergaben zwar konsistent 6.35/6.32/6.32 ms, aber ein **prozess-übergreifendes, verschachteltes A/B** (4 Runden NEU/ALT im Wechsel) zeigte Streuungen von **±2.1 ms innerhalb desselben Arms**. Mittelwert NEU 7.42 ms vs. ALT 6.93 ms — der Effekt verschwindet im Rauschen. Ursache gefunden per `ps`: ein **Chrome-Renderer bei 84.7 % CPU und WindowServer bei 99.2 %** (Fremdprozesse, nicht von uns). **Konsequenz, die für alle Folgearbeit gilt: Auf dieser Maschine sind nur prozess-INTERNE gepaarte Messungen belastbar.**

**Neues Werkzeug `cod.mjs ab` — gepaartes A/B im selben Prozess.** Alterniert das Feature frameweise, dreht jede zweite Paarung die Reihenfolge um (damit kein systematischer First-of-Pair-Effekt auf einen Arm fällt), rechnet Median-Paardifferenz, winRate und Vorzeichentest-z. Registry `TOGGLES` enthält `overrideBatch` und `cascadeCull`.

- **`overrideBatch` ist damit bestätigt: 800 Paare, medianPairedDiff +0.271 ms, winRate 0.711, signTestZ 11.95, drawCallsOn 1142 vs. off 1350.** Das ist eine **Untergrenze** — ein Draw-Call im GL-Mock ist billiger als beim echten Treiber.

**Neu: `--qset=key=value,...`** in `harness.mjs` + `cod.mjs`. Merged Overrides in `cfg.q`, wird nach jedem `setQuality()` erneut angewandt (sonst überschreibt der adaptive Scaler das A/B mitten im Lauf), und **wirft bei unbekannten Keys** — ein Tippfehler, der still nichts misst, sieht sonst aus wie ein wirkungsloses Feature.

**`prepassDepthReuse` und `overrideBatch` sind jetzt echte Config-Keys** in allen vier Presets in `src/core/config.js`. `RenderSystem` setzt `this.overrideBatcher = q.overrideBatch === false ? null : new OverrideBatcher()`; beide Aufrufstellen sind auf `?.begin`/`?.end` umgestellt. Damit haben die Test-Agenten einen sauberen A/B-Schalter.

**Leak-Test gebaut, gehärtet und definitiv gelaufen.** `cmdLeak` misst jetzt zusätzlich **Frame-Zeit-Trend** (cpuMsMedian/P95 pro Bucket) — die zweite Hälfte der Auftragsforderung, die aus flachem Speicher nicht folgt. Entscheidend: der rohe `heapUsed`-Sample ist ein Punkt auf einer Sägezahnkurve und meldete fälschlich „leaking" (21.76 MB/1000). Mit `globalThis.gc?.()` vor jedem Sample wird stattdessen der **retained set** gemessen.

- **14 000 Frames (~4 min Spielzeit), `node --expose-gc`: retained heap 44.81 → 44.83 MB, GPU-Speicher exakt konstant 809.76 MB, GL-Objekte bit-stabil (133 Texturen / 1430 Buffer / 101 Programme), CPU-Median-Trend −0.017 ms/1000 Frames, `leaking: []`.** Die Auftragsforderung „prolonged gameplay must not cause increasing lag or memory usage" ist damit belegt.

**Shader-Permutationen analysiert — Sackgasse, mit Beleg.** Von 101 Programmen sind nur **2 echte Duplikate** (`fx-particles-additive`, `fx-particles-lit`, je einmal pro Szene: Welt und Viewmodel). `csm-depth ×4` und `ow-prepass ×4` sind **legitime Geometrie-Varianten** (plain / instanced / instanced+color / skinned), die three zwingend getrennt kompilieren muss. Die restlichen 69 sind Einmal-Programme für Post/Sky. Decke der Arbeit: 101 → 99. **Nicht weiterverfolgen.**

**CSM vermessen — beide vorgeschlagenen Culls sind tot, gemessen statt geraten.** Neuer Befehl `cod.mjs csm`:

- **Größen-Cull: 0.** Selbst in der gröbsten Kaskade ist der p05-Caster **73.8 Texel** breit; `wouldCullUnder8Texels` = 1 von 756.
- **Near-Depth-Cull: nur 5.7 %** (43 von 756 Submissions). Grund: `sunY 0.298` = 17° Sonnenstand, Schatten sind 3.4× Objekthöhe und reichen echt über Kaskadengrenzen. Splits: 0.05 / 5.57 / 12.86 / 33.18 / 150; erstmals gesampelt bei 0 / 4.91 / 11.98 / 30.74 (die 12-%-Überblendung zieht den Beginn vor die eigene Near-Split).
- **Die eigentliche Erkenntnis: 756 Submissions aus nur 210 verschiedenen Objekten** — 139 davon landen in allen 4 Kaskaden, 37 in 3, 31 in 2, 3 in 1. Der bestehende Zylinder-Cull leistet also bereits die Hauptarbeit; **Caster-Culling ist ausgereizt.**
- Der `groundY`-Wert musste dabei von Bounding-**Spheres** auf Bounding-**Boxes** umgestellt werden: die flache Straße hat eine Kugel, die 118 m unter die Fahrbahn reicht, und machte jeden Schatten unendlich lang (−118.67 → −1.32).

**Neuer Befehl `cod.mjs fragcost` — der einzige GPU-Kosten-Indikator, den es ohne GPU geben kann.** Die alte Metrik `fragTextureFetches` in `cmdShaders` ist **irreführend** und war der Grund, warum die GPU-Seite bisher unsichtbar blieb: sie zählt statische Aufrufstellen und meldete **6** für einen Shader, der real ≥26 Schatten-Taps macht. `fragcost` ist **interprozedural** — es zerlegt den Shader in Funktionsrümpfe, gewichtet jede `texture()`-Stelle mit dem Produkt der umschließenden Schleifen (löst `#define`-Trip-Counts wie `OW_PCF_TAPS` auf) und propagiert Kosten über Aufrufkanten, weil die teuren Fetches nicht in `main()` stehen, sondern in `owCsmTap`, aufgerufen aus den PCSS-Schleifen.

Zwei Fallen mussten dafür gelöst werden, beide dokumentiert im Code: three's Chunk-Suppe enthält **eine unbalancierte Klammer** (mehrzeilige Signatur in `computeMultiscatteringIridescence`, Zeile ~1162), weshalb ein globaler Depth-Zähler nie wieder auf 0 kommt und `main()` unsichtbar wird; und ein Funktionsrumpf, der bis EOF durchläuft, verschluckt `main()` samt allem danach — deshalb werden unterminierte Rümpfe verworfen (`if (d !== 0) continue`).

**Ergebnis von `fragcost` — das ist der wichtigste offene Befund:** Jedes Weltmaterial kostet **136 dynamische Fetches pro Fragment, davon `owSunShadow` allein 52.** Die 52 sind 26 PCSS-Taps (10 Blocker + 16 PCF) **mal zwei**, weil die Kaskaden-Überblendung `owCsmCascade` ein zweites Mal aufruft. Als statische Obergrenze korrekt gekennzeichnet („assuming every branch is taken").

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **Der PCF-Early-Out in `src/render/csm.js:530-550` — der größte verbleibende Hebel, und er ist beweisbar output-identisch.** Der Blocker-Search hat bereits ein Early-Out für „gar kein Blocker" (`if ( count < 0.5 ) return 1.0;`, Zeile 538) — das spart die 16 PCF-Taps für voll besonnte Pixel. **Es fehlt das symmetrische Gegenstück: `if ( count > float( OW_BLOCKER_TAPS ) - 0.5 )`, also alle 10 Blocker-Taps verdeckt.** Achtung, das ist **nicht** trivial korrekt: „alle 10 Taps verdeckt" beweist nicht, dass die 16 PCF-Taps über `filterR` ebenfalls alle verdeckt sind, denn `filterR` kann nach Zeile 542 **größer** als `searchR` werden (`searchR = min(maxR, 10*invTex)`, `filterR = clamp(penumbra/extent, 1*invTex, maxR)`). **Sicher ist der Early-Out nur, wenn zusätzlich `filterR <= searchR` gilt** — dann liegt die PCF-Scheibe innerhalb der bereits vollständig verdeckten Suchscheibe. Genau so implementieren, nicht ohne diese Bedingung. Danach `fragcost` erneut laufen lassen; die Zahl bleibt gleich (statische Obergrenze), also den Gewinn stattdessen argumentativ und über `ab` auf der CPU-Seite belegen bzw. ehrlich als **modelliert** kennzeichnen.
2. **Die Kaskaden-Überblendung ist der Faktor 2 auf die teuerste Funktion im Frame** (`csm.js:576-581`). `if ( t > 0.001 )` ist auf der GPU ein divergenter Branch: sobald **eine** Lane im Warp die zweite Kaskade braucht, zahlen **alle** Lanes. Prüfen, ob `t > 0.001` auf `t > 0.02` angehoben werden kann — die Überblendung beginnt bei 88 % der Kaskade, die ersten 2 % tragen sichtbar nichts bei, aber die Bandbreite des divergenten Bereichs schrumpft. **Annahme, ungeprüft** — vorher mit `fragcost` bzw. per Hand die betroffene Bildschirmfläche abschätzen.
3. **`cmdShaders`: `fragTextureFetches` entweder entfernen oder auf `fragmentCost()` umstellen.** Die Metrik steht noch drin und meldet 6 statt 136. Sie hat in PH6 die GPU-Analyse in die falsche Richtung gelenkt und wird das wieder tun.
4. **Gestaffelte Kaskaden-Updates — bewusst NICHT umgesetzt, Begründung muss erhalten bleiben.** Kaskade 2+3 sind 429 der 756 Submissions (57 %), ein Wechselbetrieb spart ~0.9 ms CPU (14 %). **Dagegen entschieden**, weil CPU mit 6.3 ms (158 fps) **nicht der Flaschenhals** ist und der Preis unverifizierbares Schatten-Flackern wäre. Der saubere Entwurf, falls es doch jemand will: Fit-Zentrum jede Frame billig neu berechnen, gegen das eingefrorene vergleichen und bei Überschreitung einer Marge zwangs-refitten (selbstkorrigierend, kein Raten über Maximalgeschwindigkeit); Rotation dominiert dabei, nicht Translation — bei Kaskade 3 liegt das Fit-Zentrum 150 m vor der Kamera, 1° Drehung verschiebt es 2.6 m.
5. **`shadowMapSize: 4096` im Ultra-Preset ist eine Lüge** — `csm.js:39` klemmt hart: `Math.min(opts.mapSize ?? 2048, 2048)`. Der Schutz ist richtig, der Config-Wert ist eine Falle für den Nächsten. Entweder Preset auf 2048 korrigieren oder den Clamp im Preset kommentieren.
6. **Presets in getrennten Node-Prozessen messen** (`cmdPresets`, `cod.mjs:328`, hat ein `break`, weil `boot()` pro Prozess einmalig ist). Shell-Wrapper fehlt weiterhin.
7. **Aufräumen:** `tools/_navcheck.mjs`, `tools/_smoke.mjs`, `tools/launch.mjs` löschen.
8. **Ganz zum Schluss** die zwei Test-Agenten fan-outen. Beide brauchen den Hinweis, dass `--qset=prepassDepthReuse=false` und `--qset=overrideBatch=false` die A/B-Schalter sind.

## 4. Risiken & Edge Cases

- **Messmethodik ist die wichtigste Übergabe dieses Abschnitts.** Zwei getrennte `passes`-Läufe können auf dieser Maschine einen 0.5-ms-Effekt nicht von 2 ms Drift trennen. **Nur `cod.mjs ab` (prozess-intern, gepaart) ist belastbar.** Drei übereinstimmende Läufe hintereinander beweisen nichts — genau das hat in PH6 zur falschen 1.7-ms-Behauptung geführt.
- **`fragcost` liefert eine Obergrenze pro Fragment, keine Messung.** Es kann nicht wissen, wie oft ein dynamischer Branch betreten wird. Immer so kennzeichnen. Die **Rangfolge** ist das Belastbare, nicht der Absolutwert.
- **Die Depth-Wiederverwendung bleibt die einzige Änderung, deren Freiheit von Z-Fighting ohne GPU nicht beweisbar ist.** Draw-Stream, Attachments (`hdrSharesPrepassDepth: true`) und Dreieckszahl sind geprüft. **Dem User klar sagen, nicht als „gemessen" verkaufen.** Abschalter: `q.prepassDepthReuse = false`.
- **60 fps bei Ultra/3.34 MP sind mit diesem Feature-Set nicht erreichbar.** Modell `frame = 10 ms + 15.9 ms/MP` → ~63 ms nativ (~16 fps). Selbst bei `minRenderScale: 0.65` (1.41 MP) bleiben ~32 ms (~31 fps). **Der Flaschenhals ist die GPU, nicht die CPU** — jede weitere reine CPU-Arbeit verbessert das Spielgefühl nicht. Das dem User früh und deutlich sagen.
- **`getProgramParameter` liefert 0 aktive Uniforms** — Uniform-Uploads sind No-Ops, reine Uniform-Optimierungen sind im Harness unsichtbar.
- **`boot()` ist pro Prozess nur einmal aufrufbar.**
- **Point-Light-Early-Out ist BESTÄTIGT und fertig** (2.966 ms, winRate 0.963, signTestZ 16.02). **Nicht wiederholen, nicht anfassen.** `pointLightSlots` bleibt 20.
- **Niemals pauschales `git stash`** — sonst gehen der Adaptive-Fix in `src/render/adaptive.js` und fremde Start-Screen-Änderungen in `index.html`/`src/global.css`/`src/main.js` verloren.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()`, **32-Texel-Marge im CSM-Zylinder-Cull** (bei 2 Texeln war der Pass nachweislich nicht pixel-neutral). **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048 → 1536 bei Ultra. **Bewusst so:** `contactScale: 1`, `minRenderScale: 0.65`.
- **`grep` liefert in dieser Sandbox durchgehend leere Ergebnisse.** Stattdessen `node -e` mit `fs.readFileSync` + Regex benutzen — alle Suchen in diesem Abschnitt liefen so.
- **`timeout` gibt es auf diesem macOS nicht.**
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. Kein-Headless-Zeile und der Forderung nach den zwei Test-Agenten.
- `tools/cli/cod.mjs` — die CLI. Befehle: `probe`, `systems`, `passes`, `shaders`, `fingerprint`, `diff`, `leak`, `presets`, `shot`, `overdraw`, `drawlist`, `targets`, **`ab`**, **`csm`**, **`fragcost`**. Global `--qset=`.
- `tools/cli/harness.mjs` — `boot({ qset })` mit Typo-Guard und `setQuality`-Wrapper.
- `src/render/csm.js:506-551` — `owCsmCascade`, PCSS-Blocker + PCF. **Hier sitzt Aufgabe 1.** Zeile 538 ist das vorhandene Early-Out, Zeile 542 die `filterR`-Berechnung, die den symmetrischen Fall unsicher macht.
- `src/render/csm.js:554-589` — `owSunShadow`, Kaskadenwahl und die 12-%-Überblendung (Aufgabe 2).
- `src/render/csm.js:39` — der `Math.min(..., 2048)`-Clamp (Aufgabe 5).
- `src/core/config.js` — `prepassDepthReuse` und `overrideBatch` in allen vier Presets.
- `src/render/index.js:248` — `overrideBatcher`-Gate; `1526`/`1548` die zwei `?.begin`/`?.end`-Klammern; `304` `reusePrepassDepth`.
- `src/render/overridebatch.js` — das Group-Collapsing, der Kachel-Guard ist der Korrektheitsbeweis.
- `/tmp/cod/shaders.json`, `/tmp/cod/csm.json`, `/tmp/cod/leak-long.json` — die Rohdaten dieses Abschnitts, falls Nachrechnen nötig ist.

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md` — flüssig auch auf Ultra, ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Tools in `tools/*.mjs` starten Chromium und sind unbenutzbar, auch `capture.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut. `grep` liefert in dieser Umgebung leere Ergebnisse — benutze `node -e` mit `fs.readFileSync`. `timeout` existiert nicht.

**Benutze das browserlose CLI `tools/cli/cod.mjs`** (bootet die echte Engine in Node gegen einen aufzeichnenden WebGL2-Mock, Boot ~4.5 s). Befehle: `probe`, `systems`, `passes`, `shaders`, `fingerprint`, `diff`, `leak`, `shot`, `overdraw`, `drawlist`, `targets`, `ab`, `csm`, `fragcost`. Global `--qset=key=value,...`.

**Messmethodik — das ist die wichtigste Regel dieses Projekts.** Auf dieser Maschine laufen Fremdprozesse (Chrome-Renderer 85 % CPU, WindowServer 99 %). Zwei getrennte Läufe streuen um ±2.1 ms und können 0.5-ms-Effekte nicht auflösen; drei übereinstimmende Läufe hintereinander beweisen **nichts**. Belastbar ist ausschließlich `node tools/cli/cod.mjs ab --toggle=<name> --frames=1600` (prozess-intern, frameweise alterniert, Median-Paardifferenz + Vorzeichentest-z). Ein Befund gilt ab |z| > 3.

**Erledigt, nicht wiederholen:** Regressions-Shot sauber (alle Geometrie da), `pnpm build` grün. Leak-Test über 14 000 Frames definitiv sauber — retained heap 44.81 → 44.83 MB, GPU-Speicher konstant 809.76 MB, GL-Objekte bit-stabil, CPU-Trend −0.017 ms/1000. `overrideBatch` bestätigt (+0.271 ms, z = 11.95). Point-Light-Early-Out bestätigt. Shader-Permutationen sind eine Sackgasse (nur 2 echte Duplikate von 101). CSM-Caster-Culling ist ausgereizt: Größen-Cull 0 %, Near-Depth-Cull 5.7 %, gemessen mit `cod.mjs csm`.

**Der offene Hauptbefund:** `cod.mjs fragcost` (neu, interprozedural) zeigt, dass jedes Weltmaterial **136 dynamische Texture-Fetches pro Fragment** kostet und **`owSunShadow` allein 52** davon — 26 PCSS-Taps mal zwei wegen der Kaskaden-Überblendung. Die GPU ist der Flaschenhals (Modell: ~63 ms bei Ultra nativ), nicht die CPU (6.3 ms = 158 fps).

Arbeite in dieser Reihenfolge:

1. **PCF-Early-Out in `src/render/csm.js:530-550`.** Zeile 538 hat bereits `if ( count < 0.5 ) return 1.0;` für „kein Blocker". Ergänze das symmetrische „alle Blocker verdeckt" — **aber nur zusammen mit der Bedingung `filterR <= searchR`**, sonst ist es falsch: `filterR` wird in Zeile 542 aus der Penumbra berechnet und kann `searchR` überschreiten, dann liegen PCF-Taps außerhalb der geprüften Scheibe.
2. **Kaskaden-Überblendung `csm.js:576-581`:** `if ( t > 0.001 )` ist ein divergenter Branch, der die teuerste Funktion im Frame verdoppelt. Prüfe eine Anhebung auf `t > 0.02`. Annahme, ungeprüft — vorher die betroffene Bildschirmfläche abschätzen.
3. **`cmdShaders`: `fragTextureFetches` entfernen oder auf `fragmentCost()` umstellen** — die Metrik meldet 6 statt 136 und hat die GPU-Analyse schon einmal fehlgeleitet.
4. **`shadowMapSize: 4096` im Ultra-Preset korrigieren oder kommentieren** — `csm.js:39` klemmt hart auf 2048.
5. **Presets in getrennten Node-Prozessen messen** (`cmdPresets` hat ein `break`).
6. **Aufräumen:** `tools/_navcheck.mjs`, `tools/_smoke.mjs`, `tools/launch.mjs` löschen.
7. **Ganz zum Schluss** die zwei vom Auftrag geforderten Test-Agenten ausfahren (einer Performance, einer Visuals+Gameplay). Beide brauchen die A/B-Schalter `--qset=prepassDepthReuse=false` und `--qset=overrideBatch=false`.

Gestaffelte Kaskaden-Updates wurden **bewusst verworfen** (0.9 ms CPU-Gewinn auf einem Nicht-Flaschenhals gegen unverifizierbares Schatten-Flackern) — nicht ohne neuen Grund wieder aufgreifen. Niemals pauschales `git stash`. Fasse die 32-Texel-Marge im CSM-Zylinder-Cull nicht an. Sag dem User früh, dass 60 fps bei Ultra und 3.34 MP mit diesem Feature-Set nicht erreichbar sind, und dass die Depth-Wiederverwendung die einzige Änderung ist, deren Z-Fighting-Freiheit ohne GPU nicht beweisbar ist.
