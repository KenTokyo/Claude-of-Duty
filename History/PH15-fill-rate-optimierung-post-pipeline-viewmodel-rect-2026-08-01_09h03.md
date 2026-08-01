# PH15 - Fill-Rate-Optimierung Post-Pipeline — Viewmodel-Rect vermessen und ver...

> 2026-08-01T07:03:29.988Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH15)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` soll vollständig performance-optimiert werden — auch auf Ultra — ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). In dieser Schicht wurde die von PH14 halbfertig übergebene `ow-view-composite`-Optimierung gebaut, vermessen, als **wertlos bewiesen und wieder entfernt**, und stattdessen ein beweisbar ausgabeidentischer Sky-Early-Out im GTAO-Blur eingebaut: **476,0 M → 471,9 M Fetches, davon 4,17 M echte Reduktion.**

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Alle Skripte direkt unter `tools/*.mjs` starten Chromium. Benutzbar ist ausschließlich `node tools/cli/cod.mjs`.

**Der Backtick-Fehler aus PH14 war real und hat sofort zugeschlagen.** `pnpm check` war auf der halbfertigen Änderung nie gelaufen; sie enthielt **zwei** Backticks in `/* glsl */`-Kommentaren (`composite.js:266` und `:273`). Mir ist derselbe Fehler beim Schreiben der Ablehnungs-Begründung ein drittes Mal passiert. **Das ist die häufigste Fehlerquelle dieses Projekts.**

**Neu gebaut: `cod viewrect` (`cmdViewrect` in `tools/cli/cod.mjs`) — das Werkzeug dieser Schicht.** Es projiziert **jedes Dreieck, das das Viewmodel wirklich zeichnet**, clippt es per Sutherland-Hodgman gegen die Near-Plane, wendet exakt das Backface-Culling des Treibers an (Vorzeichen der NDC-Fläche, `frontFace`-Flip bei negativer `matrixWorld`-Determinante), respektiert `drawRange` und Index-Buffer und vergleicht das Ergebnis mit dem ausgelieferten `uViewRect`. Die Projektion läuft über die **volle 4×4-Matrix**, nicht über die `p00/p11`-Abkürzung des Renderers — ein unabhängiger Pfad, der eine nicht-standardmäßige Projektionsmatrix fangen würde. Dazu neu: `driveScript(engine, events, degPerFrame)` mit einer Timeline aus Laufen, Feuern, ADS, Nachladen, Nahkampf und Waffenwechsel über `_pendingDown`/`_pendingUp`.

**Der Befund, und er ist eindeutig: die Idee ist an ihrer eigenen Prämisse gestorben, nicht an der Implementierung.**

| Messung | Wert |
|---|---|
| Frames, in denen das Rechteck auf Vollbild zurückfiel | **140 von 140** |
| tatsächlicher Fußabdruck der Waffe, Median | **45,1 %** |
| p90 / Maximum / Mittel | 73,3 % / 75,4 % / 48,6 % |
| Fußabdruck nur aus Dreiecken **vor** der Near-Plane | 48,35 % (gegen 48,56 %) |
| bestmögliche Ersparnis eines **perfekten** Rechtecks | 8,6 M von 476 M = **1,8 %** |

**Erstens: `viewCamera.near` ist 0,005 m, und die Gewehrschulterstütze steht 0,20 m HINTER dem Auge.** `rifle-body-alu`, `rifle-body-polymer`, `rifle-body-rubber` und eine unbenannte `BufferGeometry` haben in jedem einzelnen Frame Dreiecke, die die Near-Plane schneiden. Eine Kugel, die die Near-Plane erreicht, hat kein beschränktes perspektivisches Bild — also nahm jeder Frame den Aufgeben-Pfad. Die Tangenten-Mathematik von PH14 war richtig; die Prämisse, dass eine Viewmodel-Kugel vor dem Auge bleibt, war falsch.

**Zweitens, und das ist das eigentliche Argument: es hätte sich auch repariert nicht gelohnt.** Die 15 %, die PH14 angenommen hat, sind in Wahrheit 45 % im Median. Ein Rechteck kann nur ein Rechteck sein, und die **Bounding-Box** der Waffe ist eben nicht ihre Silhouette.

**Drittens, und das war wichtig auszuschließen: das Near-Clipping ist KEIN Grafikfehler.** 0,4835 gegen 0,4856 — die schneidenden Dreiecke clippen zu Splittern, sie schmieren nicht über das Bild. **6,4 M Backfaces pro Lauf werden gecullt**, was den Fußabdruck aber nicht verkleinert.

**Also entfernt:** `uViewRect` aus `composite.js`, `RenderSystem._viewScreenRect()` samt `_viewRectV3`/`_viewRectScratch` und dem Aufruf aus `index.js`. **An beiden Stellen steht jetzt die vollständige Messung als Kommentar**, damit die nächste Schicht sie nicht neu herleitet. Das entfernt nebenbei eine Traversierung von 117 Meshes pro Frame, die nichts geliefert hat.

**Eingebaut und gemessen: der Sky-Early-Out in `AO_BLUR` (`src/render/gtao.js`). 11,68 M → 7,51 M, −4,17 M, exakt.** Die von PH14 offen gelassene Frage ist beantwortet: **`AO_TEMPORAL` reicht `.g` als `cur.y` unverändert durch (`gtao.js:192`)**, das Sentinel trägt also. Die Kette ist geschlossen und schärfer als in PH14 beziffert: `.g` ist **positive lineare View-Tiefe in Metern**, die Far-Plane der Welt-Kamera ist **1200**, das Sentinel ist 1e4 — Faktor 8 Luft, der Test steht bei `c.g > 2000.0`. Ein Nachbar auf echter Tiefe wiegt höchstens `w0·exp(−21,98)` = 2,9e-10, jeder Himmelsnachbar trägt `.r = 1,0`, das Defizit ist damit höchstens **6,2e-10**, und `pow(x, 1.25)` skaliert es um höchstens 1,25. Das Ziel ist `HalfFloatType`/`RGFormat`, dessen Stufe bei 1,0 **4,9e-4** ist — sechs Größenordnungen gröber. **Auch in float32 (Stufe 6,0e-8) wäre es noch bitgleich.** Der Pass wird zweimal gezeichnet, der Early-Out greift auf beiden.

**`ow-gtao-blur` neu in `fillsim.passCost` aufgenommen, `modelledPasses` 11 → 12.** Vorher war der Pass „bound only" bei 11,68 M — und weil er vor der Änderung gar keinen Early-Out hatte, war dort Schranke = Realkosten. **Die 4,1 M im Gesamttotal sind deshalb reine Realersparnis und kein Modellierungsartefakt.** Das ist der saubere Fall, den PH14 bei `sky-vol-composite` angemahnt hat.

**`pnpm check` ist grün.**

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **`fx-haze-warp` modellieren — 16,7 M, der größte noch unmodellierte Pass.** Ich war mitten drin: der letzte Edit an `fillsim.mjs` (Notiz im `ow-view-composite`-Block) ist geschrieben, **`pnpm check` ist danach NICHT mehr gelaufen** — als Erstes nachholen. PH13 beziffert den Null-Distortion-Early-Out mit ~2 statt 5 Fetches auf 97 % der Pixel; **die 97 % sind argumentiert, nicht gemessen.** Entweder in `fillsim` messen wie bei `sky-dome`, oder als `bounded` mit lo 2 / hi 5 eintragen. Erwartung: ~7 M statt 16,7 M, reine Rangfolgen-Korrektur.
2. **Drei weitere „bound only"-Pässe, zusammen 30 M:** `ow-bloom-down` 11,7 M, `sky-vol-resolve` 10,0 M, `ow-ssr-blur` 8,3 M. `ow-ssr-blur` ist der aussichtsreichste — falls er wie `ow-contact-blur` und `ow-gtao-blur` ein Tiefen-Sentinel hat, liegt dort derselbe Early-Out.
3. **Abschluss-Verifikation, in dieser Schicht NICHT gelaufen:** `probe` gegen `/tmp/cod/ph13-probe.json` und ein `leak --q=ultra --frames=3000`. Beide Änderungen dieser Schicht ändern den Draw-Stream **nicht** (der GTAO-Early-Out ist ein Shader-Zweig, das Entfernen von `_viewScreenRect` streicht nur CPU-Arbeit) — `probe` sollte identisch sein, jede Abweichung wäre ein Fund.
4. **`ab --toggle=…` auf das Entfernen von `_viewScreenRect`.** Das ist die **einzige rein CPU-seitige** Änderung seit mehreren Schichten und damit die einzige, bei der `ab` überhaupt etwas sehen kann: 117 Meshes Traversierung plus Kugel-Mathematik pro Frame sind weg. Erwartung klein, aber positiv.
5. **Ein Tap statt zwei im Volumetric March liegt weiterhin gemessen bereit: +36 M.** Konvergiert 0,047 Prozentpunkte, Einzelbild-p99 5,1 Prozentpunkte, eine Zeile (`SK_VOL_SHADOW_TAPS 1` in `src/sky/volumetrics.js`). Bewusst bei zwei belassen. Das ist die Reserve.
6. **`shot`-Smoke-Test steht seit PH11 aus.** Kann konstruktionsbedingt nichts über March, TAA oder Motion Blur sagen (`raster.mjs:11` sagt selbst „no PBR, no shadow"). Als reiner Nicht-Absturz-Test trotzdem billig.

## 4. Risiken & Edge Cases

- **Backticks in `/* glsl */`-Template-Literalen beenden den JS-String.** Dreimal in zwei Schichten passiert. In Shader-Kommentaren **niemals** Backticks, kein `${`. Der GL-Mock kompiliert keine Shader — **nach JEDER Shader-Änderung `pnpm check`**, sonst ist ein kaputter Shader von korrektem durch nichts unterscheidbar.
- **`cod viewrect` überlebt bewusst das Feature, das es getötet hat.** Es hängt sich an `_viewScreenRect`, falls vorhanden (dann sind die Margin-Spalten gültig), sonst an `viewComposite.render` gegen Vollbild — dann ist der `ceiling`-Block die Antwort. Nach dem Umhängen kam **exakt dieselbe Zahl** (0,4856) heraus, was den Hook-Punkt bestätigt. Der Exit-Code prüft ohne Bound nur noch die Starrheits-Annahme.
- **`viewScene` ist zu 100 % starr: 117 Meshes, 0 skinned, 0 morph, 0 instanced** — von `cod viewrect` neu gemessen, nicht aus PH14 übernommen. Kämen animierte Hände dazu, wäre jede Bounding-Argumentation hinfällig; `viewrect` würde es sofort melden und mit Exit-Code 1 aussteigen.
- **`fx-particles-additive`/`-lit` parken inaktive Partikel bei ~1e7 Metern.** Ihre Bounding-Sphere ist damit astronomisch. Für die Dreiecks-Messung irrelevant (sie clippen komplett weg), aber jede künftige kugelbasierte Idee stirbt allein an ihnen.
- **Die Blame-Tabelle in `viewrect` ist auf Mesh **und** Grund verschlüsselt.** Vorher waren Kugel-Abstand und Dreiecks-Abstand in einer Zeile vermischt, was einen Meter Kugel-Spiel wie einen Meter Geometrie durchs Auge aussehen ließ — ich habe fast auf falscher Datenbasis entschieden.
- **`fill` ist statisch, `fill --real` und `fillcost` sind dynamisch. Ab jetzt immer `--real --look=1`.**
- **Der Harness bewegt den Spieler standardmäßig nicht.** `driveMove` und `driveScript` existieren, werden aber nur von `taataps` und `viewrect` benutzt. `fill --real` und `fillcost` messen weiter einen stehenden Spieler. Wer SSR oder Motion Blur anfasst, muss das zuerst einhängen.
- **`ab` misst CPU-Zeit.** Für GPU-seitige Änderungen ist `z ≈ 0` dort erwartet, kein Gegenbeweis. Punkt 4 oben ist die Ausnahme.
- **`grep`/`rg` liefern in dieser Sandbox leere Ergebnisse** — Ersatz: `node -e` mit `fs.readFileSync`. **`timeout` existiert nicht. Niemals `git stash`** — in `index.html`, `src/global.css`, `src/main.js` liegt fremde, uncommittete Arbeit.
- **`viewrect` in voller Auflösung braucht `--max-old-space-size=8192`** und läuft bei 140 Frames rund eine Minute.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()`, 32-Texel-Marge im CSM-Zylinder-Cull, Zeilen 129–160 in `adaptive.js`, `maxPixelRatio` 1,5. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048→1536, gestaffelte Kaskaden-Updates, Spatial-BatchedMesh, `CHUNK`-Verkleinerung, Größen-Culling, instanz-genaues Kaskaden-Culling, `contactScale`, **und jetzt das `ow-view-composite`-Screen-Rechteck**.
- **60 fps bei Ultra und 3,34 MP bleiben mit diesem Feature-Set unerreichbar.** Flaschenhals ist die GPU, CPU-Median 5,3–6,8 ms.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. Kein-Headless-Zeile.
- `tools/cli/cod.mjs` — **`cmdViewrect` ist das Kernstück dieser Schicht** (Near-Clipping, Backface-Culling, Doppel-Hook, `ceiling`-Block). Dazu `driveScript`. **`THREE` ist hier NICHT importiert** — die 4×4-Matrizen werden von Hand gerechnet, das ist Absicht und macht die Messung unabhängig vom Renderer.
- `src/render/gtao.js` — `AO_BLUR` mit dem Early-Out und der vollständigen Fehlerabschätzung gegen die Half-Float-Stufe. `AO_TEMPORAL:192` ist die Zeile, die das Sentinel trägt.
- `src/render/composite.js` + `src/render/index.js` — **beide tragen jetzt die Ablehnungs-Begründung mit allen Zahlen.** Wer die Idee wiederbeleben will, muss dort zuerst widerlegt werden.
- `tools/cli/fillsim.mjs` — neu: `ow-gtao-blur`. Der `ow-view-composite`-Block warnt jetzt ausdrücklich davor, sein kleines `viewmodelPctOfFrame` als Rechteck zu lesen: **Coverage ist keine Box.**
- `/tmp/cod/ph15-fill-real.json` (die aktuelle Rangfolge, 471,9 M), `/tmp/cod/ph15-viewrect.json` (die Ablehnungs-Messung), `/tmp/cod/ph13-probe.json` (**die richtige Probe-Baseline**, aus PH13).

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md`.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Skripte direkt unter `tools/*.mjs` starten Chromium; benutzbar ist nur `node tools/cli/cod.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut. `grep`/`rg` liefern hier leere Ergebnisse — benutze `node -e` mit `fs.readFileSync`. `timeout` existiert nicht. Niemals `git stash`.

**Fang hier an: der letzte Edit in `tools/cli/fillsim.mjs` ist geschrieben, aber `pnpm check` lief danach nicht mehr.** Führ das zuerst aus. Dann modelliere `fx-haze-warp` — 16,7 M und der größte noch unmodellierte Pass. PH13 hat dort einen Null-Distortion-Early-Out eingebaut und beziffert ihn mit ~2 statt 5 Fetches auf 97 % der Pixel; **die 97 % sind argumentiert, nicht gemessen.** Miss sie in `fillsim` wie bei `sky-dome`, oder trag den Pass ehrlich als `bounded` mit lo 2 / hi 5 ein. Danach `ow-ssr-blur` (8,3 M): falls er ein Tiefen-Sentinel hat wie `ow-contact-blur` und `ow-gtao-blur`, liegt dort derselbe Early-Out.

**Benutze `fill --q=ultra --real --look=1`, niemals `fill` allein.** Gesamt real **471,9 M** gegen 831,5 M Schranke, zwölf Pässe modelliert. Die Basis-Kennzeichnung ist vierteilig: `exact`, `bounded`, `coverage` und `bound only` = nicht modelliert, keine Messung.

**Die Lehre dieser Schicht, und sie ist teuer bezahlt: die halbfertige Optimierung, die du übernommen hättest, war wertlos — und das ließ sich nur durch Messen feststellen, nicht durch Nachdenken.** Das Screen-Rechteck für `ow-view-composite` fiel auf **140 von 140 Frames** auf Vollbild zurück, weil die Gewehrschulterstütze 0,20 m hinter dem Auge steht und die Viewmodel-Near-Plane bei 0,005 m liegt: eine Kugel, die die Near-Plane erreicht, hat kein beschränktes Bild. Und selbst repariert hätte es sich nicht gelohnt — der tatsächliche Fußabdruck der Waffe ist **45 % des Bildes im Median und 73 % bei p90**, nicht die angenommenen 15 %. Ein perfektes Rechteck wäre 8,6 M von 476 M wert. Die Idee ist gestrichen, die Messung steht als Kommentar in `composite.js` und `index.js`, und `cod viewrect` ist das Werkzeug, das sie erzeugt hat — es clippt jedes gezeichnete Dreieck gegen die Near-Plane und cullt Backfaces wie der Treiber. **Bau sie nicht neu.** Wenn du eine Bounding-Idee hast, lass sie erst von `viewrect` prüfen, bevor du sie einbaust.

**Setze stattdessen die Linie fort, die trägt: Fetch-Reduktionen, die beweisbar ausgabeidentisch sind.** Der Sky-Early-Out im GTAO-Blur, den ich eingebaut habe, ist die Vorlage: `.g` trägt 1e4 als Himmels-Sentinel, `AO_TEMPORAL` reicht es unverändert durch, `.g` ist lineare View-Tiefe in Metern und die Far-Plane ist 1200 — also acht mal Luft für den Test bei 2000. Das Defizit gegenüber dem vollen Filter ist höchstens 6,2e-10, die Half-Float-Stufe bei 1,0 ist 4,9e-4. Nach dem Write bitgleich, −4,17 M. **Nach JEDER Shader-Änderung `pnpm check`, und setze in `/* glsl */`-Literalen niemals Backticks** — dieser Fehler ist in zwei Schichten dreimal passiert und das Gate ist das Einzige, was ihn fängt.

**Sag dem User früh und deutlich:** 60 fps bei Ultra und 3,34 MP sind mit diesem Feature-Set nicht erreichbar; der Flaschenhals ist die GPU, der CPU-Median liegt bei 5,3–6,8 ms. **Ein Tap statt zwei im Volumetric March liegt weiter gemessen bereit und bringt 36 M** — eine Zeile in `src/sky/volumetrics.js`, konvergiert 0,047 Prozentpunkte. Er bleibt bewusst bei zwei, damit die Schätzung auch innerhalb eines einzelnen Frames trägt; greif darauf zurück, wenn mehr gebraucht wird.
