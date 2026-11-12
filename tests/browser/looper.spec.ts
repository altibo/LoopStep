import { test, expect, type Page } from "@playwright/test";

const fast = { bpm: 240, meter: "4/4", bars: 1, countIn: 1, click: "immer", clickVol: 0.6, duck: 1, onsetStart: false };

async function open(page: Page, query: string, settings: Record<string, unknown>) {
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem("ls-init")) {
      localStorage.setItem("loopstep:settings:v1", JSON.stringify({ ...s, hideHint: true }));
      sessionStorage.setItem("ls-init", "1");
    }
  }, settings);
  await page.goto(`./?nosw&noshare${query}`);
}

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

test("loopback: calibration measures the round trip and recordings land sample-exact on the grid", async ({ page }) => {
  await open(page, "&loopback=0.123", { ...fast, trackCount: 2, gap: 0, latencyMs: 0 });
  await page.getByTestId("calibrate").click();
  await expect(page.getByTestId("lat-msg")).toContainText("Gemessen", { timeout: 15000 });
  const lat = await ev<number>(page, "__ls.s.latencyMs");
  expect(Math.abs(lat - 123)).toBeLessThanOrEqual(0.1);
  await page.getByTestId("main").click();
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 15000 });
  const r = await ev<{ L: number; sr: number; lens: number[]; onsets: number[][] }>(
    page,
    `(() => {
      const L = __ls.loopLen, sr = __ls.ctx.sampleRate, bf = L / 4;
      const onsets = __ls.tracks.slice(0, 2).map((t) => {
        const d = t.data; const out = [];
        for (let k = 0; k < 4; k++) {
          const a = Math.max(0, Math.round(k * bf) - 400), b = Math.round(k * bf) + 2000;
          let pk = 0; for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(d[i]));
          let on = -1; for (let i = a; i < b; i++) if (Math.abs(d[i]) >= pk * 0.5) { on = i; break; }
          out.push(on - k * bf);
        }
        return out;
      });
      return { L, sr, lens: __ls.tracks.slice(0, 2).map((t) => t.data.length), onsets };
    })()`,
  );
  expect(r.L).toBe(Math.round(r.sr)); // 1 bar 4/4 at 240 BPM = 1 s
  expect(r.lens).toEqual([r.L, r.L]);
  // every recorded click starts within 8 frames (< 0.2 ms) of its beat; the 1100–1760 Hz click
  // itself needs 3–6 frames to reach half of its peak, so this is sample-tight alignment.
  console.log("onset offsets (frames):", JSON.stringify(r.onsets), "latency ms:", lat);
  for (const tr of r.onsets) for (const o of tr) {
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThanOrEqual(8);
  }
});

test("fake mic: one tap auto-advances through all tracks, then mute, solo, delete, undo, stop, export", async ({ page }) => {
  await open(page, "", { ...fast, trackCount: 3, gap: 1, latencyMs: 40 });
  const states: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("main").click();
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const s = (await page.getByTestId("state").textContent()) ?? "";
    if (states[states.length - 1] !== s) states.push(s);
    if ((await ev<boolean>(page, "__ls.tracks[2].data !== null")) && s === "Spielt") break;
    await page.waitForTimeout(40);
  }
  const seen = states.filter((x) => x !== "Bereit");
  expect(seen[0]).toBe("Einzählen");
  for (const want of ["Aufnahme Spur 1", "Aufnahme Spur 2", "Aufnahme Spur 3", "Spielt"]) expect(states).toContain(want);
  expect(states.indexOf("Aufnahme Spur 1")).toBeLessThan(states.indexOf("Aufnahme Spur 2"));
  expect(states.indexOf("Aufnahme Spur 2")).toBeLessThan(states.indexOf("Aufnahme Spur 3"));
  const L = await ev<number>(page, "__ls.loopLen");
  expect(await ev<number[]>(page, "__ls.tracks.slice(0,3).map(t => t.data.length)")).toEqual([L, L, L]);
  expect(await ev<number>(page, "Math.max(...__ls.tracks[0].data.map(Math.abs))")).toBeGreaterThan(0.01); // fake mic beep recorded
  await expect(page.getByTestId("state-sub")).toHaveText("Alle Spuren aufgenommen");

  await page.getByTestId("mute-0").click();
  await expect(page.getByTestId("chip-0")).toHaveText("stumm");
  expect(await ev<boolean>(page, "__ls.tracks[0].params.mute")).toBe(true);
  await page.getByTestId("solo-1").click();
  expect(await ev<boolean>(page, "__ls.tracks[1].params.solo")).toBe(true);
  await page.getByTestId("solo-1").click();
  await page.getByTestId("vol-2").fill("0.3");
  expect(await ev<number>(page, "__ls.tracks[2].params.vol")).toBeCloseTo(0.3);

  // switch auto-record off, delete track 2 -> stays empty
  await page.getByTestId("auto").click();
  await page.getByTestId("del-1").click();
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull();
  await page.waitForTimeout(1500);
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull();
  // auto-record on again -> the empty slot is re-recorded automatically
  await page.getByTestId("auto").click();
  await page.waitForFunction("__ls.tracks[1].data !== null", null, { timeout: 8000 });
  expect(await ev<number>(page, "__ls.tracks[1].data.length")).toBe(L);
  // undo removes the newest take
  await page.getByTestId("undo").click();
  await page.getByTestId("auto").click(); // off, so it is not re-recorded
  expect(await ev<unknown>(page, "__ls.tracks[1].data")).toBeNull();

  // pedal (keyboard): space = stop
  await page.keyboard.press("Space");
  await expect(page.getByTestId("main")).toHaveText("▶ Weiter");
  expect(await ev<string>(page, "__ls.phase")).toBe("paused");

  const dl = page.waitForEvent("download");
  await page.getByTestId("export").click();
  const file = await dl;
  const path = await file.path();
  const { statSync } = await import("node:fs");
  expect(statSync(path).size).toBe(44 + 2 * L * 2 * 2); // 2 loops, stereo, 16-bit
  await page.getByTestId("save").click();
  await expect(page.getByTestId("io-msg")).toContainText("gespeichert");
  await page.getByTestId("clear").click({ trial: true });
  expect(errors).toEqual([]);
});

test("session survives a reload", async ({ page }) => {
  await open(page, "", { ...fast, trackCount: 1, gap: 0, latencyMs: 0 });
  await page.getByTestId("main").click();
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  await page.getByTestId("main").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("io-msg")).toContainText("gespeichert");
  await page.reload();
  await page.getByTestId("load").click();
  await expect(page.getByTestId("io-msg")).toContainText("geladen");
  const L = await ev<number>(page, "__ls.loopLen");
  expect(await ev<number>(page, "__ls.tracks[0].data.length")).toBe(L);
  await expect(page.getByTestId("main")).toHaveText("▶ Weiter");
  await expect(page.getByTestId("bpm-plus")).toBeDisabled();
});

test("start on first note (onset trigger) records without count-in", async ({ page }) => {
  await open(page, "&loopback=0.05", { ...fast, trackCount: 1, gap: 0, latencyMs: 50, onsetStart: true, onsetLevel: 0.1, click: "aus" });
  await page.getByTestId("main").click();
  await expect(page.getByTestId("state")).toHaveText("Spiel los!");
  // play a "note" into the loopback input
  await page.evaluate(`(() => { const c = __ls.ctx; const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.5; o.connect(g).connect(__ls.outTapForTest()); o.start(c.currentTime + 0.3); o.stop(c.currentTime + 0.6); })()`);
  await page.waitForFunction("__ls.tracks[0].data !== null", null, { timeout: 10000 });
  const pre = await ev<number>(page, `(() => { const d = __ls.tracks[0].data; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= 0.1) return i; return -1; })()`);
  const sr = await ev<number>(page, "__ls.ctx.sampleRate");
  // the note starts right after the 15 ms pre-roll
  expect(Math.abs(pre - Math.round(0.015 * sr))).toBeLessThanOrEqual(64);
});

test("screenshots portrait and landscape", async ({ page }) => {
  await open(page, "", { ...fast, bpm: 90, bars: 2, trackCount: 4, gap: 0, latencyMs: 40, click: "aufnahme" });
  await page.getByTestId("main").click();
  // quicker: fast tempo so two tracks are done; screenshot while track 3 records
  await page.waitForFunction("__ls.tracks[1].data !== null && __ls.view().recording === 2", null, { timeout: 30000 });
  await page.evaluate("__ls.setParam(0,'hall',0.4); __ls.setParam(1,'echo',0.5); __ls.setParam(1,'filter',-0.4)");
  await page.waitForTimeout(700);
  await page.screenshot({ path: "shots/portrait-390x844.png" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shots/landscape-844x390.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("main").click();
  await page.evaluate("document.querySelector('.settings').scrollIntoView()");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "shots/portrait-settings-390x844.png" });
});
