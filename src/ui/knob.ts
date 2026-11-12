// Brass knob: vertical/horizontal drag, arrow keys, double-tap resets. role=slider for accessibility.
export interface KnobOpts {
  label: string;
  min: number;
  max: number;
  value: number;
  def?: number;
  step?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  testId?: string;
}

export interface Knob {
  el: HTMLElement;
  set(v: number): void;
}

export function knob(o: KnobOpts): Knob {
  const wrap = document.createElement("div");
  wrap.className = "knob-wrap";
  const k = document.createElement("div");
  k.className = "knob";
  k.tabIndex = 0;
  k.setAttribute("role", "slider");
  k.setAttribute("aria-label", o.label);
  k.setAttribute("aria-valuemin", String(o.min));
  k.setAttribute("aria-valuemax", String(o.max));
  if (o.testId) k.dataset.testid = o.testId;
  const cap = document.createElement("div");
  cap.className = "knob-cap";
  k.append(cap);
  const lab = document.createElement("div");
  lab.className = "knob-label";
  lab.textContent = o.label;
  const val = document.createElement("div");
  val.className = "knob-val";
  wrap.append(k, val, lab);
  let v = o.value;
  const fmt = o.format ?? ((x: number) => String(Math.round(((x - o.min) / (o.max - o.min)) * 100)));
  const render = () => {
    const f = (v - o.min) / (o.max - o.min);
    k.style.setProperty("--a", `${-135 + f * 270}deg`);
    k.style.setProperty("--f", String(f));
    k.setAttribute("aria-valuenow", String(v));
    k.setAttribute("aria-valuetext", fmt(v));
    val.textContent = fmt(v);
    k.classList.toggle("on", Math.abs(v - (o.def ?? o.min)) > 1e-6);
  };
  const setV = (nv: number, emit = true) => {
    const st = o.step ?? (o.max - o.min) / 100;
    nv = Math.round(Math.min(o.max, Math.max(o.min, nv)) / st) * st;
    nv = Math.min(o.max, Math.max(o.min, nv));
    if (nv === v && emit) return;
    v = nv;
    render();
    if (emit) o.onInput(v);
  };
  let drag: { x: number; y: number; v: number } | null = null;
  k.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, v };
    k.setPointerCapture(e.pointerId);
    k.classList.add("drag");
    e.preventDefault();
  });
  k.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const d = (drag.y - e.clientY + (e.clientX - drag.x)) / 160;
    setV(drag.v + d * (o.max - o.min));
  });
  const end = () => {
    drag = null;
    k.classList.remove("drag");
  };
  k.addEventListener("pointerup", end);
  k.addEventListener("pointercancel", end);
  let lastTap = 0;
  k.addEventListener("pointerdown", () => {
    const t = performance.now();
    if (t - lastTap < 300) setV(o.def ?? o.min);
    lastTap = t;
  });
  k.addEventListener("keydown", (e) => {
    const st = (o.max - o.min) / 20;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") setV(v + st);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") setV(v - st);
    else if (e.key === "Home") setV(o.min);
    else if (e.key === "End") setV(o.max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  return { el: wrap, set: (nv) => setV(nv, false) };
}
