# AGENTS — Claude of Duty

## Zwei Pflichtregeln

1. **Im Loop arbeiten:** iterieren bis Userziel oder objektive Grenze.
2. **Keine Rückfragen:** selbst entscheiden, innerhalb des Userauftrags.

## Zuerst lesen — nicht optional

[`ARCHITECTURE.md`](ARCHITECTURE.md) ist der Engine-Vertrag und das **einzige** Koordinationsmittel zwischen
parallel arbeitenden Agenten: eigenes Verzeichnis, kein Import fremder Subsysteme, keine neuen Dependencies.
Was dort steht, schlägt jeden Tipp aus `shared-docs`.

## Projekt

Three.js r180 · WebGL2 · Playwright · Vite 7. Keine Art-Assets — alles prozedural zur Ladezeit. Subsysteme
liegen je in `src/<subsystem>/`. Befehle: `pnpm dev`, `check`, `glslcheck`, `shot` sowie die Gates
`browser:batch:gate`, `browser:viewmodel:gate`, `browser:weapon:gate`, `browser:performance:gate`. Harness
in `tools/` (`capture.mjs`, `batch-gate.mjs`, `ab.mjs`, `ab-gpu.mjs`, `baseline.mjs`, `crop.mjs` …).

## Messen und Bilder

Gilt für `tools/capture.mjs` und jedes Gate:

- **Zahlen vor Bildern.** Erst messen (Deckung, Luminanz, NDC-Position, Abstand), ein Bild nur wenn keine
  Zahl die Frage beantwortet — dann genau eines. Neun Sweep-Werte sind neun Tabellenzeilen, nicht neun PNGs.
- **Relativ vergleichen, nie in nativen Pixeln** — sonst „12 px gegen 11 px, passt", wo in Anteilen der
  Framebreite 0,60x steht. Vor jedem Ranking Rauschboden messen und prüfen, worauf das Messfenster zeigt.
- **Ein Prozess, viele Messungen.** Start und Shader-Warmup kosten das Doppelte bis Dreifache der Messung;
  Aufwärm-fps sind kein Kostenmaß — auf identischem Code 83,5 gegen 44,3.
- **Pixel aus dem Render-Target** (`readRenderTargetPixels()` aufs Post-Target), nicht `page.screenshot()`:
  das geht über den Compositor und zeigt nicht, was der Renderer erzeugt hat.
- **Software-Rendering ist ein Abbruch mit Fehlercode**, keine Warnung — Kennung über
  `WEBGL_debug_renderer_info`, Match auf `swiftshader|llvmpipe|software|warp|angle \(google`. Ursache
  hängender Rechner. Kein GPU-Flag ohne eigene Messung, `--use-angle=vulkan` ist auf NVIDIA schädlich.

## Learning-System

3D-Fachwissen über den Router [`shared-docs/THREEJS-RULES.md`](shared-docs/THREEJS-RULES.md), Arbeitsregeln
in `shared-docs/CODING-RULES.md` — Tipps sind freiwillig, eine gemessen bessere Lösung schlägt jeden. Was in
dieser Schicht Zeit gekostet hat, kommt als zwei Zeilen nach `shared-docs/projects/claude-of-duty/` (beim
ersten Learning anlegen): Fehlerbild, Ursache, Handlung — darunter der Beleg mit Zahl und Datum. Ohne Beleg
ist ein Tipp nicht widerlegbar; jede KI darf jeden gegen eine Gegenmessung stürzen, der gestürzte wird zum
neuen Tipp. Regeln `shared-docs/LEARNING-SYSTEM.md`, Submodule `git submodule update --remote shared-docs`.
