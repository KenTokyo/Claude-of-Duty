# PH12 - CSM-Schattenpass - castShadow-Flag beachten, GPU-Timer-Sanity-Check ge...

> 2026-08-01T05:48:00.819Z · Grund: Zeitlimit erreicht

# Übergabe: Performance-Optimierung „Claude-of-Duty" (PH12)

## 1. Mission in 2 Sätzen

Der Three.js-Shooter in `/Users/kentoky/Documents/React Projects/Claude-of-Duty` soll vollständig performance-optimiert werden — auch auf Ultra — ohne Verlust an AAA-Optik, Gameplay oder Atmosphäre (Auftrag im Wortlaut: `Notes/optimize-game-loop-current-notes.md`). In dieser Schicht wurde `fillcost` vollständig gegengeprüft und beide offenen Zahlen bestätigt, ein **grundlegender Messfehler der gesamten Werkzeugkette gefunden** (die Kamera bewegt sich in KEINER Messung), und daraus vier Fetch-Reduktionen abgeleitet, von denen die größte bis zu **64 % der Motion-Blur-Kosten** entfernt und dabei bei schnellen Drehungen beweisbar unverändert bleibt.

## 2. Was wurde bereits erledigt

**Absolute Randbedingung, unverändert gültig: KEIN BROWSER, in keiner Form.** Alle Skripte direkt unter `tools/*.mjs` starten Chromium. Benutzbar ist ausschließlich `node tools/cli/cod.mjs`.

**Aufgabe 1 aus PH11 — `fillcost` gegengeprüft, BEIDE Prüfungen bestanden.**
- (a) Deckungsmaske: `fillcost.coverage.shadingPixels` = **84 785** gegen `shadowcost.pixels.receiverPixels` = **84 782**. 3 Pixel von 144 000 auseinander (0,0035 %), aus zwei unabhängigen Rasterisierungen. **Wichtig für den Nachfolger:** die richtige Gegenzahl ist `receiverPixels`, NICHT `shadingPixels` (das ist in `shadowcost` bereits nach Backface-Verwerfung, 41 334).
- (a2) Die Deckungsmaske prüft die Tiefenrücktransformation NICHT mit. Deshalb separat algebraisch verifiziert: `d = 2fn/((f+n) − z(f−n))` bildet z=−1→near und z=+1→far ab, und `raster.mjs:340` legt `_sz = clip.z/w` ab, also NDC-z. Die Formel in `fillsim.mjs:61` ist exakt richtig.
- (b) **Die 77,54 % beim Volumetric March sind korrekt, die Überschlagsrechnung aus PH11 war falsch.** Zerlegung nach Population eingebaut und gemessen: Geometriepixel **100,00 %** (56 von 56 Schritten), Himmelpixel **45,38 %** (25,41 Schritte). 0,5888·100 + 0,4112·45,38 = **77,54 %**, also die gemeldete Zahl auf die Nachkommastelle. Grund: jedes Pixel mit Geometrie näher als der letzte Split (150 m) hat `maxT < 150`, also liegt JEDER Schritt drinnen. Die Zahl darf jetzt zitiert werden.

**Größter Einzelbefund der Schicht: In der gesamten Werkzeugkette bewegt sich die Kamera nie.** `engage()` schaltet Input frei, aber es gibt keine Input-Aufzeichnung — der Spieler steht in jeder je gemessenen Frame still. Über 299 Frames gemessen (`/tmp/cod/mbtrace.mjs`): Rotation max **0,0027°/Frame**, Translation max 0,0028 m. Die Auslöseschwelle von Motion Blur liegt bei **0,1554°/Frame**. Folge: `ow-mb` nahm in JEDER bisherigen Messung seinen Early-Out (3 Fetches statt 52), während `fill` es an der Spitze seiner Rangfolge führte. Beide Zahlen waren richtig — sie beschreiben nur verschiedene Zustände, und für einen Shooter ist der drehende der normale.

**`--look=<Grad>` gebaut** (`driveLook()` in `cod.mjs`): injiziert synthetische Maus-Pixel in `input._rawLook` — denselben Weg, den ein echtes `mousemove` nimmt, also durch Sensitivität, Freeze und den Yaw-Rate-Feed. **Nur der letzte Frame wird gefahren**, mit Absicht: Motion Blur liest genau ein Frame-Delta, und jeder frühere Frame bleibt bit-identisch zum ungefahrenen Lauf, sodass sich genau eine Variable ändert statt die Ansicht wegzudriften.

**`fillcost` um Motion Blur erweitert** (Aufgabe 2 aus PH11). Kamera-Reprojektion aus `_currVP`/`_prevVP`, die per Hook auf `MotionBlur.render` **während** des Frames geschnappt werden — nach `run()` ist `_prevVP` bereits mit `_currVP` überschrieben (`index.js:1824`) und würde einen stillstehenden Kamera melden. Tile-Dilation (16×16-Block-Max) modelliert; `blurredPctExact` ist exakt, `blurredPctAfterTileDilation` approximiert das Gitter auf dem gröberen Sim-Raster. Ergebnis bei 2°/Frame: **58,71 % blurren — exakt die Geometriedeckung**, also bewegt sich jedes Geometriepixel ≥ 1 px; 62,01 % nach Dilation.

**`fillcost` um das vollständige March-Modell erweitert.** Dichte-Skip, Transmittanz-Abbruch und die Kaskaden-Projektionstests werden jetzt nachgerechnet. **Echte Kosten von `sky-vol-march`: 175,6 Fetches/Fragment, nicht 227** — also 146,8 M statt 189,7 M. Schritt-Zensus über 8,06 M Schritte: getappt 77,07 % · hinter Transmittanz-Abbruch 10,93 % · zu dünn zum Streuen 7,07 % · hinter dem letzten Split 4,93 % · **außerhalb der Kaskadenkarte exakt 0** (feuert nie).

**Vier Shader-Änderungen eingebaut, alle mit `glslcheck` 0 Befunden und grünem Build:**
1. **`composite.js`** — Mitten-Tap hochgezogen. War 3× `texture2D(tColor, vUv)`, jetzt 1×. Beweisbar identisch: das nachfolgende `max(hdr,0)` lässt `max(max(x,0),0)` zusammenfallen. Statisch 12 → 10, dynamisch −1 Fetch/Fragment = **3,34 M/Frame**.
2. **`contact.js` BILATERAL** — Early-Out auf das Himmel-Sentinel `c.g >= 1e4`. Beweisbar identisch bis ~1e-17: jedes Nachbargewicht ist `exp(−|a.g−1e4|·40/1e4)` ≤ `exp(−40)`, und nichts stromabwärts liest den Wert (der Term wird auf den Sonnenanteil multipliziert, Himmel hat keinen). Das `.g`-Sentinel wird unverändert weitergereicht, damit die zweite Richtung dieselbe Maske sieht. **10,99 M/Frame** (41,12 % × 4 Fetches × 2 Passen).
3. **`taa.js`** — Tap 4 des 3×3 hat Offset (0,0), ist also `tCurrent` an `vUv`, der Texel der schon in `current` liegt. Ersetzt durch den gehaltenen Wert **unter Beibehaltung der Schleifenreihenfolge**, also bit-identisch (nicht nur äquivalent); `x + 0.0` ist exakt. 27 → 26 = **3,34 M/Frame**, plus ein eingesparter doppelter tonemap+YCoCg.
4. **`motionblur.js` — die große: Tap-Zahl folgt der Streifenlänge.** `taps = clamp(ceil(radius·0.5), 2, 12)` hält die Abtastdichte auf genau dem, was die 12-Tap-Schleife am Auslegungspunkt (24 px) liefert — eine Probe pro Pixel Streifen. Konstante Schleifengrenze mit dynamischem `break`, also bleibt der Unroll unberührt und ESSL-1.00-Konformität erhalten.

**Die Motion-Blur-Änderung über vier Drehraten gemessen — die Ersparnis ist invers zur Sichtbarkeit des Effekts:**

| Drehrate | Streifen | Ø Taps | noch bei 12 Taps | Fetches | vorher | gespart |
|---|---|---|---|---|---|---|
| 0,5°/F (30°/s) | 5,7 px | 3,35 | 0 % | 39,9 M | 111,8 M | **−64,3 %** |
| 1°/F (60°/s) | 11,4 px | 6,20 | 0 % | 63,5 M | 111,6 M | **−43,1 %** |
| 2°/F (120°/s) | 22,8 px | 10,43 | 50,4 % | 98,5 M | 111,5 M | −11,7 % |
| 4°/F (240°/s) | 45,7 px | 12,00 | **100 %** | 110,9 M | 110,9 M | **0 %** |

Bei schnellen Flicks — wo dünne Abtastung als Banding sichtbar würde — ist die Ausgabe unverändert.

**Rangfolge nach ECHTEN Kosten neu aufgestellt** (nicht nach der statischen Schranke): `sky-vol-march` 146,8 M > `ow-mb` 111,5 M drehend / 10,0 M stehend > `ow-taa` 86,9 M > `ow-ssr` ~48 M > Contact-Kette ~46 M.

**Geometrie-Seite gegengerechnet, damit die Post-Fokussierung belegt ist:** `overdraw` meldet `shadedPerPixel` 2,145 bei `depthPrepassSavesFragmentsPct` 53,4; mit Prepass-Reuse also ~1,97 M Fragmente bei Vollauflösung × ~180 Fetches ≈ **~350 M**, gegen ~600–940 M für Post. **Post dominiert etwa 2:1** — die Post-Linie fortzusetzen ist belegt, nicht angenommen.

**`sky-dome` untersucht und BEWUSST NICHT geändert.** Es ist ein Full-Screen-Dreieck mit `depthTest:false`, `renderOrder −10000`, zahlt 1,0 Bildschirme Fill und wird zu 58,88 % überzeichnet; `hdrRt` teilt sich die Prepass-Tiefe (`reusePrepassDepth`), Early-Z könnte also verwerfen. **Der Blocker: `SKY_VERT` setzt `gl_Position.z = 0.0`**, also Fenstertiefe 0,5 — das entspricht bei near=0,05 nur ~10 cm Sichttiefe, ein `LessEqual`-Test würde also NICHTS verwerfen. Es zu bauen hieße den von ALLEN SkyPass-Passen geteilten Vertex-Shader zu ändern plus Gating auf `reusePrepassDepth` (ohne das Gate zeigt der Test bei `directViewmodel` gegen einen ungeclearten Tiefenpuffer und der Himmel verschwindet). Nicht visuell verifizierbar → liegen gelassen, siehe offene Punkte.

**`pnpm check` als Gate gebaut** (Aufgabe 5): `"glslcheck": "node tools/cli/cod.mjs glslcheck --q=ultra"` und `"check": "pnpm glslcheck && pnpm build"`. Verifiziert, exit 0.

**Der Backtick-Fehler ist mir dreimal passiert** — deshalb ein Scanner geschrieben, der stray Backticks in `/* glsl */`-Literalen findet, ohne die Datei zu importieren (eine kaputte Datei PARST nicht, also stirbt jedes importierende Werkzeug vorher). Aktuell über `src/` sauber.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

1. **`fill` neu fahren und die Gesamtbilanz sauber ziehen — ich war genau hier, als die Zeit ablief.** `fill --q=ultra` lief zuletzt nach Änderung 1, nicht nach 2–4. **Achtung, sonst zieht man den falschen Schluss:** `fill` ist eine STATISCHE Schranke und kann die Änderungen 2, 3 und 4 grundsätzlich nicht sehen — Early-Outs und dynamische Tap-Zahlen entfernen keinen `texture2D`-Aufruf aus der Quelle. Die letzte Messung sagt 941 808 214 → 935 126 686 = −0,71 %, und das ist **allein** `composite.js`. Die echten Summen stehen in `fillcost`. Wer die Bilanz aus `fill` zitiert, unterschätzt die Schicht um etwa das Zehnfache.
2. **Die vier Änderungen strukturell absichern.** `probe --q=ultra` und `leak --q=ultra --frames=3000` fahren: Draws, Dreiecke, Programme, `gpuMB` müssen unverändert sein (alle vier Änderungen sind rein shaderintern). Ein `shot`-Smoke-Test ist noch offen (Aufgabe 6 aus PH11) — **er kann zu Motion Blur und TAA per Konstruktion nichts sagen**, weil `raster.mjs:11` selbst „no PBR, no shadow" sagt und überhaupt keine Post-Kette rendert. Als reiner Nicht-Absturz-Test trotzdem billig.
3. **`fillcost` in `fill` einhängen, damit es EINE Rangfolge gibt.** Aktuell muss man die statische Schranke aus `fill` von Hand mit den Einstiegsanteilen aus `fillcost` verrechnen — genau der Schritt, bei dem PH11 sich vertan hat. `fillcost` kennt bereits `fetchesPerFragment` für den March und `fetchesPerFrame` für Motion Blur; dieselbe Zahl für SSR, GTAO und Contact zu liefern und in `fill` als zweite Spalte auszugeben, macht den Fehler unmöglich.
4. **`contactScale` entscheiden (Aufgabe 3 aus PH11, jetzt mit Zahlen).** Neue Lage: der Bilateral-Early-Out hat bereits 10,99 M der Kette geholt, und `fillcost` zeigt, dass nur 28,65 % der Pixel den Marsch betreten — die **echten** Kosten der Kette sind ~35,4 M, nicht die 86,9 M der Schranke. `contactScale: 0.5` spart davon nochmals ~23,7 M, kostet aber Auflösung an einem Effekt, der ausdrücklich für ein 0–40-cm-Band gebaut ist. **Meine Empfehlung: lassen.** Der Hebel ist nach dem Early-Out deutlich kleiner als PH11 annahm, und `contact.js:133-142` beschreibt den Sub-1x-Pfad zwar, aber niemand kann das Ergebnis mit diesem Werkzeugkasten anschauen. Falls doch: `fill --qset=contactScale=0.5` misst die Ersparnis exakt.
5. **`sky-dome`-Tiefentest, falls jemand das Risiko tragen will.** Wert: 19,7 M Fetches (2,1 %) plus 0,59 Bildschirme Fill. Weg: `SKY_VERT` auf `gl_Position = vec4(position.xy, 1.0, 1.0)` (für alle anderen SkyPass-Passen folgenlos, die haben `depthTest:false`), Dome-Material `depthTest: true` **nur wenn `reusePrepassDepth`**. Sicherheit ist zur Hälfte belegt: `_hide` (Transparente, `owNoPrepass`, nicht-maskierbare Alpha-Tests) fehlt im Prepass, wird aber im Forward gezeichnet — diese Richtung reißt kein Loch. Die gefährliche Richtung wäre Tiefe im Puffer ohne Forward-Geometrie; `_draw` ⊆ Forward-Menge spricht dagegen. **Als Annahme markiert, nicht bewiesen.**
6. **Motion-Blur-Velocity trägt keine Objektbewegung.** `fillcost`s `motionBlur` sagt das im `note` ausdrücklich und ist damit eine **untere Schranke** für bewegte Pixel. Ein rennender Gegner blurrt im Spiel, hier nicht. Wer die Zahl als Budget benutzt, muss das dazusagen.

## 4. Risiken & Edge Cases

- **`fill` ist statisch, `fillcost` ist dynamisch. Sie beantworten verschiedene Fragen und dürfen nicht vermischt werden.** Das ist die Hauptfehlerquelle dieser Schicht gewesen.
- **Ohne `--look` misst man einen stillstehenden Spieler.** Das gilt für JEDEN Befehl, nicht nur `fillcost` — `probe`, `ab`, `passes` und `fill` haben alle nie eine bewegte Kamera gesehen. Für Motion Blur ist der Unterschied 10,0 M gegen 111,5 M Fetches.
- **Backticks in `/* glsl */`-Template-Literalen beenden das JS-String und die Datei parst nicht mehr.** Mir dreimal passiert (`composite.js`, `taa.js`, `motionblur.js` — letzteres zweimal im selben Kommentarblock). In Shader-Kommentaren **niemals** Backticks, kein `${`. Der Scanner dafür liegt in der Historie dieses Chats; er darf die Datei nicht importieren.
- **Der GL-Mock kompiliert keine Shader.** Nach JEDER Shader-Änderung `pnpm check` fahren (ist jetzt das Gate). Ohne das ist ein kaputter Shader von korrektem durch nichts in diesem Werkzeugkasten unterscheidbar.
- **Die Dichte-Modellierung in `fillsim` benutzt das Wertrauschen an seinem Mittelpunkt**, nicht das echte `skVal3`. Wie stark das trägt, sagt `whereTheStepsGo.skippedTooThinToScatter` — aktuell 7,07 %, also nicht vernachlässigbar. Bei ±40 % Rauschfaktor verschiebt sich die Höhe der 1e-4-Schwelle um `ln(1,4)/uFog.y` Meter. **Als Annahme markiert.**
- **`fragcost`-Zahlen aus PH1–PH10 sind für alle GLSL1-Shader falsch** (dort 0). Nicht aus alten Notizen zitieren.
- **`ab` misst CPU-Zeit.** Alle vier Änderungen dieser Schicht sind reine GPU-Änderungen; ein `z ≈ 0` dort ist das erwartete Ergebnis, kein Gegenbeweis.
- **60 fps bei Ultra und 3,34 MP bleiben mit diesem Feature-Set unerreichbar.** Flaschenhals ist die GPU, CPU-Median 5,7–6,8 ms.
- **`maxPixelRatio: 1.5` → `1.25` wurde geprüft und bleibt bewusst ungeändert** — der adaptive Regler deckt den GPU-Engpass bereits pro Frame ab (`minRenderScale` 0,65), was einer statischen Deckelung überlegen ist.
- **`grep`/`rg` liefern in dieser Sandbox leere Ergebnisse.** Ersatz: `node -e` mit `fs.readFileSync`. **`timeout` existiert nicht. Niemals `git stash`** — in `index.html`, `src/global.css`, `src/main.js` liegt fremde, uncommittete Arbeit. **zsh spaltet `$var` in `for`-Schleifen nicht** — Mehrfachläufe über `node -e` mit `execFileSync`.
- **Nicht anfassen:** Ballast-System, Viewmodel-4×-MSAA, schwarze Clear-Farbe in `GBuffer.render()`, 32-Texel-Marge im CSM-Zylinder-Cull, Zeilen 129–160 in `adaptive.js`. **Gestrichen und bleibt gestrichen:** CSM `mapSize` 2048→1536, gestaffelte Kaskaden-Updates, Spatial-BatchedMesh, `CHUNK`-Verkleinerung, Größen-Culling, instanz-genaues Kaskaden-Culling. **Fertig und bestätigt:** Point-Light-Early-Out, PCSS-Umbra-Early-Out, Kaskaden-Überblendung, Timer-Sanity-Check, `castShadow`-Beachtung, Tiefen-Coverage in Motion Blur und TAA, `fillcost`-Gegenprüfung.
- Der User will **keine Rückfragen**, autonomes Durcharbeiten im Loop und **keine Screenshot-Flut**.

## 5. Wichtige Dateien & warum

- `Notes/optimize-game-loop-current-notes.md` — Auftrag im Wortlaut inkl. Kein-Headless-Zeile.
- `tools/cli/fillsim.mjs` — **Kern dieser Schicht, jetzt gegengeprüft.** Neu: `motionBlur`-Block, `bySurface`-Zerlegung des March, `whereTheStepsGo`-Zensus, `cascadeTaps()`. Der Kopfkommentar trennt weiterhin ausdrücklich exakt/nicht-exakt.
- `tools/cli/cod.mjs` — neu: `driveLook()` (mit ausführlicher Begründung, warum nur der letzte Frame gefahren wird), MotionBlur-Hook in `cmdFillcost`, `--look`. **`THREE` ist hier NICHT importiert** — Grad/Bogenmaß von Hand rechnen.
- `src/render/motionblur.js` — adaptive Tap-Zahl. Die Begründung im Kommentar ist der Kern: es entfernt Überabtastung, es tauscht keine Qualität.
- `src/render/taa.js` — `i == 4 ? curY : texture2D(...)`. Der Kommentar hält fest, warum die Schleifenreihenfolge erhalten bleibt (bit-identisch statt nur äquivalent).
- `src/render/contact.js` — `c.g >= 1.0e4`-Early-Out im BILATERAL, mit dem `exp(−40)`-Argument im Kommentar.
- `src/render/composite.js` — Mitten-Tap hochgezogen.
- `src/sky/volumetrics.js:238-271` — die March-Schleife, die `fillsim` nachbildet. `skSunVisibility` (174–199) hat die vier Taps und die drei fetch-freien Rückgaben.
- `src/sky/fullscreen.js:36-41` — `SKY_VERT` mit `gl_Position.z = 0.0`, der Blocker für den Dome-Tiefentest.
- `package.json` — `pnpm check` = glslcheck + build. Das ist das Gate.
- `/tmp/cod/fc-ultra-90.json`, `fc-ultra-90b.json`, `fc-ultra-deep.json` (fillcost-Stufen), `sc-ultra-90.json` (Gegenprobe), `od-ultra.json` (Geometrie-Seite), `mbtrace.mjs` (Kamera-Trace über 299 Frames), `fill-ultra-b.json` / `fill-ultra-c.json`.

## 6. Übergabe-Startprompt für die nächste KI

Du übernimmst eine laufende Performance-Optimierung des Three.js-Shooters in `/Users/kentoky/Documents/React Projects/Claude-of-Duty`. Auftrag: `Notes/optimize-game-loop-current-notes.md`.

**Wichtigste Regel, ohne Ausnahme: Starte keinen Browser.** Kein Playwright, kein Headless, auch kein Headed — der Laptop des Users stürzt sonst ab. Alle Skripte direkt unter `tools/*.mjs` starten Chromium; benutzbar ist nur `node tools/cli/cod.mjs`. Arbeite autonom, stelle keine Rückfragen, produziere keine Screenshot-Flut. `grep`/`rg` liefern hier leere Ergebnisse — benutze `node -e` mit `fs.readFileSync`. `timeout` existiert nicht. Niemals `git stash`.

**Der Frame ist fragmentgebunden.** Post dominiert Geometrie etwa 2:1 (~600–940 M gegen ~350 M Fetches) — das ist gemessen, nicht angenommen, also ist die Post-Linie die richtige.

**Die wichtigste Regel dieser Werkzeugkette: `fill` ist eine STATISCHE Schranke, `fillcost` misst die echten Early-Outs. Vermische die beiden nie.** `fill` kann Early-Outs und dynamische Schleifengrenzen grundsätzlich nicht sehen. Die letzten `fill`-Zahlen (941 808 214 → 935 126 686 = −0,71 %) beschreiben **allein** die `composite.js`-Änderung; drei weitere Änderungen sind eingebaut und für `fill` unsichtbar.

**Zweitwichtigste Regel: ohne `--look=<Grad>` misst du einen stillstehenden Spieler.** Es gibt keine Input-Aufzeichnung in dieser Harness — über 299 Frames dreht die Kamera maximal 0,0027°/Frame gegen eine Motion-Blur-Auslöseschwelle von 0,1554°. Für `ow-mb` ist das der Unterschied zwischen 10,0 M und 111,5 M Fetches pro Frame. `--look` fährt nur den letzten Frame, damit sich genau eine Variable ändert.

**`fillcost` ist jetzt vollständig gegengeprüft, beide Prüfungen bestanden.** Deckungsmaske gegen `shadowcost.pixels.receiverPixels`: 84 785 gegen 84 782 von 144 000. Die 77,54 % beim Volumetric March sind korrekt — Geometriepixel tappen 100 % ihrer 56 Schritte, weil ihr ganzer Strahl innerhalb des 150-m-Splits liegt, Himmelpixel 45,38 %; die alte Überschlagsrechnung war falsch. Echte Kosten des Märsches: **175,6 Fetches/Fragment, nicht 227.**

**Vier Shader-Änderungen sind eingebaut, `pnpm check` grün.** `composite.js` (Mitten-Tap hochgezogen, beweisbar identisch), `contact.js` (Bilateral-Early-Out auf das Himmel-Sentinel, identisch bis 1e-17), `taa.js` (Tap 4 des 3×3 ist der schon gehaltene Texel, bit-identisch), und `motionblur.js` — die Tap-Zahl folgt jetzt der Streifenlänge und spart 64,3 % bei 30°/s, 43,1 % bei 60°/s, 0 % bei 240°/s, wo die Ausgabe unverändert bleibt.

**Deine erste Aufgabe: die Bilanz sauber ziehen.** `fill --q=ultra` neu fahren, aber die Gesamtsumme aus `fillcost` bilden, nicht aus `fill` — sonst unterschätzt du die Schicht um etwa das Zehnfache. Danach `probe` und `leak --q=ultra --frames=3000` zur strukturellen Absicherung: Draws, Dreiecke, Programme und `gpuMB` müssen unverändert sein, weil alle vier Änderungen rein shaderintern sind.

**Danach:** `fillcost` in `fill` einhängen, damit es nur noch EINE Rangfolge gibt — das ist genau der Handrechenschritt, an dem sich die letzte Schicht vertan hat. `contactScale` würde ich lassen: der Bilateral-Early-Out hat den Hebel bereits von 86,9 M auf ~35,4 M gedrückt, und niemand kann das Ergebnis mit diesem Werkzeugkasten anschauen.

**Nach JEDER Shader-Änderung `pnpm check` fahren** (= glslcheck + build, neu eingerichtet). Der GL-Mock kompiliert nie einen Shader — ohne das ist ein kaputter Shader von korrektem durch nichts unterscheidbar. **Setze in `/* glsl */`-Template-Literalen niemals Backticks** — sie beenden das JS-String, die Datei parst dann nicht mehr, und jedes importierende Werkzeug stirbt vor seiner eigenen Fehlermeldung. Mir ist das in dieser Schicht dreimal passiert.

**Sag dem User früh und deutlich:** 60 fps bei Ultra und 3,34 MP sind mit diesem Feature-Set nicht erreichbar; der Flaschenhals ist die GPU. `maxPixelRatio` 1,5 → 1,25 wurde geprüft und bleibt bewusst ungeändert, weil der adaptive Regler den Engpass bereits pro Frame abdeckt und der Auftrag ausdrücklich vor „einfach weniger rendern" warnt. Setze stattdessen die Linie dieser Schicht fort: Fetch-Reduktionen, die entweder beweisbar ausgabeidentisch sind oder — wie die Motion-Blur-Taps — nachweislich nur Überabtastung entfernen und genau dort unverändert bleiben, wo der Effekt sichtbar wäre.
