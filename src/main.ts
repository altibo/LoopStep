import "./style.css";
import { BAR_CHOICES, Engine, defaultSettings, type ClickMode, type PedalB, type Settings } from "./audio/engine.ts";
import { METERS, clampBpm, tapTempo } from "./core/timing.ts";
import { encodeWav } from "./core/wav.ts";
import { loadSession, saveSession } from "./core/store.ts";
import { knob, type Knob } from "./ui/knob.ts";
import type { DelayDiv, TrackParams } from "./audio/fx.ts";

const LS = "loopstep:settings:v2";
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "{}") as Partial<Settings> & { pedal?: boolean; hideHint?: boolean };
  } catch {
    return {};
  }
})();
const settings: Settings = { ...defaultSettings(), ...saved };
let pedalOn = saved.pedal ?? true;
let hideHint = saved.hideHint ?? false;
const engine = new Engine(settings);
const params = new URLSearchParams(location.search);
if (params.has("loopback")) engine.loopbackSeconds = Number(params.get("loopback")) || 0.1;
(window as unknown as { __ls: Engine }).__ls = engine;

const persist = () => localStorage.setItem(LS, JSON.stringify({ ...settings, pedal: pedalOn, hideHint }));

// ---------- tiny DOM helpers ----------
type Attrs = Record<string, string | number | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  el.append(...kids);
  return el;
}
function btn(label: string, cls: string, onClick: () => void, testid?: string): HTMLButtonElement {
  const b = h("button", { class: cls, type: "button", "data-testid": testid }, label);
  b.addEventListener("click", onClick);
  return b;
}
function select<T extends string | number>(label: string, opts: [T, string][], value: T, onChange: (v: T) => void, testid?: string) {
  const s = h("select", { "aria-label": label, "data-testid": testid });
  for (const [v, t] of opts) s.append(h("option", { value: String(v) }, t));
  s.value = String(value);
  s.addEventListener("change", () => {
    const raw = s.value;
    const v = (typeof value === "number" ? Number(raw) : raw) as T;
    onChange(v);
  });
  return { el: h("label", { class: "field" }, h("span", { class: "engrave" }, label), s), select: s };
}

// ---------- layout ----------
const app = document.getElementById("app")!;
const stateBig = h("div", { class: "state", "data-testid": "state" }, "Bereit");
const stateSub = h("div", { class: "state-sub", "data-testid": "state-sub" }, "");
const countNum = h("div", { class: "count", "data-testid": "count" }, "");
const countUnit = h("div", { class: "count-unit", "data-testid": "count-unit" }, "");
const countBig = h("div", { class: "count-box" }, countNum, countUnit);
const barNum = h("div", { class: "barnum", "data-testid": "bar" }, "–");
const beatDots = h("div", { class: "dots", "aria-hidden": "true" });
const progress = h("div", { class: "progress" }, h("div", { class: "progress-fill" }));
const meterBar = h("div", { class: "meter", title: "Eingangspegel" }, h("div", { class: "meter-fill" }));
const display = h(
  "section",
  { class: "display panel", "aria-live": "polite" },
  h("div", { class: "display-top" }, stateBig, countBig),
  stateSub,
  h("div", { class: "display-grid" }, h("div", { class: "barbox" }, h("span", { class: "engrave small" }, "Takt"), barNum), beatDots),
  progress,
  h("div", { class: "meter-row" }, h("span", { class: "engrave small" }, "Mikro"), meterBar),
);

const mainBtn = btn("Start", "main-btn", () => void main(), "main");
const undoBtn = btn("↶ Rückgängig", "wood-btn", () => engine.undo(), "undo");
const nextBtn = btn("● REC nächste Spur", "wood-btn rec-next", () => void guard(() => engine.pedalTap()), "rec-next");
const clearBtn = btn("Alles löschen", "wood-btn danger", () => {
  if (confirm("Alle Spuren löschen?")) engine.clearAll();
}, "clear");
const transport = h("section", { class: "transport" }, mainBtn, h("div", { class: "transport-row" }, undoBtn, nextBtn, clearBtn));

const hint = h(
  "div",
  { class: "hint panel", role: "note", "data-testid": "hint" },
  h("strong", {}, "🎧 Kabel-Kopfhörer empfohlen. "),
  "Sonst nimmt das Handy-Mikro die laufenden Spuren mit auf (Übersprechen). Bluetooth-Kopfhörer sind zu stark verzögert. Ohne Kopfhörer hilft „Mithören bei Aufnahme“ leiser stellen.",
  btn("OK", "wood-btn small", () => {
    hideHint = true;
    persist();
    hint.remove();
  }),
);

const errBox = h("div", { class: "err", role: "alert", "data-testid": "error" });

// settings panel
const bpmVal = h("output", { class: "bpm", "data-testid": "bpm" }, String(settings.bpm));
const taps: number[] = [];
const setBpm = (v: number) => {
  if (engine.hasAudio) return;
  settings.bpm = clampBpm(v);
  persist();
  refresh();
};
const bpmMinus = btn("−", "wood-btn sq", () => setBpm(settings.bpm - 1), "bpm-minus");
const bpmPlus = btn("+", "wood-btn sq", () => setBpm(settings.bpm + 1), "bpm-plus");
const tapBtn = btn("Tap", "wood-btn sq", () => {
  const t = performance.now();
  if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(t);
  if (taps.length > 6) taps.shift();
  const b = tapTempo(taps);
  if (b) setBpm(b);
}, "tap");
const bpmRow = h("div", { class: "field bpm-field" }, h("span", { class: "engrave" }, "Tempo (BPM)"), h("div", { class: "bpm-row" }, bpmMinus, bpmVal, bpmPlus, tapBtn));
const meterSel = select("Taktart", Object.keys(METERS).map((m) => [m, m] as [string, string]), settings.meter, (v) => { settings.meter = v; persist(); refresh(); }, "meter");
const defBarsSel = select("Länge neuer Spuren", BAR_CHOICES.map((n) => [n, `${n} ${n === 1 ? "Takt" : "Takte"}`] as [number, string]), settings.defaultBars, (v) => {
  settings.defaultBars = v;
  for (const t of engine.tracks) if (!t.data && engine.rec?.track !== t.index) t.bars = v;
  persist();
  refresh();
}, "default-bars");
const tracksSel = select("Spuren", [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)] as [number, string]), settings.trackCount, (v) => { engine.setTrackCount(v); persist(); }, "tracks");
const countSel = select("Einzählen", [[1, "1 Takt"], [2, "2 Takte"]] as [number, string][], settings.countIn, (v) => { settings.countIn = v; persist(); }, "countin");
const clickSel = select<ClickMode>("Klick", [["aus", "Aus"], ["einzaehlen", "Nur Einzählen"], ["aufnahme", "Bei Aufnahme"], ["immer", "Immer"]], settings.click, (v) => { settings.click = v; persist(); }, "click");
const pedalSel = select<PedalB>("Pedal links/hoch", [["undo", "Rückgängig"], ["stop", "Stopp/Weiter"], ["cancel", "REC abbrechen"]], settings.pedalB, (v) => { settings.pedalB = v; persist(); }, "pedalb");
const onsetBtn = btn("", "wood-btn toggle", () => { settings.onsetStart = !settings.onsetStart; persist(); refresh(); }, "onset");
const pedalBtn = btn("", "wood-btn toggle", () => { pedalOn = !pedalOn; persist(); refresh(); }, "pedal");

const pct = (v: number) => `${Math.round(v * 100)}`;
const kClick = knob({ label: "Klick", min: 0, max: 1, value: settings.clickVol, def: 0.6, format: pct, onInput: (v) => { settings.clickVol = v; persist(); } });
const kDuck = knob({ label: "Mithören b. Aufn.", min: 0, max: 1, value: settings.duck, def: 1, format: pct, onInput: (v) => { settings.duck = v; persist(); }, testId: "duck" });
const kIn = knob({ label: "Eingang", min: 0, max: 4, value: settings.inputGain, def: 1, format: (v) => `${v.toFixed(1)}×`, onInput: (v) => { engine.setInputGain(v); persist(); } });
const kOnset = knob({ label: "Anschlag-Schwelle", min: 0.02, max: 0.6, value: settings.onsetLevel, def: 0.12, format: pct, onInput: (v) => { settings.onsetLevel = v; persist(); } });

const latVal = h("output", { class: "lat", "data-testid": "latency" }, "");
const latRange = h("input", { type: "range", min: 0, max: 500, step: 1, value: settings.latencyMs, "aria-label": "Latenz in Millisekunden", "data-testid": "latency-range", class: "fader" }) as HTMLInputElement;
latRange.addEventListener("input", () => { settings.latencyMs = Number(latRange.value); persist(); refresh(); });
const latMsg = h("div", { class: "small-note", "data-testid": "lat-msg" }, "Einmal messen: ohne Kopfhörer, Handy-Lautstärke hoch, 3 s still sein.");
const calBtn = btn("Latenz messen", "wood-btn", async () => {
  calBtn.disabled = true;
  latMsg.textContent = "Messe … bitte still sein";
  try {
    const r = await engine.calibrate();
    latMsg.textContent = r.ok ? `Gemessen: ${r.ms.toFixed(1)} ms (${r.hits} Klicks, Streuung ${r.spreadMs.toFixed(1)} ms)` : `Messung unsicher (${r.hits} Klicks erkannt). Lauter stellen oder Regler von Hand setzen.`;
    persist();
  } catch (e) {
    latMsg.textContent = "Messung fehlgeschlagen: " + (e as Error).message;
  }
  calBtn.disabled = false;
  refresh();
}, "calibrate");

const settingsPanel = h(
  "section",
  { class: "panel settings" },
  h("h2", { class: "engrave" }, "Takt & Ablauf"),
  h("div", { class: "grid" }, bpmRow, meterSel.el, defBarsSel.el, tracksSel.el, countSel.el, clickSel.el),
  h("div", { class: "knob-row" }, kClick.el, kDuck.el, kIn.el, kOnset.el),
  h("div", { class: "grid" }, onsetBtn, pedalBtn, pedalSel.el),
  h("h2", { class: "engrave" }, "Latenz-Ausgleich"),
  h("div", { class: "lat-row" }, calBtn, latRange, latVal),
  latMsg,
);

// master + export
const kMVol = knob({ label: "Gesamt", min: 0, max: 1.2, value: engine.master.vol, def: 0.9, format: pct, onInput: (v) => engine.setMaster({ vol: v }) });
const kMHall = knob({ label: "Hall", min: 0, max: 1, value: engine.master.hall, def: 0.8, format: pct, onInput: (v) => engine.setMaster({ hall: v }) });
const kMEcho = knob({ label: "Echo", min: 0, max: 1, value: engine.master.echo, def: 0.8, format: pct, onInput: (v) => engine.setMaster({ echo: v }) });
const kMFb = knob({ label: "Echo-Wdh.", min: 0, max: 0.85, value: engine.master.echoFeedback, def: 0.4, format: pct, onInput: (v) => engine.setMaster({ echoFeedback: v }) });
const echoDiv = select<DelayDiv>("Echo-Zeit", [["1/16", "1/16"], ["1/8", "1/8"], ["1/8.", "1/8 punktiert"], ["1/4", "1/4"]], engine.master.echoDiv, (v) => engine.setMaster({ echoDiv: v }));
const expSel = select("Export-Länge", [[1, "1× Gesamtlänge"], [2, "2×"], [4, "4×"], [8, "8×"]] as [number, string][], 2, () => {});
const exportBtn = btn("WAV exportieren", "wood-btn", () => void exportWav(), "export");
const saveBtn = btn("Sitzung speichern", "wood-btn", () => void saveNow(), "save");
const loadBtn = btn("Sitzung laden", "wood-btn", () => void loadNow(), "load");
const ioMsg = h("div", { class: "small-note", "data-testid": "io-msg" });
const masterPanel = h(
  "section",
  { class: "panel master" },
  h("h2", { class: "engrave" }, "Summe & Export"),
  h("div", { class: "knob-row" }, kMVol.el, kMHall.el, kMEcho.el, kMFb.el),
  h("div", { class: "grid" }, echoDiv.el, expSel.el, exportBtn, saveBtn, loadBtn),
  ioMsg,
);

// tracks
const trackList = h("section", { class: "tracks", "data-testid": "tracks" });
interface Strip {
  el: HTMLElement;
  chip: HTMLElement;
  wave: HTMLCanvasElement;
  head: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  rev: HTMLButtonElement;
  del: HTMLButtonElement;
  vol: HTMLInputElement;
  knobs: Partial<Record<keyof TrackParams, Knob>>;
  drawn: Float32Array | null;
  rec: HTMLButtonElement;
  len: HTMLSelectElement;
  info: HTMLElement;
}
const strips: Strip[] = [];
function makeStrip(i: number): Strip {
  const p = engine.tracks[i].params;
  const chip = h("span", { class: "chip", "data-testid": `chip-${i}` }, "leer");
  const wave = h("canvas", { class: "wave", width: 600, height: 80, "aria-hidden": "true" });
  const head = h("div", { class: "playhead" });
  const set = <K extends keyof TrackParams>(k: K, v: TrackParams[K]) => engine.setParam(i, k, v);
  const mute = btn("Stumm", "wood-btn toggle", () => set("mute", !engine.tracks[i].params.mute), `mute-${i}`);
  const solo = btn("Solo", "wood-btn toggle", () => set("solo", !engine.tracks[i].params.solo), `solo-${i}`);
  const rev = btn("Rückwärts", "wood-btn toggle", () => set("reverse", !engine.tracks[i].params.reverse), `rev-${i}`);
  const rec = btn("● REC", "rec-btn", () => void guard(() => engine.toggleRec(i)), `rec-${i}`);
  const len = h("select", { class: "len-sel", "aria-label": `Länge Spur ${i + 1}`, "data-testid": `len-${i}` });
  for (const n of BAR_CHOICES) len.append(h("option", { value: String(n) }, `${n} ${n === 1 ? "Takt" : "Takte"}`));
  len.value = String(engine.tracks[i].bars);
  len.addEventListener("change", () => {
    engine.setTrackBars(i, Number(len.value));
    refresh();
  });
  const info = h("span", { class: "len-info", "data-testid": `info-${i}` });
  const del = btn("Löschen", "wood-btn danger", () => engine.deleteTrack(i), `del-${i}`);
  const vol = h("input", { type: "range", min: 0, max: 1.5, step: 0.01, value: p.vol, class: "fader", "aria-label": `Lautstärke Spur ${i + 1}`, "data-testid": `vol-${i}` }) as HTMLInputElement;
  vol.addEventListener("input", () => set("vol", Number(vol.value)));
  const filterFmt = (v: number) => (v < -0.02 ? `Tief ${Math.round(-v * 100)}` : v > 0.02 ? `Hoch ${Math.round(v * 100)}` : "aus");
  const mk = (k: "hall" | "echo" | "drive" | "filter" | "trem" | "chorus", label: string, min = 0) =>
    knob({ label, min, max: 1, value: p[k], def: 0, format: k === "filter" ? filterFmt : pct, onInput: (v) => set(k, v), testId: `${k}-${i}` });
  const knobs = { hall: mk("hall", "Hall"), echo: mk("echo", "Echo"), drive: mk("drive", "Zerre"), filter: mk("filter", "Filter", -1), trem: mk("trem", "Tremolo"), chorus: mk("chorus", "Chorus") };
  const el = h(
    "article",
    { class: "track panel", "data-testid": `track-${i}` },
    h("div", { class: "track-head" }, h("span", { class: "track-name engrave" }, `Spur ${i + 1}`), info, chip),
    h("div", { class: "rec-row" }, rec, h("label", { class: "len-field" }, h("span", { class: "engrave small" }, "Länge"), len)),
    h("div", { class: "wave-box" }, wave, head),
    h("div", { class: "track-btns" }, mute, solo, rev, del),
    h("label", { class: "vol-row" }, h("span", { class: "engrave small" }, "Lautstärke"), vol),
    h("div", { class: "knob-row" }, ...Object.values(knobs).map((k) => k.el)),
  );
  return { el, chip, wave, head, mute, solo, rev, del, vol, knobs, drawn: null, rec, len, info };
}

function drawWave(s: Strip, data: Float32Array | null) {
  const c = s.wave.getContext("2d");
  s.drawn = data;
  if (!c) return;
  const { width: w, height: hh } = s.wave;
  c.clearRect(0, 0, w, hh);
  if (!data) return;
  c.fillStyle = "rgba(255, 214, 150, 0.9)";
  const step = data.length / w;
  for (let x = 0; x < w; x++) {
    let m = 0;
    const a = Math.floor(x * step);
    const b = Math.min(data.length, Math.floor((x + 1) * step));
    for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(data[j]));
    const y = Math.max(1, Math.min(1, m * 1.4) * (hh / 2));
    c.fillRect(x, hh / 2 - y, 1, y * 2);
  }
}

app.append(
  h("header", { class: "top" }, h("h1", { class: "brand" }, "LoopStep"), h("span", { class: "brand-sub" }, "Looper ohne dritte Hand")),
  h("div", { class: "layout" }, h("div", { class: "col-left" }, display, transport, errBox), h("div", { class: "col-right" }, ...(hideHint ? [] : [hint]), trackList, settingsPanel, masterPanel)),
  h("footer", { class: "foot" }, "Pedal: Leertaste/Enter/→/↓/Bild↓ = Start · Stopp · Weiter. ←/↑/Bild↑ = einstellbar. Aufnahmen bleiben auf dem Gerät."),
);

// ---------- actions ----------
let wakeLock: { release(): Promise<void> } | null = null;
async function lockScreen() {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl && !wakeLock) wakeLock = await wl.request("screen");
  } catch {
    /* not available */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && engine.phase !== "idle") {
    wakeLock = null;
    void lockScreen();
  }
});

async function guard(fn: () => Promise<unknown> | unknown) {
  errBox.textContent = "";
  try {
    await fn();
    void lockScreen();
  } catch (e) {
    errBox.textContent = engine.micError || (e as Error).message;
  }
}
const main = () => guard(() => engine.mainAction());

function pedalB() {
  if (settings.pedalB === "undo") engine.undo();
  else if (settings.pedalB === "cancel") {
    if (engine.rec) void guard(() => engine.toggleRec(engine.rec!.track));
  } else void main();
}

// Pedal A: short tap = REC next empty track (or cancel an armed one; Start/Weiter when stopped),
// hold >= 0.6 s = Stopp. Pedal B (left/up) is configurable.
const PEDAL_A = [" ", "Enter", "ArrowRight", "ArrowDown", "PageDown", "MediaPlayPause"];
const PEDAL_B = ["ArrowLeft", "ArrowUp", "PageUp"];
let pedalDown = 0;
let pedalHeldFired = false;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement && (t.type === "number" || t.type === "text");
window.addEventListener(
  "keydown",
  (e) => {
    if (!pedalOn || isTyping(e.target)) return;
    if (PEDAL_A.includes(e.key)) {
      if (!e.repeat && !pedalDown) {
        pedalDown = performance.now();
        pedalHeldFired = false;
        holdTimer = setTimeout(() => {
          pedalHeldFired = true;
          if (engine.phase !== "idle" && engine.phase !== "paused") engine.pause();
        }, 600);
      }
    } else if (PEDAL_B.includes(e.key)) {
      if (!e.repeat) pedalB();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
window.addEventListener(
  "keyup",
  (e) => {
    if (!pedalOn || !PEDAL_A.includes(e.key) || !pedalDown) return;
    if (holdTimer) clearTimeout(holdTimer);
    pedalDown = 0;
    if (!pedalHeldFired) void guard(() => engine.pedalTap());
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

async function exportWav() {
  if (!engine.hasAudio) {
    ioMsg.textContent = "Noch keine Spur aufgenommen.";
    return;
  }
  ioMsg.textContent = "Rendere …";
  const mix = await engine.renderMix(Number(expSel.select.value));
  const blob = new Blob([encodeWav(mix.channels, mix.sampleRate)], { type: "audio/wav" });
  const name = `loopstep-${settings.bpm}bpm-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.wav`;
  const file = new File([blob], name, { type: "audio/wav" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && !params.has("noshare")) {
    try {
      await navigator.share({ files: [file], title: "LoopStep" });
      ioMsg.textContent = "Geteilt.";
      return;
    } catch {
      /* fall back to download */
    }
  }
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  ioMsg.textContent = `Gespeichert: ${name}`;
}

async function saveNow() {
  try {
    await saveSession("last", engine.snapshot());
    ioMsg.textContent = "Sitzung auf diesem Gerät gespeichert.";
  } catch (e) {
    ioMsg.textContent = "Speichern fehlgeschlagen: " + (e as Error).message;
  }
}
async function loadNow() {
  try {
    const s = await loadSession<ReturnType<Engine["snapshot"]>>("last");
    if (!s) {
      ioMsg.textContent = "Keine gespeicherte Sitzung.";
      return;
    }
    await engine.restore(s);
    syncControls();
    ioMsg.textContent = "Sitzung geladen. Start tippen zum Abspielen.";
  } catch (e) {
    ioMsg.textContent = "Laden fehlgeschlagen: " + (e as Error).message;
  }
}

function syncControls() {
  meterSel.select.value = settings.meter;
  defBarsSel.select.value = String(settings.defaultBars);
  tracksSel.select.value = String(settings.trackCount);
  kMVol.set(engine.master.vol);
  kMHall.set(engine.master.hall);
  kMEcho.set(engine.master.echo);
  kMFb.set(engine.master.echoFeedback);
  echoDiv.select.value = engine.master.echoDiv;
  refresh();
}

const barsTxt = (n: number) => `${n} ${n === 1 ? "Takt" : "Takte"}`;

// ---------- rendering ----------
function refresh() {
  const locked = engine.gridLocked;
  bpmVal.textContent = String(settings.bpm);
  for (const el of [bpmMinus, bpmPlus, tapBtn, meterSel.select]) (el as HTMLButtonElement).disabled = locked;
  bpmRow.title = locked ? "Zum Ändern alle Spuren löschen" : "";
  latRange.value = String(settings.latencyMs);
  latVal.textContent = `${settings.latencyMs.toFixed(0)} ms`;
  onsetBtn.textContent = `Start bei 1. Anschlag: ${settings.onsetStart ? "an" : "aus"}`;
  onsetBtn.classList.toggle("active", settings.onsetStart);
  pedalBtn.textContent = `Fußpedal/Tasten: ${pedalOn ? "an" : "aus"}`;
  pedalBtn.classList.toggle("active", pedalOn);
  undoBtn.disabled = !engine.canUndo();
  clearBtn.disabled = !engine.hasAudio && engine.phase === "idle";
  const ph = engine.phase;
  mainBtn.textContent = ph === "idle" ? "▶ Start" : ph === "paused" ? "▶ Weiter" : "■ Stopp";
  mainBtn.dataset.phase = ph;
  const v = engine.view();
  nextBtn.disabled = engine.firstEmpty() < 0 && !engine.rec;
  const visible = Math.max(settings.trackCount, ...engine.tracks.map((t, i) => (t.data ? i + 1 : 0)));
  while (strips.length < engine.tracks.length) {
    const s = makeStrip(strips.length);
    strips.push(s);
    trackList.append(s.el);
  }
  strips.forEach((s, i) => {
    const t = engine.tracks[i];
    const st = v.trackState[i];
    s.el.hidden = i >= visible;
    if (s.drawn !== t.data) drawWave(s, t.data);
    for (const [k, kn] of Object.entries(s.knobs)) kn!.set(t.params[k as keyof TrackParams] as number);
    if (document.activeElement !== s.vol) s.vol.value = String(t.params.vol);
    if (document.activeElement !== s.len) s.len.value = String(t.bars);
    s.len.disabled = (!!t.data && st !== "armed") || st === "recording";
    s.mute.classList.toggle("active", t.params.mute);
    s.solo.classList.toggle("active", t.params.solo);
    s.rev.classList.toggle("active", t.params.reverse);
    s.del.disabled = !t.data;
    s.rec.textContent = st === "armed" ? "✕ Abbrechen" : st === "recording" ? "■ Verwerfen" : t.data ? "● Neu aufn." : "● REC";
    s.rec.dataset.state = st;
    const mb = engine.masterBars;
    const rel = mb && t.bars !== mb ? ` · ${t.bars > mb ? `${t.bars / mb}×` : `1/${mb / t.bars}`} Spur-1-Loop` : "";
    s.info.textContent = barsTxt(t.data ? t.dataBars : t.bars) + rel;
    s.chip.textContent = { empty: "leer", armed: "wartet auf Anfang", recording: "Aufnahme", playing: "spielt", muted: "stumm" }[st];
    s.el.dataset.state = st === "recording" ? "rec" : st === "armed" ? "armed" : st === "playing" ? "play" : st === "muted" ? "mute" : "empty";
  });
  if (engine.micError) errBox.textContent = engine.micError;
  else if (engine.notice) errBox.textContent = engine.notice;
}
engine.onChange = refresh;

let lastKey = "";
function frame() {
  const v = engine.view();
  const ph = v.phase;
  let st = "Bereit";
  let sub = "Start tippen oder Pedal treten: Einzählen, dann Spur 1 aufnehmen.";
  let mode = "idle";
  let count = "";
  let unit = "";
  if (ph === "waiting") {
    st = "Spiel los!";
    sub = `Spur ${v.armed + 1} startet beim ersten Anschlag`;
    mode = "armed";
  } else if (ph === "paused") {
    st = "Pause";
    sub = "Weiter tippen (wird neu eingezählt) – oder REC an einer Spur.";
  } else if ((ph === "countin" || ph === "running") && v.countIn > 0) {
    st = "Einzählen";
    count = String(v.countIn);
    unit = v.countIn === 1 ? "Schlag" : "Schläge";
    sub = v.armed >= 0 ? `Danach Aufnahme Spur ${v.armed + 1} (${barsTxt(engine.tracks[v.armed].bars)})` : "Danach spielen die Loops";
    mode = "count";
  } else if (ph === "running" || ph === "countin") {
    if (v.recording >= 0 && v.toEnd) {
      st = `Aufnahme Spur ${v.recording + 1}`;
      mode = "rec";
      count = String(v.toEnd.show);
      unit = v.toEnd.unit;
      sub = `noch ${v.toEnd.show} ${v.toEnd.unit}`;
    } else if (v.armed >= 0 && v.toStart) {
      st = `REC Spur ${v.armed + 1} ab Anfang`;
      mode = "soon";
      count = String(v.toStart.show);
      unit = v.toStart.unit;
      sub = `Aufnahme ab Takt 1 – noch ${v.toStart.show} ${v.toStart.unit}`;
    } else {
      st = "Spielt";
      mode = "play";
      sub = engine.firstEmpty() >= 0 ? `REC an Spur ${engine.firstEmpty() + 1} tippen – Aufnahme beginnt am Anfang` : "Alle Spuren belegt";
    }
  }
  if (stateBig.textContent !== st) stateBig.textContent = st;
  if (stateSub.textContent !== sub) stateSub.textContent = sub;
  if (countNum.textContent !== count) countNum.textContent = count;
  if (countUnit.textContent !== unit) countUnit.textContent = unit;
  document.body.dataset.mode = mode;
  const beats = engine.meter.beats;
  if (beatDots.childElementCount !== beats) beatDots.replaceChildren(...Array.from({ length: beats }, () => h("span", { class: "dot" })));
  const running = (ph === "running" || ph === "countin") && v.countIn === 0 && v.masterBars > 0;
  const key = `${ph}:${v.bar}:${v.beat}:${v.countIn}:${v.armed}:${v.recording}`;
  if (key !== lastKey) {
    lastKey = key;
    barNum.textContent = running ? `${v.bar}/${v.masterBars}` : "–";
    [...beatDots.children].forEach((d, i) => d.classList.toggle("lit", running && v.beat === i + 1));
    refresh();
  }
  (progress.firstChild as HTMLElement).style.transform = `scaleX(${running ? v.masterFrac : 0})`;
  (meterBar.firstChild as HTMLElement).style.transform = `scaleX(${Math.min(1, v.level)})`;
  meterBar.classList.toggle("clip", v.clip);
  strips.forEach((s, i) => (s.head.style.left = running ? `${v.trackFrac[i] * 100}%` : "0"));
  requestAnimationFrame(frame);
}

refresh();
requestAnimationFrame(frame);

if ("serviceWorker" in navigator && import.meta.env.PROD && !params.has("nosw")) {
  void navigator.serviceWorker.register("./sw.js").catch(() => {});
}
