# PH2 - Bitte lies die Notizen aus "Notes/spielfluss-verbessern-behebe-verbess...

> 2026-08-01T17:27:01.996Z · Grund: Zeitlimit erreicht

# Übergabe — Spielfluss-Verbesserung Claude-of-Duty (Punkt 7: Gegnerverhalten)

## 1. Mission in 2 Sätzen

Die sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sollen umgesetzt sein; Punkte 1–6 (Ducken, Strafing/Sliding, Vollbild, Browser-Tastenkonflikte, Tod bei 0 HP, HP-Regeneration) waren bereits fertig, in dieser Schicht wurde **Punkt 7 (Gegner bewegen sich / verhalten sich realistisch, inkl. Fall- und Fade-Out-Animation)** komplett abgeschlossen. Qualitätskontrolle erfolgt ausschließlich browserlos über `node tools/cli/cod.mjs` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

**Diagnose (Ursache war anders als in der letzten Übergabe vermutet):**
- Messung ergab: 4614 Pfadanfragen in 1200 Frames, davon **1849 `noRoute`** (A* lief bis zum vollen 6000-Node-Budget und fand nichts) und **2639 `deferred`** (Budget-Aushungerung).
- Eigentliche Hauptursache: Das Nav-Grid hat **789 unzusammenhängende Komponenten** — ein Straßennetz mit 29835 Zellen und 788 abgeschnittene Dächer/Vorsprünge/Tischplatten. Agenten 1 und 3 spawnten auf einer **10-Zellen-Insel**, ein Patrouillenpunkt lag darauf, und **340 von 1349 Cover-Punkten** waren unerreichbar. Das war der Grund für „Gegner stehen nur herum".

**Umgesetzt (alles gemessen, nicht geraten):**
- **`src/ai/nav.js` — Connected-Component-Labelling.** Neues `_buildRegions()` flutet mit exakt den A*-Regeln (8 Nachbarn, kein Corner-Cutting, `maxStep`). Kostet **5.5 ms einmalig beim Boot**. Neue Felder `region`, `regionSize`, `mainRegion`, neue Methode `regionAt()`. `nearest()` hat einen 6. Parameter `region` (rückwärtskompatibel — `tools/demo-driver.js:141` ruft weiter mit 5 Args). `findPath()` bricht bei verschiedenen Komponenten sofort ab, versucht aber vorher den **Start** (nie das Ziel) in die Zielkomponente umzuankern. `CoverMap`-Punkte tragen `region`; `pick()` kennt `opts.region` und `opts.exclude`.
- **`src/ai/index.js` — faire A*-Vergabe.** Neues `_pathQueue` + `queuePath()` + `_servePathQueue()`, aufgerufen am Anfang von `update()` **vor** der Agentenschleife. Vorher verbrauchten Agent 1 und 2 jeden Frame das Budget von 2, bevor Agent 4 überhaupt fragen durfte.
- **`populate()` erreichbarkeitsgefiltert:** Spawns, Anker und alle Patrouillenpunkte werden in die Komponente des Spielers gesnappt (`onRoute()`-Helfer). Fallback auf ungefilterte Liste, damit das Level nie leer bleibt.
- **`src/ai/agent.js` — Bewegungsfixes:** `_goTo` schreibt im `!grid`-Fallback jetzt einen echten Ein-Punkt-Pfad (`_setPath1`); bei `n === 0` gibt es einen Backoff (`pathFailTimer`, 0.45–0.9 s) statt Retry-Sturm; bei `n < 0` reiht sich der Agent in die Queue ein. Patrol/Alert respektieren `pathFailTimer`. Neuer **Stall-Timer** in `_move`: `desiredSpeed > 0.2` bei `speed < 0.25` für 1.4 s → Repath erzwingen.
- **Kampf-Realismus:** An der Deckung erstarrt niemand mehr — `coverPos` bleibt der stabile Anker, neues `stancePos` ist der aktuelle Standplatz, der Agent **läuft** die ~0.6 m zum Peek-Versatz (`arriveEps` 0.1). `coverHold`/`coverHoldMax` (5–9 s) zwingen zum Stellungswechsel (`exclude` beim Pick). Ducken beim Nachladen (`animator.reloading`).
- **Lokale Vermeidung repariert:** `if (want === 0) want = desiredSpeed * 0.35` war bei `desiredSpeed === 0` (Deckung) exakt 0 — zwei Soldaten in derselben Tür trennten sich nie. Jetzt `if (want < 0.9) want = 0.9`.
- **Friendly Fire abgestellt:** Neues `_friendlyInLine()` hält den Schuss, wenn ein Squadmate in der Feuerlinie steht (`t < 0.1` als Untergrenze — der gemessene Fall war ein Lauf **0.3 m** in der Brust des Kameraden, 8 Treffer / 111 Schaden). Zusätzlich in `index.js`: eigene Granaten unterdrücken weiter (Deckung suchen), verletzen die eigene Seite aber nicht mehr (gemessen: 80/49/39 Schaden durch Squadmates).
- **Leichen-Fade-Out (Punkt B der alten Übergabe):** `Agent.beginFade()` klont die Materialien **pro Leiche** (sie sind zwischen Varianten geteilt — sonst faden alle gleichzeitig), setzt `transparent`/`depthWrite:false`, lässt sie vom `render.patcher` patchen. `updateFade()` treibt `fadeOpacity` 1→0. `AiSystem.update()`: `corpseLinger = 9 s`, `corpseFade = 2.5 s`, danach `dispose()` + `splice` aus `ai.agents`. `_updateRelevance` setzt `owNoShadow` für fadende Leichen (die Cascades lesen `.opacity` nicht). Keine Allokation pro Frame.
- **Doku:** `player:death`, `player:defeat`, `player:respawn` in die Event-Tabelle in `ARCHITECTURE.md` eingetragen; `respawnFromDeath()` und die drei Events im API-Kommentarblock oben in `src/player/index.js` ergänzt; Modul-Header von `src/ai/index.js` um Reachability/Queue/Corpse-Absätze erweitert.
- **`.tmpdiag/` gelöscht** (war Wegwerf-Diagnose).

**Messergebnisse vorher → nachher:**
- Szenario `ai`: `agentsThatMoved 3/6 → 6/6`; `travelledM [27.12, 0.07, 1.05, 8.74, 11.47, 1.36] → [29.31, 28.78, 30.08, 23.13, 19.53, 32.4]`; Netto-Verschiebung 5.3–27.1 m (also echtes Gelände, kein Zittern); `finalStates` jetzt `{combat: 6}`, alle am Leben.
- Pfadanfragen 4614 → **50**, `deferred` 2639 → **1**, `noRoute` 1849 → **1**.
- Agent-Frames mit Feuerwunsch 727 → 1256.
- Szenario `aideath`: `fadeOutObserved: true`, `corpseCleanedUp: true`, `deathEvents: 1`, `bodyDroppedM: 1.51`.

**Alle Gates grün:** `node tools/cli/cod.mjs play` = **9/9 PASS**, `pnpm build` grün, `node tools/cli/cod.mjs glslcheck --q=ultra` = 0 findings / 100 Programme, ein Kontroll-Screenshot `/tmp/cod-check.png` geprüft (Szene sauber, Soldaten sichtbar). Gestellte Capture-Tableau (`debugStage('firefight')`) verifiziert: 46 Schuss in 90 Frames, nur 2 zurückgehalten, alle 5 Lebenden bei 100 HP.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. Letzte Änderung ist noch nicht verifiziert (höchste Priorität, ~3 Minuten).** Ganz zuletzt wurden zwei kosmetische Edits gemacht, danach lief **kein** Testlauf mehr:
1. In `src/ai/agent.js` wurde die tote Zeile `this.peekSide = 0;` im Nicht-Peek-Zweig von `_combat` entfernt (`peekSide` wird nirgends gelesen — nur an drei Stellen geschrieben).
2. In `src/ai/index.js` `populate()` wurde `all.filter(inRegion).length ? all.filter(inRegion) : all` zu `const reachable = all.filter(inRegion); const ranked = reachable.length ? reachable : all;` umgeschrieben.

Beide ziehen **keine** RNG-Draws und dürfen das Ergebnis nicht ändern. Trotzdem als Erstes ausführen: `node tools/cli/cod.mjs play` muss weiter **9/9** liefern und `travelledM` sollte exakt `[29.31, 28.78, 30.08, 23.13, 19.53, 32.4]` sein. Danach `pnpm build`. Falls abweichend: die beiden Edits sind die einzigen Verdächtigen.

**B. Nichts committen ohne ausdrückliche Aufforderung des Users.** Im Baum liegt fremde, uncommittete Arbeit (u. a. `index.html`, `src/core/input.js`, `src/main.js`, `src/ui/*`, `tools/cli/cod.mjs`). **Niemals `git stash`.**

**C. Optional, falls Zeit bleibt — kein Blocker, alle Gates sind grün:**
- `shared-docs/projects/claude-of-duty/` anlegen (von `AGENTS.md` als „freiwillig" beschrieben). Aktuell **nicht möglich ohne Netzwerk**: das Submodule `shared-docs` ist nicht ausgecheckt (leeres Verzeichnis, `git submodule status` zeigt `-460e5b3`). Bewusst nicht per `git submodule update --init` nachgeladen, weil das ein Netzwerk-Fetch ohne Auftrag wäre. Wenn der User es will: erst fragen bzw. explizit beauftragen lassen.
- `ai.pathsPerFrame` steht weiterhin auf 2. Das reicht jetzt reichlich (nur noch 1 deferred pro 1200 Frames) — **nicht** erhöhen, das wäre unbegründete Frame-Kosten.
- Möglicher nächster Realismus-Schritt (nicht beauftragt): Agenten reagieren noch nicht auf den Tod eines Squadmates (kein „Mann unten"-Verhalten, keine Deckungsneubewertung). Wäre eine eigenständige Erweiterung.

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Nur `node tools/cli/cod.mjs …` ist erlaubt. Fehlt eine Messung, baue sie unter `tools/cli/`.
- **Sandbox-Eigenheiten:** `grep`/`rg` liefern leere Ergebnisse → stattdessen `node -e` mit `fs.readFileSync` (Muster: rekursives `walk()` über `src`/`tools`, dann `split('\n').forEach` mit Regex — funktioniert zuverlässig). `timeout` existiert nicht. `nohup … &` erzeugt leere Dateien → Bash-Tool mit `run_in_background` nutzen.
- **`--at=90` bei `cod.mjs shot` ist eine FRAME-Zahl, keine Sekunden** (90 Frames = 1.5 s). Deshalb berührt der Leichen-Fade (`corpseLinger = 9 s`) **kein** Capture-Gate — geprüft. Wer `corpseLinger` unter ~2 s senkt, zerschießt das gestellte Firefight-Tableau, weil dessen Casualty dann während der Aufnahme verschwindet.
- **Materialien sind zwischen Agenten derselben Variante geteilt.** `beginFade()` klont deshalb pro Leiche und `dispose()` gibt **nur** die Klone frei — die Originale gehören `ai.variant()`. Wer das umbaut, löscht sonst die Materialien noch lebender Gegner.
- **`owNoShadow` ist laut `ARCHITECTURE.md` der EINZIGE Shadow-Schalter** (`castShadow` wird von den Cascades ignoriert). `_updateRelevance` schreibt das Flag jeden Frame — die Fade-Bedingung muss daher **dort** stehen, nicht in `beginFade()`. Das war ein echter Bug, der bereits behoben wurde.
- **Determinismus:** `boot({deterministic: true})` überspringt `populate()`; `engagePlay(engine, {populate: true})` in `play.mjs` ruft es manuell nach. Kein `Math.random()` in Gameplay — `ctx.rng` verwenden (ARCHITECTURE-Regel 4). Keine Allokation pro Frame (Regel 5).
- **Annahme (ungeprüft, da kein Browser):** Das transparente Fade-Material rendert im Browser korrekt sortiert. Im Node-Harness ist der GL-Mock kein Beweis dafür. `glslcheck --q=ultra` meldet 0 Findings, das ist der stärkste verfügbare Beleg.
- **`remainingAgents: 0` im Szenario `aideath` ist irreführend**, aber kein Bug: `playtests.mjs` ruft `engine.dispose()` **vor** dem Bau des Rückgabeobjekts, und `AiSystem.dispose()` leert `agents`. Die belastbaren Felder sind `deathEvents: 1` und `corpseCleanedUp`.
- `src/core/`, `src/main.js` und `tools/` gehören laut `ARCHITECTURE.md` dem Lead. In dieser Schicht wurde dort **nichts** angefasst — nur `src/ai/*`, `src/player/index.js` (Kommentarblock) und `ARCHITECTURE.md`.

## 5. Wichtige Dateien & warum

- `src/ai/nav.js` — `_buildRegions()` (~Z. 195, das Herzstück der Reparatur), `nearest()` mit `region`-Parameter (~Z. 272), `findPath()`-Early-Out (~Z. 307), `CoverMap.pick()` mit `region`/`exclude` (~Z. 528).
- `src/ai/index.js` — `_servePathQueue()`/`queuePath()` (~Z. 847), Aufruf in `update()` (~Z. 770), Leichen-Fade in `update()` (~Z. 796), `populate()` mit Region-Filter (~Z. 510), `_updateRelevance`-Shadow-Flag (~Z. 935), Explosions-Handler mit Team-Guard (~Z. 358).
- `src/ai/agent.js` — `_goTo`/`_setPath1` (~Z. 648), Stall-Timer in `_move` (~Z. 700), `_combat` mit Cover-Shuffle und `coverHold` (~Z. 505–600), `_friendlyInLine()` (~Z. 890), `beginFade`/`updateFade` (~Z. 1126), `dispose()`.
- `tools/cli/playtests.mjs` — alle 9 Szenarien und ihre Schwellwerte. Neue Gameplay-Behauptungen gehören hierher, nicht in Prosa.
- `tools/cli/play.mjs` — Input-Treiber + Sampler; `aiSample()` liest `a.fadeOpacity`, `travelled()` summiert Wegstrecke.
- `tools/cli/cod.mjs` — `cmdPlay()`, `COMMANDS`-Map, Header-Doku.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, Events in derselben Änderung dokumentieren.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless; das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse: benutze `node -e` mit `fs.readFileSync`. Kein `git stash`, im Baum liegt fremde uncommittete Arbeit. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Alle sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sind umgesetzt. Der Stand bei Schichtende: `node tools/cli/cod.mjs play` = 9/9 PASS, `pnpm build` grün, `node tools/cli/cod.mjs glslcheck --q=ultra` = 0 findings, ein Kontroll-Screenshot geprüft. Das Gegnerverhalten wurde repariert, indem das Nav-Grid Connected-Component-Labels bekam (789 Komponenten auf diesem Level — ein Drittel der Garnison spawnte auf unerreichbaren Inseln), die A*-Vergabe auf eine faire FIFO-Queue umgestellt wurde, und Agenten an der Deckung nicht mehr erstarren.

Deine Aufgaben in dieser Reihenfolge:

1. **Zuerst verifizieren**: Ganz zum Schluss der letzten Schicht wurden zwei rein kosmetische Edits gemacht, ohne danach zu testen — die tote Zeile `this.peekSide = 0;` in `_combat` (`src/ai/agent.js`) wurde entfernt, und in `populate()` (`src/ai/index.js`) wurde ein doppelter `.filter(inRegion)`-Aufruf in eine `reachable`-Variable gezogen. Beide ziehen keine RNG-Draws und dürfen nichts ändern. Führe `node tools/cli/cod.mjs play` aus: erwartet 9/9 PASS mit `travelledM: [29.31, 28.78, 30.08, 23.13, 19.53, 32.4]` und `finalStates: {"combat": 6}`. Danach `pnpm build`. Bei Abweichung sind diese beiden Edits die einzigen Verdächtigen.

2. Danach ist die beauftragte Arbeit vollständig. **Committe nichts ohne ausdrückliche Aufforderung des Users.** Wenn er committen will: nur `src/ai/nav.js`, `src/ai/index.js`, `src/ai/agent.js`, `src/ai/…`, `src/player/index.js` und `ARCHITECTURE.md` gehören zu dieser Arbeit — der Rest des `git status` ist fremd.

3. Falls der User weitere Verbesserungen will, ist der naheliegendste nächste Schritt am Gegnerverhalten: Agenten reagieren noch nicht auf den Tod eines Squadmates (kein „Mann unten"-Verhalten, keine Neubewertung der Deckung, kein Rückzug bei dezimiertem Squad). Das wäre in `src/ai/squad.js` + `_think`/`_combat` in `src/ai/agent.js` anzusiedeln, mit einem neuen Szenario in `tools/cli/playtests.mjs` als Beleg.

4. Beachte: `--at=N` bei `cod.mjs shot` ist eine Frame-Zahl, keine Sekunden. Der Leichen-Fade (`ai.corpseLinger = 9 s`, `ai.corpseFade = 2.5 s`) liegt bewusst weit hinter allen Capture-Gates — senke ihn nicht unter ~2 s, sonst verschwindet die Leiche im gestellten Firefight-Tableau während der Aufnahme.
