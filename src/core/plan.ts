// Pure auto-advance planner: decides what each loop cycle does.

export interface TrackSlot {
  hasAudio: boolean;
  rerecord: boolean;
}

export type CycleAction = { kind: "record"; track: number } | { kind: "listen"; nextRecordIn: number; track: number } | { kind: "play" };

export interface PlanInput {
  slots: TrackSlot[];
  trackCount: number;
  gap: number; // free cycles between two recordings
  autoRecord: boolean;
  cyclesSinceRecord: number; // cycles that passed since the last recording cycle ended (Infinity = none yet)
}

export function pendingTrack(slots: TrackSlot[], trackCount: number): number {
  for (let i = 0; i < trackCount; i++) {
    const s = slots[i];
    if (!s || !s.hasAudio || s.rerecord) return i;
  }
  return -1;
}

export function decideCycle(p: PlanInput): CycleAction {
  if (!p.autoRecord) return { kind: "play" };
  const t = pendingTrack(p.slots, p.trackCount);
  if (t < 0) return { kind: "play" };
  if (p.cyclesSinceRecord < p.gap) return { kind: "listen", nextRecordIn: p.gap - p.cyclesSinceRecord, track: t };
  return { kind: "record", track: t };
}

/** Simulates the planner for n cycles assuming every recording succeeds (used by tests and the UI preview). */
export function simulate(trackCount: number, gap: number, cycles: number): CycleAction[] {
  const slots: TrackSlot[] = Array.from({ length: trackCount }, () => ({ hasAudio: false, rerecord: false }));
  let since = Infinity;
  const out: CycleAction[] = [];
  for (let c = 0; c < cycles; c++) {
    const a = decideCycle({ slots, trackCount, gap, autoRecord: true, cyclesSinceRecord: since });
    out.push(a);
    if (a.kind === "record") {
      slots[a.track].hasAudio = true;
      since = 0;
    } else since++;
  }
  return out;
}
