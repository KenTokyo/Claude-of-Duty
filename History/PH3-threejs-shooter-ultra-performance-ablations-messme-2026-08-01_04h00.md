# PH3 - Three.js-Shooter Ultra-Performance - Ablations-Messmethodik korrigiert...

> 2026-08-01T02:00:03.636Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH3)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` muss vollständig performance-optimiert werden — auch auf Ultra — **ohne** Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). Erst nach Abschluss der Optimierung sollen laut Auftrag zwei separate Test-Agenten (Performance / Visuals+Gameplay) hart gegentesten, die die Änderungen nicht selbst gemacht haben.

## 2. Was wurde bereits erledigt

**Messmethodik weiter repariert (die zentrale Erkenntnis dieser Schicht):**
- `tools/ab.mjs` hat jetzt zusätzlich eine **`SETTLE`-Map**: Zeilen, die Render-Targets neu allozieren, bekommen 60–120 Warmlauf-Frames statt 12, und zwar **vor beiden Hälften** des Paares. Grund, gemessen: die drei `scale-*`-Zeilen kamen mit 12 Frames mit Baselines von **109–123 ms** zurück, während jede nicht-allozierende Zeile im selben Build 63 ms sah — und mit Spreads (52–79 ms) so groß wie die Kosten, die sie meldeten. Der Alloc-Sturm landet im nächsten Messfenster, **inklusive der ON-Hälfte der nächsten Runde**, deshalb verdirbt er auch die Baseline. Nach dem Fix: `scale-0.8` Spread **1.6**.
- Damit ist auch das `contact-fullres`-Rätsel der Vorschicht erklärt (Baseline 107 ms statt 63): die Zeile alloziert zwei Targets pro Apply *und* pro Restore.

**Batch 2 validiert und teilweise zurückgebaut:**
- `contact-off` kostet **0.5 ms von 63 ms** (Spread 9.5) — der gesamte Contact-Shadow-Pass. Halbe Auflösung kann dort also nie mehr als ~1 ms bringen, und das Band, das der Pass auflöst, ist 3–10 px breit. **`contactScale` in `src/core/config.js` deshalb bei medium/high/ultra auf `1` zurückgesetzt**, mit der Messung als Begründung im Kommentar. Die `setSize(w, h, blurScale = 1)`-Signatur in `contact.js` bleibt (korrekt, und bei `blurScale=1` verhaltensidentisch zu vorher).
- `gtao-fullres` = **−8.8 ms** (Spread 4.1) gegen `gtao-off` = 5.3 ms → Full-Res-GTAO ≈ 14 ms, Half-Res ≈ 5.3 ms. **Batch-1-`aoScale` ist damit validiert.**
- **AO-Hoist geprüft und behalten:** `owSampleAO()` (materialpatch.js:299) ist eine reine Funktion aus `gl_FragCoord.xy` + Uniforms, der Hoist ist semantisch exakt äquivalent. Beide Call-Sites (`lightInjection` und der Indirect-Block) liegen im `!simple`-Zweig, `owAoCached` wird also nie undeklariert referenziert.

**Der wichtigste neue Befund — das Frame ist pixel-gebunden:**
- `scale-0.8` (Spread 1.6, belastbar): **63.5 ms → 44.4 ms** bei 0.64× Pixeln. Aufgelöst nach `frame = fix + k·MP`: **k ≈ 15.9 ms/MP, fix ≈ 10 ms**.
- Heißt: von 63.5 ms sind **~53 ms pixelproportional** und nur **~10 ms** Draw-Calls, Vertex, Shadow-Raster und CPU zusammen. `scale-0.65` bestätigt es unabhängig (k ≈ 18.6, fix ≈ 6.3).
- **Konsequenz: Draw-Calls (937) und Dreiecke (7.26 M) sind NICHT das Problem.** Instancing, LOD und Culling-Arbeit zielen auf ein ~10-ms-Budget. Der gesamte Hebel liegt in den Kosten **pro Pixel**.
- Aufteilung bei 3.34 MP: `post-off` **12.3 ms** (Spread 0.7) · `csm-shader-off` **8.5 ms** (Spread 3.8, sauber nachgemessen) · `ballast-off` **4.6 ms** (Spread 0.7) → Forward-Fragment-Shading ohne CSM ≈ **28 ms**.

**Punktlicht-Ballast gemessen:**
- `src/world/index.js:234` (`_addBallast`) hält `NUM_POINT_LIGHTS` konstant bei `pointLightSlots` (ultra/high = **20**), indem es mit schwarzen Lichtern auffüllt — korrekt und notwendig gegen die Permutations-Stalls (dokumentiert: 186 Programme, ~3.5 s Stalls in 900 Frames).
- Neue Ablation **`ballast-off`** in `tools/ab.mjs` (Settle 120) misst nur die toten Slots: **4.6 ms, Spread 0.7 — belastbar.** Der alte Kommentar dort („15.7 → 14.4 ms, inside noise") stammt aus einer anderen Konfiguration und **unterschätzt die Kosten bei 3.34 MP deutlich**.

**Depth-Prepass-Wiederverwendung — Blocker-Analyse fertig, zwei von drei entschärft:**
- `_visit` (`src/render/index.js:1071`) sortiert **alle transparenten Objekte plus `owNoPrepass`** bereits in `_hide` und damit aus dem Prepass heraus. Der Prepass zeichnet exakt die Opaque-Menge.
- Geprüft: Glas (`library.js:378`), Decals (`fx/decals.js`, `transparent: true`), AI-Grounding (`ai/grounding.js`) sind transparent → schon draußen. Die Sky-Dome hat `owNoPrepass = true` (`sky/dome.js:348`). Die `BackSide`-Materialien liegen ausschließlich in Preview-Szenen (`materials/preview.js`, `weapons/preview.js`, `ai/preview.js`), nicht in der Welt.
- **Einziger echter Blocker bleibt Foliage**: `src/materials/library.js:334-335` (`side: DoubleSide`, `alphaTest: 0.45`), benutzt von den Props `palm_frond`, `shrub`, `weeds` (`src/world/props.js:980-982`), keiner davon mit `noPrepass`.
- `hdrRt` ist **nicht MSAA** (`index.js:983`) und wird auf dieselbe Größe wie der GBuffer alloziert → Depth-Sharing ist technisch möglich. Prepass und Forward laufen beide mit derselben **gejitterten** Kamera (Jitter bei 1471, Prepass 1478, Forward 1521) → gleiche Matrizen.

**Verworfen (mit Begründung):**
- **CSM `mapSize` 2048 → 1536 bei Ultra: gestrichen.** Die Rechnung der Vorschicht verglich gegen die *alte* Ultra-Baseline (200 m/2048). Da `shadowDistance` bereits auf 150 steht, ist der aktuelle Ultra-Texel 150/2048 = 0.0732 m; mit 1536 wären es 0.0977 m — **33 % gröber als `high`** (140/2048 = 0.0684 m). Ultra würde damit schlechtere Schatten bekommen als High, das widerspricht dem Auftrag direkt. Der bereits eingelöste Schärfegewinn aus `shadowDistance` würde einfach wieder verkauft.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **`vite build` läuft noch nicht mit dem `contactScale: 1`-Rückbau.** Der letzte Build war *vor* der config.js-Änderung. **Erster Schritt: `node_modules/.bin/vite build`.** Sonst misst jede weitere Messung den alten Stand.
2. **Punktlicht-Slots senken — der billigste belastbare Hebel, 4.6 ms bei Spread 0.7.** Die Welt besitzt laut Kommentar in `world/index.js:210` nur **17 Praktikale** (12 Innenraum-Birnen à 13 m, 5 Straßenlampen à 22 m); gleichzeitig in Reichweite sind typisch weit weniger. `pointLightSlots` in `src/core/config.js` bei high/ultra von **20 auf 12** senken und `ballast-off` erneut fahren. **Wichtig: das Ballast-System nicht abschalten** — nur den Zielwert senken. Der Ratchet in `_stabiliseLightCount` (`world/index.js:306`, `if (n > this._lightTarget) this._lightTarget = n`) fängt Überläufe automatisch mit genau einem Recompile ab, das ist der Sicherheitsgurt. **Annahme (ungeprüft):** 12 Slots reichen visuell; das muss über das Bild-Gate gegengeprüft werden, nicht über die Zahl.
3. **Depth-Prepass-Wiederverwendung — der größte verbliebene Win, jetzt gut begründet.** Das Frame ist pixel-gebunden (siehe oben), und genau das ist die Voraussetzung, unter der Early-Z etwas bringt; der Prepass wird ohnehin schon vollständig bezahlt und sein Tiefen-Attachment wird bisher weggeworfen. Umsetzung:
   - `GBuffer.setSize` (`prepass.js:151`) mit `depthTexture: new THREE.DepthTexture(w,h)` anlegen.
   - In `resize()` **`this.gbuffer.setSize(rw, rh)` (Zeile 1013) vor die `hdrRt`-Erzeugung (Zeile 983) ziehen** und `hdrRt` mit `depthTexture: this.gbuffer.rt.depthTexture` bauen (`hdrTarget` in `render/pass.js:65` reicht `...opts` durch).
   - In `render()` Zeile 1520 `renderer.clear(true, true, false)` auf **nur Farbe** umstellen, wenn geteilt wird. `depthFunc` muss nicht angefasst werden — three.js-Default ist bereits `LessEqualDepth`.
   - **Vorher zwingend den Foliage-Blocker lösen** (siehe 4.).
   - **Empfehlung:** erst als Wegwerf-Experiment mit dem Foliage-Bug messen, um die Größe des Gewinns zu kennen, und die saubere Umsetzung nur bauen, wenn der Gewinn den Aufwand trägt.
4. **Alpha-Test-fähiger Prepass** (Voraussetzung für 3.). Empfohlener Weg ist **zwei Overrides statt `discard` für alle**: Prepass zweimal fahren — einmal mit dem heutigen Material und versteckten Cutout-Objekten, einmal mit einem Cutout-Override und nur den Cutout-Objekten. Ein einzelnes Material mit unconditional `discard` würde Early-Z im Prepass selbst für *alle* Draws killen. Die Cutout-Menge ist winzig (drei Prop-Typen). Die Alpha-Maske kommt aus dem prozedural gebackenen Kanal, siehe `src/materials/glsl/surfaces-organic.js:322` („h doubles as the cutout mask for foliage").
5. **Tiefen-Invarianz prüfen, bevor Depth-Sharing als fertig gilt.** Prepass ist `GLSL3`, die Stock-Materialien sind GLSL ES 1.00 — zwei verschiedene Programme, die `gl_Position` unabhängig berechnen. Weicht das Ergebnis um ein ULP nach oben ab, verwirft LEQUAL die Oberfläche und es entstehen flackernde Löcher. Gegenmittel ist `invariant gl_Position;` in **beiden** Shadern, für die Stock-Materialien also ein Vertex-Patch in `materialpatch.js` (bisher wird dort nur der Fragment-Shader gepatcht).
6. **End-to-End-Messung aller vier Presets auf abgekühlter Maschine:** `node tools/subsystem-profile.mjs --query=q=<preset> --frames=420`. Vergleich OLD: low 132 / medium 56 / high 29 / ultra 23 fps. Ultra nach Batch 1: 30 fps.
7. **Visuelles Gate — noch nie gelaufen, `shots/` existiert nicht.** `git stash push -- src/core/config.js src/render/index.js src/render/prepass.js src/render/gtao.js src/render/contact.js src/render/ssr.js src/render/csm.js src/render/materialpatch.js` → `node tools/shotset.mjs --out=shots/base` → `git stash pop` → `node tools/shotset.mjs --out=shots/opt` → `node tools/imagediff.mjs --a=shots/base --b=shots/opt --tol=2 --write-diff`. `?capture=1` erzwingt in `src/main.js` ~Zeile 101 automatisch Ultra + `deterministic`, das Gate trifft also die geänderten Pfade.
8. **`pnpm build` + `node tools/capture.mjs` grün halten** (harte Regel aus `ARCHITECTURE.md`). `capture.mjs` ist bisher **nie** gelaufen.
9. **Erwartungsmanagement — bitte an den User weitergeben:** 60 fps bei Ultra und 3.34 MP sind mit diesem Feature-Set nicht erreichbar. Bei ~10 ms Fixkosten bräuchte man ~2 ms/MP statt der gemessenen 15.9 — das ist ein Faktor 8 und wäre eine Neuentwicklung, keine Optimierung. Realistisch ist eine deutliche Senkung von `k` (Overdraw + Punktlichter + CSM) plus die vorhandene adaptive Auflösung. Die Zielmarke sollte explizit abgestimmt werden.
10. Aufräumen: `tools/_navcheck.mjs` löschen.
11. **Ganz zum Schluss:** die zwei Test-Agenten fan-outen. Der User hat klargestellt, dass Sub-Agenten **nur auf ausdrückliche Anforderung** starten — die Notiz ist diese Anforderung, gilt aber erst für diesen letzten Schritt.

## 4. Risiken & Edge Cases

- **Messen ist die eigentliche Falle dieses Projekts.** Lies in jeder A/B-Tabelle **zuerst `spreadMs`**. Eine Zeile, deren Spread ihre Kosten erreicht, ist keine Messung. In dieser Schicht waren `ssr-off` (2.6 ms bei Spread 45.1) und alle `scale-*`-Zeilen vor dem SETTLE-Fix genau so wertlos. Belastbar sind nur `tools/ab.mjs` (runden-major + SETTLE) und `tools/subsystem-profile.mjs`.
- **Neue Ablationen, die Targets allozieren oder Shader-Permutationen ändern, MÜSSEN in die `SETTLE`-Map** in `tools/ab.mjs`, sonst produzieren sie stillschweigend Müll — und zwar auch in den *benachbarten* Zeilen.
- **`git stash push -- <konkrete Dateiliste>`, niemals pauschales `git stash`.** Sonst verlierst du den Adaptive-Fix in `src/render/adaptive.js` und die fremden Start-Screen-Änderungen in `index.html`, `src/global.css`, `src/main.js`. `adaptive.js` muss in **beiden** Armen drin sein.
- **Der `depth > 0`-Coverage-Vertrag** hängt an der explizit schwarzen Clear-Farbe in `GBuffer.render()` (`prepass.js:202-218`). Wer sie ändert, bricht gleichzeitig GTAO, Contact und SSR.
- **GLSL steht in JS-Template-Literals** — ein Backtick in einem Shader-Kommentar bricht den Build.
- **Ballast-System nicht entfernen.** Ein wechselndes `NUM_POINT_LIGHTS` kostete messbar 33–36 Programme und 640–900 ms auf einzelnen Frames.
- **32-Texel-Marge im Cylinder-Cull von `csm.js` nicht anfassen** (bei 2 Texeln nachweislich nicht pixel-neutral). **`mapSize` ist in `csm.js:39` auf 2048 geklemmt**, Ultras `shadowMapSize: 4096` hat also keine Wirkung.
- **Viewmodel-4×-MSAA (`_viewSamples`) stehen lassen** — einziges AA der Waffe, sie wird nicht temporal aufgelöst.
- **Der Prepass rendert alles mit `side: FrontSide`.** Bei Depth-Sharing schreiben Rückseiten von `DoubleSide`-Geometrie keine Tiefe — für flache Cards unkritisch (koplanar, LEQUAL greift), aber vor dem Livegang zu verifizieren.
- **`minRenderScale`**: Ultra steht bei 0.65 und damit *höher* als high (0.6) und medium (0.55). Nicht einfach senken, das würde Ultra unschärfer als High machen.
- Kein Hinweis auf ein Memory-Leak: Heap-Wachstum in allen Läufen 0 MB über 420 Frames. Die Notiz verlangt trotzdem Langzeittests.
- `ARCHITECTURE.md` schreibt Verzeichnis-Ownership vor; für diese systemweite Optimierung wird das bewusst übergangen.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — der Auftrag im Wortlaut inkl. der Forderung nach den zwei Test-Agenten.
- `ARCHITECTURE.md` — Engine-Vertrag, Qualitäts-Messlatte, die harte `pnpm build` + `capture.mjs`-Regel.
- `tools/ab.mjs` — runden-major, **neu: `SETTLE`-Map und die Zeile `ballast-off`**. Das Werkzeug, dem man trauen kann.
- `tools/subsystem-profile.mjs` — verlässliches End-to-End-Maß (`fps.p50`, `frameTimeMs`, `scale`, `heapMb`).
- `src/render/index.js` — `resize()` ab 964 (Reihenfolge hdrRt/gbuffer für Depth-Sharing), `_visit`/`_collect` ab 1053 (Prepass-Hide-Logik), `render()` ab 1380, Forward-Pass 1519-1521, `_cullLights` 1353.
- `src/render/prepass.js` — `GBuffer.setSize()` 143 (hier kommt die DepthTexture rein), `render()` 202 (Clear-Farb-Vertrag).
- `src/render/materialpatch.js` — 104-190: die Injektion, `owAoCached`-Hoist bei 136, `owSampleAO()` bei 299. Hier müsste auch der Vertex-Patch für `invariant gl_Position` hin.
- `src/world/index.js` — `_addBallast()` 234, `_stabiliseLightCount()` 271 mit dem Ratchet bei 306.
- `src/core/config.js` — `QUALITY_PRESETS`; `aoScale` (bleibt 0.5), `contactScale` (jetzt 1), `pointLightSlots` (der nächste Hebel).
- `src/materials/library.js:334-335` — Foliage, der letzte Blocker für Depth-Sharing. Konsumenten in `src/world/props.js:980-982`.
- `src/render/pass.js:65` — `hdrTarget()`, reicht `...opts` durch, also auch `depthTexture`.
- Rohdaten dieser Schicht: `/tmp/ab-ultra3.json` (post/csm/gtao/contact), `/tmp/ab-ultra4.json` (Budgets), `/tmp/ab-scale.json` (kontaminiert, vor dem SETTLE-Fix), `/tmp/ab-scale2.json` (Auflösungs-Sweep, brauchbar), `/tmp/ab-lights.json` (Ballast + CSM).

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md` — flüssig auch auf Ultra, **ohne** Verlust an AAA-Optik, Gameplay oder Atmosphäre. Lies zuerst `ARCHITECTURE.md`.

**Der wichtigste Befund, auf dem alles Weitere aufbaut:** Ultra ist bei 3.34 MP zu ~84 % pixel-gebunden. Aus `scale-0.8` (63.5 → 44.4 ms bei 0.64× Pixeln, Spread 1.6) folgt `frame = 10 ms + 15.9 ms/MP`. Draw-Calls (937) und Dreiecke (7.26 M) sind also **nicht** das Problem — Instancing-, LOD- und Culling-Arbeit zielt auf ein 10-ms-Budget. Alles, was zählt, sind die Kosten pro Pixel. Aufteilung bei 3.34 MP: post 12.3 ms · CSM-Sampling 8.5 ms · Punktlicht-Ballast 4.6 ms · restliches Forward-Fragment-Shading ~28 ms.

Arbeite so weiter:

1. **Erster Schritt: `node_modules/.bin/vite build`.** Der letzte Build ist älter als der `contactScale: 1`-Rückbau in `src/core/config.js`, jede Messung davor misst den falschen Stand. Es laufen bereits ein Dev-Server auf 5173 und ein Preview-Server auf 8080; miss immer gegen den Production-Build auf 8080.
2. **Lies in jeder A/B-Tabelle zuerst `spreadMs`.** Eine Zeile, deren Spread ihre Kosten erreicht, ist keine Messung. `tools/ab.mjs` ist runden-major mit 240 Frames Warmlauf und hat jetzt eine `SETTLE`-Map: Zeilen, die Render-Targets neu allozieren oder Shader-Permutationen ändern, brauchen 60–120 Settle-Frames statt 12 — ohne das kamen die `scale-*`-Zeilen mit Baselines von 109–123 ms statt 63 ms und Spreads von 52–79 ms zurück. **Jede neue Ablation dieser Art gehört in die Map.**
3. **Nächster Hebel: `pointLightSlots` bei high/ultra von 20 auf 12.** `ballast-off` misst 4.6 ms bei Spread 0.7 für die toten Slots. Die Welt besitzt nur 17 Praktikale insgesamt. **Das Ballast-System dabei NICHT abschalten** — nur den Zielwert senken; der Ratchet in `world/index.js:306` fängt Überläufe mit genau einem Recompile ab. Ein frei schwankendes `NUM_POINT_LIGHTS` kostet 640–900 ms auf einzelnen Frames.
4. **Größter verbliebener Win: Depth-Prepass-Wiederverwendung.** Der Prepass wird komplett bezahlt und sein Tiefen-Attachment weggeworfen; das Frame ist pixel-gebunden, also greift Early-Z. Zwei der drei alten Blocker sind entschärft: `_visit` (`render/index.js:1071`) hält bereits **alle** transparenten Objekte plus `owNoPrepass` aus dem Prepass heraus, `hdrRt` ist nicht MSAA und größengleich mit dem GBuffer. Übrig bleibt **Foliage** (`materials/library.js:334-335`, `alphaTest: 0.45`, benutzt von `palm_frond`/`shrub`/`weeds` in `world/props.js:980-982`). Mach den Prepass alpha-test-fähig über **zwei Overrides in zwei Durchgängen**, nicht über ein `discard` für alle — Letzteres killt Early-Z im Prepass selbst. Danach `gbuffer.setSize` in `resize()` vor die `hdrRt`-Erzeugung ziehen, `hdrRt` mit `depthTexture` bauen und in `render()` Zeile 1520 nur noch die Farbe clearen. **Vorher `invariant gl_Position` in beiden Shadern absichern** — Prepass ist GLSL3, die Stock-Materialien sind GLSL ES 1.00, und eine ULP-Abweichung nach oben lässt LEQUAL die Oberfläche verwerfen (flackernde Löcher). **Empfehlung: erst als Wegwerf-Experiment mit dem Foliage-Bug messen, um die Größe des Gewinns zu kennen, bevor du die saubere Version baust.**
5. **CSM `mapSize` 2048 → 1536 bei Ultra ist gestrichen und bleibt es.** Die Rechnung der Vorschicht verglich gegen die alte 200-m-Baseline. Mit `shadowDistance: 150` ist Ultras Texel heute 0.0732 m; mit 1536 wären es 0.0977 m und damit 33 % gröber als `high` (0.0684 m). Ultra bekäme schlechtere Schatten als High.
6. **`contactScale` ist bewusst wieder 1** — `contact-off` kostet 0.5 ms von 63 ms, halbe Auflösung kann dort nichts holen und würde ein 3–10 px breites Band auffressen. Die `blurScale`-Signatur in `contact.js` bleibt trotzdem stehen, sie ist korrekt.
7. **Das visuelle Gate ist noch nie gelaufen, `shots/` existiert nicht.** Fahre es: Änderungen mit `git stash push -- <konkrete Dateiliste>` trennen (**niemals pauschales `git stash`**, sonst verlierst du den Adaptive-Fix in `src/render/adaptive.js` und die fremden Start-Screen-Änderungen), dann `shotset.mjs` für beide Arme und `imagediff.mjs --tol=2 --write-diff`. `?capture=1` erzwingt Ultra + deterministisch. Während eines `shotset`-Laufs keine Dateien editieren (Dev-Server auf 5173, HMR). Halte `pnpm build` und `node tools/capture.mjs` grün — `capture.mjs` ist bisher nie gelaufen.
8. **Sag dem User früh, wo die Grenze liegt:** 60 fps bei Ultra und 3.34 MP würden bei ~10 ms Fixkosten rund 2 ms/MP verlangen statt der gemessenen 15.9 — Faktor 8, das ist eine Neuentwicklung, keine Optimierung. Stimme die Zielmarke explizit ab, statt sie zu unterstellen.
9. **Fass nicht an:** die 32-Texel-Marge im Cylinder-Cull von `csm.js`, das Ballast-System, den Viewmodel-4×-MSAA (einziges AA der Waffe), die schwarze Clear-Farbe in `GBuffer.render()` (trägt den `depth > 0`-Vertrag von GTAO/Contact/SSR).
10. **Erst wenn die Optimierung vollständig und pixel-abgesichert ist**, fahre die beiden vom Auftrag geforderten Test-Agenten aus (einer Performance, einer visuelle Qualität und Gameplay-Regressionen), die die Änderungen nicht selbst gemacht haben. Der User hat klargestellt, dass Sub-Agenten nur auf ausdrückliche Anforderung starten — diese Anforderung steht in der Notiz, gilt aber erst für diesen letzten Schritt.

Lösche zum Schluss `tools/_navcheck.mjs`. Es gibt weiterhin keinen Hinweis auf ein Memory-Leak (Heap-Wachstum 0 MB über 420 Frames), die Notiz verlangt aber explizit Langzeittests.
