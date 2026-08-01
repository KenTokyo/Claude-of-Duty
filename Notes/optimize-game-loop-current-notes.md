# optimize game loop current

*01/08/2026, 02:44:31*

---

**You (Draft):**
Optimize the game in loop

The current Three.js shooter is visually impressive but nearly unplayable because of severe performance problems. Optimize the complete game so that it runs smoothly and consistently, including on Ultra settings, while preserving its current AAA-like appearance, gameplay and atmosphere.

First inspect and profile the actual game to identify the largest CPU, GPU, memory and rendering bottlenecks. Then optimize everything necessary, including instancing, LOD systems, frustum and distance culling, shadow rendering, shared materials and geometries, object pooling, particle limits, collision checks, enemy updates, post-processing, React rerenders and allocations inside the render loop.

Do not simply remove most of the environment, lighting, enemies, effects or visual detail. Preserve the quality while rebuilding expensive systems more efficiently. Ultra settings should represent the highest optimized quality, not unlimited rendering cost. Repeated shooting, explosions, enemy combat and prolonged gameplay must not cause increasing lag or memory usage.

Complete the full optimization first. Only afterward, fan out separate testing agents that did not implement the changes. Have them harshly test movement, shooting, every weapon, all enemies, dense areas, explosions, shadows, Ultra settings and prolonged combat.

One agent should focus entirely on performance and another on visual quality and gameplay regressions. If they find major frame drops, memory leaks, unnecessary draw calls, broken mechanics or noticeable visual degradation, fix the issues and repeat the final tests.

The finished shooter should retain its AAA-like presentation while running smoothly and feeling like a polished game rather than an overloaded browser demo.

Use custom CLI System for screenshots or to measure performance, do not use a headless browser to avoid performance issues