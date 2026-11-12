import { test, expect, type Page } from "@playwright/test";
import { statSync } from "node:fs";

const fast = { bpm: 240, meter: "4/4", defaultBars: 1, countIn: 1, click: "immer", clickVol: 0.6, duck: 1, onsetStart: false };

async function open(page: Page, query: string, settings: Record<string, unknown>) {
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem("ls-init")) {
      localStorage.setItem("loopstep:settings:v2", JSON.stringify({ ...s, hideHint: true }));
      sessionStorage.setItem("ls-init", "1");
    }
  }, settings);
  await page.goto(`./?nosw&noshare${query}`);
}

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

/** Onset offsets (frames) of the recorded metronome clicks relative to each beat of a track. */
const clickOffsets = (page: Page, i: number) =>
  ev<number[]>(
    page,
    `(() => {
      const t = __ls.tracks[${i}], d = t.data, bf = __ls.barF / 4, out = [];
      for (let k = 0; k < d.length / bf; k++) {
        const a = Math.max(0, Math.round(k * bf) - 400), b = Math.round(k * bf) + 2000;
        let pk = 0; for (let j = a; j < b; j++) pk = Math.max(pk, Math.abs(d[j]));
        let on = -1; for (let j = a; j < b; j++) if (Math.abs(d[j]) >= pk * 0.5) { on = j; break; }
        out.push(on - k * bf);
      }
      return out;
    })()`,
  );

async function waitMasterFrac(page: Page, lo: number, hi: number) {
  await page.waitForFunction(`(() => { const v = __ls.view(); return v.phase === "running" && v.countIn === 0 && v.masterFrac > ${lo} && v.masterFrac < ${hi}; })()`, null, { timeout: 10000 });
}

test("loopback: calibration, track 1 then stop recording; REC mid-loop starts exactly at the next loop start", async ({ page }) => {
  await open(page, "&loopback=0.123", { ...fast, trackCount: 3, latencyMs: 0 });
  await page.getByTestId("calibrate").click();
  await expect(page.getByTestId("lat-msg")).toContainText("Gemessen", { timeout: 15000 });
  const lat = await ev<number>(page, "__ls.s.latencyMs");
  expect(Math.abs(lat - 123)).toBeLessThanOrEqual(0.1);

  await page.getByTestId("main").click();
  await expect(page.getByTestId("state")).toHaveText("Einzählen");
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  // no auto-advance: two more cycles pass, track 2 stays empty and nothing is armed
  await page.waitForTimeout(2200);
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull();
  expect(await ev<unknown>(page, "__ls.rec")).toBeNull();
  await expect(page.getByTestId("state")).toHaveText("Spielt");

  // press REC on track 2 in the middle of the loop
  await waitMasterFrac(page, 0.35, 0.6);
  const pressed = await ev<number>(page, "Math.round(__ls.ctx.currentTime * __ls.sr)");
  await page.getByTestId("rec-1").click();
  await expect(page.getByTestId("state")).toHaveText("REC Spur 2 ab Anfang");
  await expect(page.getByTestId("state-sub")).toContainText("Aufnahme ab Takt 1 – noch");
  await expect(page.getByTestId("chip-1")).toHaveText("wartet auf Anfang");
  const r = await ev<{ S: number; t0: number; M: number }>(page, "({ S: __ls.rec.S, t0: __ls.t0, M: __ls.masterLen })");
  expect((r.S - r.t0) % r.M).toBe(0); // exactly a loop start
  expect(r.S).toBeGreaterThan(pressed);
  expect(r.S - pressed).toBeLessThan(r.M); // the very next one
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 10000 });
  expect(await ev<number>(page, "__ls.tracks[1].data.length")).toBe(r.M);
  // recorded clicks sit on the beats (0..8 frames = attack of the click itself)
  const offs = [...(await clickOffsets(page, 0)), ...(await clickOffsets(page, 1))];
  console.log("click onset offsets (frames):", JSON.stringify(offs));
  for (const o of offs) {
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThanOrEqual(8);
  }
  // still no auto-advance to track 3
  await page.waitForTimeout(1500);
  expect(await ev<unknown>(page, "__ls.tracks[2].data")).toBeNull();
});

test("per-track lengths: 2-bar and 4-bar tracks over a 1-bar master stay on the grid; export = LCM", async ({ page }) => {
  await open(page, "&loopback=0.08", { ...fast, trackCount: 3, latencyMs: 80 });
  await page.getByTestId("main").click();
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  await page.getByTestId("len-1").selectOption("2");
  await page.getByTestId("len-2").selectOption("4");
  // mute earlier tracks so the loopback only carries the live clicks (no bleed of recorded clicks)
  await page.getByTestId("mute-0").click();
  await waitMasterFrac(page, 0.3, 0.7);
  await page.getByTestId("rec-1").click();
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 10000 });
  await page.getByTestId("mute-1").click();
  await waitMasterFrac(page, 0.2, 0.6);
  await page.getByTestId("rec-2").click();
  // 4-bar take: countdown shows bars while more than one bar is left
  await page.waitForFunction("__ls.view().recording === 2", null, { timeout: 5000 });
  await expect(page.getByTestId("count-unit")).toHaveText(/Takte|Schläge|Takt|Schlag/);
  await page.waitForFunction("__ls.tracks[2].data !== null", null, { timeout: 12000 });
  const info = await ev<{ barF: number; lens: number[]; bars: number[]; phases: number[] }>(
    page,
    "({ barF: __ls.barF, lens: __ls.tracks.map(t => t.data.length), bars: __ls.tracks.map(t => t.dataBars), phases: __ls.tracks.map(t => t.phaseBars) })",
  );
  expect(info.bars).toEqual([1, 2, 4]);
  expect(info.lens).toEqual([info.barF, 2 * info.barF, 4 * info.barF]);
  expect(info.phases[0]).toBe(0);
  expect(info.phases[1]).toBeLessThan(2);
  expect(info.phases[2]).toBeLessThan(4);
  // the long tracks contain the clicks of every bar exactly on the beats
  for (const i of [1, 2]) for (const o of await clickOffsets(page, i)) expect(Math.abs(o)).toBeLessThanOrEqual(8);
  // phase-locked playback: each track's loop position is consistent with the global grid
  const pos = await ev<number[]>(page, "(() => { const f = Math.round(__ls.ctx.currentTime*__ls.sr); return __ls.tracks.map(t => ((f - __ls.t0 - t.phaseBars*__ls.barF) % t.data.length + t.data.length) % t.data.length % __ls.barF); })()");
  expect(new Set(pos).size).toBe(1); // all tracks sit at the same place inside the bar
  await expect(page.getByTestId("info-2")).toHaveText("4 Takte · 4× Spur-1-Loop");
  await expect(page.getByTestId("len-2")).toBeDisabled();
  await page.getByTestId("main").click();
  const dl = page.waitForEvent("download");
  await page.getByTestId("export").click();
  const file = await dl;
  expect(statSync(await file.path()).size).toBe(44 + 2 * 4 * info.barF * 2 * 2); // LCM 4 bars × 2, stereo 16-bit
});

test("fake mic: Start records only track 1; pedal arms the next track; cancel, mute, solo, delete, undo, long-press stop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "", { ...fast, trackCount: 4, latencyMs: 40 });
  const states: string[] = [];
  await page.getByTestId("main").click();
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const s = (await page.getByTestId("state").textContent()) ?? "";
    if (states[states.length - 1] !== s) states.push(s);
    await page.waitForTimeout(40);
  }
  const seen = states.filter((x) => x !== "Bereit");
  expect(seen.slice(0, 3)).toEqual(["Einzählen", "Aufnahme Spur 1", "Spielt"]);
  expect(seen).not.toContain("Aufnahme Spur 2");
  const L = await ev<number>(page, "__ls.masterLen");
  expect(await ev<number>(page, "__ls.tracks[0].data.length")).toBe(L);
  expect(await ev<number>(page, "Math.max(...__ls.tracks[0].data.map(Math.abs))")).toBeGreaterThan(0.01);
  expect(await ev<boolean[]>(page, "__ls.tracks.slice(1).map(t => t.data === null)")).toEqual([true, true, true]);

  // pedal tap (key down + up) arms the next empty track -> records at the next loop start
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  await page.waitForFunction("__ls.rec && __ls.rec.track === 1", null, { timeout: 2000 });
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 8000 });

  // REC on track 3 then REC again = cancel
  await waitMasterFrac(page, 0.1, 0.5);
  await page.getByTestId("rec-2").click();
  await expect(page.getByTestId("rec-2")).toHaveText("✕ Abbrechen");
  await page.getByTestId("rec-2").click();
  expect(await ev<unknown>(page, "__ls.rec")).toBeNull();
  await page.waitForTimeout(1500);
  expect(await ev<unknown>(page, "__ls.tracks[2].data")).toBeNull();

  await page.getByTestId("mute-0").click();
  await expect(page.getByTestId("chip-0")).toHaveText("stumm");
  await page.getByTestId("solo-1").click();
  expect(await ev<boolean>(page, "__ls.tracks[1].params.solo")).toBe(true);
  await page.getByTestId("solo-1").click();
  await page.getByTestId("vol-1").fill("0.3");
  expect(await ev<number>(page, "__ls.tracks[1].params.vol")).toBeCloseTo(0.3);
  await page.getByTestId("del-1").click();
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull();
  await page.waitForTimeout(1200);
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull(); // not re-recorded automatically
  // re-record track 1 via its REC button, then undo brings the old take back
  const old = await ev<number>(page, "__ls.tracks[0].takes");
  await page.getByTestId("rec-0").click();
  await page.waitForFunction(`__ls.tracks[0].takes === ${old + 1}`, null, { timeout: 8000 });
  await page.getByTestId("undo").click();
  expect(await ev<number>(page, "__ls.tracks[0].data.length")).toBe(L);

  // long press on the pedal = stop
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await expect(page.getByTestId("main")).toHaveText("▶ Weiter");
  expect(await ev<string>(page, "__ls.phase")).toBe("paused");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("io-msg")).toContainText("gespeichert");
  expect(errors).toEqual([]);
});

test("session survives a reload; REC while stopped counts in and records at the loop start", async ({ page }) => {
  await open(page, "", { ...fast, trackCount: 2, latencyMs: 0 });
  await page.getByTestId("main").click();
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  await page.getByTestId("main").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("io-msg")).toContainText("gespeichert");
  await page.reload();
  await page.getByTestId("load").click();
  await expect(page.getByTestId("io-msg")).toContainText("geladen");
  const L = await ev<number>(page, "__ls.masterLen");
  expect(await ev<number>(page, "__ls.tracks[0].data.length")).toBe(L);
  await expect(page.getByTestId("main")).toHaveText("▶ Weiter");
  await expect(page.getByTestId("bpm-plus")).toBeDisabled();
  await page.getByTestId("rec-1").click();
  await expect(page.getByTestId("state")).toHaveText("Einzählen");
  expect(await ev<number>(page, "__ls.rec.S - __ls.t0")).toBe(0);
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 10000 });
});

test("start on first note (onset trigger) records without count-in", async ({ page }) => {
  await open(page, "&loopback=0.05", { ...fast, trackCount: 1, latencyMs: 50, onsetStart: true, onsetLevel: 0.1, click: "aus" });
  await page.getByTestId("main").click();
  await expect(page.getByTestId("state")).toHaveText("Spiel los!");
  await page.evaluate(`(() => { const c = __ls.ctx; const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.5; o.connect(g).connect(__ls.outTapForTest()); o.start(c.currentTime + 0.3); o.stop(c.currentTime + 0.6); })()`);
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  const pre = await ev<number>(page, `(() => { const d = __ls.tracks[0].data; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= 0.1) return i; return -1; })()`);
  const sr = await ev<number>(page, "__ls.ctx.sampleRate");
  expect(Math.abs(pre - Math.round(0.015 * sr))).toBeLessThanOrEqual(64);
});

test("screenshots portrait and landscape", async ({ page }) => {
  await open(page, "", { ...fast, bpm: 100, defaultBars: 2, trackCount: 4, latencyMs: 40, click: "aufnahme" });
  await page.getByTestId("main").click();
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 15000 });
  await page.getByTestId("len-1").selectOption("4");
  await page.getByTestId("rec-1").click();
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 20000 });
  await page.evaluate("__ls.setParam(0,'hall',0.4); __ls.setParam(1,'echo',0.5); __ls.setParam(1,'filter',-0.4)");
  await waitMasterFrac(page, 0.3, 0.45);
  await page.getByTestId("rec-2").click();
  await page.waitForFunction("(() => { const v = __ls.view(); return v.toStart && v.toStart.unit === 'Schläge' && v.toStart.show <= 3; })()", null, { timeout: 10000 });
  await page.screenshot({ path: "shots/portrait-armed-390x844.png" });
  await page.waitForFunction("__ls.view().recording === 2", null, { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "shots/portrait-390x844.png" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate("window.scrollTo(0, 0)");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "shots/landscape-844x390.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("main").click();
  await page.evaluate("document.querySelector('.settings').scrollIntoView()");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "shots/portrait-settings-390x844.png" });
});
