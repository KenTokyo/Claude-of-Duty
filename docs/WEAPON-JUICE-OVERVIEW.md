# Weapon Juice Overview – warum sich das Schießen so kräftig und glaubwürdig anfühlt

## Kurzantwort

Das Schießen wirkt nicht wegen eines einzelnen „Realismus-Schalters“ so stark. Bei jedem Schuss erzählen viele kleine Systeme **im selben Moment dieselbe Geschichte**:

- Der Abzug folgt einer echten Feuerrate und einem echten Magazin-/Patronenstand.
- Die Kamera steigt kontrollierbar, während die Waffe zusätzlich eigenständig zurückschlägt.
- Verschluss oder Pistolenschlitten arbeiten sichtbar, die Hülse kommt leicht verzögert aus dem Auswurffenster.
- Der Schuss ist ein fliegendes Projektil mit Geschwindigkeit, Schwerkraft und Luftwiderstand.
- Mündungsfeuer, warmes Licht, Rauch, Funken, Tracer und Einschlag reagieren passend zur Situation.
- Der Schussknall besteht aus Druckknall, Körper, Knall, Raumantwort und Mechanik statt aus einem einzelnen Sound.
- Trefferkreuz, Trefferklang, Schadenszahl und Materialeffekt bestätigen denselben Treffer sofort.

Der wichtigste „Juice“-Grundsatz lautet deshalb: **Hand, Auge, Ohr und Spielregel bekommen gleichzeitig eine passende Antwort.** Kein Layer muss das Erlebnis allein tragen.

## Der auffällige 3D-Effekt im Visier

Die Beobachtung stimmt: Beim Zielen wirkt der rote Leuchtpunkt beziehungsweise der Kreis-Punkt so, als läge er räumlich getrennt vom Zielfernrohrgehäuse – fast ein Stück weiter vorne oder „in“ der Optik. Das entsteht, weil er **nicht als flaches Bild auf das Glas oder in die Bildschirmmitte geklebt** ist.

- Das Zielfernrohr selbst besitzt echte Tiefe: äußeres Gehäuse, aufgeweiteter Tubus, dunkle Innenwand, vordere und hintere Linse, Randreflex und eine leichte Abdunklung am Glasrand. Das wird in [src/weapons/parts.js](../src/weapons/parts.js) gebaut.
- Das Glas hat ein eigenes physikalisches Material. Gerade betrachtet reflektiert es eher grünlich; schräg betrachtet wandert der Schimmer Richtung Violett/Magenta. Dadurch liest das Auge „beschichtetes Glas“ statt „Loch im Metall“. Das steckt in [src/weapons/materials.js](../src/weapons/materials.js).
- Der rote Zielpunkt ist ein **eigenes 3D-Objekt außerhalb der Waffen-Hierarchie**. Er besteht aus Kern, dunkler Kontur, engem Leuchthof und segmentiertem Außenring. Aufbau und Bewegung liegen in [src/weapons/viewmodel.js](../src/weapons/viewmodel.js).
- Seine Position wird jedes Bild neu aus der Blickrichtung, der optischen Achse und der Linsenöffnung berechnet. Wenn die Waffe schwingt, bleibt der Punkt deshalb zielorientiert und verschiebt sich relativ zum Gehäuse – genau dieser Unterschied erzeugt Parallaxe und räumliche Trennung.
- Schaut das Auge zu schräg durch den Tubus, wandert der Punkt zum Rand und blendet aus. Er kann also nicht unnatürlich außerhalb der sichtbaren Glasöffnung stehen.
- Beim vollständigen Zielen wird nicht einfach eine feste Waffenposition abgespielt. Das Rig berechnet aus Visierknoten und Augenabstand die Position, die das Visier exakt auf die Kameraachse setzt. Die Augenabstände pro Waffe stehen in [src/weapons/defs.js](../src/weapons/defs.js).
- Das normale HUD-Fadenkreuz verschwindet währenddessen schnell. Übrig bleibt wirklich der optische Leuchtpunkt der Waffe; dafür ist [src/ui/crosshair.js](../src/ui/crosshair.js) zuständig.

In Alltagsworten: **Das Rohr bewegt sich wie ein Gegenstand direkt vor dem Gesicht, der rote Punkt verhält sich eher wie eine Blickrichtung in die Ferne.** Weil beide nicht starr zusammenkleben, erkennt das Gehirn Tiefe. Technisch imitiert das einen Kollimator: Der Punkt ist nicht buchstäblich ein Objekt weit vor der Waffe, soll aber optisch so wirken, als käme seine Richtung aus großer Entfernung.

## Was bei einem einzelnen Schuss passiert

```text
Linke Maustaste
    ↓
Feuermodus, Feuerrate, Kammer und Magazin prüfen
    ↓
Projektil starten + Streuung erhöhen
    ↓
Kamera-Rückstoß + Waffen-Rückstoß + Verschlussbewegung
    ↓
Endgültige Mündungsposition bestimmen
    ↓
Mündungsfeuer + Licht + Sound + HUD-Reaktion + spätere Hülse
    ↓
Projektil fliegt in festen Physikschritten
    ↓
Material / Körperteil / Wandstärke bestimmen
    ↓
Einschlag, Durchschuss, Schaden, Trefferfeedback und Raumklang
```

Die Kette beginnt mit dem stabilen Eingabe-Schnappschuss in [src/core/input.js](../src/core/input.js). [src/core/engine.js](../src/core/engine.js) führt danach Physik, normale Updates und späte Updates in einer festen Reihenfolge aus. Dadurch kann [src/weapons/index.js](../src/weapons/index.js) zuerst den Schuss entscheiden und später – nachdem Kamera und Waffenpose fertig sind – die **wirklich aktuelle** Mündungsposition an Effekte und Audio melden. Das verhindert sichtbare Lücken zwischen Lauf und Mündungsfeuer.

Die Systeme sprechen über die gemeinsamen Ereignisse aus [ARCHITECTURE.md](../ARCHITECTURE.md):

| Ereignis | Alltagserklärung | Wer reagiert darauf? |
|---|---|---|
| `weapon:fire` | Jetzt hat die Patrone den Lauf verlassen. | Mündungsfeuer, Licht, Schussklang, Fadenkreuz |
| `weapon:shell` | Jetzt verlässt die Hülse das Auswurffenster. | Hülsenphysik und metallisches Auftreffen |
| `bullet:tracer` | Dieser Schuss bekommt eine sichtbare Leuchtspur. | Tracer-Effekt und Vorbeiflugklang |
| `bullet:impact` | Das Projektil hat eine konkrete Oberfläche getroffen oder verlassen. | Materialeffekt, Loch, Staub, Funken, Einschlagklang |
| `damage:dealt` | Ein Ziel hat tatsächlich Schaden erhalten. | Gegner, Hitmarker, Schadenszahl, Trefferklang, Killfeed |

Diese Trennung ist wichtig: Ein Mündungsblitz behauptet noch keinen Treffer. Erst die Physik erzeugt das Trefferereignis.

## Die wichtigsten Juice-Schichten

### 1. Der Abzug hat Regeln und Rhythmus

[src/weapons/index.js](../src/weapons/index.js) verwaltet Automatik-, Burst- und Einzelfeuer, sperrt zwischen zwei Schüssen nach der echten Feuerrate und unterscheidet Magazin von geladener Patrone.

- Eine M4A1 läuft mit 800 Schuss pro Minute, die MPX-9 mit 950, die Pistole mit 460.
- Ein taktischer Magazinwechsel kann die Patrone im Lager behalten; ein leer geschossenes Gewehr muss wieder zuführen.
- Der erste Schuss nach einer Pause bekommt etwas mehr körperlichen Impuls.
- Dauerfeuer erhöht die Streuung, Loslassen lässt sie wieder zusammenlaufen.
- Zielen, Stillstehen und Hocken helfen; Rennen und Springen verschlechtern die Ruhe.

Die Zahlen und Waffenunterschiede sind an einer Stelle in [src/weapons/defs.js](../src/weapons/defs.js) gebündelt. Dadurch stimmen Feuerrhythmus, Rückstoß, Streuung, Nachladezeit und Projektilgeschwindigkeit pro Waffe miteinander überein.

### 2. Kamera und Waffe schlagen nicht wie ein starres Brett zurück

Der Rückstoß ist bewusst in mehrere Bewegungen geteilt:

- **Kameraanstieg:** Eine feste, lernbare Folge gibt jedem Schuss Höhe und Seitendrift. Wer die Waffe kennt, kann gegenhalten. Erzeugt wird die Folge in [src/weapons/defs.js](../src/weapons/defs.js), angewendet in [src/weapons/index.js](../src/weapons/index.js).
- **Waffenkick:** Die sichtbare Waffe fährt auf Federachsen zurück, hoch und leicht zur Seite. Sie überschwingt und setzt sich wieder. Das passiert in [src/weapons/viewmodel.js](../src/weapons/viewmodel.js).
- **Kamerapunch:** Zusätzlich wird das Auge minimal nach hinten gedrückt und über eigene Federkanäle wieder gefangen. Dafür sorgen [src/player/camera.js](../src/player/camera.js) und die Abstimmung in [src/player/tuning.js](../src/player/tuning.js).
- **Langsames Nachsetzen:** Nach einer Salve bleibt ein kleiner Restdrift, statt dass alles maschinell auf den Ausgangspunkt schnellt.
- **ADS-Stabilisierung:** Im Anschlag bewegt sich die Waffe weniger und kehrt schneller zurück. Das fühlt sich gestützt an, ohne Rückstoß komplett zu löschen.

Das ist ein großer Teil des Gefühls: **Der Zielpunkt zeigt die spielerische Konsequenz, die sichtbare Waffe zeigt Masse und Mechanik.** Eine einzige gemeinsam bewegte Kamera könnte beides nicht überzeugend ausdrücken.

### 3. Die Waffe ist ein arbeitender Gegenstand

Die First-Person-Waffe ist kein statisches Modell:

- [src/weapons/viewmodel.js](../src/weapons/viewmodel.js) mischt Grundhaltung, Zielen, Sprint, Atmung, unregelmäßiges Schwanken, Schrittbewegung, Kamera-Nachlauf, Rückstoß und Animationen additiv zusammen.
- Beim schnellen Drehen folgt die Waffe einen Moment später, überschwingt und fängt sich. Dieses „Gewicht hinter der Kamera“ verhindert den Eindruck einer festgeklebten Bildschirmwaffe.
- Verschluss, Pistolenschlitten und Abzug bewegen sich pro Schuss separat.
- [src/weapons/clips.js](../src/weapons/clips.js) enthält die zeitlichen Stationen für Magazin heraus, Magazin fallen lassen, neues Magazin einsetzen, Ladegriff/Schlitten und Rückkehr an den Griff.
- [src/weapons/hands.js](../src/weapons/hands.js) löst Arme und Hände auf die Griffpunkte der Waffe. Beim Nachladen folgt die Stützhand wirklich dem Magazin statt nur zusammen mit der gesamten Waffe zu rotieren.
- Die Modelle in [rifle.js](../src/weapons/models/rifle.js), [smg.js](../src/weapons/models/smg.js) und [pistol.js](../src/weapons/models/pistol.js) definieren echte Mündung, Auswurffenster, Visierachse, Griffpunkte und Bewegungswege.
- Der Teilebau in [src/weapons/parts.js](../src/weapons/parts.js) orientiert sich an realen Abmessungen. [src/weapons/geometry.js](../src/weapons/geometry.js) baut dafür Kanten, Drehteile, Schienen, Schrauben und Fräsformen prozedural.

### 4. Das Geschoss muss die Entfernung wirklich überbrücken

[src/weapons/ballistics.js](../src/weapons/ballistics.js) simuliert Projektile statt sofortiger Trefferstrahlen.

- Die Gewehrkugel startet ungefähr mit 880 m/s, Pistolenmunition deutlich langsamer.
- Schwerkraft zieht das Projektil nach unten; Luftwiderstand nimmt Geschwindigkeit heraus.
- Die Simulation läuft in festen Physikschritten und prüft den gesamten Weg zwischen alter und neuer Position. So kann eine schnelle Kugel nicht zwischen zwei Bildern durch eine dünne Wand springen.
- Schaden nimmt mit Entfernung ab.
- Nur ausgewählte Schüsse bekommen einen Tracer; Dauerfeuer wird dadurch lesbar, ohne zu einer Lichtschlange zu werden.

Beim Kontakt übernimmt [src/physics/penetration.js](../src/physics/penetration.js):

- Die tatsächliche Materialdicke verbraucht Durchschlagskraft.
- Holz, Stahl, Beton, Glas, Stoff und Fleisch kosten unterschiedlich viel Energie.
- Nach einem Durchschuss kommt ein eigener Austrittseffekt mit weniger Restschaden.
- Das Projektil kann sich im Material leicht ablenken.
- Körperteile haben echte Trefferkörper; Kopf, Brust, Becken, Arme und Beine sind nicht nur eine große unsichtbare Kapsel. Die Gegnerseite dafür liegt in [src/ai/agent.js](../src/ai/agent.js).

Materialwerte und die gemeinsame Oberflächenliste stehen in [src/physics/surfaces.js](../src/physics/surfaces.js). Darum können Physik, Bild und Ton bei „Metall“ alle dieselbe Antwort wählen.

### 5. Das Mündungsfeuer ist eine kurze Ereigniskette, kein Stern-Bildchen

[src/fx/muzzle.js](../src/fx/muzzle.js) zerlegt einen Schuss in mehrere sichtbare Zeiten und Formen:

- kleiner weißheißer Kern direkt an der Laufkrone;
- ungleichmäßige orange Gaszungen, deren Form zum Mündungsgerät passt;
- kurzer Gasstrahl nach vorne;
- einzelne unverbrannte Pulverkörner;
- ein leicht verzögerter heißer Rauchstoß;
- länger ausrollender Laufrauch;
- Hitzeflimmern;
- echtes warmes Punktlicht auf Welt, Waffe und Handschuh.

Die Form wird pro Schuss variiert, bleibt aber physikalisch gerichtet: Brennende Körner fliegen aus dem Lauf heraus und nicht zufällig ins Gesicht des Spielers. Wichtig ist auch die doppelte Beleuchtung in [src/fx/index.js](../src/fx/index.js): Ein Licht beleuchtet die Welt, ein gespiegeltes Licht die separat gerenderte First-Person-Waffe. So sieht der Spieler den Schuss nicht nur als Sprite, sondern als kurze Lichtänderung auf echten Oberflächen.

[src/fx/tracers.js](../src/fx/tracers.js) baut eine sichtbare Spur aus heißem Kopf, hellem Kern und Nachglühen. [src/fx/shells.js](../src/fx/shells.js) gibt Hülsen Größe, Masse, Rotation, Kollision und Aufprall. Dadurch entsteht nach dem lauten Hauptmoment noch ein kleiner mechanischer Nachsatz.

### 6. Jeder Treffer verrät Material und Richtung

[src/fx/impacts.js](../src/fx/impacts.js) besitzt getrennte Rezepte statt eines universellen Staubballs:

- Metall wirft schnelle, flache Funken und einen kurzen harten Blitz.
- Beton hustet hellen Staub, Splitter und länger hängenden Abrieb.
- Holz erzeugt Splitter.
- Erde und Sand werfen schwerere Klumpen in Bögen.
- Glas, Stoff, Gummi und Fleisch haben eigene Antworten.

Die Partikel fliegen überwiegend in nachvollziehbaren Kegeln aus der Oberfläche. Geschwindigkeit, Schwerkraft und Widerstand unterscheiden Funken, Staub und Brocken. [src/fx/decals.js](../src/fx/decals.js) projiziert Einschusslöcher auf die wirkliche Wandgeometrie, schneidet sie an Kanten sauber ab und gibt ihnen Normalen- und Rauheitsstruktur. Das Loch liegt dadurch auf der Oberfläche, statt als flacher Fleck durch Ecken zu schmieren.

### 7. Der Schuss besteht akustisch aus vielen Entfernungen gleichzeitig

In [src/audio/weapons.js](../src/audio/weapons.js) ist ein Schuss in hörbare Aufgaben zerlegt:

- extrem schneller Anfangsklick für Sofortigkeit;
- tiefer Körper und Subbass für Druck;
- mittlerer Knall für das Kaliber;
- kurzer Rauschanteil als Kleber;
- auslaufender Raumanteil;
- verzögerter Verschluss, Rücklauf und Federgeräusch;
- bei Entfernung zusätzlich dunkler Rollknall und Bodenreflexion.

Sechs Klangvarianten plus kleine kontrollierte Abweichungen verhindern, dass Automatikfeuer wie dieselbe Audiodatei in Schleife klingt.

[src/audio/index.js](../src/audio/index.js) entscheidet aus Entfernung und Umgebung, wie diese Schichten gemischt werden. Mehrere Strahlen prüfen, ob der Spieler in einem engen Raum, auf einer Straße oder im Freien steht. Der eigene Schuss kommt ohne künstliche Schalllaufzeit direkt am Kopf an; die Umgebung antwortet danach passend.

[src/audio/spatial.js](../src/audio/spatial.js) ergänzt für fremde Geräusche:

- echte Laufzeit mit ungefähr 343 m/s;
- Links-/Rechts-/Höhenortung über HRTF;
- Höhenverlust durch Luft auf Entfernung;
- Dämpfung und dumpferen Klang hinter Wänden;
- mehr Raumanteil bei entfernten oder verdeckten Quellen.

Einschläge, Nachladephasen und Hülsen verwenden [src/audio/foley.js](../src/audio/foley.js). Damit hört ein Spieler auch nach dem Knall, **was** getroffen wurde und ob die Hülse auf Beton oder einem weicheren Untergrund landet.

### 8. Das HUD bestätigt, ohne den eigentlichen Schuss zu überdecken

- [src/ui/crosshair.js](../src/ui/crosshair.js) öffnet die Fadenkreuzarme auf einer Feder. Bewegung, Sprint, Luftstand und Schussimpuls addieren sich; beim Zielen blendet es zugunsten des echten Waffenvisiers aus.
- [src/ui/hitmarkers.js](../src/ui/hitmarkers.js) lässt den Treffer in wenigen Zehntelsekunden einschnappen, halten und verschwinden. Kopf-, Rüstungs- und Killtreffer haben eigene Farbe, Gewicht und Zeit.
- [src/ui/index.js](../src/ui/index.js) erzeugt Trefferklang, Schadenszahl, Killfeed und Zielreaktion erst auf `damage:dealt`, nicht schon beim Abfeuern.
- [src/ui/ammo.js](../src/ui/ammo.js) reagiert sichtbar auf jede abgegebene Patrone und zeigt beim Nachladen, wann das alte Magazin heraus und das neue eingesetzt ist.

Dieses Feedback ist absichtlich sehr schnell. Der reale Projektilflug darf Zeit brauchen; sobald die Physik den Treffer bestätigt, darf das Spiel den Spieler aber nicht rätseln lassen.

## Warum die Summe größer wirkt als die Einzelteile

Die stärksten Beiträge zum Erlebnis sind, grob geordnet:

1. **Zeitliche Übereinstimmung:** Rückstoß, Knall, Blitz, Verschluss und HUD beginnen am selben Schussereignis.
2. **Getrennte Bewegungen:** Kamera, Waffe, Verschluss, Hände, Leuchtpunkt und Hülse besitzen jeweils ihre eigene Trägheit.
3. **Konsequenz:** Die Kugel hat Flugzeit, trifft einen bestimmten Werkstoff und verliert durch Entfernung oder Wandstärke Energie.
4. **Räumlicher Ton:** Der Knall sitzt nicht nur „im Lautsprecher“, sondern bekommt Entfernung, Wände und Raum zurückgespiegelt.
5. **Kurze Nachgeschichte:** Rauch, Hülsen, Loch, Staub und Raumhall bleiben, nachdem der helle Hauptmoment vorbei ist.
6. **Lesbarkeit:** Tracer, Hitmarker und Schadenszahl übersetzen komplizierte Physik sofort in eine klare Spielerantwort.

Ein einzelner großer Effekt würde schnell künstlich wirken. Hier liefern viele kleine Effekte Beweise füreinander: Das Auge sieht den Verschluss, das Ohr hört ihn kurz später; die Hülse fliegt und schlägt anschließend auf; die Wand zeigt Staub, Loch und den passenden dumpfen oder metallischen Klang.

## Bewusste Tricks statt blinder Simulation

Das System ist glaubwürdig, aber kein Labor-Simulator. Einige „Unwahrheiten“ sind gerade dafür da, dass ein Bildschirm das Richtige vermittelt:

- Ein echtes Mündungsfeuer dauert nur wenige Millisekunden. Die sichtbaren Kerne leben hier ungefähr zwei bis drei Bilder, damit der Spieler sie bei jeder Bildrate wahrnimmt.
- Ein echtes 2-MOA-Leuchtpunktvisier wäre bei 1080p teilweise kleiner als ein Pixel. Der dargestellte Punkt wird deshalb lesbar vergrößert und beim Zielen betont.
- Die Physikkugel nutzt die echte hohe Mündungsgeschwindigkeit; der sichtbare Tracer wird langsamer begrenzt, damit das Auge seinen Weg überhaupt erkennt.
- Der Luftwiderstand ist ein gutmütiges lineares Spielmodell, keine vollständige Geschoss-Aerodynamik.
- Die First-Person-Waffe liegt in einer eigenen Szene mit sehr naher Kameraebene. Sie kann deshalb nicht hässlich in Wänden verschwinden; [src/core/engine.js](../src/core/engine.js) und [src/render/index.js](../src/render/index.js) setzen diese getrennte Darstellung zusammen.
- Tonprofile sind vollständig synthetisiert und auf Wahrnehmung gemischt, nicht von einer Messmikrofon-Aufnahme eins zu eins kopiert.

Das gemeinsame Muster lautet: **Die Ursache bleibt glaubwürdig, Sichtbarkeit und Timing werden für den Spieler verstärkt.** Genau diese Mischung erzeugt oft mehr gefühlten Realismus als eine physikalisch korrekte, aber auf dem Bildschirm kaum wahrnehmbare Simulation.

## Dateilandkarte

| Bereich | Zentrale Dateien | Wofür sie in einfachen Worten stehen |
|---|---|---|
| Ablauf | [src/core/input.js](../src/core/input.js), [src/core/engine.js](../src/core/engine.js), [ARCHITECTURE.md](../ARCHITECTURE.md) | Abzug einsammeln, Systeme in stabiler Reihenfolge ausführen, gemeinsame Ereignissprache |
| Schussentscheidung | [src/weapons/index.js](../src/weapons/index.js), [src/weapons/defs.js](../src/weapons/defs.js) | Darf geschossen werden, wohin, wie schnell, mit welcher Waffe und wie viel Munition? |
| Waffenbewegung | [src/weapons/viewmodel.js](../src/weapons/viewmodel.js), [src/weapons/clips.js](../src/weapons/clips.js), [src/weapons/hands.js](../src/weapons/hands.js) | Zielen, Gewicht, Rückstoß, Atmung, Hände, Verschluss und Nachladen |
| Waffenform und Visier | [src/weapons/parts.js](../src/weapons/parts.js), [src/weapons/materials.js](../src/weapons/materials.js), [src/weapons/models/rifle.js](../src/weapons/models/rifle.js) | Echte räumliche Teile, beschichtetes Glas, Leuchtpunkt und Oberflächen |
| Flug und Durchschuss | [src/weapons/ballistics.js](../src/weapons/ballistics.js), [src/physics/penetration.js](../src/physics/penetration.js), [src/physics/surfaces.js](../src/physics/surfaces.js) | Kugelflug, Schwerkraft, Wanddicke, Restenergie und Materialantwort |
| Kameragefühl | [src/player/camera.js](../src/player/camera.js), [src/player/tuning.js](../src/player/tuning.js) | Augenbewegung, Feder-Rückstoß, Punch, Atmung und FOV |
| Schussbild | [src/fx/index.js](../src/fx/index.js), [src/fx/muzzle.js](../src/fx/muzzle.js), [src/fx/tracers.js](../src/fx/tracers.js) | Mündungsfeuer, Licht, Rauch, Hitze und sichtbare Flugspur |
| Trefferbild | [src/fx/impacts.js](../src/fx/impacts.js), [src/fx/decals.js](../src/fx/decals.js), [src/fx/shells.js](../src/fx/shells.js) | Funken, Staub, Löcher, Splitter und Hülsen |
| Klang | [src/audio/index.js](../src/audio/index.js), [src/audio/weapons.js](../src/audio/weapons.js), [src/audio/spatial.js](../src/audio/spatial.js), [src/audio/foley.js](../src/audio/foley.js) | Schusskörper, Mechanik, Raum, Entfernung, Wände, Einschläge und Hülsen |
| Bestätigung | [src/ui/index.js](../src/ui/index.js), [src/ui/crosshair.js](../src/ui/crosshair.js), [src/ui/hitmarkers.js](../src/ui/hitmarkers.js), [src/ui/ammo.js](../src/ui/ammo.js) | Streuung lesen, Treffer verstehen, Munition und Nachladen verfolgen |
| Zusammensetzen des Bildes | [src/render/index.js](../src/render/index.js), [src/render/bloom.js](../src/render/bloom.js), [src/render/composite.js](../src/render/composite.js) | Welt und First-Person-Waffe sauber kombinieren, helle Kerne glühen lassen, fertiges Bild graden |

## Fazit

Das Schießen fühlt sich stark an, weil es **mechanisch, optisch, akustisch und spielerisch dieselbe Ursache fortsetzt**. Der Abzug startet keine lose Sammlung von Effekten, sondern eine abgestimmte Kette: Patrone, Rückstoß, arbeitende Waffe, Licht, Schall, Flug, Materialkontakt und Bestätigung.

Der beobachtete Visier-Effekt ist dafür ein besonders gutes Beispiel. Das Spiel behandelt Gehäuse, Glas und Zielpunkt als unterschiedliche räumliche Dinge. Diese kleine relative Bewegung liefert dem Auge mehr Tiefe als ein perfektes, aber flach aufgeklebtes Fadenkreuz – und genau solche Details machen aus „es funktioniert“ ein kräftiges Gunfeel.
