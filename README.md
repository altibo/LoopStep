# LoopStep – Looper ohne dritte Hand

Gitarren-Looper als Web-App (PWA) fürs Handy, gedacht für Android mit eingebautem Mikrofon. Holz-Look, große Anzeige, aus etwa 1 m lesbar.

**Live:** https://altibo.github.io/LoopStep/

## So geht's

1. **Kabel-Kopfhörer** einstecken (empfohlen). Ohne Kopfhörer nimmt das Mikro die laufenden Spuren mit auf. Bluetooth-Kopfhörer sind zu stark verzögert.
2. Einmal **Latenz messen** (ohne Kopfhörer, Lautstärke hoch, 3 s still). Der Wert wird gespeichert. Danach liegen die Spuren genau im Takt. Mit dem Regler kannst du von Hand nachjustieren.
3. **Tempo, Taktart, Loop-Länge (Takte), Anzahl Spuren** und **Zwischenrunde** (freie Runden zwischen zwei Aufnahmen zum Zuhören und Vorbereiten) einstellen.
4. **Einmal „Start“** tippen oder aufs Fußpedal treten: 1 oder 2 Takte Einzählen (Klick und große Zahl) → Spur 1 wird genau N Takte aufgenommen → der Loop schließt sich selbst und spielt → Spur 2 wird automatisch in der nächsten (bzw. übernächsten) Runde aufgenommen → … bis alle Spuren voll sind. Danach läuft der Loop einfach weiter.
5. **Stopp** hält alles an, **Weiter** zählt neu ein und macht weiter.

Pro Spur: Stumm, Solo, Rückwärts, Neu aufnehmen (in der nächsten Aufnahmerunde), Löschen, Lautstärke, Hall, Echo (tempo-synchron), Zerre, Filter (links Tiefpass, rechts Hochpass), Tremolo (synchron, Achtel), Chorus. Summe: Lautstärke, Hall, Echo, Echo-Zeit, Echo-Wiederholungen, Limiter.

Weitere Funktionen:
- **Rückgängig** macht die letzte Aufnahme rückgängig. Bei „Neu aufnehmen“ kommt die alte Spur zurück.
- **Auto-Aufnahme an/aus**: Bei „aus“ spielt der Loop nur, ohne neue Aufnahmen.
- **Start bei 1. Anschlag**: Statt einzuzählen beginnt Spur 1 genau mit dem ersten Ton.
- **Mithören bei Aufnahme**: macht die Loops während einer Aufnahme leiser, gegen Übersprechen ohne Kopfhörer.
- **Klick**: aus, nur beim Einzählen, bei Aufnahme oder immer, mit eigener Lautstärke.
- **Fußpedal oder Bluetooth-Blätterpedal** (meldet sich wie eine Tastatur): Leertaste, Enter, →, ↓ oder Bild↓ lösen Start, Stopp und Weiter aus. ←, ↑ oder Bild↑ lassen sich auf Rückgängig, Auto-Aufnahme oder Stopp legen.
- **WAV-Export** (1/2/4/8 Loops, nahtlos loopbar, mit Hall- und Echo-Ausklang) über Teilen oder als Download. **Sitzung speichern und laden** lokal (IndexedDB).
- Der Bildschirm bleibt an (Wake Lock). Die App funktioniert nach dem ersten Laden auch offline.

## Technik

- Vite + TypeScript, Web Audio, keine Laufzeit-Abhängigkeiten.
- Mikro mit `echoCancellation`, `noiseSuppression` und `autoGainControl` **aus**.
- Ein AudioWorklet streamt die Mikro-Samples mit dem absoluten `currentFrame` der AudioContext-Uhr in einen Ringpuffer. Jede Aufnahme wird sample-genau als Fenster `[Rundenstart + Latenz, + Looplänge)` ausgeschnitten.
- Die Looplänge ist eine ganze Zahl von Frames. Das Klick-Raster wird daraus abgeleitet, damit nichts driftet.
- Naht ohne Knacken: Die Samples direkt nach dem Loop-Ende werden mit Equal-Power über 256 Samples in den Anfang überblendet.
- Latenzmessung: 10 Klicks über den Lautsprecher, Einsatz im Mikro-Signal suchen, Median nehmen.

## Entwicklung

```
npm ci
npm test            # Unit-Tests (Timing, Planer, Ringpuffer, Naht, Latenz, WAV)
npm run lint && npm run build
npm run test:browser  # Playwright (Chromium, Fake-Mikro + interner Loopback)
LOOPSTEP_URL=https://altibo.github.io/LoopStep/ npx playwright test   # gegen die Live-Seite
```

`?loopback=0.123` ist ein Testmodus: Statt des Mikros wird der Ausgang 123 ms verzögert wieder eingespeist.

## Grenzen

- Nicht auf einem echten Android-Handy mit echtem Mikro getestet, nur in Headless-Chromium mit Fake-Mikro und Loopback.
- Die Latenz hängt vom Gerät ab und muss einmal gemessen werden. Mit Bluetooth-Kopfhörern ist sie zu groß.
- Ohne Kopfhörer kommt es zu Übersprechen. Echo-Unterdrückung ist bewusst aus, weil sie die Gitarre verfälschen würde.
