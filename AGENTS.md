# AGENTS — Claude of Duty

## Drei Pflichtregeln

1. **Im Loop arbeiten:** iterieren bis Userziel oder objektive Grenze.
2. **Keine Rückfragen:** innerhalb des Userauftrags selbst entscheiden.
3. **Committen und pushen:** jede kompilierfähige Einheit sofort und ungefragt; Fehler selbst beheben.

**Vor jeder Arbeit vollständig lesen:** [`ARCHITECTURE.md`](ARCHITECTURE.md) als Engine-Vertrag und
[`shared-docs/CODING-RULES.md`](shared-docs/CODING-RULES.md) als gemeinsame Orchestrierung. Der lokale
Architekturvertrag hat bei Widersprüchen Vorrang.

## Projekt

Three.js r180 · WebGL2 · Playwright · Vite 7. Keine Art-Assets; alles wird prozedural geladen. Subsysteme
liegen in `src/<subsystem>/`: eigenes Verzeichnis, kein Import fremder Subsysteme, keine neuen Dependencies.
Befehle: `pnpm dev`, `check`, `glslcheck`, `shot`; relevante Gates: `browser:batch:gate`,
`browser:viewmodel:gate`, `browser:weapon:gate`, `browser:performance:gate`. Harness in `tools/`.

- Für 3D-Facharbeit über [`shared-docs/THREEJS-RULES.md`](shared-docs/THREEJS-RULES.md) routen. Visuelle
  Prüfungen nur über den CLI-Harness und [`shared-docs/SCREENSHOT-GUIDE.md`](shared-docs/SCREENSHOT-GUIDE.md).

## Lieferung und Wissen

- Zielbranch ist **`main`**. Ein Subsystem pro Commit; passende statische und Browser-Gates gehören zur
  kompilierfähigen Einheit.
- Shared-Docs-Änderungen zuerst in `shared-docs/` committen und pushen, danach nur den Pointer im Hauptrepo.
  Aktualisieren: `git submodule update --remote shared-docs`.
- Projekttipps liegen bei Bedarf unter `shared-docs/projects/claude-of-duty/`. Genau eine passende Tippdatei
  lesen; neue belegte Learnings nach [`shared-docs/LEARNING-SYSTEM.md`](shared-docs/LEARNING-SYSTEM.md) zurückgeben.
