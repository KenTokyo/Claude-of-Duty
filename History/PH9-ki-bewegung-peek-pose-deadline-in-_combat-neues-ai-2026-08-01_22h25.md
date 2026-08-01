# PH9 - KI-Bewegung - Peek-Pose-Deadline in _combat, neues ai-move-Gate, ehrli...

> 2026-08-01T20:25:54.416Z · Grund: Zeitlimit erreicht

# Übergabe — PH9

## 1. Mission in 2 Sätzen

Punkt 7 der Notiz `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` („Gegner sollen sich bewegen statt stillzustehen") wird weiter abgearbeitet: die ererbte Diagnose des Rest-Stillstands wurde **widerlegt**, die echte Ursache gefunden (`slopeLimit` in Grad statt Bogenmaß in `src/ai/agent.js`) und zusammen mit einem Seitwärtsschritt behoben. Qualitätskontrolle läuft ausschließlich browserlos über `node tools/cli/cod.mjs` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

**A. Die offene Messung aus PH8/3A ist erledigt — die Hypothese ist WIDERLEGT, nicht bestätigt.** Probe teilte die Stillstandsframes nach dem Alter des Marschbefehls (aufeinanderfolgende Travel-Frames). Ergebnis: Frames jünger als 8 stallen zu **42.0 %** — der Geschwindigkeits-Auslauf ist also real —, aber es gibt nur **283 solche Frames**, also **8.2 % aller Stillstände**, nicht die geschätzten ~60 %. Der Überschlag der Vorschicht („~20 Starts pro Mann") lag um Faktor 3.4 daneben: es sind ~6 Starts pro Mann. `settled>30` liegt bei 19.1 % gegen 20.0 % gesamt.

**B. Die daraus folgende „ehrlichere Metrik" wurde gemessen und VERWORFEN — mit Negativkontrolle.** Rechnet man `travelStallPct` nur über Frames mit Befehlsalter > 30, liest Auslieferung 19.1 und der kaputte Build B **19.7**. Das dreht das Vorzeichen einer 0.5-Punkte-Lücke in eine 0.6-Punkte-Lücke um — kein Schwellwert. Der Filter wird nicht angewendet, der Grund steht ausformuliert im `travelStallPct`-Absatz in `scenarioMove`.

**C. Die ererbte Diagnose „er drückt frontal gegen eine Wand" war auf einem toten Flag gebaut.** `lastMoveBlocked` las auf 95.7 % der Stillstandsframes — aber das Flag setzt **jeder** Sweep-Kontakt, auch der Boden, auf dem ein Mann jeden Frame mit Gravitation steht. `touchingWall` las auf **0 von 1223** Frames. Die Wand war nie gemessen, nur erschlossen.

**D. ROOT CAUSE, in unserer eigenen Datei: `src/ai/agent.js` übergab `slopeLimit: 48` in GRAD.** `CharacterController` will Bogenmaß (eigener Default `50 * (Math.PI/180)`, der Spieler in `src/player/movement.js:151` rechnet korrekt um). Am lebenden Controller gemessen: `cosSlope = -0.6401443394691997` = exakt `Math.cos(48)`. Ein Kosinus von −0.64 nennt jede Fläche bis 130° begehbar, also klassifizierte `_classifyContact` **jeden** Kontakt als Boden: **0 Wand-Klassifikationen in 3600 Controller-Moves**. Folgen: `touchingWall`/`wallNormal` permanent tot, `onSteepSlope` nie wahr, `probeGround` akzeptierte eine senkrechte Fläche unter einem Mann als den Boden, auf dem er steht, und die Cliff-Cling-Sperre in `move()` feuerte nie. Fix: `slopeLimit: 48 * (Math.PI / 180)` mit MEASURED-Absatz.

**E. Der Fix allein las auf diesem Level SCHLECHTER — der Mechanismus wurde nachgemessen, bevor entschieden wurde.** 20.0 % → 25.4 % Stillstand, 339.8 m → 323.6 m Boden. Verdacht war ein Grounding-Verlust; die Messung sagt Nein: airborne **12.9 % → 12.8 %**, `steppedUp` 7.3 % → 7.4 %, Step-Offset-Nutzung 57.9 % → 56.2 %. Der Wide-Fallback in `probeGround` übernimmt neu 1274 Frames (genau der Treppennasen-Fall, für den er dokumentiert ist), `touchingWall` **0 % → 33.4 %**, `onSteepSlope` **0 % → 8.8 %**. Der Unterschied ist Schmetterlingseffekt über geänderte A*-Routen, kein Regress — und der Fix ist die Vorbedingung dafür, dass die AI überhaupt nach einer Wand fragen kann.

**F. Seitwärtsschritt in `_move` gebaut (der ungetestete Weg aus PH8/3B) — jetzt mit echtem Kontaktnormal statt `id % 2`.** Ab `stallTimer > 0.25` (lässt 1.15 s Zeit, bevor die Wache die Route wegwirft), Rampe über 0.5 s auf Gewicht 1.6, Tangente aus `con.wallNormal`, Seite = die Tangente, die noch am meisten zum Wegpunkt zeigt; bei Frontalstoß (Dot ≈ 0) `id % 2` als deterministischer Gleichstand-Brecher wie in der Separations-Logik. Danach `_steer` neu normalisiert — steht **vor** dem Facing-Block, also läuft und schaut er in dieselbe Richtung. Kein RNG-Draw, keine Allokation, neues Feld `this.sidestepping` im Konstruktor.

**G. Wirkung, saubere Eins-zu-eins-Messung gegen Build D (nur der Zweig aus).** Stillstand **25.4 % → 19.3 %**; Schlimmster-Mann-Boden **35.8 m → 42.9 m**; und die eigentliche Aussage — pro Mann schlimmster Stillstand **[1.40, 1.40, 1.40, 1.38, 0.97, 0.05] → [1.40, 1.38, 0.85, 0.73, 0.63, 0.28]**: aus vier an der Wachhund-Decke geklemmten Männern werden zwei. Der Schritt befreit ihn, **bevor** die Route weggeworfen werden muss.

**H. Zwei neue Ansprüche im `ai-move`-Gate, beide mit perfekter Trennung.** Anspruch 5 `wallContact >= 500` (gemessen 5014, Build C liest **0**) — die Behauptung ist „ein Agent kann eine Wand vom Boden unterscheiden". Anspruch 6 `sidestep >= 60` (gemessen 512, Build D liest **0**). Beide zählen über **lebende** statt reisende Frames, weil ein Mann auch beim Halten der Deckung in eine Wand geschoben werden kann.

**I. Sieben gemessene Negativkontroll-Builds, Tabelle liegt an der `pass`-Bedingung.**

| Build | stallPct | travelStall | shuffleStall | wall | side | worstGround |
|---|---|---|---|---|---|---|
| Auslieferung | 19.3 | 1.40 | 0.82 | 5014 | 512 | 42.9 |
| A: Wache auf `speed` | 26.9 | **7.43** | 0.98 | 5119 | 20 | 32.7 |
| B: keine Stance-Frist | 21.3 | 1.40 | **5.77** | 5651 | 690 | 44.2 |
| C: slopeLimit in Grad | 20.0 | 1.40 | 0.98 | **0** | **0** | 35.8 |
| D: kein Seitwärtsschritt | 25.4 | 1.40 | 0.98 | 4812 | **0** | 35.8 |
| A+B | 25.7 | **8.65** | **6.53** | 4513 | 24 | 44.7 |
| C+D | 20.0 | 1.40 | 0.98 | **0** | **0** | 35.8 |

Die assertierten Spalten kreuzen sich nicht. **Eine ehrliche Ausnahme steht so im Code:** `side` wird auch von C genullt, weil der Seitwärtsschritt `touchingWall` liest — C liegt *oberhalb* von D, ist kein zweiter Eigentümer. Was Anspruch 6 zu Ds eigenem macht: auf Build D ist er der **einzige** fallende Anspruch.

**J. `totalGround` ausdrücklich als Metrik entwertet und der Grund danebengeschrieben.** Die Builds C und C+D decken mit **339.8 m** am meisten Boden ab — und sind genau die, die keine Wand erkennen. Ein hin- und hergeschobener Mann sammelt Pfadlänge. `worstGround` ist die ehrliche Hälfte (35.8 → 42.9).

**K. Stand: 15/15 Gates grün, `pnpm build` 2.56 s.** `ai-movement` verbessert nebenbei: `longestTravelStallS` 1.40 → **0.85**, alle sechs Männer erreichen echte Entfernung (reachedM 7.33–27.48 m).

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. HÖCHSTE PRIORITÄT — Schichtabschluss ist NICHT fertig, drei Punkte fehlen.** (1) `glslcheck --q=ultra` (Erwartung 0 findings) ist in dieser Schicht **nicht gelaufen**. (2) Der Bildvergleich fehlt: `node tools/cli/cod.mjs shot --q=ultra --at=90` gegen `/tmp/cod-shot-ultra-90.png` per `imgdiff`. **Annahme, ungeprüft:** die Referenz sollte wie in den letzten drei Schichten 1 Pixel von 256000 an (454,209) zeigen — aber diese Schicht hat als erste die *Physik* der Agenten angefasst, also ist eine größere Abweichung möglich und wäre erklärbar, nicht automatisch ein Fehler. Vorher prüfen, ob `/tmp/cod-shot-ultra-90.png` überhaupt noch existiert. (3) **Aufräumen: `tools/cli/` enthält vier `_probe-*.mjs`, die gelöscht werden müssen** — `_probe-age.mjs`, `_probe-wall.mjs`, `_probe-ground.mjs`, `_probe-controls.mjs`. `_probe-controls.mjs` ist der einzige, dessen Verlust weh tut (er fährt die ganze Tabelle aus 2I automatisch); wer ihn braucht, baut ihn in zehn Minuten nach — die Anker stehen alle in der Tabelle.

**B. Der Rest-Stillstand ist gesenkt, nicht beseitigt (19.3 %), und zwei Männer klemmen weiter an der 1.4-s-Decke.** Was jetzt gemessen feststeht und die nächste Runde leiten sollte: der Seitwärtsschritt feuert nur bei `touchingWall`, also **nur wenn der Controller letzten Frame wirklich eine Wand meldete**. Es ist ungemessen, wie viele der verbleibenden Stillstandsframes gar keinen Wandkontakt haben — genau diese Zahl fehlt und wäre die erste Probe der nächsten Schicht (`stallTimer > 0.25 && !touchingWall`, Anteil und längste Strähne). Ist sie groß, braucht der Zweig einen zweiten Auslöser (z. B. Kameraden-Deadlock oder Wegpunkt hinter einer Kante); ist sie klein, ist der Restfehler die Wiederbeschaffung derselben Route, und dort ist der nächste Hebel.

**C. Gemessen ausgeschlossene Wege — NICHT wiederholen.** Aus PH8: unerreichbare Zwischen-Wegpunkte überspringen (macht es schlechter, 1.4 s → 7.35 s, weil das Aufgeben der Route die Rettung ist) und den Deckungsanspruch beim Stillstand freigeben (wirkungslos). Aus dieser Schicht: `travelStallPct` über gesetzte Frames rechnen (trennt nicht, siehe 2B) und `totalGround` als Erfolgsmaß (zeigt in die falsche Richtung, siehe 2J).

**D. `minSize = 10` in `operatingRegion` und der Boden `cell * 2.5` in `findPath`** sind weiterhin aus der Verteilung **dieses** Levels gewählt und auf anderen Seeds ungeprüft (**Annahme** unverändert seit vier Schichten).

**E. Nichts committen ohne ausdrückliche Aufforderung. Niemals `git stash`.** Im Baum liegt fremde uncommittete Arbeit (`index.html`, `src/core/input.js`, `src/main.js`, `src/ui/*`, `src/global.css`, `src/weapons/index.js`, `src/player/*`, …). Zu **dieser** Arbeit gehören genau zwei Dateien: `src/ai/agent.js` und `tools/cli/playtests.mjs`. `ARCHITECTURE.md` bleibt unverändert — keine neuen Events. `shared-docs/projects/claude-of-duty/` anzulegen ist weiterhin nicht möglich (Submodule nicht ausgecheckt, `git submodule update --init` wäre ein unbeauftragter Netzwerk-Fetch).

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Erlaubt sind nur `node tools/cli/cod.mjs …` und eigene Proben **unter `tools/cli/`**, die `harness.mjs` + `play.mjs` importieren. Eine Probe unter `/tmp` findet `./harness.mjs` nicht.
- **`lastMoveBlocked` ist KEIN Wandsignal und darf nie wieder als eines gelesen werden.** Es setzt jeder Sweep-Kontakt, auch der Boden unter einem stehenden Mann. Genau daran ist die Diagnose der Vorschicht gescheitert. `touchingWall` ist das Signal — und es funktioniert erst seit dem Einheiten-Fix aus 2D.
- **Wer `slopeLimit` anfasst: RADIANT.** `cosSlope` ist `Math.cos(slopeLimit)`. Der Fehler ist stumm — nichts wirft, nichts loggt, das Spiel läuft, nur ist jede Fläche Boden. Anspruch 5 im `ai-move`-Gate ist ab jetzt die Wache dagegen.
- **`con.wallNormal` im Seitwärtsschritt ist der Kontakt des LETZTEN Frames** (`c.move()` läuft am Ende von `_move`). Ein Frame Latenz ist gewollt und harmlos; wer den Block nach `c.move()` verschiebt, ändert stillschweigend die Semantik.
- **Sandbox:** `grep`/`rg` liefern **leere** Ergebnisse → stattdessen `node -e` mit `fs.readFileSync` und `split('\n').forEach`. `timeout` existiert nicht.
- **`quiet()` in eigenen Proben fängt die `[render]`-Logs NICHT.** Ausgabe durch einen `node -e`-Filter pipen, der ab einem Marker (`@@`) schneidet — sonst geht das JSON im Rauschen unter.
- **`execFileSync` wirft bei Exit-Code 1 — und ein fallendes Gate ist genau das.** Wer Kontroll-Builds skriptet, muss `err.stdout` lesen, sonst stirbt der Sweep beim ersten (erwarteten) Fehlschlag. Hat mich einen Durchlauf gekostet.
- **`new URL(...).pathname` ist im Projektpfad kaputt** — „React Projects" enthält ein Leerzeichen und wird zu `React%20Projects`. `fileURLToPath` benutzen.
- **`cod.mjs play --json` liefert `{results: [...], failed: n}`**, nicht ein nacktes Array.
- **Nicht auf `speed` messen, niemals.** `speed` ist die *Absicht*. `progress` ist der zurückgelegte Boden und die einzige ehrliche Grundlage.
- **Die Gate-Laufzeit ist Teil der Behauptung.** `ai-move` braucht 40 s, `ai-retreat` 60 s. Wer kürzt, entwertet die Kontrolle, ohne dass etwas rot wird.
- **`ai-move` liest im vollen Suite-Lauf andere Zahlen als einzeln** (travelFrames 6492 gegen 6735, worstGround 36.2 gegen 42.9), weil `ai.cover` und der Agent-ID-Zähler global über alle Szenarien sind. **Jede Schwelle muss in beiden Läufen halten** — das ist der Grund, warum `worstGround` bei 10 steht und nicht bei 40.
- **Determinismus:** Weder der Einheiten-Fix noch der Seitwärtsschritt zieht einen RNG-Draw — aber geändertes *Verhalten* ändert, wie oft später gewürfelt wird. Nach jeder Verhaltensänderung die volle Suite, nicht nur das betroffene Szenario.
- **PNG-Vergleich niemals über die Dateigröße** — dafür ist `cod.mjs imgdiff` da. Bei `--tol=0` ist Exit 1 schon bei einem einzigen Silhouetten-Pixel.

## 5. Wichtige Dateien & warum

- `src/ai/agent.js` — **das Hauptergebnis dieser Schicht, zwei Stellen.** `slopeLimit: 48 * (Math.PI / 180)` im Konstruktor (~Z. 172) mit dem MEASURED-Absatz, der erklärt, warum `Math.cos(48)` jede Fläche zu Boden machte; der SIDESTEP-Block in `_move` direkt nach der Stall-Wache (~Z. 1143–1185) mit der Herleitung aus den 59.5 mm/7.5 mm; `this.sidestepping` im Konstruktor (~Z. 288). Die Stall-Wache selbst (~Z. 1128) und die Stance-Frist in `_combat` (~Z. 798) sind unverändert aus PH8.
- `tools/cli/playtests.mjs` — `scenarioMove` (Abschnitt 13, `ai-move`): Kopfkommentar mit sechs Ansprüchen, die Sieben-Build-Tabelle direkt an der `pass`-Bedingung, die Ansprüche 5 und 6 mit ihren Kontrollen, und der ausgebaute `travelStallPct`-Absatz mit **beiden** in dieser Schicht bezahlten Korrekturen (Rampen-Theorie widerlegt, `totalGround` entwertet). **Neue Behauptungen gehören hierher — und jede mit einer Negativkontrolle, sonst ist sie Prosa.**
- `src/physics/character.js` — **gehört uns nicht und ist korrekt**, aber Pflichtlektüre für jeden, der an der Bewegung arbeitet: `_classifyContact` (~Z. 296) ist die Stelle, an der die Einheit zuschlug, `probeGround` (~Z. 412) mit dem Dünn/Breit-Traceschema, und `move()` (~Z. 141) mit dem Step-Offset-Verfahren.
- `tools/cli/play.mjs` — `play(engine, rec, { frames, onFrame })`, `onFrame` läuft **nach** `engine.step`; bequemster Hebel für neue Messungen. `aiSample()` enthält **kein** `progress`/`desiredSpeed`/`sidestepping` — wer die braucht, nimmt `onFrame` und liest direkt vom Agenten.
- `tools/cli/cod.mjs` — `play --scenario=… --json`, `shot`, `imgdiff`. Header-Doku ist aktuell; die neuen Felder von `ai-move` brauchen dort keine Änderung.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, keine Allokation pro Frame, kein `Math.random()`, im Loop arbeiten, keine Rückfragen.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless, das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`; eigene Proben dürfen unter `tools/cli/` liegen und `harness.mjs`/`play.mjs` importieren, müssen aber vor Schichtende wieder gelöscht werden. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse — nutze `node -e` mit `fs.readFileSync`; `quiet()` in Proben unterdrückt die `[render]`-Logs nicht, filtere die Ausgabe ab einem Marker; `new URL(...).pathname` ist im Projektpfad kaputt (Leerzeichen), nutze `fileURLToPath`. Kein `git stash`, im Baum liegt fremde uncommittete Arbeit, und committe nichts ohne ausdrückliche Aufforderung. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Stand: **15/15 Gates grün, `pnpm build` 2.56 s.** Diese Schicht hat die ererbte Diagnose widerlegt und die echte Ursache gefunden: `src/ai/agent.js` übergab `slopeLimit: 48` in Grad, wo der `CharacterController` Bogenmaß will, also lief jeder Agent auf `Math.cos(48) = -0.640` als Begehbarkeitsschwelle — jede Fläche bis 130° war Boden, `_classifyContact` erreichte seinen Wand-Zweig **kein einziges Mal in 3600 Controller-Moves**, und `touchingWall`/`wallNormal`/`onSteepSlope` waren tot. Der Fix (Bogenmaß) plus ein Seitwärtsschritt in `_move`, der bei `stallTimer > 0.25` entlang des echten Kontaktnormals statt frontal in die Wand läuft, senkt den Stillstand von 25.4 % auf 19.3 %, hebt den Boden des schlechtesten Mannes von 35.8 m auf 42.9 m und macht aus vier an der 1.4-s-Wachhunddecke klemmenden Männern zwei. Beides ist mit sieben gemessenen Negativkontroll-Builds gegatet (`wallContact >= 500` gegen 0 auf Build C, `sidestep >= 60` gegen 0 auf Build D), Tabelle steht an der `pass`-Bedingung in `scenarioMove`.

Deine Aufgaben in dieser Reihenfolge:

1. **Zuerst den Schichtabschluss nachholen, der mir nicht mehr gelungen ist:** `node tools/cli/cod.mjs glslcheck --q=ultra` (Erwartung 0 findings); dann `shot --q=ultra --at=90` und per `cod.mjs imgdiff` gegen `/tmp/cod-shot-ultra-90.png` vergleichen (prüfe erst, ob die Referenz noch existiert — sonst neu anlegen und das im Bericht sagen). Erwartung laut den letzten drei Schichten: 1 Pixel von 256000 an (454,209); diese Schicht hat aber als erste die Agenten-Physik geändert, eine größere Abweichung ist erklärbar und muss angesehen, nicht wegdiskutiert werden. Danach **`tools/cli/` von allen `_probe-*.mjs` befreien** — es liegen vier drin (`_probe-age`, `_probe-wall`, `_probe-ground`, `_probe-controls`).
2. **Dann die eine Zahl messen, die für den Restfehler fehlt.** Der Seitwärtsschritt feuert nur bei `touchingWall`. Ungemessen ist, wie viele der verbleibenden Stillstandsframes **keinen** Wandkontakt haben (`stallTimer > 0.25 && !con.touchingWall`) — Anteil und längste Strähne. Ist der Anteil groß, braucht der Zweig einen zweiten Auslöser; ist er klein, liegt der Rest in der Wiederbeschaffung derselben Route (A* liefert bis zu fünf Mal dasselbe Ergebnis auf dasselbe Ziel). Erst messen, dann entscheiden.
3. **Vier Wege sind gemessen ausgeschlossen, nicht wiederholen:** unerreichbare Zwischen-Wegpunkte überspringen (1.4 s → 7.35 s, schlechter), den Deckungsanspruch beim Stillstand freigeben (wirkungslos), `travelStallPct` nur über gesetzte Frames rechnen (trennt nicht: 19.1 gesund gegen 19.7 kaputt), und `totalGround` als Erfolgsmaß (die Builds ohne Wanderkennung decken mit 339.8 m am meisten Boden ab).
4. **Jede neue Behauptung gehört in `tools/cli/playtests.mjs` und braucht eine Negativkontrolle** (Fix temporär zurückdrehen, Gate muss fallen, sauber restaurieren — vorher `cp` als Backup, danach mit `includes()` prüfen, auch auf *Abwesenheit* der Experimentreste). Drei bezahlte Fallen: `execFileSync` wirft bei einem fallenden Gate, lies `err.stdout`; `ai-move` liest im vollen Suite-Lauf andere Zahlen als einzeln (geteilte `ai.cover`, globaler ID-Zähler), jede Schwelle muss in **beiden** halten; und wenn sich eine Zahl über keine Kontrolle von einem kaputten Build trennen lässt, gieß sie **nicht** ins `pass`, sondern melde sie und schreib den Grund daneben.
5. **Vor Schichtende:** volle Suite (`node tools/cli/cod.mjs play`), `pnpm build`, `glslcheck --q=ultra`, Bildvergleich, und `tools/cli/` von allen `_probe-*.mjs` befreien.
