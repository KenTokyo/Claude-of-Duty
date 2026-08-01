# PH14 - Fill-Rate-Optimierung Post-Pipeline - fillcost-Integration in fill-Ran...

> 2026-08-01T06:38:40.430Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH14)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` soll vollständig performance-optimiert werden — auch auf Ultra — ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). In dieser Schicht sind **33,0 M Fetches pro Frame wirklich entfernt** worden (Sky-Dome-Depth-Test 19,6 M + TAA-Dilatation 13,4 M), fünf bisher ungemessene Vollbild-Pässe wurden modelliert, das Messwerkzeug `taataps` neu gebaut — und der Harness hatte einen systematischen Fehler, der eine ganze Klasse von Messungen geschönt hat.

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Alle Skripte direkt unter `tools/*.mjs` starten Chromium. Benutzbar ist ausschließlich `node tools/cli/cod.mjs`.

**Gesamtstand: `fill --q=ultra --real --look=1` meldet 525,4 M (PH13) → 476,0 M.** Davon 33,0 M echte Reduktion, der Rest bessere Modellierung. `/tmp/cod/ph14-fill-real.json`.

**Änderung 1 — `src/sky/dome.js`, `depthTest: false` → `true`. 33,4 M → 13,8 M, −19,6 M, ausgabeidentisch.** Der Dome ist ein Vollbild-Quad auf NDC z = 1 mit `renderOrder: -10000`. Der Forward-Pass erbt den Prepass-Tiefenpuffer (`reusePrepassDepth`, `render/index.js:1032/1639`), also steht auf jedem verdeckten Pixel bereits die Endtiefe, wenn das Quad gezeichnet wird. LEQUAL besteht damit genau dort, wo der Prepass nichts geschrieben hat — der Himmel —, und fällt auf jedem der **58,8 % Geometriepixel** durch. Kein `discard`, kein `gl_FragDepth`, kein Depth-Write: die Verwerfung ist Early-Z, `skSample` wird gar nicht erst betreten. Ohne Prepass oder auf dem `directViewmodel`-Pfad wird die Tiefe vorher auf 1,0 geleert, LEQUAL besteht überall, Verhalten wie vorher. Das ist die billigste Änderung des Projekts bisher: ein Wort.

**Änderung 2 — `src/render/taa.js`, 9-Tap-Dilatation → 5 Taps (vier Ecken + Mitte). −4 Fetches, −13,4 M.** Neu: `#define OW_TAA_DILATE_TAPS 5`, eine Hilfsfunktion `owDilate()` und fünf entrollte Aufrufe statt der Schleife.

**Das Werkzeug dafür neu gebaut: `taataps` (`tools/cli/taasim.mjs` + `cmdTaataps`).** Es rastert Tiefe und Coverage in der **echten Passauflösung 2268×1473**, baut die Velocity exakt so, wie `prepass.js` sie schreibt (`(currNDC − prevNDC) * 0.5`), und wertet jedes Tap-Muster auf denselben Pixeln aus. **Warum das ohne GPU geht:** die Dilatation ist eine reine Funktion des Tiefenpuffers, ihre beiden Abnehmer (`cb`, `vel`) sind geschlossene Formen davon, und alles unterhalb von `huv` — Catmull-Rom, Varianz-Clip, Feedback — ist eine feste Funktion von `huv`. Die gemeldete Verschiebung von `huv` in Pixeln ist damit **die ganze Differenz zwischen zwei Shadern, kein Korrelat davon.** Farbe geht nirgends ein.

**Die Messung (Anteil des Frames, dessen History-Sample mehr als einen Pixel danebenlandet):**

| Muster | Taps | gespart | >1 px | Mittel px | max px |
|---|---|---|---|---|---|
| gar keine Dilatation | 1 | 8 | 0,796 % | 0,0934 | 51,2 |
| „+"-Kreuz | 5 | 4 | 0,179 % | 0,0306 | 51,2 |
| **X + Mitte (eingebaut)** | **5** | **4** | **0,0029 %** | **0,00132** | **30,2** |
| 4 Ecken ohne Mitte | 4 | 5 | 0,0051 % | 0,00167 | 30,3 |

**Der Befund, den die nächste Schicht weitertragen muss: das naheliegende „+"-Kreuz ist bei gleichen Kosten 62-mal schlechter.** Über ein lokal ebenes Tiefenfeld `d = d0 + gx·x + gy·y` liegt das Minimum der neun immer auf der Ecke `(−sign gx, −sign gy)` — die Ecken sind, wo beide Gradienten extrem sind. Ein Kantenmittelpunkt gewinnt nur bei exakt achsparallelem Gradienten oder an einer echten Diskontinuität. Wer die vier Ecken wegwirft, wirft fast jedes Argmin weg. Die Mitte bleibt drin, weil sie der Dünn-Geometrie-Fall ist: auf einem ein Pixel breiten Kabel sind alle vier Diagonalen Himmel, und ohne die eigene Tiefe nähme das Pixel die Hintergrund-Reprojektion — genau der Fehler „Stromleitungen durch die Waffe lesbar", den dieser Pass schon einmal behoben hat.

**Der Harness-Fehler, und er ist wichtig: `driveLook` dreht die Kamera und sonst nichts.** Parallaxe entsteht aber ausschließlich aus **Translation**. Unter reiner Drehung bewegt sich jedes Pixel um fast denselben Bildschirmversatz, egal wie tief — und genau davon lebt die Velocity-Dilatation. Die erste Messung meldete deshalb max 0,107 px für *gar keine Dilatation*, also „ist nichts wert". Das war ein Artefakt der Eingabe. Neu: **`driveMove(engine, 'KeyW')`** in `cod.mjs`, hält die Taste über `_pendingDown` (denselben Set, den ein echtes keydown schreibt) den ganzen Lauf. `taataps` fährt sie standardmäßig, meldet `movedMPerFrame` und **warnt selbst, wenn unter 0,002**. `--move=none` reproduziert den alten Fall. **Jede frühere Messung, die von Parallaxe abhängt, ist damit potenziell geschönt** — Motion Blur und SSR sind die Kandidaten.

**Fünf Pässe in `fillsim.passCost` aufgenommen, `modelledPasses` 6 → 11:**

| Pass | Res | Schranke | REAL | Basis |
|---|---|---|---|---|
| sky-vol-march | 0,25 | 96,1 M | 74,7 M | exact |
| **ow-taa** | 1 | 76,8 M | **72,2 M** | **exact (neu)** |
| ow-mb | 1 | 173,7 M | 63,5 M | exact |
| **sky-vol-composite** | 1 | 33,4 M | **33,4 M** | **exact (neu)** |
| **ow-composite** | 1 | 33,4 M | **33,1 M** | **exact (neu)** |
| ow-gtao | 0,25 | 41,7 M | 24,9 M | exact |
| ow-contact-blur | 1 | 33,4 M | 22,7 M | exact |
| **ow-view-composite** | 1 | 33,4 M | **20,0–22,0 M** | **bounded (neu)** |
| ow-contact | 1 | 53,5 M | 18,7 M | bounded |
| ow-ssr | 0,25 | 143,6 M | 18,0 M | bounded |
| fx-haze-warp | 1 | 16,7 M | 16,7 M | bound only |
| **sky-dome** | 1 | 33,4 M | **13,8 M** | **coverage (neu)** |

Neue Basis **`coverage`**: die Fetch-Zahl pro Fragment bleibt unangetastet, gemessen wurde, **wie viele Fragmente den Tiefentest überhaupt überleben**. `fill` multipliziert dafür die *eigene* fragcost-Zahl der Zeile (`shadedFraction`), statt sie zu wiederholen — sonst driftet das Modell beim nächsten Shader-Edit weg. `ow-taa` liest seine Tap-Zahl aus `OW_TAA_DILATE_TAPS`, wie `VOL_TAPS` und `MB_TAPS`.

**Zwei Ergebnisse daraus:** `sky-vol-composite` ist bei **exakt 10** — nicht jeder ungemessene Pass war überschätzt, das gehört mit ins Protokoll. Und `ow-view-composite` ist real 6,0–6,6 statt 10 Fetches: **das Viewmodel plus ein Texel sind nur 15 % des Frames.**

**`pnpm check` ist grün.** Der Backtick-Fehler ist mir einmal passiert (`taa.js`, `` `taataps` `` im Shader-Kommentar) — das Gate hat ihn sofort gefangen, genau dafür ist es da.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **HALBFERTIG UND UNGETESTET: der `ow-view-composite`-Early-Out. Zuerst zu Ende bringen.** Wert ~14,2 M. Geschrieben ist bereits: `uViewRect` (vec4, min/max UV) als Uniform in `createViewComposite()`, Default `(0,0,1,1)`; der Early-Out im Shader (`src/render/composite.js`, direkt nach `world`); `RenderSystem._viewScreenRect()` in `src/render/index.js` hinter `_collectViewScene`; Scratch-Felder `_viewRectV3`/`_viewRectScratch` im Konstruktor; der Aufruf **nach** `renderer.render(viewScene, viewCamera)` (vorher wären die Weltmatrizen einen Frame alt). **Noch NICHT gelaufen: `pnpm check`.** Danach fehlt: das Verifikationskommando `cod viewrect` (unten). **Der Early-Out ist beweisbar ausgabeidentisch**, weil das Viewmodel-Target auf `vec4(0)` geleert wird: ist die ganze Fünf-Tap-Nachbarschaft leer, ist jedes `edgeLuma` 0, `lmax − lmin` 0, der Test gegen `max(0.045, 0)` schlägt fehl, `alpha` ist 0 und die Zeile reduziert sich auf `world`. Die ganze Last liegt also auf dem Rechteck.
2. **`cod viewrect` bauen, bevor das ausgeliefert wird.** `_viewScreenRect` pro Frame neu herleiten und gegen **jeden Vertex** prüfen, den das Viewmodel wirklich zeichnet (nicht rastern — die Vertex-Projektion ist der exakte Test), über ~120 Frames im `firefight`-Stage inklusive Feuern und ADS. Ausgeben: kleinster Rand in Texeln und wie oft auf Vollbild zurückgefallen wurde. **Rand negativ = Waffe wird beschnitten = nicht ausliefern.** Die Mathematik dahinter ist belastbar: die x-Ausdehnung des perspektivischen Bildes einer Kugel hängt nur von X und Z ab (`X/−Z` enthält kein Y), das Extremum liegt also auf dem Großkreis in der x-z-Ebene durch den Mittelpunkt und die beiden Tangenten liefern es exakt. **Gemessene Randbedingung, die das trägt: `viewScene` enthält 111 starre Meshes, 0 skinned, 0 morph, 0 instanced** — genau die Unsicherheit, an der PH13 diese Idee als „riskant" liegen gelassen hat, existiert nicht. Drei Ausstiege gehen bewusst auf Vollbild statt zu raten: Kugel schneidet Near-Plane, fehlende Bounding-Sphere, InstancedMesh.
3. **`ow-gtao-blur` Sky-Early-Out, ~4,1 M, exakt.** Die Beweiskette steht komplett: `AO_CORE` schreibt für Himmel `vec4(1.0, 1e4, 0, 1)`, in `AO_BLUR` (`src/render/gtao.js:196`) ist jedes Nachbargewicht `w0·exp(−|a.g−1e4|·22/1e4)` ≈ 3e-10 für jede echte Tiefe, alle Himmelsnachbarn tragen `.r = 1.0`, also ist das Ergebnis `(S+ε)/(S+ε)` mit S ≥ 0,4 und ε ≤ 7e-10 — Abweichung von 1,0 höchstens ~2e-9, während die **kleinste Stufe von Half-Float bei 1,0 rund 5e-4 ist. Nach dem Write also bitgleich.** `pow(1, y) = 1`, der Intensitätszweig ändert daran nichts. 1e4 ist in Half-Float exakt darstellbar (Abstand 8 bei 10000, 10000/8 ganzzahlig). **Trotzdem prüfen, ob der Temporal-Pass zwischen Core und Blur `.g` unverändert durchreicht** — sonst trägt das Sentinel dort nicht.
4. **`fx-haze-warp` modellieren (16,7 M, immer noch „bound only").** Reine Rangfolgen-Korrektur, vermutlich auf ~7 M. PH13 hat den Null-Distortion-Early-Out eingebaut und beziffert ihn mit ~2 statt 5 Fetches auf 97 % der Pixel; **die 97 % sind meines Wissens argumentiert, nicht gemessen** — als Annahme behandeln und entweder messen oder als `bounded` mit lo 2 / hi 5 eintragen.
5. **Ein Tap statt zwei im Volumetric March liegt weiterhin gemessen bereit: +36 M.** Konvergiert 0,047 Prozentpunkte, Einzelbild-p99 5,1 Prozentpunkte, eine Zeile (`SK_VOL_SHADOW_TAPS 1` in `src/sky/volumetrics.js`). Bewusst bei zwei belassen, damit die Schätzung auch **innerhalb** eines Frames trägt, wo der Resolve gerade disokkludiert hat. Das ist die Reserve, wenn mehr gebraucht wird.
6. **Abschluss-Verifikation, in dieser Schicht noch nicht gelaufen:** `pnpm check`, `probe` gegen `/tmp/cod/ph13-probe.json`, ein `leak --q=ultra --frames=3000`. Der Sky-Dome-Depth-Test ändert den Draw-Stream **nicht** (ein verworfenes Fragment ist ein abgeschickter Draw) — `probe` sollte identisch sein, jede Abweichung dort wäre ein Fund.
7. **`shot`-Smoke-Test steht seit PH11 aus.** Kann zu March, TAA und Motion Blur konstruktionsbedingt nichts sagen (`raster.mjs:11` sagt selbst „no PBR, no shadow" und rendert keine Post-Kette). Als reiner Nicht-Absturz-Test trotzdem billig.

## 4. Risiken & Edge Cases

- **Der Harness bewegt den Spieler standardmäßig nicht.** `driveLook` dreht nur, und das reicht für Motion Blur (dessen Early-Out an Bildschirmbewegung hängt), aber **nicht** für alles, was von Parallaxe lebt. `driveMove` existiert jetzt, wird aber bisher **nur von `taataps` benutzt**. `fill --real` und `fillcost` messen weiter einen Spieler, der auf der Stelle steht (`cameraMovedM: 0.0001`). Wer SSR oder Motion Blur ernsthaft anfasst, sollte `driveMove` dort zuerst einhängen.
- **`fill` ist statisch, `fill --real` und `fillcost` sind dynamisch. Ab jetzt immer `--real`.** `ow-ssr` ist um Faktor 7,96 überschätzt. Neu: `sky-dome` um 2,43, und `sky-vol-composite` gar nicht.
- **Ein `coverage`-Eintrag ist eine Untergrenze der Ersparnis, keine Obergrenze der Kosten.** Opake Geometrie, deren Alpha-Cut der Prepass nicht reproduzieren kann (außerhalb `canPrepassAlphaTest`), hinterlässt Tiefe 1,0, wird vom Dome beschattet und dann überzeichnet — die alten Kosten, nie ein falsches Pixel.
- **`_viewScreenRect` läuft nach dem Viewmodel-Draw, weil `renderer.render()` die Weltmatrizen auffrischt.** Wer den Aufruf nach vorn zieht, bekommt das Rechteck von letztem Frame — und beim Rückstoß ist genau das die Kante, an der die Waffe abgeschnitten wird.
- **`_viewRectV3` ist absichtlich eine eigene Scratch-Variable:** `_tmpV3` wird im selben Viewmodel-Block schon vom Licht-Rig benutzt.
- **Backticks in `/* glsl */`-Template-Literalen beenden das JS-String.** Mir in dieser Schicht einmal passiert. In Shader-Kommentaren niemals Backticks, kein `${`.
- **Der GL-Mock kompiliert keine Shader.** Nach JEDER Shader-Änderung `pnpm check`.
- **`taataps` in voller Auflösung braucht `--max-old-space-size=8192`** und läuft einige Minuten (3,34 M Pixel × 5 Muster). `--w=480 --h=312` ist schnell, **überschätzt aber die Abweichung systematisch**: bei halber Breite überspannt ein 3×3 die doppelte Weltfläche, Tiefensprünge fallen viel öfter hinein. Klein simulieren ist konservativ, nicht billig.
- **`grep`/`rg` liefern in dieser Sandbox leere Ergebnisse** — Ersatz: `node -e` mit `fs.readFileSync`. **`timeout` existiert nicht. Niemals `git stash`** — in `index.html`, `src/global.css`, `src/main.js` liegt fremde, uncommittete Arbeit.
- **`ab` misst CPU-Zeit.** Alle Änderungen dieser Schicht sind rein GPU-seitig; ein `z ≈ 0` dort ist erwartet, kein Gegenbeweis.
- **Annahme, nicht bewiesen:** In `fillsim` wird die TAA-Coverage-Dilatation mit dem vollen 3×3 gerechnet, obwohl der Shader jetzt fünf Taps hat. Das ist absichtlich eine Obergrenze — die 3×3-Dilatation enthält jede Teilmuster-Dilatation — und betrifft **einen** Fetch von 22.
- **Geprüft, nicht angenommen:** `viewScene` ist zu 100 % starr (111 Meshes, 0 skinned/morph/instanced), Stand `firefight`-Stage bei Frame 90. Wenn später animierte Hände dazukommen, **fällt die Grundlage von `_viewScreenRect` weg** — dann muss die Bounding-Sphere pro Frame neu berechnet oder auf Vollbild zurückgefallen werden.
- **60 fps bei Ultra und 3,34 MP bleiben mit diesem Feature-Set unerreichbar.** Flaschenhals ist die GPU, CPU-Median 5,3–6,8 ms.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()`, 32-Texel-Marge im CSM-Zylinder-Cull, Zeilen 129–160 in `adaptive.js`, `maxPixelRatio` 1,5. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048→1536, gestaffelte Kaskaden-Updates, Spatial-BatchedMesh, `CHUNK`-Verkleinerung, Größen-Culling, instanz-genaues Kaskaden-Culling, `contactScale`.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. Kein-Headless-Zeile.
- `tools/cli/taasim.mjs` — **neu, das Kernwerkzeug dieser Schicht.** Der Kopfkommentar führt die Begründung, warum die Antwort ohne GPU berechenbar ist; ohne sie sieht die Methode nach Raten aus. Enthält die Musterliste (`PATTERNS`) und die exakte Nachbildung der GLSL-Schleife samt Tie-Break auf den frühesten Index.
- `tools/cli/cod.mjs` — neu: `cmdTaataps`, `driveMove`, die `coverage`-Basis in `cmdFill`. **`THREE` ist hier NICHT importiert** — Grad/Bogenmaß von Hand.
- `tools/cli/fillsim.mjs` — neu: `ow-taa`, `ow-composite`, `sky-vol-composite`, `sky-dome`, `ow-view-composite`; `OW_TAA_DILATE_TAPS` wird aus dem Shader gelesen; `avg()` prüft weiterhin, dass die Populationen das Bild genau einmal überdecken.
- `src/render/taa.js` — `OW_TAA_DILATE_TAPS`, `owDilate()`, und die vollständige Begründung des X-Musters inklusive der Warnung vor dem „+"-Kreuz.
- `src/sky/dome.js:328-360` — der Depth-Test mit der ganzen Argumentationskette für alle drei Konfigurationen.
- `src/render/composite.js` — `uViewRect`, der Early-Out und das Identitätsargument. **Ungetestet.**
- `src/render/index.js` — `_viewScreenRect()` hinter `_collectViewScene`, Scratch-Felder um Zeile 326, Aufruf im Viewmodel-Block hinter `renderer.render(viewScene, viewCamera)`. **Ungetestet.**
- `/tmp/cod/ph14-fill-real.json` (die eine Rangfolge), `ph14-taataps-full.json` (die Musterentscheidung in voller Auflösung), `/tmp/cod/ph13-probe.json` (**die richtige Probe-Baseline**, aus PH13).

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md`.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Skripte direkt unter `tools/*.mjs` starten Chromium; benutzbar ist nur `node tools/cli/cod.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut. `grep`/`rg` liefern hier leere Ergebnisse — benutze `node -e` mit `fs.readFileSync`. `timeout` existiert nicht. Niemals `git stash`.

**Fang mit der halbfertigen Änderung an, sie ist ungetestet.** In `src/render/composite.js` und `src/render/index.js` liegt ein Early-Out für `ow-view-composite`: ein Uniform `uViewRect`, ein Frühausstieg im Shader und `RenderSystem._viewScreenRect()`, das die projizierten Bounding-Spheres aller Viewmodel-Meshes vereinigt. **`pnpm check` ist darauf noch nicht gelaufen.** Wert ~14,2 M Fetches. Der Early-Out selbst ist beweisbar ausgabeidentisch — das Viewmodel-Target wird auf `vec4(0)` geleert, also ist bei leerer Fünf-Tap-Nachbarschaft `lmax − lmin` gleich 0, der Kantentest schlägt fehl, `alpha` ist 0 und der Pass liefert `world` unverändert. Die ganze Last liegt auf dem Rechteck, also **baue `cod viewrect`, bevor du das stehen lässt**: leite das Rechteck pro Frame neu her und prüfe es gegen jeden Vertex, den das Viewmodel wirklich zeichnet, über ~120 Frames im `firefight`-Stage mit Feuern. Negativer Rand heißt beschnittene Waffe, dann nicht ausliefern. Die Grundlage ist gemessen, nicht angenommen: `viewScene` enthält 111 starre Meshes, 0 skinned, 0 morph, 0 instanced.

**Benutze `fill --q=ultra --real --look=1`, niemals `fill` allein.** Gesamt real 476,0 M gegen 831,5 M Schranke, elf Pässe modelliert. Die Basis-Kennzeichnung ist jetzt vierteilig: `exact`, `bounded`, **`coverage`** (die Fetch-Zahl pro Fragment steht unverändert, gemessen wurde, wie viele Fragmente den Tiefentest überleben) und `bound only` = nicht modelliert, keine Messung. Die Schranke ist stellenweise absurd daneben — `ow-ssr` um Faktor 7,96 —, aber bei `sky-vol-composite` ist sie exakt. Beides gehört ins Protokoll.

**Zwei Lehren aus dieser Schicht, die du beim nächsten Tausch brauchst.** Erstens: **das naheliegende Muster war das falsche.** Beim Ersetzen von TAAs 9-Tap-Dilatation ist das „+"-Kreuz bei identischen Kosten 62-mal schlechter als die vier Ecken plus Mitte, weil über einem lokal ebenen Tiefenfeld das Minimum immer auf einer Ecke liegt — dort sind beide Gradienten extrem. Gemessen mit `taataps` in der echten Passauflösung 2268×1473: 0,179 % des Frames gegen 0,0029 %, wo gar keine Dilatation 0,796 % kostet. Zweitens, und wichtiger: **der Harness bewegte den Spieler nie.** `driveLook` dreht nur die Kamera, Parallaxe kommt aber ausschließlich aus Translation, und unter reiner Drehung meldete dieselbe Messung, dass die Dilatation *gar nichts* wert sei. `driveMove` behebt das und `taataps` warnt selbst unter 0,002 m/Frame — aber `fill --real` und `fillcost` fahren es noch nicht. Wenn du SSR oder Motion Blur anfasst, häng es dort zuerst ein und miss neu.

**Nach JEDER Shader-Änderung `pnpm check`** (= glslcheck + build). Der GL-Mock kompiliert nie einen Shader — ohne das Gate ist ein kaputter Shader von korrektem durch nichts unterscheidbar. **Setze in `/* glsl */`-Template-Literalen niemals Backticks**; mir ist das hier einmal passiert und das Gate hat es sofort gefangen.

**Sag dem User früh und deutlich:** 60 fps bei Ultra und 3,34 MP sind mit diesem Feature-Set nicht erreichbar; der Flaschenhals ist die GPU. Setze stattdessen die Linie fort: Fetch-Reduktionen, die entweder beweisbar ausgabeidentisch sind — wie der Sky-Dome-Depth-Test, der 58,8 % der Pixel vor `skSample` verwirft, oder der gtao-blur-Early-Out, dessen Abweichung von 1,0 bei ~2e-9 liegt, während Half-Float bei 1,0 erst bei 5e-4 auflöst — oder deren Abweichung wie bei den TAA-Taps gemessen und in Prozentpunkten beziffert ist. **Ein Tap statt zwei im Volumetric March liegt weiter gemessen bereit und bringt 36 M**: konvergiert 0,047 Prozentpunkte, eine Zeile in `src/sky/volumetrics.js`. Er bleibt bewusst bei zwei, damit die Schätzung auch innerhalb eines einzelnen Frames trägt — greif darauf zurück, wenn mehr gebraucht wird.
