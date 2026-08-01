# PH5 - KI-Gegnerverhalten - Squad-Reaktion auf Verluste, Deckungs-Kill-Zone,...

> 2026-08-01T18:42:24.268Z · Grund: Zeitlimit erreicht

# Übergabe — Gegnerverhalten Claude-of-Duty (Stillstand, Nav-Regionen, A\*-Budget)

## 1. Mission in 2 Sätzen

Punkt 7 der Notiz `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` („Gegner sollen sich bewegen statt stillzustehen") wird vertieft: in dieser Schicht wurde die **eigentliche Ursache des Stillstands** gefunden und behoben — ein Mann, der auf eine winzige Nav-Insel läuft, bekommt von jeder regionsgefilterten Abfrage „nichts" zurück und friert ein. Qualitätskontrolle läuft ausschließlich browserlos über `node tools/cli/cod.mjs` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

**A. Der offene Edit aus der letzten Übergabe ist fertig und grün.** Die Rückfall-Bremse `if (overstayed) this.coverHold = 0;` steht in `src/ai/agent.js` `_combat` direkt nach `this.repathTimer = this.rng.range(2.2, 4.5);`.

**B. Der Hauptfund dieser Schicht — gemessen, nicht geraten.** `tools/cli/_probe-idle.mjs` meldete nach dem Overstay-Edit **43,0 s** schlechteste Stillstandssträhne (statt der erwarteten Verbesserung gegenüber 10,7 s). Drei Proben haben die Kette aufgeklärt:
- `_probe-stuck.mjs`: Agent 6 hatte 2581 Frames am Stück **keine Deckung**, `pick()` lieferte in **jedem** Frame `null` — und wurde 60×/s aufgerufen (voller CoverMap-Scan über 1349 Punkte pro Frame).
- `_probe-nocover.mjs`: Ablehnungsgrund war zu 1349/1349 **`wrongRegion`**.
- `_probe-region.mjs`: das Level hat **789 Komponenten** — eine Straße mit 29835 Zellen und 788 Inseln; **749 davon sind ≤ 9 Zellen**. Agent 6 lief bei f980 mit 4,4 m/s auf Region **360** (8 Zellen, 5 m², **0 Cover-Punkte**, y = 0,94 — ein Kistendeckel) und stand dort 43 s. Agent 2, 3, 5 trafen dieselben Inseln mehrfach, blieben aber nur transient hängen.

**C. Umgesetzt (alles in `src/ai/`):**
- **`src/ai/nav.js` → neu `NavGrid.operatingRegion(x, z, y, maxRings = 3, minSize = 10)`** direkt unter `regionAt()`: liefert die Komponente, in der jemand *arbeiten* kann. Ist die Insel unter `minSize` Zellen, wird ringweise (dieselben **3 Ringe**, die `findPath` beim Start-Re-Anchor benutzt) die größere Nachbarkomponente gesucht — näher schlägt größer, Schleife bricht beim ersten brauchbaren Netz ab. `regionAt` bleibt unverändert und ehrlich.
- **`src/ai/agent.js` Z. ~320:** `navRegion` kommt jetzt aus `operatingRegion` statt `regionAt`.
- **`src/ai/agent.js` `_combat`, Repath-Gate:** `!this.cover ||` aus der Bedingung entfernt → `if ((this.repathTimer <= 0 || overstayed) && this.pathFailTimer <= 0)`. Kein Deckungsloser scannt mehr die CoverMap jeden Frame. Alle Pfade, die den Claim abgeben, setzen die Uhr ohnehin klein (0,4 s / 0,6 s / 0 bei `_enterCombat`); ergänzt wurde `this.repathTimer = 0;` beim FLANK→COMBAT-Übergang in `_think`.
- **`src/ai/agent.js` `_combat`, neuer „Bound":** eigenständiges `if (!this.cover && !this.hasMoveTarget && !this.pathPending)` **nach** dem Pick-Block (bewusst **kein** `else if` — genau daran hing der zweite Fund, siehe unten): 7 m seitlich versetzt, 4 m näher, über `_flankPoint` auf begehbaren Boden gesnappt, dann `_goTo`.
- **`src/ai/agent.js` `_combat`, Bewegungszweig:** aus `if (this.cover && !atCover)` wurde `if (!atCover && (this.cover || this.hasMoveTarget))`. Vorher hat der Else-Arm („peek and shoot") mit `desiredSpeed = 0; hasMoveTarget = false;` den gerade erteilten Bound im selben Frame stillschweigend annulliert — und die Stall-Wache in `_move` greift nicht, weil die nur bei `desiredSpeed > 0.2` anschlägt.
- **`src/ai/nav.js` `findPath()` → Teilpfade:** `bestNode`/`bestH` werden mitgeführt; findet A\* das Ziel nicht, wird zum erreichbaren Knoten mit der kleinsten Heuristik gelaufen, sofern er **mindestens `cell * 2.5` (= 2,0 m)** Gewinn bringt, sonst weiterhin `0`. Jeder Knoten im Suchbaum ist per Konstruktion erreichbar, und der Regionstest oben hat das Ziel bereits als erreichbar bewiesen — ein Teilpfad führt also nie ins Nichts. Scratch-Vektor: `this._p1` (war ungenutzt, kollidiert nicht mit `_v`/`_v2` in `_stringPull`).
- **`src/ai/agent.js` `_goTo` + `src/ai/index.js` `requestPath(from, dest, out, opts)` → eskalierendes Knotenbudget:** neue Felder `pathFails` und `_pathOpts = { maxNodes: 6000 }` (vorbelegt, keine Allokation pro Frame); `maxNodes = 6000 * min(4, 1 + pathFails)`, Reset bei Erfolg, `pathFails++` bei `n === 0`.

**D. Warum das Budget eskaliert — gemessen.** `_probe-deadend.mjs` zeigte: eine Deckung **5,1 m Luftlinie** entfernt, 17 Wegpunkte über die Straße, sprengte die 6000 Knoten und kam 20× hintereinander als „no route" zurück (13,6 s Stillstand von Agent 2), während **12000 Knoten** die Route jedes Mal fanden. `_probe-heap.mjs` hat die Kosten abgesichert: Heap-Kapazität 48841, **High Water über 60 s Feuergefecht: 798**, 0 verworfene Pushes, nur **158 Solves in 60 s** — die Front eines Grid-A\* ist ein Umfang, keine Fläche, vierfaches Budget kostet also viermal Arbeit und keinen Speicher.

**E. Warum der Teilpfad einen Boden von 2,5 Zellen braucht — gemessen.** Mit einem Halb-Zellen-Boden entstand ein Re-Solve-Karussell: ein Teilpfad mit **0,57 m** Gewinn ließ den Mann im nächsten Frame innerhalb `arriveEps` ankommen, `_combat` las „Pfadende erreicht, trotzdem nicht in Deckung", gab den Punkt zurück, nahm denselben wieder → 10 Picks, 6,5 s ohne Bewegung. Verteilung über 60 s: 150 Solves, 146 direkt am Ziel, 3 Teilpfade (0,57 / 1,0 / 4,05 m), 1 „no route".

**F. Wirkung, gegen die Basiswerte gehalten** (`_probe-stuck.mjs`, 60 s, 6 Mann):

| | vor der Schicht | 43-s-Bug | **jetzt** |
|---|---|---|---|
| schlechteste Einzelsträhne | 10,7 s | 43,0 s | **5,0 s** |
| Mittel stillstehend | 24 % | 28 % | **19 %** |
| Frames ohne Deckung / Null-Picks | — | 2581 / 2581 | **0 / 0** |

Alle sechs längsten Strähnen sind jetzt „in Deckung, peekend" — also gewolltes Verhalten, nicht Steckenbleiben.

**G. Gate-Stand nach allen Edits:** `node tools/cli/cod.mjs play` = **11/11 PASS**, `pnpm build` grün, `node tools/cli/cod.mjs glslcheck --q=ultra` = 0 findings. Neue Referenzwerte: `ai-movement` **`travelledM: [29.35,31.19,37.66,42.17,20.96,31.9]`**, `finalStates: {"combat":4,"flank":2}`; `ai-flank` `flankAttempts: 10 · attemptsWithNoRoute: 0 · flanksEntered: 10 · entriesPer10s: [1,4,1,4] · longestBarredByGrenadeS: 0.48 · grenadesThrown: 3`. **Achtung:** die letzten `travelledM`/`ai-flank`-Zahlen stammen vom Lauf *vor* der Anhebung des Teilpfad-Bodens auf `cell * 2.5`; der 11/11-Lauf danach wurde nur mit `grep -E '^(PASS|FAIL...)'` gefiltert, die Detailzeilen sind also **nicht** neu abgelesen — vor dem Festschreiben einmal `node tools/cli/cod.mjs play --scenario=ai` und `--scenario=aiflank` laufen lassen (Annahme: `travelledM` hat sich erneut verschoben).

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. HÖCHSTE PRIORITÄT — Referenzwerte nachziehen und die Wegwerf-Proben entfernen.**
1. `node tools/cli/cod.mjs play --scenario=ai` und `--scenario=aiflank` einzeln laufen lassen, die tatsächlichen Werte notieren und in die nächste Übergabe schreiben (die Zahlen aus 2G sind eine Schicht alt).
2. `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-check4.png --w=640 --h=400 --at=90` gegen `/tmp/cod-shot-ultra-90.png` halten. **Das steht noch aus** — in dieser Schicht wurde kein Kontrollbild gemacht. `--at=N` ist eine **Frame**-Zahl. Ein Bild reicht, KI-Änderungen hatten bisher nie Render-Einfluss.
3. Danach löschen: `tools/cli/_probe-idle.mjs`, `_probe-stuck.mjs`, `_probe-nocover.mjs`, `_probe-region.mjs`, `_probe-deadend.mjs`, `_probe-heap.mjs`. Vorher Punkt B erledigen.

**B. Die neuen Ansprüche ins Gate heben — sonst sind sie nur Prosa.** Drei Behauptungen dieser Schicht sind durch **keinen** Gate abgesichert und können jederzeit lautlos zurückfallen:
1. **`longestStandStillS`** in `scenarioFlank` (`tools/cli/playtests.mjs`, Abschnitt 9, ~Z. 633) mitzählen — der Lauf ist 40 s und hat schon `onFrame`. Gemessen 5,0 s über 60 s; mit 1,5× Luft auf **`< 8`** zusichern.
2. **`framesWithoutCoverInCombat`** oder direkt `nullPicksInARow` — der 43-s-Bug war „keine Deckung, `pick()` null, trotzdem stehen". Vorschlag: in `scenarioFlank` zählen, wie viele Frames ein lebender Agent in `combat` ohne `cover` **und** ohne `hasMoveTarget` verbringt, und auf z. B. `< 120` (2 s) zusichern.
3. **`attemptsWithNoRoute: 0`** deckt Flanken ab, nicht Deckungswege. Ein Zähler für alle `_goTo`-Fehlschläge (nicht nur die aus `_flankPoint`) würde den 13,6-s-Fund abdecken; die Hook-Vorlage steht in `_probe-deadend.mjs`.

**C. Erst danach inhaltlich weiter**, jeweils erst messen, dann ändern:
- (a) `src/ai/index.js` Z. 518/521 (`populate`) benutzt weiterhin `regionAt` für „auf welchem Netz steht der Spieler" und „welche Spawns liegen darin". Das ist derselbe Fehlerfall wie 2B, nur zur Spawn-Zeit. **Bewusst nicht angefasst** (verschiebt die Spawn-Platzierung und damit jede Referenz). Erst messen, ob Spieler-/Spawn-Zellen je auf einer Insel < 10 Zellen liegen — wenn nie, ist der Wechsel gratis und richtig.
- (b) `hasGrenade` wird nach einem Wurf nie wieder true — jeder Mann wirft höchstens eine Granate pro Runde. Prüfen ob gewollt.
- (c) Reaktion auf einen **überlebten** Treffer (`applyDamage`) ist bis heute ungemessen.
- (d) Der Suchschwenk gilt nur in ALERT; ein Mann in COMBAT ohne frische Peilung starrt weiter eine Linie an.

**D. Nichts committen ohne ausdrückliche Aufforderung. Niemals `git stash`.** Im Baum liegt fremde uncommittete Arbeit (`index.html`, `src/core/input.js`, `src/main.js`, `src/ui/*`, `src/global.css`, `src/weapons/index.js`, …). Zu **dieser** Arbeit gehören: `src/ai/agent.js`, `src/ai/nav.js`, `src/ai/index.js` (nur die eine `requestPath`-Signatur) — plus die sechs `tools/cli/_probe-*.mjs`, die vor Schichtende weg sollen.

**E. `ARCHITECTURE.md` bleibt unverändert** — keine neuen Events. `shared-docs/projects/claude-of-duty/` anzulegen ist weiterhin nicht möglich (Submodule nicht ausgecheckt, `git submodule update --init` wäre ein unbeauftragter Netzwerk-Fetch).

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Erlaubt sind nur `node tools/cli/cod.mjs …` und eigene Proben **unter `tools/cli/`**, die `harness.mjs` + `play.mjs` importieren (Node-GL-Mock). Proben müssen dort liegen — ein Skript unter `/tmp` findet `./harness.mjs` nicht.
- **Sandbox:** `grep`/`rg` liefern **leere** Ergebnisse → stattdessen `node -e` mit `fs.readFileSync` und `split('\n').forEach`. `timeout` existiert nicht.
- **`minSize = 10` in `operatingRegion` ist aus der Verteilung dieses Levels gewählt** (749 Regionen ≤ 9 Zellen, dann ein Sprung auf 23 Regionen mit 10–99). Auf anderen Levels/Seeds ungeprüft — **Annahme**. Zu hoch angesetzt würde ein echtes Dach dem Erdgeschoss zugeschlagen; zu niedrig lässt Kistendeckel wieder durch.
- **`operatingRegion` muss dieselben 3 Ringe benutzen wie der Re-Anchor in `findPath`** (Z. ~382). Wer den einen Wert ändert und den anderen nicht, benennt Regionen, in die der Pfadfinder den Agenten nicht setzen kann — dann ist der 43-s-Bug zurück, nur mit anderer Signatur.
- **Teilpfade ändern die Semantik von `findPath` für ALLE Aufrufer** (Deckung, Flanke, Patrouille, Rückzug): `n > 0` heißt nicht mehr „Ziel erreichbar in einem Lauf". Für Deckung ist das abgefangen (der „nicht wirklich erreichbar"-Zweig gibt den Punkt zurück), für FLANK/RETREAT endet der Zustand ohnehin bei `distanceTo(moveTarget) < 1.2`.
- **Der Boden `cell * 2.5` ist die Bremse gegen das Karussell.** Wer ihn senkt, bekommt den 6,5-s-Fund aus 2E zurück; wer ihn stark anhebt, bekommt wieder harte „no route"-Antworten.
- **Eskalation ist auf 4× (24000 Knoten) gedeckelt.** Der Heap ist mit 798/48841 High Water weit weg von seiner Grenze — aber `Heap.push` **verwirft still**, wenn er voll ist. Wer den Deckel deutlich anhebt, muss das neu messen (`_probe-heap.mjs` als Vorlage, vor dem Löschen ansehen).
- **Determinismus:** Jeder neue `rng.float()`-Aufruf in einem im `ai`-Szenario durchlaufenen Pfad verschiebt `travelledM` für alle sechs Agenten. Der neue Bound zieht **einen** Draw (`side`), `reach` ist die Konstante 7. Kein `Math.random()` in Gameplay (ARCHITECTURE-Regel 4), keine Allokation pro Frame (Regel 5) — daher `_pathOpts` vorbelegt und `_p1` als Scratch.
- **Scratch-Vektoren:** `_flankPoint` belegt `_v` (perp) und `_v2` (Ziel) — der Bound ruft `_flankPoint` und liest danach sofort `this._v2`, dazwischen darf nichts dazwischenfunken. In `NavGrid` benutzt `_stringPull` `_v`/`_v2`, der Teilpfad `_p1`.
- **Reihenfolge im Frame:** `_sense → _think → _move → _shoot → _drive`. Der Schock-Block steht **nach** der switch in `_think` und überschreibt `crouch`/`desiredSpeed`. `_move` liest sie danach — Messproben in `onFrame` sehen also immer den Zustand **nach** `_move`, weshalb `hasMoveTarget` bei einem Pfad, der im selben Frame endet, nie als `true` erscheint (genau darüber bin ich bei 2E fast falsch abgebogen).
- **Geteilte CoverMap:** `ai.cover` ist global über alle Squads; Claims des einen verändern die Auswahl des anderen. Bei Test-Flakiness zuerst hier suchen.
- **Der `ai-flank`-Gate hakt `_flankPoint` ein** — der neue Bound benutzt dieselbe Methode und wird deshalb **als Flankenversuch mitgezählt** (`flankAttempts` stieg 8 → 11). Wer die beiden Manöver getrennt zählen will, muss den Gate anpassen, nicht die Produktion; der Unterscheider ist `reach === 7`.

## 5. Wichtige Dateien & warum

- `src/ai/agent.js` — `pathFails` / `_pathOpts` (Konstruktor, bei `pathFailTimer`), `navRegion` über `operatingRegion` (~Z. 320), `_combat` mit Repath-Gate, Bound und dem umgebauten Bewegungszweig (~Z. 629–700), `_goTo` mit dem eskalierenden Budget, FLANK→COMBAT-Reset in `_think`.
- `src/ai/nav.js` — `operatingRegion()` direkt unter `regionAt()`; `findPath()` mit `bestNode`/`bestH` und dem Teilpfad-Block vor dem Parent-Walk. Das ist der Hebel für jedes „der Mann kann nirgends hin"-Problem.
- `src/ai/index.js` — nur `requestPath(from, dest, out, opts)` (eine Zeile Signatur + Durchreichen); `populate()` Z. 508–540 ist der noch offene `regionAt`-Fall.
- `tools/cli/playtests.mjs` — `scenarioFlank` (Abschnitt 9, ~Z. 633), `scenarioSquad` (Abschnitt 8), `SCENARIOS`-Map ab Z. 776. **Neue Behauptungen gehören hierher.**
- `tools/cli/play.mjs` — `play(engine, rec, { frames, onFrame(i) })`, läuft **nach** `engine.step`; bequemster Hebel für neue Messungen.
- `tools/cli/_probe-stuck.mjs` — die wertvollste Probe: längste Stillstandssträhne **plus** warum (Deckung, Picks, Peek, Pfad-Zustand). Vorlage für den Gate-Anspruch aus 3B, dann löschen.
- `tools/cli/_probe-heap.mjs`, `_probe-deadend.mjs`, `_probe-region.mjs`, `_probe-nocover.mjs`, `_probe-idle.mjs` — Wegwerf, Belege stehen oben in 2B/2D/2E.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, im Loop arbeiten, keine Rückfragen.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless, das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`; eigene Proben dürfen unter `tools/cli/` liegen und `harness.mjs`/`play.mjs` importieren. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse — nutze `node -e` mit `fs.readFileSync`. Kein `git stash`, im Baum liegt fremde uncommittete Arbeit, und committe nichts ohne ausdrückliche Aufforderung. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Stand: Alle sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sind fertig; Punkt 7 (Gegnerverhalten) wird vertieft. In der letzten Schicht wurde die Ursache des „die Gegner stehen nur rum"-Eindrucks gefunden und behoben: `NavGrid.regionAt` labelt einen Mann, der auf einen Kistendeckel gelaufen ist, mit einer 8-Zellen-Insel ohne einen einzigen Cover-Punkt, worauf jede regionsgefilterte Abfrage leer zurückkam — gemessen 43 s Stillstand, 2581 Frames ohne Deckung, 2581 Null-Picks, dazu ein voller CoverMap-Scan pro Frame. Behoben durch `NavGrid.operatingRegion()` (neu in `src/ai/nav.js`), Teilpfade in `findPath()` mit `cell * 2.5` Mindestgewinn, ein eskalierendes A\*-Knotenbudget in `Agent._goTo` (6000 → max. 24000, weil eine Deckung 5,1 m Luftlinie / 17 Wegpunkte entfernt 20× „no route" bekam), ein Repath-Gate ohne den `!this.cover`-Freifahrtschein, einen Bound für den Mann ohne Deckung und den Bewegungszweig `if (!atCover && (this.cover || this.hasMoveTarget))`. Ergebnis gemessen: schlechteste Stillstandssträhne **43,0 s → 5,0 s**, Mittel **28 % → 19 %**. Zu diesem Zeitpunkt: `node tools/cli/cod.mjs play` = 11/11 PASS, `pnpm build` grün, `glslcheck --q=ultra` = 0 findings.

Deine Aufgaben in dieser Reihenfolge:

1. **Referenzen nachziehen.** `node tools/cli/cod.mjs play --scenario=ai` und `--scenario=aiflank` einzeln laufen lassen und die Detailwerte festschreiben — die zuletzt notierten (`travelledM: [29.35,31.19,37.66,42.17,20.96,31.9]`, `finalStates: {"combat":4,"flank":2}`, `flankAttempts: 10 · attemptsWithNoRoute: 0 · flanksEntered: 10`) stammen vom Lauf **vor** der letzten Änderung am Teilpfad-Boden und sind vermutlich verschoben. Danach einmal `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-check4.png --w=640 --h=400 --at=90` gegen `/tmp/cod-shot-ultra-90.png` halten (`--at` ist eine Frame-Zahl, **nicht** `/tmp/cod-check.png` als Referenz nehmen). Ein Bild reicht.

2. **Die drei neuen Ansprüche in `tools/cli/playtests.mjs` gießen, dann die Proben löschen.** In `scenarioFlank` (Abschnitt 9): `longestStandStillS` (gemessen 5,0 s → auf `< 8` zusichern), Frames in `combat` ohne `cover` und ohne `hasMoveTarget` (auf `< 120` zusichern), und einen Zähler für **alle** gescheiterten `_goTo` (nicht nur die aus `_flankPoint`; Hook-Vorlage steht in `tools/cli/_probe-deadend.mjs`). Erst danach `tools/cli/_probe-idle.mjs`, `_probe-stuck.mjs`, `_probe-nocover.mjs`, `_probe-region.mjs`, `_probe-deadend.mjs`, `_probe-heap.mjs` löschen. Jeden neuen Anspruch einmal mit einer Negativkontrolle prüfen (Fix temporär zurückdrehen, Gate muss fallen, dann sauber restaurieren).

3. **Erst dann inhaltlich weiter**, jeweils erst messen, dann ändern: (a) `src/ai/index.js` `populate()` Z. 518/521 benutzt noch `regionAt` für Spieler-Netz und Spawn-Filter — dieselbe Fehlerklasse, bewusst nicht angefasst, weil es die Spawn-Platzierung und damit jede Referenz verschiebt; erst messen, ob Spieler- oder Spawn-Zellen je auf einer Insel unter 10 Zellen liegen. (b) `hasGrenade` wird nach einem Wurf nie wieder true. (c) Die Reaktion auf einen **überlebten** Treffer (`applyDamage`) ist völlig ungemessen. (d) Der Suchschwenk gilt nur in ALERT.

Beachte: `minSize = 10` in `operatingRegion` und der Boden `cell * 2.5` in `findPath` sind aus Messungen dieses Levels gewählt und auf anderen Seeds ungeprüft. `operatingRegion` muss dieselben drei Ringe benutzen wie der Start-Re-Anchor in `findPath` — sonst benennt es Regionen, in die der Pfadfinder den Agenten nicht setzen kann.
