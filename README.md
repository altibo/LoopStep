# LoopStep – Looper ohne dritte Hand

Gitarren-Looper als Web-App (PWA) fürs Handy, gedacht für Android mit eingebautem Mikrofon. Holz-Look, große Anzeige, aus etwa 1 m lesbar.

**Live:** https://altibo.github.io/LoopStep/

## So geht's

1. **Kabel-Kopfhörer** einstecken (empfohlen). Ohne Kopfhörer nimmt das Mikro die laufenden Spuren mit auf. Bluetooth-Kopfhörer sind zu stark verzögert.
2. Einmal **Latenz messen** (ohne Kopfhörer, Lautstärke hoch, 3 s still). Der Wert wird gespeichert, damit die Spuren genau im Takt liegen. Mit dem Regler kannst du von Hand nachjustieren.
3. **Tempo** und **Taktart** einstellen, dazu bei Spur 1 die **Länge** (1, 2, 4, 8 oder 16 Takte).
4. **Start** tippen oder kurz aufs Pedal treten. Die App zählt ein, nimmt Spur 1 auf und spielt sie danach als Loop ab. Danach wird **nichts automatisch** aufgenommen.
5. Für jede weitere Spur ihre Länge wählen und **● REC** an dieser Spur tippen, egal an welcher Stelle im Loop. Die Spur ist dann scharf geschaltet, und die große Anzeige zählt herunter: „REC Spur 2 ab Anfang – noch 3 Takte“, im letzten Takt Schlag für Schlag. Du kannst schon mitspielen. Die Aufnahme beginnt sample-genau am nächsten Anfang, also bei Takt 1 von Spur 1. Sie läuft genau die gewählte Länge, schließt sich und spielt dann mit.
6. **REC nochmal tippen**: Solange die Spur wartet, wird die Aufnahme abgebrochen. Läuft sie schon, wird sie verworfen und die Spur bleibt wie vorher. Abbrechen ist bewusst einfacher und sicherer als ein vorzeitiges Ende mit krummer Länge.
7. **REC an einer belegten Spur** („Neu aufn.“) nimmt sie neu auf. Solange sie wartet, kannst du die Länge ändern. Während der neuen Aufnahme ist die alte Spur stumm, und „Rückgängig“ holt sie zurück.
8. **Stopp** hält alles an, **Weiter** zählt neu ein. Tippst du REC, während alles gestoppt ist, wird eingezählt und die Spur ab dem Anfang aufgenommen.

**Längen:** Spur 1, genauer die zuerst aufgenommene Spur, legt den Grundloop fest. Andere Spuren können kürzer oder länger sein, z. B. 1 Takt über einem 4-Takt-Loop oder 8 Takte darüber. Alle laufen auf demselben Taktraster und bleiben phasengleich. Eine längere Spur beginnt immer an einem Anfang des Grundloops. Ist eine Spur aufgenommen, ist ihre Länge gesperrt. Zum Ändern nimmst du sie neu auf.

**Fußpedal / Bluetooth-Blätterpedal** (meldet sich wie eine Tastatur):
- Leertaste, Enter, →, ↓ oder Bild↓ **kurz** treten: REC an der nächsten leeren Spur. Ist schon eine Spur scharf geschaltet, wird sie abgebrochen. Ist alles gestoppt, geht es weiter bzw. es startet.
- **Lang halten** (0,6 s): Stopp.
- Eine laufende Aufnahme bricht das Pedal nie ab.
- ←, ↑ oder Bild↑ lassen sich auf Rückgängig, Stopp/Weiter oder REC abbrechen legen.

Pro Spur: REC, Länge, Stumm, Solo, Rückwärts, Löschen, Lautstärke, Hall, Echo (tempo-synchron), Zerre, Filter (links Tiefpass, rechts Hochpass), Tremolo (synchron, Achtel), Chorus. Summe: Lautstärke, Hall, Echo, Echo-Zeit, Echo-Wiederholungen, Limiter.

Weitere Funktionen:
- **Start bei 1. Anschlag** (nur für die erste Spur): Statt einzuzählen beginnt die Aufnahme genau mit dem ersten Ton.
- **Mithören bei Aufnahme**: macht die Loops während einer Aufnahme leiser, gegen Übersprechen ohne Kopfhörer.
- **Klick**: aus, nur beim Einzählen, bei Aufnahme (auch beim Herunterzählen vor der Aufnahme) oder immer.
- **WAV-Export**: Die Länge ist das kleinste gemeinsame Vielfache aller Spurlängen, also eine volle Runde, in der jede Spur aufgeht. Das ergibt höchstens 64 Takte, sonst wird die längste Spur genommen. Wählbar sind 1×, 2×, 4× oder 8× davon. Der Export ist nahtlos loopbar, mit Hall- und Echo-Ausklang, und geht übers Teilen oder als Download.
- **Sitzung speichern und laden** lokal (IndexedDB).
- Der Bildschirm bleibt an (Wake Lock). Die App funktioniert nach dem ersten Laden auch offline.

## Technik

- Vite + TypeScript, Web Audio, keine Laufzeit-Abhängigkeiten.
- Mikro mit `echoCancellation`, `noiseSuppression` und `autoGainControl` **aus**.
- Ein AudioWorklet streamt die Mikro-Samples mit dem absoluten `currentFrame` der AudioContext-Uhr in einen Ringpuffer. Jede Aufnahme wird sample-genau als Fenster `[Rundenstart + Latenz, + Looplänge)` ausgeschnitten.
- Ein Takt ist eine ganze Zahl von Frames, und alle Spurlängen sind ganze Vielfache davon. Jede Spur merkt sich, ab welchem Takt im Raster ihr Loop beginnt. Deshalb driften auch unterschiedlich lange Spuren nie gegeneinander.
- Naht ohne Knacken: Die Samples direkt nach dem Loop-Ende werden mit Equal-Power über 256 Samples in den Anfang überblendet.
- Latenzmessung: 10 Klicks über den Lautsprecher, Einsatz im Mikro-Signal suchen, Median nehmen.

## Entwicklung

```
npm ci
npm test            # Unit-Tests (Timing, Raster/Spurlängen, Ringpuffer, Naht, Latenz, WAV)
npm run lint && npm run build
npm run test:browser  # Playwright (Chromium, Fake-Mikro + interner Loopback)
LOOPSTEP_URL=https://altibo.github.io/LoopStep/ npx playwright test   # gegen die Live-Seite
```

`?loopback=0.123` ist ein Testmodus: Statt des Mikros wird der Ausgang 123 ms verzögert wieder eingespeist.

## Grenzen

- Nicht auf einem echten Android-Handy mit echtem Mikro getestet, nur in Headless-Chromium mit Fake-Mikro und Loopback.
- Die Latenz hängt vom Gerät ab und muss einmal gemessen werden. Mit Bluetooth-Kopfhörern ist sie zu groß.
- Ohne Kopfhörer kommt es zu Übersprechen. Echo-Unterdrückung ist bewusst aus, weil sie die Gitarre verfälschen würde.
