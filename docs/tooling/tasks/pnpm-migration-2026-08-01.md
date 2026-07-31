# Migration der Paketverwaltung von npm zu pnpm

## Userziel (kompakt)
- Projekt vollständig von npm auf pnpm umstellen.
- pnpm als eindeutigen Paketmanager festlegen.
- Installations- und Build-Befehle in der Projektdokumentation vereinheitlichen.

## Lösungsentscheidung
1. **Gewählt:** Bestehende npm-Lockdatei mit `pnpm import` übernehmen. Dadurch bleiben aufgelöste Versionen möglichst stabil.
2. **Verworfen:** Neue `pnpm-lock.yaml` nur über `pnpm install --lockfile-only` erzeugen. Das könnte Abhängigkeiten innerhalb ihrer Versionsbereiche unbeabsichtigt aktualisieren.
3. **Verworfen:** Lockdatei manuell konvertieren. Fehleranfällig und unnötig, weil pnpm einen Importweg bereitstellt.

## Phasen

### ✅ Phase 1 — Bestand und Migrationsweg prüfen
**Ziel:** Alle npm-bezogenen Projektstellen und der kleinste stabile Migrationsweg sind bekannt.
- [x] `package.json` und `package-lock.json` geprüft.
- [x] Dokumentation und Tooling nach npm-/npx-Verweisen durchsucht.
- [x] Installierte Node-, npm-, pnpm- und Corepack-Versionen geprüft.
**Ergebnis:** Die Migration betrifft Paketmetadaten, Lockdatei, README und zwei Tooling-Anweisungen.
**Warum:** Vollständige Suche verhindert gemischte npm-/pnpm-Befehle.
**Eingehalten:** Keine UI- oder Browserprüfung, keine unnötige Architekturänderung, bestehende Versionsauflösung bleibt erhalten.
**Architektur passt:** pnpm ersetzt nur die Paketverwaltung; Laufzeitcode und Vite-Aufbau bleiben unverändert.
**Auffälligkeiten/Performance/Kritische Findings:** Lokale `CLAUDE.md` und `shared-docs/CODING-RULES.md` fehlen im Projekt; globale Fallback-Regeln und die verfügbare kanonische Coding-Rules-Datei wurden gelesen.
**Referenzen:**
- `package.json`
- `package-lock.json`
- `README.md`

### ✅ Phase 2 — pnpm als Paketmanager etablieren
**Ziel:** Das Repository besitzt nur noch eine pnpm-Lockdatei und eine eindeutige Paketmanager-Deklaration.
- [x] Exakte pnpm-Version in `package.json` hinterlegt (`pnpm@10.33.0`).
- [x] Bestehende Auflösungen mit `pnpm import` in `pnpm-lock.yaml` übernommen.
- [x] Veraltete `package-lock.json` entfernt.
**Ergebnis:** Installationen laufen reproduzierbar über pnpm.
**Warum:** Zwei konkurrierende Lockdateien können lokal und in CI unterschiedliche Abhängigkeitsbäume erzeugen.
**Eingehalten:** Single Source of Truth, minimale Änderung, keine Abhängigkeitsaktualisierung als Nebeneffekt.
**Architektur passt:** `packageManager` und `pnpm-lock.yaml` sind die üblichen Einstiegspunkte eines einzelnen pnpm-Projekts.
**Auffälligkeiten/Performance/Kritische Findings:** Keine bekannt.
**Referenzen:**
- `package.json`
- `pnpm-lock.yaml`
- `package-lock.json`

### ⏳ Phase 3 — Befehle vereinheitlichen und Installation prüfen
**Ziel:** Nutzer und interne Tooling-Anweisungen verwenden ausschließlich pnpm; die Lockdatei ist installierbar.
- [ ] README-Startbefehle auf pnpm umstellen.
- [ ] `npx vite build` in Tooling-Anweisungen durch das vorhandene pnpm-Build-Script ersetzen.
- [ ] Suche nach verbliebenen aktiven npm-/npx-Verweisen wiederholen.
- [ ] Installation mit eingefrorener pnpm-Lockdatei prüfen.
- [ ] Abschlussabgleich gegen alle Userziele durchführen.
**Ergebnis:** Setup und Tooling sind konsistent auf pnpm ausgerichtet.
**Warum:** Eine neue Lockdatei allein verhindert keine veralteten npm-Abläufe in Doku und Arbeitsanweisungen.
**Eingehalten:** Keine Tests, kein Dev-Server, keine UI-Prüfung, UTF-8.
**Architektur passt:** Bestehende Scripts bleiben die Befehlsquelle; Dokumentation ruft sie nur über pnpm auf.
**Auffälligkeiten/Performance/Kritische Findings:** Keine bekannt.
**Referenzen:**
- `README.md`
- `tools/workflows/perf.js`
- `pnpm-lock.yaml`

## Kommentare

### Phase 1
**Eingehalten:** Bestand vollständig gesucht ✅, Alternativen bewertet ✅, keine unnötige Laufzeitänderung ✅
**Auffälligkeiten (nach Schwere):**
1. 🟡 **Hinweis:** Projektlokale Regeldateien fehlen; verfügbare globale und kanonische Fallbacks verwendet.

### Phase 2
**Eingehalten:** Single Source of Truth ✅, aufgelöste Paketversionen beibehalten ✅, pnpm exakt deklariert ✅
**Auffälligkeiten (nach Schwere):** Keine.

## Arbeitsprotokoll (append-only)

### Phase 1 — Status success
**Dateien:** `package.json`, `package-lock.json`, `README.md`, `tools/workflows/perf.js` — Paketmanager-Bestand und Befehlsverweise geprüft.
**Entscheidungen:** `pnpm import` statt Neuauflösung gewählt, damit der Abhängigkeitswechsel keinen versteckten Versionswechsel auslöst.
**Unsicher / Risiko:** Kein CI-Workflow vorhanden; deshalb ist dort keine Anpassung nötig.

### Phase 2 — Status success
**Dateien:** `package.json` — pnpm-Version deklariert; `pnpm-lock.yaml` — aus npm-Lockdaten erzeugt; `package-lock.json` — entfernt.
**Entscheidungen:** pnpm 10.33.0 exakt gepinnt; npm-Lockdatei nach erfolgreichem Import gelöscht, damit nur eine Lockdatei maßgeblich bleibt.
**Unsicher / Risiko:** Keine; direkte Abhängigkeiten blieben auf `three@0.180.0`, `playwright@1.61.1`, `pngjs@7.0.0` und `vite@7.3.6`.

## Offene Fix-Punkte (aktuell)
- [ ] npm-Lockdatei und aktive npm-/npx-Befehle vollständig entfernen.
