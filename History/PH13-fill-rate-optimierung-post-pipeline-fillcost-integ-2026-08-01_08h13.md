# PH13 - Fill-Rate-Optimierung Post-Pipeline - fillcost-Integration in fill-Ran...

> 2026-08-01T06:13:16.304Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH13)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` soll vollständig performance-optimiert werden — auch auf Ultra — ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). In dieser Schicht wurden **78,6 M Fetches pro Frame entfernt** (davon 72,1 M aus dem größten Einzelposten des Frames, dem Volumetric March), das dafür nötige Messwerkzeug `voltaps` neu gebaut, und `fill --real` liefert jetzt **eine einzige Rangfolge** statt zweier, die von Hand verrechnet werden müssen.

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Alle Skripte direkt unter `tools/*.mjs` starten Chromium. Benutzbar ist ausschließlich `node tools/cli/cod.mjs`.

**Strukturelle Absicherung der vier PH12-Änderungen (Aufgabe 2 aus PH12) — bestanden.** `leak --q=ultra --frames=3000`: Heap 44,04 → 44,89 MB über 3000 Frames (+0,85 MB, praktisch flach), `glTextures` 133, `glBuffers` 1405, `glPrograms` 100, `gpuMB` 809,56 — **über alle 10 Messpunkte konstant**. Kein Leck.

**Achtung, Baseline-Falle:** `probe` zeigt gegen `/tmp/cod/ph10-probe.json` Draws 1153→1077, Dreiecke 9,37 M→8,58 M, Programme 101→100. Das ist **keine Regression** — die alten Probe-Dateien (`ph10-probe.json` 06:36, `probe-ultra.json` 06:09) stammen von VOR der castShadow-Arbeit aus PH10/PH11, die genau diese Draws entfernt hat. **Es gibt keine Post-PH11-Probe-Baseline.** `/tmp/cod/ph13-probe.json` ist ab jetzt die richtige.

**Aufgabe 1 aus PH12 erledigt: `fill` neu gefahren.** 941 808 214 (PH11) → 935 126 686 (nach PH12) → **844 862 554** jetzt.

**Änderung 1 — `fx/haze.js` WARP_FRAG, Null-Distortion-Early-Out.** Beweisbar bit-identisch: bei `d == vec2(0)` ist `vUvw + 0.0*k` für jedes k exakt `vUvw`, also sind die drei Chroma-Taps drei Fetches desselben Texels und `vec4(c.r,c.g,c.b,c.a)` ist `c`. Der Distortion-Puffer wird auf Null geleert und nur dort beschrieben, wo ein Sprite landet. **Spart ~6,5 M/Frame.** **Wichtig:** `fill` meldet dafür 4→5 Fetches, also eine *Verschlechterung* — die statische Schranke zählt den Early-Out-Fetch als zusätzliche Stelle. Genau der Fall, den die Schranke falsch herum bewertet.

**Änderung 2 — die große: `sky/volumetrics.js`, `skSunVisibility` von 4 auf 2 Vogel-Taps.** Vorher 227 statisch / 175,7 real Fetches pro Fragment, jetzt 115 / 89,4. **146,8 M → 74,7 M pro Frame, −72,1 M.** Neu: `#define SK_VOL_SHADOW_TAPS 2`, Schleifengrenze und Normalisierung (`s / float(SK_VOL_SHADOW_TAPS)`) lesen die Zahl von dort.

**Das Werkzeug dafür neu gebaut: `voltaps` (`tools/cli/volsim.mjs` + `cmdVoltaps`).** Es rastert die vier Kaskadenkarten in ihrer **echten Auflösung 2048²** aus der echten Casterliste, marschiert jedes Pixel mit der eigenen Schrittverteilung, dem eigenen Dither (`skIGN` portiert), dem echten Dichterauschen (`skVal3` portiert) und der echten Kaskadenprojektion, und wertet jede Tap-Zahl auf **denselben Schritten** aus.

**Warum die Zahl ohne GPU berechenbar ist** — der Kern der Begründung, bitte weitertragen: L ist **exakt affin** in der Folge der Sichtbarkeiten `vis_i`, weil Transmittanz, `sigmaS` und `sigmaE` den Schattenterm nie lesen. Also ist `dL = Σ w_i K_i dvis_i` mit **identischen w_i auf beiden Seiten**, und `|dV|/V` beschränkt den relativen In-Scatter-Fehler nach oben, weil der Ambient-Boden nur den Nenner vergrößert. Phasenfunktion, Ambient-LUT und Wolkendecke kürzen sich heraus oder helfen nur.

**Gegenprobe bestanden:** `voltaps` meldet 43,16 tappende Schritte pro Strahl und 175,7 Fetches/Fragment — `fillcost` sagt unabhängig 43,18 und 175,7. Zwei getrennte Implementierungen auf drei signifikante Stellen.

**Die Messung selbst:**

| Variante | Ersparnis | \|ΔV\| Einzelbild | \|ΔV\| konvergiert | p99 konv. | max konv. |
|---|---|---|---|---|---|
| 3 Taps | 24,5 % | — | 0,00018 | 0,0031 | 0,0148 |
| **2 Taps (eingebaut)** | **49,1 %** | 0,0016 | **0,00026** | 0,0047 | 0,0140 |
| 1 Vogel-Tap | 73,7 % | 0,0028 | 0,00047 | 0,0080 | 0,0230 |
| 1 Tap in der Mitte | 73,7 % | 0,0022 | **0,00217** | 0,0353 | 0,0903 |

„Konvergiert" = über 8 Dither-Rotationen gemittelt, also der Fixpunkt, auf den `sky-vol-resolve`s 0,9-Exponentialmittel zuläuft (`uFrame` dreht die Scheibe jedes Frame).

**Zwei Befunde daraus, die die nächste Schicht braucht:**
1. **Die Taps sind NICHT redundant.** Über 2,76 M Aufrufe landen die vier auf **3,998 verschiedenen Texeln** im Mittel. Das ist also ein echter Tausch, kein Entfernen von Überabtastung — anders als bei Motion Blur in PH12.
2. **Der Mittel-Tap ist die falsche Wahl und im Einzelbild trügerisch.** Er sieht auf ein Frame gemessen besser aus als der Vogel-Tap (0,0022 gegen 0,0028), konvergiert aber als einziger **nicht** (0,00217 gegen 0,00047, Faktor 4,6) — eine Drehung liefert dasselbe Texel. Die Rotation ist der Grund, warum die Akkumulation funktioniert, und sie hat nur dann etwas zu überstreichen, wenn der Tap außermittig sitzt.

**`fillcost` liest die Tap-Zahl jetzt aus dem Shader** (`SK_VOL_SHADOW_TAPS`), statt 4 fest verdrahtet zu haben — sonst hätte es nach der Änderung weiter 146,8 M gemeldet. `whereTheStepsGo.tapped4x` heißt jetzt `tapped`, neu ist `tapsPerTappingStep`.

**Aufgabe 3 aus PH12 erledigt: `fill --real`.** `fillsim` gibt jetzt `passCost` aus — eine realisierte Fetch-Zahl pro Pass mit ausgewiesener **Basis**: `exact` (jeder entscheidende Zweig pro Pixel ausgewertet), `bounded` (Marsch bricht beim Treffer ab, lo/hi klammern), `bound only` (nicht modelliert, die Schranke steht unverändert da und ist als Nicht-Messung markiert). Die Populationen müssen das Bild exakt einmal überdecken — `avg()` wirft sonst, damit keine Population still unter den Tisch fällt.

**Die eine Rangfolge, Stand jetzt** (`fill --q=ultra --real --look=1`, Gesamt **525,4 M real** gegen 844,9 M Schranke):

| Pass | Res | Schranke | REAL | Basis | Schranke zu groß um |
|---|---|---|---|---|---|
| **ow-taa** | 1 | 90,2 M | **90,2 M** | bound only | — |
| sky-vol-march | 0,25 | 96,1 M | 74,7 M | exact | 1,29× |
| ow-mb | 1 | 173,7 M | 63,5 M | exact | 2,74× |
| sky-dome | 1 | 33,4 M | 33,4 M | bound only | — |
| sky-vol-composite | 1 | 33,4 M | 33,4 M | bound only | — |
| ow-view-composite | 1 | 33,4 M | 33,4 M | bound only | — |
| ow-composite | 1 | 33,4 M | 33,4 M | bound only | — |
| ow-gtao | 0,25 | 41,7 M | 24,9 M | exact | 1,68× |
| ow-contact-blur | 1 | 33,4 M | 22,7 M | exact | 1,47× |
| ow-contact | 1 | 53,5 M | 18,7 M | bounded | 2,86× |
| ow-ssr | 0,25 | 143,6 M | 18,0 M | bounded | **7,96×** |
| fx-haze-warp | 1 | 16,7 M | 16,7 M | bound only | — |

**`ow-ssr` war die größte Fehleinschätzung der bisherigen Arbeit: die Schranke ist knapp achtmal zu groß.** Wer die Schicht nach `fill` allein plant, optimiert dort und findet nichts.

`fill --real` warnt außerdem selbst, wenn die Kamera unter 0,16°/Frame steht.

**`pnpm check` ist nach jeder Änderung grün gelaufen.** Der Backtick-Fehler ist mir einmal passiert (`volumetrics.js` Zeile 173, `` `sky-vol-march` `` im Shader-Kommentar) — das Gate hat ihn sofort gefangen, genau dafür ist es da.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **`ow-taa` ist jetzt der größte Posten des Frames (90,2 M) und ist noch nicht einmal modelliert.** Zuerst in `fillsim.passCost` aufnehmen, sonst rankt man gegen eine Schranke. Aufschlüsselung der 26 Fetches: 1× `tCurrent` oben, **9× `tDepth` für die Velocity-Dilatation**, 2× `tNormal` (`ca` an `vUv`, `cb` an `bestUv`), 1× `tVelocity` (bedingt), 8× `tCurrent` (3×3 ohne Mitte), 5× `tHistory` (Catmull-Rom). Der offensichtliche Hebel ist die 9-Tap-Dilatation → 5-Tap-Kreuz: **13,4 M**, aber nicht identisch. **Das ist messbar wie die Taps**: welcher Nachbar gewinnt, hängt nur an der Tiefe, die der Software-Raster schon liefert — man kann exakt zählen, bei wie vielen Pixeln `bestUv` abweicht und wie weit die Velocity dort auseinanderläuft. Empfehlung: dafür `voltaps` als Vorlage nehmen.
2. **Vier volle Bildschirme zu je 10 Fetches, die nie jemand angesehen hat: `sky-dome`, `sky-vol-composite`, `ow-view-composite`, `ow-composite` = 133,6 M zusammen.** Konkret analysiert habe ich `ow-view-composite` (`src/render/composite.js:255`): 1× `tColor` + 5× `tView` + 4 weitere im FXAA-Zweig. Außerhalb der Waffe ist `tView` überall exakt Null, also liefert der Pass dort `world` unverändert für 5 Fetches. **Ein Early-Out auf `m == 0` allein ist FALSCH** — an der Silhouette ist `m` null und die Nachbarn nicht, und genau dort läuft das Kantenfilter. Sauber wäre ein konservatives Screen-Rechteck des Viewmodels als Uniform (außerhalb: 1 Fetch, ~13,4 M), aber die Projektion einer Bounding-Box, die die Near-Plane schneidet, ist unzuverlässig, und Mündungsfeuer gehört dazu. **Als riskant markiert, absichtlich liegen gelassen.**
3. **`ow-gtao-blur` Sky-Early-Out** — dieselbe Konstruktion wie der Contact-Bilateral aus PH12. `AO_CORE` schreibt für Himmel `vec4(1.0, 1e4, 0, 1)`, also trägt `.g` dasselbe 1e4-Sentinel. In `AO_BLUR` ist jedes Nachbargewicht `exp(-|a.g-1e4|*22/1e4)` ≈ 2,8e-10 für jede echte Tiefe. **Wert: nur ~4,1 M** (der Pass läuft auf Halbauflösung, 11,7 M gesamt) — deshalb nicht mehr gemacht. Die Nachweiskette steht: Himmel-AO wird nirgends beschattet gelesen, und auf Geometriepixel wirkt es nur über Gewichte von ~1e-10.
4. **Ein Tap statt zwei im March liegt gemessen bereit: weitere 36 M.** Konvergiert 0,047 Prozentpunkte, Einzelbild-p99 5,1 Prozentpunkte. Bewusst bei zwei gelassen, damit die Schätzung auch **innerhalb eines Frames** trägt — in einem gerade disokkludierten Bereich hat der Resolve keine History zum Mitteln. Wenn mehr gebraucht wird, ist das der billigste belegte Hebel im ganzen Frame: `#define SK_VOL_SHADOW_TAPS 1`, eine Zeile.
5. **`shot`-Smoke-Test steht weiterhin aus** (offen seit PH11). Er kann zu March, TAA und Motion Blur **konstruktionsbedingt nichts sagen** — `raster.mjs:11` sagt selbst „no PBR, no shadow" und rendert überhaupt keine Post-Kette. Als reiner Nicht-Absturz-Test trotzdem billig.
6. **`contactScale` bleibt meine Empfehlung: lassen.** Unverändert gültig, jetzt mit besserer Zahl: die Contact-Kette ist real 41,4 M (18,7 + 22,7), nicht die 86,9 M der Schranke.

## 4. Risiken & Edge Cases

- **`fill` ist statisch, `fill --real` und `fillcost` sind dynamisch.** Das bleibt die Hauptfehlerquelle. Zwei frische Belege aus dieser Schicht: `ow-ssr` ist um Faktor 7,96 überschätzt, und `fx-haze-warp` steigt in der Schranke von 4 auf 5, während die echten Kosten um 2 Fetches auf 97 % der Pixel fallen. **Ab jetzt immer `--real` benutzen.**
- **Ohne `--look` misst man einen stillstehenden Spieler.** Gilt für jeden Befehl. `fill --real` warnt inzwischen selbst.
- **`voltaps` braucht `--max-old-space-size=6144`** (4 × 2048² Float32 = 268 MB) und läuft bei `--w=320 --h=200 --converge=8` einige Minuten. Der Kaskaden-Raster allein sind ~10,5 s.
- **In `volsim.mjs` durfte der Relativfehler nicht ungefiltert gebildet werden**: Strahlen, die den Schatten nie verlassen, haben V = 0 — und das sind genau die, denen gröbere Abtastung am meisten schadet. Erst hatte ich sie stillschweigend fallen lassen, was 34 % der Strahlen unterschlug und das Ergebnis schöngerechnet hat. Jetzt zählt die **absolute** Statistik jeden Strahl, die relative nur die mit V ≥ 0,02, und die Zahl der ausgeschlossenen steht im Ausgabefeld `raysAboveRelativeFloor`.
- **Backticks in `/* glsl */`-Template-Literalen beenden das JS-String.** Mir in dieser Schicht einmal passiert. In Shader-Kommentaren niemals Backticks, kein `${`. Der Scan geht mit `node -e` und `String.fromCharCode(96)`; die Datei darf dabei nicht importiert werden.
- **Der GL-Mock kompiliert keine Shader.** Nach JEDER Shader-Änderung `pnpm check`.
- **`grep`/`rg` liefern in dieser Sandbox leere Ergebnisse** — Ersatz: `node -e` mit `fs.readFileSync`. **`timeout` existiert nicht. Niemals `git stash`** — in `index.html`, `src/global.css`, `src/main.js` liegt fremde, uncommittete Arbeit.
- **`ab` misst CPU-Zeit.** Alle Änderungen dieser Schicht sind rein GPU-seitig; ein `z ≈ 0` dort ist erwartet, kein Gegenbeweis.
- **Annahme, nicht bewiesen:** In `volsim` ist die Wolkendecke als 1 angesetzt. Sie multipliziert beide Varianten gleich, verschiebt also nur die Gewichtung der Schrittfehler untereinander, nicht ob sie sich aufheben.
- **60 fps bei Ultra und 3,34 MP bleiben mit diesem Feature-Set unerreichbar.** Flaschenhals ist die GPU, CPU-Median 5,3–6,8 ms.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()`, 32-Texel-Marge im CSM-Zylinder-Cull, Zeilen 129–160 in `adaptive.js`, `maxPixelRatio` 1,5. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048→1536, gestaffelte Kaskaden-Updates, Spatial-BatchedMesh, `CHUNK`-Verkleinerung, Größen-Culling, instanz-genaues Kaskaden-Culling.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. Kein-Headless-Zeile.
- `tools/cli/volsim.mjs` — **neu, das Kernwerkzeug dieser Schicht.** Der Kopfkommentar führt die Affinitätsbegründung vollständig; ohne sie sieht die Methode nach Raten aus. Enthält Portierungen von `skIGN`, `skHash13`, `skVal3` und die Tap-Kollisionszählung.
- `tools/cli/cod.mjs` — neu: `cmdVoltaps`, `--real`/`--look`/`--w`/`--h` an `cmdFill`, `--taps`, `--converge`. **`THREE` ist hier NICHT importiert** — Grad/Bogenmaß von Hand.
- `tools/cli/fillsim.mjs` — neu: `passCost` mit `basis`-Feld, `avg()` mit Partitionsprüfung, `VOL_TAPS` aus dem Shader gelesen.
- `src/sky/volumetrics.js:169-210` — `SK_VOL_SHADOW_TAPS` und die volle Begründung im Kommentar, inklusive der Warnung vor dem Mittel-Tap.
- `src/fx/haze.js` WARP_FRAG — Null-Distortion-Early-Out mit dem Identitätsargument.
- `src/render/taa.js:112-118` — die 9-Tap-Dilatation, nächstes Ziel.
- `src/render/composite.js:255-292` — `ow-view-composite`, analysiert und begründet liegen gelassen.
- `/tmp/cod/ph13-fill-real.json` (die eine Rangfolge), `ph13-voltaps2.json` (Einzelbild + Kollisionen), `ph13-voltaps-conv8.json` (konvergiert), `ph13-leak.json`, `ph13-probe.json` (**die richtige neue Baseline**), `ph13-fc-b.json`.

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md`.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Skripte direkt unter `tools/*.mjs` starten Chromium; benutzbar ist nur `node tools/cli/cod.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut. `grep`/`rg` liefern hier leere Ergebnisse — benutze `node -e` mit `fs.readFileSync`. `timeout` existiert nicht. Niemals `git stash`.

**Benutze ab jetzt `fill --q=ultra --real --look=1`, niemals `fill` allein.** Es gibt jetzt EINE Rangfolge, die die Early-Outs wirklich ausführt und jede Zeile mit ihrer Basis kennzeichnet (`exact` / `bounded` / `bound only` = nicht modelliert, keine Messung). Die statische Schranke ist stellenweise absurd daneben: bei `ow-ssr` um Faktor 7,96. Wer nach ihr plant, optimiert an der falschen Stelle. Gesamt real: 525,4 M gegen 844,9 M Schranke.

**Der größte Posten des Frames ist jetzt `ow-taa` mit 90,2 M — und er ist noch nicht modelliert.** Nimm ihn zuerst in `fillsim.passCost` auf, sonst rankst du ihn gegen seine Schranke. Seine 26 Fetches: 1 + **9 für die Velocity-Dilatation** + 2 `tNormal` + 1 `tVelocity` + 8 für das 3×3 + 5 Catmull-Rom. Der Hebel ist die 9-Tap-Dilatation auf ein 5-Tap-Kreuz (13,4 M) — nicht identisch, aber **exakt messbar**, weil nur die Tiefe entscheidet, welcher Nachbar gewinnt, und der Software-Raster die schon liefert.

**Das Muster, dem du dabei folgen sollst, steht in `tools/cli/volsim.mjs`.** Es hat in dieser Schicht die größte Änderung des Projekts abgesichert: die vier Vogel-Taps im Volumetric March auf zwei zu senken, 146,8 M → 74,7 M pro Frame. Das Werkzeug rastert die Kaskadenkarten in ihrer echten Auflösung 2048², marschiert jedes Pixel mit dem eigenen Dither und dem eigenen Dichterauschen und wertet jede Tap-Zahl auf denselben Schritten aus. Es funktioniert ohne GPU, weil das In-Scatter-Integral **exakt affin** in den Sichtbarkeiten ist — Transmittanz und Extinktion lesen den Schattenterm nie —, sodass die Gewichte auf beiden Seiten identisch sind und der Ambient-Boden den relativen Fehler nur verkleinern kann. Gegengeprüft: `voltaps` und `fillcost` melden unabhängig 43,16 gegen 43,18 tappende Schritte.

**Zwei Lehren daraus, die du beim nächsten Tausch brauchst.** Erstens: die vier Taps waren **nicht** redundant — 3,998 verschiedene Texel im Mittel über 2,76 M Aufrufe —, also ist das ein echter Qualitätstausch und kein Entfernen von Überabtastung; behandle solche Änderungen entsprechend. Zweitens: **miss immer auch konvergiert, nicht nur ein Einzelbild.** Der Tap in der Scheibenmitte sah auf ein Frame gemessen besser aus als der Vogel-Tap und ist in Wahrheit 4,6-mal schlechter, weil er als einziger nicht konvergiert — eine Drehung liefert dasselbe Texel. `--converge=8` gibt dir den Fixpunkt, auf den der temporale Resolve zuläuft.

**Nach JEDER Shader-Änderung `pnpm check`** (= glslcheck + build). Der GL-Mock kompiliert nie einen Shader — ohne das Gate ist ein kaputter Shader von korrektem durch nichts unterscheidbar. **Setze in `/* glsl */`-Template-Literalen niemals Backticks**; mir ist das hier einmal passiert und das Gate hat es sofort gefangen.

**Sag dem User früh und deutlich:** 60 fps bei Ultra und 3,34 MP sind mit diesem Feature-Set nicht erreichbar; der Flaschenhals ist die GPU. Setze stattdessen die Linie fort: Fetch-Reduktionen, die entweder beweisbar ausgabeidentisch sind — wie der Null-Distortion-Early-Out in `src/fx/haze.js`, der bei `d == 0` dreimal denselben Texel liest — oder deren Abweichung wie bei den March-Taps gemessen und in Prozentpunkten beziffert ist. **Ein Tap statt zwei im March liegt gemessen bereit und bringt weitere 36 M**: konvergiert 0,047 Prozentpunkte, eine Zeile in `src/sky/volumetrics.js`. Ich habe ihn bei zwei belassen, damit die Schätzung auch innerhalb eines einzelnen Frames trägt, wo der Resolve gerade disokkludiert hat und keine History zum Mitteln besitzt — greif darauf zurück, wenn mehr gebraucht wird.
