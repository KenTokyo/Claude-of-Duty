# PH4 - KI-Gegnerverhalten - Squad-Reaktion auf Verluste, Deckungs-Kill-Zone,...

> 2026-08-01T18:17:08.418Z · Grund: Zeitlimit erreicht

# Übergabe — Gegnerverhalten Claude-of-Duty (Flanken, Facing, Schock)

## 1. Mission in 2 Sätzen

Punkt 7 der Notiz (`Notes/spielfluss-verbessern-behebe-verbessere-notes.md` — „Gegner sollen sich bewegen und realistischer verhalten, statt stillzustehen") wird weiter vertieft: in dieser Schicht wurden zwei tote Manöver-Pfade repariert (Flanken-Ziel unbegehbar, Granaten-Term sperrt dauerhaft), die Körpersprache an die Squad-Information gekoppelt (Drehen zur Peilung, Schock außerhalb des Kampfes, Rückzug ohne Ziel) und alles in zwei Gates gegossen. Qualitätskontrolle läuft ausschließlich browserlos über `node tools/cli/cod.mjs` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

**A. Aufgabe 1 der alten Übergabe (der ungetestete `holdingGrenade`-Edit) — verifiziert und grün.** `node tools/cli/cod.mjs play` = 10/10 PASS, `pnpm build` grün, `glslcheck --q=ultra` = 0 findings. Wichtig: `travelledM` war **bit-identisch** zur alten Referenz `[29.31,28.78,30.08,23.13,19.53,32.4]` — die Prognose des Vorgängers („wird sich ändern") war falsch, weil der Startwert `grenadeCooldown = rng.range(9,22)` im 20-s-Szenario nie unter 0 fällt und beide Schreibweisen dort dasselbe liefern.

**B. Offene Frage C beantwortet — gemessen, nicht geraten** (Wegwerf-Probe, inzwischen gelöscht, 60 s, 6 Mann): Der Granaten-Term sperrte **6637 von 11354** flank-tauglichen Frames, während die Wurfgelegenheit, auf die er wartete, in **2139 von 2143** Frames von der Squad-Ration abgelehnt wurde (4 Würfe in 60 s). Zweiter, größerer Fund derselben Probe: **11 von 14 Flankenversuchen starben daran, dass A\* keine Route fand** — das Ziel war ein roher geometrischer Offset ohne Begehbarkeitsprüfung, der Würfel war da schon bezahlt.

**C. Umgesetzt (alles in `src/ai/`, plus `tools/cli/`):**
- **`src/ai/nav.js`** — neue Methode `NavGrid.snapTo(out, maxRings, yTol, region)`: zieht einen Weltpunkt in-place auf die begehbare Menge in der eigenen Nav-Komponente, false wenn nichts in Reichweite. `findPath()` snappt zwar selbst, aber ohne Region- und Stockwerksfilter — deshalb landete ein Punkt im Gebäude auf dessen **Dach**, in anderer Komponente, und der Solve gab 0 zurück.
- **`src/ai/agent.js` `_flankPoint(target, side, reach)`** — baut das Flankenziel in `_v2` und snappt es (`6` Ringe ≈ 5 m, `yTol 2.5`, eigene `navRegion`). `_combat` probiert die gewürfelte Seite, dann die andere — der zweite Versuch kostet **keinen** RNG-Draw.
- **`src/ai/agent.js`, Granaten-Term** — neu `grenadeReady` (hasGrenade + Cooldown + `dist` 8–26 m + `lastKnownAge < 1.5`), einmal berechnet und von Flanken-Gate **und** Wurf-Zweig benutzt; das Gate sperrt nur noch bei `grenadeReady && sq.grenadeCooldown <= 0`. Gegenprobe auf demselben Lauf: 754 statt 6637 blockierte Frames.
- **Ergebnis der beiden Fixes (gemessen):** Flanken-Eintritte über 60 s **3 → 14**, Verteilung `1 1 0 1 0 0` → `1 3 2 3 3 2`, fehlgeschlagene Versuche **11 → 0**.
- **`src/ai/agent.js` `_move`, Facing** — neues Feld `faceYaw` (Konstruktor, direkt nach `targetYaw`); ALERT mit frischer Peilung zählt jetzt als „engaged", Guard `bearing.lengthSq() > 1.44` gegen Drehen auf Rauschen; wer stehend sucht, **schwenkt** den Blick (`sin(stateTime*0.9 + id) * 0.85`, Phase = Agent-ID, **kein** RNG).
- **`src/ai/agent.js` `_think`** — der Schock-Block (`manDownTimer`) wurde aus `_combat` **hinter die switch-Anweisung** verschoben und gilt jetzt in jedem Zustand; Ausnahme `relocating` (FLANK/RETREAT/auf dem Weg in Deckung), was die alte Kampf-Semantik `!this.cover || atCover` exakt reproduziert.
- **`src/ai/agent.js`** — neu `get squadIsBroken`, `_breakContact(from)` (9 m weg, **mit** `snapTo`) und `_threatPoint()`. Der Rückzug des dezimierten Squads steht jetzt zusätzlich in `_think` für ALERT/SUPPRESSED: `_combat` erreicht ein Mann ohne Ziel nie, deshalb suchte der letzte Überlebende einer aufgeriebenen Patrouille vorher 12 s allein weiter.
- **`src/ai/agent.js` Modul-Header** — `BEHAVIOUR`-Absatz um die Verlust-Reaktion ergänzt (Aufgabe 3 der alten Übergabe, erledigt).
- **`tools/cli/_probe-flank.mjs` gelöscht** (Aufgabe 2, erledigt).

**D. Zwei Gates, beide mit Zähnen.**
- **Neu `ai-flank`** (`--scenario=aiflank`, in `SCENARIOS` als `aiflank`, Header in `tools/cli/cod.mjs` Z. 38 ergänzt), 40 s, ~9,4 s Laufzeit, zweimal byte-gleich: `flankAttempts: 9 · attemptsWithNoRoute: 0 · flanksEntered: 9 · entriesPer10s: [1,3,2,3] · longestBarredByGrenadeS: 5.32 · grenadesThrown: 2`. Erkennt einen Versuch über `_flankPoint` → `_goTo` (Flag pro Agent, jeden Frame gelöscht), **nicht** über Vektor-Identität. `pass` = `attempts>=3 && deadEnds===0 && entries>=3 && barredS<8`.
- **`ai-squad` um Anspruch 6 und 7 erweitert:** `patrolStoppedForIt: 2/2 · walkingAtMsThenDownTo: ["1.35->0.33","1.35->0.33"] · turnedToBearing: 2/2 · bearingErrorDeg: ["149.1->0","138.7->0"]`. **Negativkontrolle wurde ausgeführt** (`alerted = false` temporär): Gate fällt mit `turnedToBearing: 0/2` und `["155.2->143.6","145->145"]` — der Anspruch misst also wirklich das neue Verhalten. Backup-Datei `/tmp/agent-backup.js` wurde zurückgespielt und gelöscht, Restauration verifiziert.

**E. Gate-Stand nach allen Edits bis einschließlich Schock/Facing/Rückzug:** `node tools/cli/cod.mjs play` = **11/11 PASS**, `pnpm build` grün, `glslcheck --q=ultra` = 0 findings. Neue Referenz `ai-movement`: **`travelledM: [29.35,31.18,37.66,38.1,20.74,36.9]`**, `finalStates: {"combat":5,"flank":1}` (vorher `{"combat":6}` — erstmals flankiert am Ende jemand).

**F. Screenshot-QK.** `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-check2.png --w=640 --h=400 --at=90` → visuell deckungsgleich mit der Referenz `/tmp/cod-shot-ultra-90.png` (14:26, vor allen KI-Schichten); Szene intakt, Soldaten sichtbar. Kein Render-Einfluss.

**G. Basismessung zur eigentlichen Userbeschwerde** (`tools/cli/_probe-idle.mjs`, liegt noch im Baum): 60 s, pro Mann Anteil stillstehend und längste Strähne — `still` 13–42 %, **Mittel 24 %**, schlechtester Einzelwert **10.7 s am Stück (Agent 3, combat)**. Zustandsmix z. B. Agent 3 `combat 75% flank 9% patrol 8%`. Hinweis: `longestState` in der Ausgabe ist der Zustand im **letzten** Frame der Strähne — Agent 6s „6.2 s in flank" ist ein Artefakt der Anzeige, kein Steckenbleiben.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. HÖCHSTE PRIORITÄT — der letzte Edit ist noch nicht durch die Gates gelaufen.** In `_combat` (`src/ai/agent.js`, ~Z. 601) wurde die Deckungs-Neuwahl geändert: `const overstayed = !!this.cover && this.coverHold > this.coverHoldMax; const settled = overstayed ? this.cover : null;` und die Bedingung zu `if ((!this.cover || this.repathTimer <= 0 || overstayed) && this.pathFailTimer <= 0)`. Grund: `coverHoldMax` läuft nach 5–9 s ab, beantwortet wurde das aber erst beim nächsten `repathTimer`-Tick (2,2–4,5 s) — daher die gemessenen 10.7 s.
1. **Es fehlt noch die Rückfall-Bremse.** Wenn `pick()` nichts Besseres liefert, bleibt `overstayed` true und `pick()` läuft **jeden Frame** (CoverMap-Scan pro Frame = Verstoß gegen die Kostenlogik). Direkt nach `this.repathTimer = this.rng.range(2.2, 4.5);` ergänzen: `if (overstayed) this.coverHold = 0;` — „gefragt, nichts gefunden, also setzt er sich wieder fest". Zeile 629 (`this.coverHold = atCover ? this.coverHold + dt : 0;`) läuft danach und addiert nur `dt`, das ist konsistent.
2. Danach `node tools/cli/cod.mjs play` — `travelledM` **wird sich ändern**, das ist erwartet; maßgeblich sind die Zusicherungen. Neue Werte als Referenz in die nächste Übergabe schreiben.
3. `pnpm build`, `node tools/cli/cod.mjs glslcheck --q=ultra`.
4. Wirkung belegen: `node tools/cli/_probe-idle.mjs` erneut laufen lassen und gegen die Basiswerte aus 2G halten (Ziel: schlechteste Einzelsträhne deutlich unter 10.7 s, Mittel darf ruhig bei ~24 % bleiben — Deckung halten ist richtig, nur nicht 10 s lang).

**B. Den Stillstands-Anspruch ins Gate heben, dann `tools/cli/_probe-idle.mjs` löschen.** Neue Gameplay-Behauptungen gehören nach `tools/cli/playtests.mjs`, nicht in Prosa. Vorschlag: `ai-flank` um `longestStandStillS` erweitern (der Lauf ist ohnehin 40 s lang und hat schon `onFrame`) und auf z. B. `< 8` zusichern — Schwelle erst **nach** der Messung aus 3A4 festnageln, mit mindestens 1,5× Luft.

**C. Danach inhaltlich weiter am Realismus.** Offene, noch ungemessene Kandidaten, in dieser Reihenfolge: (a) `hasGrenade` wird nach einem Wurf nie wieder true — jeder Mann wirft im ganzen Spiel höchstens eine Granate; prüfen, ob das gewollt ist. (b) Reaktion auf **eigenen** Treffer ohne Tod (`applyDamage`) — ob ein Angeschossener zuckt, in Deckung geht oder ungerührt weiterschießt, ist noch nicht gemessen. (c) Der Suchschwenk gilt nur in ALERT; ein Mann in COMBAT ohne frische Peilung starrt weiter eine Linie an.

**D. Nichts committen ohne ausdrückliche Aufforderung des Users. Niemals `git stash`.** Im Baum liegt fremde, uncommittete Arbeit (`index.html`, `src/core/input.js`, `src/main.js`, `src/ui/*`, `src/global.css`, `src/weapons/index.js`, …). Zu **dieser** Arbeit gehören: `src/ai/agent.js`, `src/ai/nav.js`, `src/ai/squad.js`, `tools/cli/playtests.mjs`, `tools/cli/cod.mjs` (nur die Header-Zeile Z. 38) — plus die Wegwerf-Datei `tools/cli/_probe-idle.mjs`, die vor Schichtende weg soll.

**E. `ARCHITECTURE.md` bleibt unverändert** — es wurden keine neuen Events eingeführt, die Tabelle stimmt. `shared-docs/projects/claude-of-duty/` anzulegen ist weiterhin nicht möglich (Submodule nicht ausgecheckt, `git submodule update --init` wäre ein unbeauftragter Netzwerk-Fetch).

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Erlaubt sind nur `node tools/cli/cod.mjs …` und eigene Proben **unter `tools/cli/`**, die `harness.mjs` + `play.mjs` importieren (Node-GL-Mock).
- **Sandbox:** `grep`/`rg` liefern **leere** Ergebnisse → stattdessen `node -e` mit `fs.readFileSync` und `split('\n').forEach`. `timeout` existiert nicht.
- **Determinismus:** Jeder neue `rng.float()`-Aufruf in einem im `ai`-Szenario durchlaufenen Pfad verschiebt `travelledM` für alle sechs Agenten. Deshalb zieht weder der Suchschwenk (Phase = `this.id`) noch der zweite Flanken-Seitenversuch einen Draw. Kein `Math.random()` in Gameplay (ARCHITECTURE-Regel 4), keine Allokation pro Frame (Regel 5) — `snapTo` schreibt in-place, `_flankPoint` nutzt `_v`/`_v2`.
- **Scratch-Vektoren:** `_flankPoint` belegt `_v` (perp) und `_v2` (Ziel), `_breakContact` belegt `_v`. Das Flanken-Ziel **muss** `_v2` bleiben, solange irgendeine Probe darauf baut; das Gate `ai-flank` tut es bewusst **nicht** (es hakt `_flankPoint` ein), ist also gegen einen Umbau robust.
- **Facing-Guard:** unter 1,2 m Abstand zur Peilung wird `faceYaw` nicht neu gesetzt, sonst dreht sich ein Mann, der genau auf dem gesuchten Punkt steht, um sich selbst. Wer diesen Guard entfernt, bekommt Zittern statt Suchen.
- **Reihenfolge im Frame:** `_sense → _think → _move → _shoot → _drive`. Der Schock-Block steht **nach** der switch in `_think`, überschreibt also `crouch`/`desiredSpeed` der Zustände — und `_move` liest sie danach. Wer den Block vor die switch zieht, macht ihn wirkungslos.
- **Facing wirkt auf die Wahrnehmung:** `_sense` prüft den 100°-Sichtkegel gegen `yaw`. Jede Facing-Änderung verschiebt also, wer wen wann sieht, und damit das ganze Szenario. Genau daran ist `ai-squad` beim ersten Durchlauf mit `lastManBrokeContact: false` gefallen — repariert wurde das **nicht** durch Zahlen-Tuning, sondern indem der Rückzug in `_think` gehoben wurde.
- **Geteilte CoverMap:** `ai.cover` ist global über alle Squads; Claims des einen verändern die Auswahl des anderen. Bei Test-Flakiness zuerst hier suchen.
- **`--at=N` bei `cod.mjs shot` ist eine FRAME-Zahl, keine Sekunden.** Vergleichsreferenz ist `/tmp/cod-shot-ultra-90.png`, **nicht** `/tmp/cod-check.png` (anderer Aufruf, unbrauchbar).
- **Annahme (ungeprüft):** `maxRings = 6` und `yTol = 2.5` in `_flankPoint`/`_breakContact` sind aus einem Level-Seed gewählt. Auf anderen Seeds nicht gegengeprüft.
- **Annahme (ungeprüft):** dass `_breakContact` durch das Snappen häufiger gelingt, ist plausibel, aber im Gegensatz zum Flanken-Fall **nicht** gemessen — es gibt keinen Zähler für gescheiterte Rückzüge.

## 5. Wichtige Dateien & warum

- `src/ai/agent.js` — `faceYaw` (~Z. 136), Schock-Block + Squad-Rückzug am Ende von `_think`, `_combat` mit `grenadeReady` und der **noch ungetesteten** `overstayed`-Neuwahl (~Z. 601), `squadIsBroken` / `_breakContact` / `_threatPoint` / `_flankPoint` als Block direkt vor `_goTo`, Facing-Block in `_move`.
- `src/ai/nav.js` — `snapTo()` direkt über `findPath()`; das ist der Hebel für jedes „roher Offset → echter Ort"-Problem.
- `src/ai/squad.js` — `reportDown()`, `strength`, `grenadeCooldown` (nebenwirkungsfrei lesbar, `requestGrenade()` **verbraucht** die Ration und darf nur einmal pro Frame gefragt werden).
- `tools/cli/playtests.mjs` — `scenarioFlank` (Abschnitt 9), `scenarioSquad` (Abschnitt 8, Ansprüche 6/7 am Ende), `SCENARIOS`-Map ganz unten. **Neue Behauptungen gehören hierher.**
- `tools/cli/play.mjs` — `play()` nimmt `onFrame(i, sample, drv)`, läuft **nach** `engine.step`; bequemster Hebel für neue Messungen ohne `aiSample()` anzufassen.
- `tools/cli/_probe-idle.mjs` — Wegwerf-Probe für Stillstandszeiten, Basiswerte siehe 2G. Nach Punkt 3B löschen.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, im Loop arbeiten, keine Rückfragen.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless, das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`; eigene Proben dürfen unter `tools/cli/` liegen und `harness.mjs`/`play.mjs` importieren. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse — nutze `node -e` mit `fs.readFileSync`. Kein `git stash`, im Baum liegt fremde uncommittete Arbeit, und committe nichts ohne ausdrückliche Aufforderung. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Stand: Alle sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sind fertig; Punkt 7 (Gegnerverhalten) wird vertieft. In der letzten Schicht kamen dazu: begehbare Flankenziele (`NavGrid.snapTo` in `src/ai/nav.js`, `Agent._flankPoint`), ein präziser Granaten-Term (`grenadeReady`), Drehen zur Peilung plus Suchschwenk im Facing-Block von `_move`, der Schock-Block und der Squad-Rückzug hinter der switch in `_think` (`squadIsBroken`, `_breakContact`, `_threatPoint`), sowie das neue Gate `ai-flank` und zwei zusätzliche Ansprüche in `ai-squad`. Zu diesem Zeitpunkt: `node tools/cli/cod.mjs play` = 11/11 PASS, `pnpm build` grün, `glslcheck --q=ultra` = 0 findings, `ai-movement`-Referenz `travelledM: [29.35,31.18,37.66,38.1,20.74,36.9]`, `finalStates: {"combat":5,"flank":1}`.

Deine Aufgaben in dieser Reihenfolge:

1. **Zuerst den letzten, ungetesteten Edit fertigstellen.** In `src/ai/agent.js` `_combat` (~Z. 601) wurde die Deckungs-Neuwahl um `overstayed` erweitert, damit ein Mann seine Deckung nicht bis zu 4,5 s länger hält als er will (gemessen: schlechteste Strähne 10.7 s stillstehend). Es fehlt die Rückfall-Bremse: direkt nach `this.repathTimer = this.rng.range(2.2, 4.5);` die Zeile `if (overstayed) this.coverHold = 0;` ergänzen — sonst ruft ein Mann, für den `pick()` nichts Besseres findet, den CoverMap-Scan **jeden Frame** auf. Danach `node tools/cli/cod.mjs play` (`travelledM` ändert sich erwartungsgemäß, maßgeblich sind die Zusicherungen), `pnpm build`, `node tools/cli/cod.mjs glslcheck --q=ultra`. Neue `travelledM`-Werte als Referenz festschreiben.

2. **Wirkung belegen:** `node tools/cli/_probe-idle.mjs` laufen lassen und gegen die Basis halten — vorher `still` 13–42 % (Mittel 24 %), schlechteste Einzelsträhne **10.7 s** (Agent 3, combat). Beachte: die Spalte `longestState` zeigt den Zustand im letzten Frame der Strähne und ist irreführend.

3. **Anspruch ins Gate heben, dann die Probe löschen.** `longestStandStillS` in `scenarioFlank` (`tools/cli/playtests.mjs`, Abschnitt 9) mitzählen — der Lauf ist 40 s lang und hat schon `onFrame` — und eine Schwelle mit mindestens 1,5× Luft über dem gemessenen Wert zusichern. Danach `tools/cli/_probe-idle.mjs` löschen.

4. **Erst dann inhaltlich weiter**, in dieser Reihenfolge und jeweils erst messen, dann ändern: (a) `hasGrenade` wird nach einem Wurf nie wieder true, jeder Mann wirft also höchstens eine Granate pro Runde — prüfen ob gewollt; (b) die Reaktion auf einen **überlebten** Treffer (`applyDamage`) ist bisher völlig ungemessen; (c) der Suchschwenk gilt nur in ALERT, ein Mann in COMBAT ohne frische Peilung starrt weiter eine Linie an.

5. Für die Bild-Kontrolle `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-check3.png --w=640 --h=400 --at=90` benutzen und gegen `/tmp/cod-shot-ultra-90.png` vergleichen — **nicht** gegen `/tmp/cod-check.png`. `--at=N` ist eine Frame-Zahl, keine Sekunden. Nicht übertreiben: ein Kontrollbild pro Schicht reicht, KI-Änderungen haben bisher keinen Render-Einfluss gehabt.
