# PH3 - KI-Gegnerverhalten - Squad-Reaktion auf Verluste, Deckungs-Kill-Zone,...

> 2026-08-01T17:52:05.030Z · Grund: Zeitlimit erreicht

# Übergabe — Gegnerverhalten Claude-of-Duty (Squad-Reaktion auf Verluste)

## 1. Mission in 2 Sätzen

Die sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sind komplett umgesetzt; in dieser Schicht wurde die vom Vorgänger als nächster Schritt benannte Erweiterung von Punkt 7 gebaut — **Gegner reagieren jetzt auf den Tod eines Squadmates** (Schock, Peilung, Aufgabe der tödlichen Deckung, Rückzug bei dezimiertem Squad), plus die Reparatur einer permanenten Flanken-Sackgasse. Qualitätskontrolle läuft ausschließlich browserlos über `node tools/cli/cod.mjs` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

**A. Verifikation der Vorgänger-Schicht (Aufgabe 1 der alten Übergabe) — erledigt und grün.**
`node tools/cli/cod.mjs play` lieferte 9/9 PASS mit exakt `travelledM: [29.31,28.78,30.08,23.13,19.53,32.4]` und `finalStates: {"combat":6}`, `pnpm build` grün. Die beiden kosmetischen Edits des Vorgängers waren sauber.

**B. Diagnose des Ist-Zustands (gemessen, nicht geraten).** Wegwerf-Probe unter `tools/cli/_probe-squad.mjs`: Agent 1 wurde **1.1 m** neben Agent 3 und 1.8 m neben Agent 2 erschossen — beide liefen ihre Patrouille vier Sekunden weiter, `lastKnownAge` blieb auf `Infinity`, `suppression` auf 0. Der Tod eines Kameraden war das einzige Ereignis, das die KI komplett ignorierte.

**C. Umgesetzt (alle Dateien in `src/ai/`, also im eigenen Verzeichnis):**
- **`src/ai/squad.js`** — neue Felder `casualties`, `lastCasualty`, `casualtyAge`, `threat`, `hasThreat`, `strength` (letzteres wird in `update()` gecached, weil `_combat` es pro Mann und Frame liest). Neue Methode **`reportDown(victim, threat)`**: erhöht die Verlustzahl, merkt Fundort und Schussrichtung, gibt Peek-Token und Flanker-Slot des Toten frei und benachrichtigt jeden lebenden Kameraden.
- **`src/ai/agent.js`** — neue Methode **`squadmateDown(pos, threat, strength)`** (bei den Sinnes-Eingängen neben `hear()`/`suppress()`), Reichweite `MANDOWN_RANGE = 30` m, mit vier Konsequenzen: 1. Suppression-Schub, skaliert mit Nähe *und* mit `shock = 1 + (1 - strength) * 0.5` (der letzte von sechs zu sterben ist lauter als der erste), IDLE/PATROL → ALERT; 2. Peilung auf den zurückgerechneten Schützen, aber **nur** mit derselben Verzögerungsregel wie `hear()` (`lastKnownAge = 0.6 + rng*0.7`) — nie eine Gratis-Position; 3. Deckung innerhalb von 5 m der Leiche wird abgegeben (`release` + `repathTimer = 0`); 4. `manDownTimer` als Schock-Beat.
- **`src/ai/agent.js` `_combat`** — während `manDownTimer > 0`: `wantFire = false`, `peeking = false`, geduckt und stehend (nur wenn nicht gerade zur Deckung unterwegs). Rückzugsbedingung erweitert: `broken = sq.casualties > 0 && sq.strength <= 0.34` löst auch bei voller HP einen Rückzug aus, mit erhöhter Rate (`dt * 0.9` statt `dt * 0.5`).
- **`src/ai/agent.js` `die()`** — meldet an den Squad, solange die Leiche noch steht. Peilung = Rückrechnung `point - dir * 14` (dieselbe 14-m-Schätzung wie `applyDamage`), ersatzweise die letzte eigene Sichtung. Nutzt `_v3` als Scratch, weil `_v`/`_v2` in `die()` noch `hitPoint`/`impulse` halten und ein `actor:death`-Listener diese Referenz behalten könnte.
- **`src/ai/nav.js` `CoverMap.pick()`** — neuer Parameter `opts.danger` und Konstante `DANGER_R = 6`: Deckungspunkte im Umkreis einer Leiche verlieren `(6 - d) * 1.1` Punkte. Bewusst **Strafe, kein Filter** — wenn es nichts Besseres gibt, ist Deckung neben der Leiche immer noch besser als offenes Feld. `_combat` übergibt `danger: sq && sq.casualtyAge < 20 ? sq.lastCasualty : null`. **Grund (gemessen):** ohne das hat der Mann die Deckung abgegeben und im nächsten Frame denselben Punkt neu gewählt — die Reaktion war ein No-Op. Mit der Strafe wechselte Agent 6 sofort von 2.3 m auf **10.8 m** Abstand zur Leiche.
- **Flanken-Sackgasse repariert (`_combat`, ~Z. 683).** Alt: `this.grenadeCooldown < 0 === false`. `hasGrenade` wird nach einem Wurf **nie** wieder true und `grenadeCooldown` zählt nur herunter — die Bedingung wurde damit dauerhaft falsch. **Gemessen über 60 s:** vier von sechs Männern standen bei Cooldown −22 bis −46 s und konnten nie wieder flankieren, obwohl allein im Fenster 20–30 s **3184 Frames** alle anderen Flanken-Bedingungen erfüllten. Neu: `const holdingGrenade = this.hasGrenade && this.grenadeCooldown <= 0;` und `!holdingGrenade` — die Absicht („wer eine Granate griffbereit hat, wirft sie statt zu laufen") bleibt, verfällt aber mit der Granate.

**D. Neues Gate `ai-squad` in `tools/cli/playtests.mjs`** (`--scenario=aisquad`, in `SCENARIOS` als `aisquad`, Header-Doku in `tools/cli/cod.mjs` Z. 38 ergänzt). Drei gestellte Tode über 16 s: ein Patrouillierender (Kameraden 1–2 m daneben), ein Mann aus dem Squad, das bereits in Deckung kämpft, und der zweite Mann von Squad 1 (damit `strength` auf 1/3 fällt). Gemessenes Ergebnis, alles PASS:
`obliviousBeforeKill: 2/2 patrolling, 2 with no bearing` · `alertedOnTheKill: 2/2` · `suppression: 0.00 -> 0.84` · `bearingsGiven: 2` · `callOutDelaysS: [1.07,1.16]` · `flinchFrames: 247` · `shotsWantedWhileFlinching: 0` · `coverNextToBody: 1/1 abandoned` · `newCoverFurtherByM: [8.52]` · `lastManBrokeContact: true`.

**E. Gates zum Zeitpunkt vor dem letzten Edit (siehe Punkt 3A!):** `node tools/cli/cod.mjs play` = **10/10 PASS**, `pnpm build` grün, `node tools/cli/cod.mjs glslcheck --q=ultra` = 0 findings, Kontroll-Screenshot geprüft. Wichtig: `ai-movement` lieferte **bit-identische** `travelledM`-Werte, weil ohne Toten kein einziger neuer RNG-Draw gezogen wird — das war der Regressionsbeweis.

**F. Screenshot-QK.** `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-squad2.png --w=640 --h=400 --at=90` → Szene intakt, Soldaten sichtbar, `skinnedInBindPose: 6`. Zwei Läufe byte-identisch, und praktisch deckungsgleich mit dem Altbestand `/tmp/cod-shot-ultra-90.png` (14:26 Uhr, vor beiden KI-Schichten) — also **keine** Render-Auswirkung. **Achtung:** `/tmp/cod-check.png` (19:21) sieht farbiger/kontrastreicher aus, ist aber *nicht* mit denselben Flags entstanden und taugt **nicht** als Referenz; die Render-Dateien wurden seit 16:16 nicht angefasst (per `ls -lT` geprüft).

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. HÖCHSTE PRIORITÄT — der Flanken-Fix ist noch nicht durch die Gates gelaufen.** Nach dem Edit in `_combat` lief nur die Wegwerf-Probe, danach kam der Schichtwechsel. Sofort ausführen, in dieser Reihenfolge:
1. `node tools/cli/cod.mjs play` — **`ai-movement` wird sich verändern**, das ist erwartet und kein Fehler: die Flanken-Bedingung entscheidet, ob `this.rng.float()` überhaupt gezogen wird, also verschiebt sich der RNG-Strom und damit `travelledM`. Maßgeblich sind die Zusicherungen (`spawned >= 4`, `agentsThatMoved >= 60 %`, `reachedWalkSpeed`), **nicht** die alten Zahlen. Die neuen `travelledM`-Werte in die nächste Übergabe schreiben, damit wieder ein Referenzwert existiert.
2. `pnpm build`, dann `node tools/cli/cod.mjs glslcheck --q=ultra`.
3. Wenn `ai-movement` oder `ai-squad` **fällt**: der einzige Verdächtige ist der `holdingGrenade`-Edit — rückgängig machen ist eine Ein-Zeilen-Änderung.

**B. Wegwerf-Datei löschen: `tools/cli/_probe-flank.mjs`.** Steht noch im Baum (`_probe-squad.mjs` wurde bereits entfernt). Sie ist browserlos und harmlos, gehört aber nicht ins Repo.

**C. Messergebnis des Flanken-Fixes bewerten (offen, Annahme).** Direkt nach dem Fix zeigte die 60-s-Probe `flank entries per 10 s bin: 1 1 0 1 0 0` gegenüber `1 1 0 1 0 2` vorher — also **nicht mehr** Flanken, obwohl die Sperre weg ist. Erklärung (Annahme, ungeprüft): die Männer, die vorher spät flankierten, hatten gerade geworfen und dadurch einen positiven Cooldown; nach dem Fix hält der Rest die Granate zurück (`hasGrenade === true`, Cooldown abgelaufen) und wartet auf eine Wurfgelegenheit (`dist` 8–26 m, `lastKnownAge < 1.5`, `sq.requestGrenade()`). Zwei von sechs Männern (1 und 6 im Ausgangslauf) hatten nach 60 s ihre Granate nie geworfen. **Zu prüfen:** ob diese Wurfgelegenheit realistisch je eintritt; falls nicht, ist die saubere Lösung, den Granaten-Term aus der Flanken-Bedingung ganz zu streichen (der Granaten-Zweig steht ohnehin danach im selben Frame) oder `hasGrenade` nach einer Weile wieder freizugeben. Belegen mit `tools/cli/_probe-flank.mjs` (Zähler für tatsächliche Würfe ergänzen).

**D. Nichts committen ohne ausdrückliche Aufforderung des Users. Niemals `git stash`.** Im Baum liegt fremde, uncommittete Arbeit (`index.html`, `src/core/input.js`, `src/main.js`, `src/ui/*`, `src/global.css`, `src/weapons/index.js`, …). Zu **dieser** Arbeit gehören nur: `src/ai/agent.js`, `src/ai/squad.js`, `src/ai/nav.js`, `tools/cli/playtests.mjs`, `tools/cli/cod.mjs` (nur die Header-Zeile) — sowie die Dateien der Vorgängerschicht in `src/ai/*`, `src/player/index.js`, `ARCHITECTURE.md`.

**E. Doku-Restarbeit (klein).** Der Modul-Header von `src/ai/squad.js` und die Docstrings von `pick()`/`squadmateDown()` sind aktualisiert. **Noch offen:** der `BEHAVIOUR`-Absatz im Kopf von `src/ai/agent.js` (Z. 11–15) beschreibt die Zustandsmaschine, erwähnt die Verlust-Reaktion aber nicht. Zwei Sätze ergänzen. Neue **Events** gibt es nicht, die Tabelle in `ARCHITECTURE.md` bleibt also unverändert.

**F. Danach optional, kein Blocker.** `shared-docs/projects/claude-of-duty/` anlegen ist weiterhin **nicht möglich**: das Submodule ist nicht ausgecheckt und ein `git submodule update --init` wäre ein unbeauftragter Netzwerk-Fetch. Nächster inhaltlicher Realismus-Schritt wäre eine gerichtete Reaktion auf die Peilung (die Überlebenden bekommen nur `lastKnown`, drehen sich aber nicht sichtbar dorthin).

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Nur `node tools/cli/cod.mjs …` ist erlaubt; eigene Proben unter `tools/cli/` (importieren `harness.mjs` + `play.mjs`, das ist der Node-GL-Mock) sind sicher.
- **Sandbox:** `grep`/`rg` liefern **leere** Ergebnisse → stattdessen `node -e` mit `fs.readFileSync` und `split('\n').forEach`. `timeout` existiert nicht. `nohup … &` erzeugt leere Dateien.
- **Determinismus-Falle:** Jeder neue `rng.float()`-Aufruf in einem Pfad, der im Szenario `ai` durchlaufen wird, verschiebt `travelledM` für alle sechs Agenten. Deshalb wurden in dieser Schicht **keine** RNG-Draws im Konstruktor von `Agent`/`Squad` ergänzt — nur konstante Felder. Wer dort `rng.range(...)` einfügt, zerschießt jede Referenzzahl. Kein `Math.random()` in Gameplay (ARCHITECTURE-Regel 4), keine Allokation pro Frame (Regel 5).
- **Fallstrick im Test, schon einmal reingefallen:** Ein Frame **vor** dem Kill ist das Opfer noch am Leben, steht 0 m von seiner eigenen Leiche entfernt und hält genau den Deckungspunkt, um den es geht. Die Hilfsfunktion `mates()` in `scenarioSquad` schließt es deshalb ausdrücklich über `a.id !== victims[k]?.id` aus — sonst meldet das Gate fälschlich `1/2 abandoned`.
- **Reihenfolge im Frame:** `AiSystem.update()` ruft erst `_servePathQueue()`, dann `for (const s of this.squads) s.update(dt)`, dann die Agentenschleife — `sq.strength` ist beim Lesen in `_combat` also frisch. Ein Tod mitten im Frame (Waffen-Raycast oder `_updateGrenades` nach der Schleife) berechnet `strength` in `reportDown()` selbst neu.
- **Geteilte CoverMap:** `ai.cover` ist **global über alle Squads**. Claims eines Squads verändern die Auswahl des anderen — deshalb waren die Deckungspunkte von Squad 2 im Szenario andere als in der isolierten Probe. Bei Test-Flakiness zuerst hier suchen.
- **`--at=N` bei `cod.mjs shot` ist eine FRAME-Zahl, keine Sekunden.** Der Leichen-Fade (`ai.corpseLinger = 9 s`, `corpseFade = 2.5 s`) liegt bewusst hinter allen Capture-Gates — nicht unter ~2 s senken, sonst verschwindet die Leiche im gestellten Firefight-Tableau während der Aufnahme.
- **`remainingAgents: 0` im Szenario `aideath` ist irreführend, aber kein Bug** (`engine.dispose()` läuft vor dem Rückgabeobjekt). Belastbar sind `deathEvents` und `corpseCleanedUp`.
- **Annahme (ungeprüft):** Die 5-m-Schwelle in `squadmateDown` und `DANGER_R = 6` in `nav.js` sind aus einer einzigen gemessenen Situation gewählt (Deckung 2.3 m neben der Leiche). Auf anderen Level-Seeds nicht gegengeprüft.

## 5. Wichtige Dateien & warum

- `src/ai/agent.js` — `MANDOWN_RANGE` (~Z. 90), Felder `manDownTimer` (~Z. 254), Dekrement in `update()` (~Z. 296), **`squadmateDown()`** (~Z. 378, das Herzstück), `broken`-Rückzug in `_combat` (~Z. 565), `danger`-Übergabe an `pick()` (~Z. 596), Flinch-Block (~Z. 672), **`holdingGrenade`-Fix** (~Z. 683, noch ungetestet), `die()` mit `reportDown` (~Z. 1059).
- `src/ai/squad.js` — `reportDown()` und die Verlust-Felder; `strength` wird in `update()` gecacht.
- `src/ai/nav.js` — `DANGER_R` (~Z. 448) und die Strafe in `CoverMap.pick()` (~Z. 560).
- `tools/cli/playtests.mjs` — `scenarioSquad` (Abschnitt 8) und die `SCENARIOS`-Map. **Neue Gameplay-Behauptungen gehören hierher, nicht in Prosa.**
- `tools/cli/play.mjs` — `play()` nimmt `onFrame(i, sample, drv)`; darüber wurden alle Squad-Felder pro Frame abgegriffen, ohne `aiSample()` anfassen zu müssen. Das ist der bequemste Hebel für neue Messungen.
- `tools/cli/_probe-flank.mjs` — Wegwerf-Probe, die die Flanken-Sackgasse belegt hat (Bins pro 10 s). Löschen oder für Punkt 3C weiterverwenden.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, im Loop arbeiten, keine Rückfragen.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless, das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`; eigene Proben dürfen unter `tools/cli/` liegen und `harness.mjs`/`play.mjs` importieren. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse — nutze `node -e` mit `fs.readFileSync`. Kein `git stash`, im Baum liegt fremde uncommittete Arbeit. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Stand: Alle sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sind fertig. In der letzten Schicht kam die Squad-Reaktion auf gefallene Kameraden dazu (`squadmateDown()` in `src/ai/agent.js`, `reportDown()` in `src/ai/squad.js`, `danger`-Strafe in `CoverMap.pick()` in `src/ai/nav.js`) plus ein neues Gate `ai-squad` in `tools/cli/playtests.mjs`. Zu diesem Zeitpunkt: `node tools/cli/cod.mjs play` = 10/10 PASS, `pnpm build` grün, `glslcheck --q=ultra` = 0 findings.

Deine Aufgaben in dieser Reihenfolge:

1. **Zuerst verifizieren, das ist ungetestet:** Ganz zum Schluss wurde in `_combat` (`src/ai/agent.js`, ~Z. 683) die Flanken-Bedingung `this.grenadeCooldown < 0 === false` durch `const holdingGrenade = this.hasGrenade && this.grenadeCooldown <= 0;` + `!holdingGrenade` ersetzt, danach lief kein Gate mehr. Grund war eine gemessene Sackgasse: `hasGrenade` wird nach einem Wurf nie wieder true und der Cooldown zählt nur herunter, sodass vier von sechs Männern nach 60 s bei −22 bis −46 s standen und dauerhaft nicht mehr flankieren konnten. Führe `node tools/cli/cod.mjs play` aus. **`travelledM` im Szenario `ai-movement` wird sich ändern — das ist korrekt und kein Fehler**, weil die Bedingung darüber entscheidet, ob `rng.float()` gezogen wird; entscheidend sind die Zusicherungen des Szenarios, nicht die alten Zahlen. Schreibe die neuen Werte als Referenz fest. Danach `pnpm build` und `node tools/cli/cod.mjs glslcheck --q=ultra`. Bei einem Fehlschlag ist dieser eine Edit der einzige Verdächtige.

2. Lösche die Wegwerf-Datei `tools/cli/_probe-flank.mjs`.

3. Ergänze im Modul-Header von `src/ai/agent.js` (Z. 11–15, Absatz `BEHAVIOUR`) zwei Sätze zur Verlust-Reaktion. Neue Events gibt es nicht, `ARCHITECTURE.md` bleibt unverändert.

4. Prüfe offene Frage C: Nach dem Flanken-Fix zeigte die 60-s-Probe nicht mehr Flanken als vorher, weil Männer mit unbenutzter Granate jetzt auf eine Wurfgelegenheit warten (`dist` 8–26 m, `lastKnownAge < 1.5`, `sq.requestGrenade()`). Miss mit einer eigenen Probe unter `tools/cli/`, ob diese Gelegenheit real eintritt. Falls nein, streiche den Granaten-Term aus der Flanken-Bedingung ganz — der Granaten-Zweig steht im selben Frame ohnehin direkt danach — und belege die Wirkung mit Flanken-Zählern pro 10-s-Fenster.

5. **Committe nichts ohne ausdrückliche Aufforderung des Users.** Zu dieser Arbeit gehören `src/ai/agent.js`, `src/ai/squad.js`, `src/ai/nav.js`, `tools/cli/playtests.mjs` und die Header-Zeile in `tools/cli/cod.mjs`; der Rest des `git status` ist fremd.

6. Beachte: `--at=N` bei `cod.mjs shot` ist eine Frame-Zahl, keine Sekunden. Für die Bild-Kontrolle `node tools/cli/cod.mjs shot --q=ultra --out=/tmp/cod-check2.png --w=640 --h=400 --at=90` benutzen und gegen `/tmp/cod-shot-ultra-90.png` vergleichen — **nicht** gegen `/tmp/cod-check.png`, das stammt aus einem anderen Aufruf und ist als Referenz unbrauchbar.
