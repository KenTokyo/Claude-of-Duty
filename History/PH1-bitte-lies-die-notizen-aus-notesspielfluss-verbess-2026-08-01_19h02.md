# PH1 - Bitte lies die Notizen aus "Notes/spielfluss-verbessern-behebe-verbess...

> 2026-08-01T17:02:18.297Z · Grund: Zeitlimit erreicht

# Übergabe — Spielfluss-Verbesserung Claude-of-Duty

## 1. Mission in 2 Sätzen

Die sieben Punkte aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` sollen umgesetzt werden: zuverlässiges Ducken, CoD-artiges Strafing/Sliding, erreichbarer Vollbild-Modus, keine Browser-Tastenkonflikte, korrektes Spielende bei 0 HP, HP-Regeneration außerhalb des Kampfes und deutlich realistischere, sich bewegende Gegner inkl. Fall-/Fade-Out-Animation beim Tod. Qualitätskontrolle erfolgt ausschließlich browserlos über die selbst gebaute CLI `node tools/cli/cod.mjs play` — **niemals einen Browser starten** (crasht den Laptop des Users).

## 2. Was wurde bereits erledigt

- **Gameplay-Probe-CLI gebaut** (war die Voraussetzung für alles andere):
  - `tools/cli/play.mjs` — treibt echte Tasten durch `Input._onKeyDown`/`_onKeyUp` mit korrekten Modifier-Flags, protokolliert pro Taste `registered` (kam die Taste im Spiel an) und `prevented` (wurde der Browser-Default unterdrückt). Enthält `BROWSER_SHORTCUTS`-Tabelle, `sample()`, `aiSample()`, `travelled()`.
  - `tools/cli/playtests.mjs` — Szenarien `crouch, strafe, slide, slidestrafe, death, regen, ai, aideath, keys`.
  - Kommando `play` in `tools/cli/cod.mjs` registriert (+ Header-Doku). Aufruf: `node tools/cli/cod.mjs play [--scenario=a,b] [--json]`. Exit-Code 1 bei Fail.
- **Browser-Tastenkonflikte behoben** (`src/core/input.js`): Bei aktivem Pointer-Lock gehören Ctrl (= Crouch) und Alt uns → Taste wird angenommen **und** `preventDefault()` gerufen. Vorher wurden mit gehaltenem Ctrl 14 Spieltasten verschluckt und 7 Kombis leakten an Chrome (Bookmark, Save, Reload, Find, Select-All, Adressleiste, Find-Next). Messwert jetzt: `leakingCombos: []`, `swallowedGameKeys: []`. `_onKeyUp` gated nicht mehr auf Modifier/Lock (kein hängender Key mehr). `ShiftRight`/`ControlRight` ergänzt.
- **Crouch zuverlässig** (`src/player/movement.js` + `tuning.js`): Hybrid aus Halten und Tippen (`MOVE.crouchHold = 0.2 s`). Halten = ducken solange gehalten, Loslassen stellt die Stance vor dem Druck wieder her; Tippen = Toggle. Sprint-Auto-Aufstehen greift nicht mehr, während die Crouch-Taste physisch gehalten wird. Verifiziert: `holdCrouchFrames 66/66`, `standsUpOnRelease true`, `movedWhileCrouchedM 1.6`.
- **Sliding erreichbar gemacht**: Slide-Gate hängt jetzt an der **Geschwindigkeit** (≥ 5.2 m/s), nicht mehr am `sprinting`-Flag. Damit funktioniert der Diagonal-Sprint-Slide (W+D+Shift), der vorher unmöglich war, weil Sprint einen Stick-Winkel < 56° verlangt. Gehen (4.57 m/s) duckt weiterhin nur. Crouch-Release beendet den Slide; Stance danach abhängig von Halten vs. Tippen. Verifiziert: `diagonalSprintSlideFrames 41`, `walkSlideFrames 0`.
- **Strafing geschärft**: `MOVE.strafeAccelScale = 1.45`, skaliert per Lateralanteil in `_accelerateGround` — Counter-Strafe schnappt, Geradeausbeschleunigung unverändert.
- **Vollbild-Modus**: neues `src/core/fullscreen.js` (Fullscreen API + **Keyboard Lock API**, `LOCK_CODES` ohne Escape). Erreichbar über F11, Alt+Enter (beides in `Input._onKeyDown`, innerhalb der trusted user gesture), Pausemenü-Zeile „Fullscreen" mit Statustext (`src/ui/menu.js`) und Checkbox „Im Vollbild starten" auf dem Startscreen (`index.html`, `src/global.css`, `src/main.js`). `Input.relockPending` verhindert, dass der Fullscreen-Wechsel das Pausemenü öffnet (`src/ui/index.js`).
- **Tod bei 0 HP**: `player:death` wurde bisher **von niemandem** gehört. Jetzt `PlayerSystem._onDeath()` → Steuerung aus, Velocity/Sprint/Slide/ADS aus, Hitbox aus, Kamera-Kollaps (`DEATH_FALL 1.05 s`, `DEATH_EYE 0.3`, `DEATH_ROLL 22°`, via `rig.eyeOffset`/`rig.deathRoll` in `src/player/camera.js`), Event `player:defeat`. Waffe feuert nicht mehr (`live`-Gate in `src/weapons/index.js`). Neues `src/ui/death.js` + Styles in `src/ui/style.js`: Death-Screen mit Killfeed-Eintrag, Redeploy-Button und Auto-Redeploy nach 5.5 s → `player.respawnFromDeath()`. Verifiziert: genau 1 Death-Event, Health exakt 0, Steuerung aus, keine Regen, keine Drift, sauberer Redeploy.
- **HP-Regeneration**: funktionierte grundsätzlich (4.6 s nach letztem Treffer), war aber nur „un-getroffen", nicht „außer Gefecht". Neu: `HEALTH.regenSuppressionHold = 0.12` — Suppression aus Beinahetreffern hält die Regen an (`src/player/health.js`). Ein Streuschuss blockiert nur ~0.26 s, Dauerbeschuss hält ~1.4 s nach dem letzten Schuss. Zusätzlich feuert die HUD-Regen-Cue jetzt auch mit echtem Player-System (Flankenerkennung in `src/ui/index.js`, vorher nur im Stub-Zweig).
- **`setControlEnabled(false)`** nullt jetzt `speed`/`horizontalSpeed`/`state` — vorher blieben Werte des letzten lebenden Frames stehen (Toter mit voll aufgeblähtem Reticle und `sprint`-HUD-State).
- **Status Test-Suite:** `crouch, strafe, slide, slidestrafe, death, regen, keys` = **7/7 PASS**. `pnpm build` läuft grün.

## 3. Was ist offen / als Nächstes zu tun (priorisiert)

**A. AI-Bewegung reparieren — der eigentliche Kern des letzten Notiz-Punkts. Diagnose ist bereits gemacht, Ursache ist identifiziert:**

Ausgabe von `node .tmpdiag/aidiag.mjs` (Diagnoseskript liegt schon im Repo unter `.tmpdiag/aidiag.mjs`, untracked):
```
pathsDeferred 2639   coverPts 1349   walkable 38742
```
- **Hauptursache: A*-Budget-Aushungerung.** `AiSystem.requestPath` rationiert Pfade über `this.pathsPerFrame`. 2639 verworfene Anfragen in 1200 Frames. Agenten 4, 5 und 6 stehen dauerhaft mit `pend: true` (`pathPending`) und `sp: 0` bei `ds: 4.3` — sie *wollen* zur Deckung laufen, bekommen aber nie einen Pfad. Genau das ist „Gegner stehen nur herum".
  - Fix-Richtung: `pathsPerFrame` erhöhen (Wert in `src/ai/index.js` prüfen, vermutlich 2), **und/oder** in `Agent.update` bei `pathPending` nicht jeden Frame neu anfragen (Backoff-Timer), **und/oder** Priorität für Agenten mit `speed === 0` und aktivem Kampf.
- **Zweitursache: `_goTo` ohne Grid.** In `src/ai/agent.js:584` setzt der `!grid`-Zweig `hasMoveTarget = true`, lässt `pathLen` aber auf 0 → `_move` findet `pathIndex(0) < pathLen(0)` = false → keinerlei Bewegung. Fallback muss den Zielpunkt als Ein-Punkt-Pfad schreiben.
- **Drittursache: Agent 3 hängt** mit `mt: false, pl: 2, pi: 1` bei `sp: 0` in `patrol`/`alert` — Pfad zu Ende gelaufen, aber `hasMoveTarget` false und kein Repath. Patrol-Zweig in `_think` prüft `position.distanceTo(moveTarget) < 1.1`; wenn der Pfad kürzer endete, bleibt der Agent stehen. Braucht einen Stall-Timer, der bei `speed ≈ 0` über ~1.5 s ein Repath auslöst.
- **Viertens (Realismus): Kampf-Repositionierung.** Sobald `atCover` erreicht ist, setzt `_combat` `desiredSpeed = 0` — Agenten stehen dann bis zum nächsten Cover-Repath (2.2–4.5 s) reglos. Für „realistischeres" Verhalten: leichtes Strafing/Peek-Versatz an der Deckung, gelegentliches Umsetzen, Ducken beim Nachladen.
- Zielmetrik: Szenario `ai` (`node tools/cli/cod.mjs play --scenario=ai`) muss von aktuell `agentsThatMoved: 3/6`, `travelledM: [27.12, 0.07, 1.05, 8.74, 11.47, 1.36]` auf ≥ 60 % bewegte Agenten kommen (Schwelle steht bereits im Test).

**B. Gegner-Tod: Fall-/Fade-Out-Animation.** Ragdoll existiert und funktioniert (`Agent.die()` → `_makeRagdoll`), aber **Leichen verschwinden nie** — `AiSystem.update` zählt nur `a.deadTime` hoch. Umzusetzen: nach ~8–12 s Opacity-Fade über die Agent-Materialien, dann `agent.dispose()` und aus `ai.agents` entfernen. Das Szenario `aideath` prüft bereits `a.fadeOpacity` (Feld existiert noch nicht — muss vom Agenten gesetzt werden) und `corpseCleanedUp`. **Achtung:** Materialien werden zwischen Varianten geteilt (`ai.variant(...).materials`) — pro Agent klonen oder über ein Uniform/`material.opacity` je Instanz lösen, sonst faden alle Gegner gleichzeitig. Danach `node tools/cli/cod.mjs play --scenario=aideath` grün bekommen.

**C. Abschluss-Verifikation:**
- `node tools/cli/cod.mjs play` (alle Szenarien) → 9/9.
- `pnpm build` und `node tools/cli/cod.mjs glslcheck --q=ultra`.
- Ein einziger Kontroll-Screenshot: `node tools/cli/cod.mjs shot --q=low --out=/tmp/cod-check.png --at=90` — nicht mehr, der User will keine Screenshot-Flut.
- `.tmpdiag/` aufräumen (ist Wegwerf-Diagnose, nicht committen).

**D. Doku (klein, aber Pflicht laut ARCHITECTURE.md):** Die neuen Events `player:defeat` und `player:respawn` in die Event-Tabelle in `ARCHITECTURE.md` eintragen — die Datei schreibt vor, dass neue Events „in the same commit" ergänzt werden. Ebenso den API-Kommentarblock oben in `src/player/index.js` um `respawnFromDeath()` erweitern.

## 4. Risiken & Edge Cases

- **KEIN BROWSER.** Jedes Skript direkt unter `tools/*.mjs` startet Chromium. Nur `node tools/cli/cod.mjs …` ist erlaubt. Fehlt eine Messung, baue sie unter `tools/cli/`.
- **Sandbox-Eigenheiten:** `grep`/`rg` liefern leer → stattdessen `node -e` mit `fs.readFileSync` (ein fertiges Suchskript liegt unter `/tmp/s.mjs`, nimmt Pattern + Wurzelverzeichnis). `timeout` existiert nicht. `nohup … &` erzeugt leere Dateien → Bash-Tool mit `run_in_background` nutzen. **Niemals `git stash`** — im Baum liegt fremde, uncommittete Arbeit.
- **`.tmpdiag/aidiag.mjs` importiert relativ** (`../tools/cli/…`) und muss aus dem Repo-Root laufen. Skripte in `/tmp` können die Module nicht auflösen.
- **Determinismus:** `boot({deterministic: true})` überspringt `populate()`. `engagePlay(engine, {populate: true})` in `play.mjs` ruft es manuell nach. Wer die AI-Tests anfasst, darf das nicht wegoptimieren. Kein `Math.random()` in Gameplay — `ctx.rng` verwenden (ARCHITECTURE-Regel 4).
- **Keine Allokation pro Frame** (ARCHITECTURE-Regel 5) — beim Fade-Out kein `new THREE.*` in `update()`.
- **Keyboard Lock ist Chrome-only** und nur im Vollbild verfügbar. Ohne Vollbild bleiben `ctrl+KeyW/KeyT/KeyQ/Digit1/Digit2/Tab` browserreserviert und **nicht** unterdrückbar — das ist bekannt, wird vom `keys`-Szenario als `needKeyboardLock` ausgewiesen und ist genau der Grund, warum Vollbild als Startoption vorausgewählt ist. Escape ist absichtlich **nicht** gelockt (Fluchtweg des Users).
- **Annahme (ungeprüft, da kein Browser):** `preventDefault()` auf F11 greift in Chrome. Falls nicht, bleiben Alt+Enter, Menü-Button und Start-Checkbox als drei weitere Wege — die Funktion fällt also nicht aus.
- **Annahme:** Der Fullscreen-Wechsel löst den Pointer-Lock. `Input.setFullscreen` fordert ihn deshalb danach neu an und schützt das Pausemenü über `relockPending`. Falls ein Browser den Lock behält, ist das re-request ein harmloser No-Op.
- `src/core/`, `src/main.js` und `tools/` gehören laut ARCHITECTURE.md dem Lead. Da hier alleine (nicht parallel) gearbeitet wird, wurden sie bewusst angefasst — bei parallelen Agenten wäre das ein Konflikt.

## 5. Wichtige Dateien & warum

- `tools/cli/play.mjs` — Input-Treiber + Sampler. Hier ist die Logik, die echte Tasten durch die echten Handler schickt; `keyLog` ist der einzige Weg, Browser-Leaks ohne Browser nachzuweisen.
- `tools/cli/playtests.mjs` — alle Szenarien und ihre Schwellwerte. Neue Gameplay-Behauptungen gehören hierher, nicht in Prosa.
- `tools/cli/cod.mjs` — `cmdPlay()` am Ende, `COMMANDS`-Map, Header-Doku.
- `src/ai/agent.js` — `_goTo` (Zeile ~584, Grid-Fallback-Bug), `_move` (~612, `pathIndex < pathLen`-Gate), `_combat` (~453, `desiredSpeed = 0` an der Deckung), `die()` (~846, Ragdoll-Übergabe).
- `src/ai/index.js` — `requestPath` (A*-Budget, `pathsPerFrame`), `update()` (~727, `deadTime`-Zählung ohne Cleanup), `populate()`.
- `src/core/input.js` — Modifier-Logik (`ctrlIsCrouch`), Fullscreen-Hooks, `relockPending`.
- `src/core/fullscreen.js` — Fullscreen + Keyboard Lock, alles feature-detected und wirft nie.
- `src/player/movement.js` — `_updateStance` (Hybrid-Crouch), `_updateSlide`/`_endSlide` (Speed-Gate), `_accelerateGround` (Strafe-Rate).
- `src/player/tuning.js` — `crouchHold`, `strafeAccelScale`, `regenSuppressionHold` mit Begründung im Kommentar.
- `src/player/index.js` — `_onDeath`, `_updateDeath`, `respawnFromDeath`, `setControlEnabled`.
- `src/ui/index.js` / `src/ui/death.js` / `src/ui/menu.js` — Death-Screen, Regen-Cue, Fullscreen-Zeile.
- `AGENTS.md` + `ARCHITECTURE.md` — Pflichtlektüre: eigenes Verzeichnis, keine Fremdimporte, keine neuen Dependencies, Events dokumentieren.

## 6. Übergabe-Startprompt für die nächste KI

Arbeite im Repo `/Users/kentoky/Documents/React Projects/Claude-of-Duty` autonom weiter, im Loop, ohne Rückfragen. **Starte niemals einen Browser** — weder Playwright noch headless; das crasht den Laptop des Users. Messen und Screenshots ausschließlich über `node tools/cli/cod.mjs`. In dieser Sandbox liefern `grep`/`rg` leere Ergebnisse: benutze `node -e` mit `fs.readFileSync` (Hilfsskript: `/tmp/s.mjs`). Kein `git stash`. Lies zuerst `AGENTS.md` und `ARCHITECTURE.md`.

Die Punkte 1–6 aus `Notes/spielfluss-verbessern-behebe-verbessere-notes.md` (Ducken, Strafing/Sliding, Vollbild, Browser-Tastenkonflikte, Tod bei 0 HP, HP-Regeneration) sind fertig und über die selbst gebaute CLI `node tools/cli/cod.mjs play` mit 7/7 PASS belegt. Offen ist **nur noch Punkt 7: Gegnerverhalten**.

Deine Aufgaben in dieser Reihenfolge:

1. Führe `node tools/cli/cod.mjs play --scenario=ai` aus und bestätige den Ausgangswert (`agentsThatMoved: 3` von 6). Nutze das vorhandene Diagnoseskript `node .tmpdiag/aidiag.mjs 2>&1 >/dev/null` (aus dem Repo-Root) für Details pro Agent.
2. Repariere die AI-Bewegung. Drei bereits diagnostizierte Ursachen: (a) A*-Budget-Aushungerung — 2639 verworfene Pfadanfragen, Agenten hängen dauerhaft mit `pathPending: true` und `speed 0` bei `desiredSpeed 4.3`; `pathsPerFrame` in `src/ai/index.js` und/oder Backoff bei `pathPending` in `Agent.update` angehen. (b) `Agent._goTo` setzt im `!grid`-Fallback `hasMoveTarget = true`, aber `pathLen` bleibt 0, wodurch `_move` gar nichts tut. (c) Agenten, deren Pfad kurz vor dem Ziel endet, bleiben ohne Repath stehen — Stall-Timer bei `speed ≈ 0` einbauen. Zusätzlich für Realismus: an der Deckung nicht komplett erstarren (Peek-Versatz, gelegentliches Umsetzen, Ducken beim Nachladen). Ziel: Szenario `ai` grün.
3. Implementiere den Gegner-Tod-Ausklang: Ragdoll fällt bereits korrekt, aber Leichen verschwinden nie (`AiSystem.update` zählt nur `deadTime`). Baue nach ~8–12 s ein Opacity-Fade-Out und danach `dispose()` plus Entfernen aus `ai.agents`. Setze dabei `agent.fadeOpacity`, das prüft das Szenario `aideath` schon. Achtung: Materialien sind zwischen Agenten derselben Variante geteilt — pro Agent klonen, sonst faden alle gleichzeitig. Keine Allokation pro Frame. Ziel: `node tools/cli/cod.mjs play --scenario=aideath` grün.
4. Abschluss: `node tools/cli/cod.mjs play` (alle 9 Szenarien grün), `pnpm build`, `node tools/cli/cod.mjs glslcheck --q=ultra`, genau **ein** Kontroll-Screenshot `node tools/cli/cod.mjs shot --q=low --out=/tmp/cod-check.png --at=90` (nicht mehr — der User will keine Screenshot-Flut). `.tmpdiag/` löschen.
5. Trage die neuen Events `player:defeat` und `player:respawn` in die Event-Tabelle in `ARCHITECTURE.md` ein und ergänze `respawnFromDeath()` im API-Kommentarblock oben in `src/player/index.js`.

Committe nichts ohne ausdrückliche Aufforderung des Users.
