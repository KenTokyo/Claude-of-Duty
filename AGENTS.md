# AGENTS — Claude of Duty

## Zwei Pflichtregeln

1. **Im Loop arbeiten:** KI muss iterieren — bis Userziel oder objektive Grenze
2. **Keine Rückfragen:** KI muss selbst entscheiden — innerhalb Userauftrag

## Zuerst lesen — nicht optional

[`ARCHITECTURE.md`](ARCHITECTURE.md) ist der Engine-Vertrag und das **einzige** Koordinationsmittel zwischen
parallel arbeitenden Agenten: eigenes Verzeichnis, kein Import fremder Subsysteme, keine neuen Dependencies.
Was dort steht, schlägt jeden Tipp aus `shared-docs`.

## Learning-System (shared-docs)

Freiwillige Tipps, die Fehler **vor** dem Output verhindern sollen. Eine gemessen bessere Lösung
überschreibt den Tipp — genau dafür ist er da.

- **Vor 3D-Arbeit:** den passenden Fachowner aus dem [Three.js-Router](shared-docs/THREEJS-RULES.md);
  Sweeps, Rankings und Kostenzahlen über [Messhandwerk](shared-docs/threejs/MEASURING.md).
- **Vor Capture- und Gate-Arbeit** (`tools/capture.mjs`, `batch:gate`, `viewmodel:gate`, `weapon:gate`,
  `performance:gate`): [Debug und Review](shared-docs/threejs/DEBUG-REVIEW.md) und
  [SCREENSHOT-GUIDE.md](shared-docs/SCREENSHOT-GUIDE.md).
- **Projekt-Learnings:** `shared-docs/projects/claude-of-duty/` — noch nicht angelegt, beim ersten Learning
  anlegen. Vorlage: [voxel-samurai-quiz](shared-docs/projects/voxel-samurai-quiz/README.md).
- **Nach der Schicht:** was Zeit gekostet hat, in zwei Zeilen mit Beleg zurückschreiben. Format,
  Änderungsrecht und Promotion: [LEARNING-SYSTEM.md](shared-docs/LEARNING-SYSTEM.md).
- **Submodule aktuell halten:** `git submodule update --remote shared-docs`

## Optionale Orientierung

- **Status:** ausschließlich optional; bessere Lösung → Vorrang
- **Lokaler Owner:** Three.js r180 + WebGL2, keine Art-Assets — alles prozedural zur Ladezeit
- **Projektlokal:** [`ARCHITECTURE.md`](ARCHITECTURE.md); `docs/`; `prompt.md`; `src/<subsystem>/`
- **Coding:** [Coding Rules](shared-docs/CODING-RULES.md)
- **Echtzeit-3D:** [Three.js-Router](shared-docs/THREEJS-RULES.md)
