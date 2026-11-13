// Home page: sketches every outline, turns the ring, and springs the pills.
// The links work without it. See CLAUDE.md for how the drawing works.

(() => {
  // ---------- Tuning ----------
  const FPS = 12;            // Drawing rate. Low on purpose, so motion reads as hand animation.
  const BOIL_EVERY = 3;      // Redraw the line wobble every N frames.
  const WOBBLE = 2;          // How far a sketched line strays, in pixels.
  const LUMPY = 0.014;       // How uneven the big circles are, as a share of radius.
  const SPRING = 90;         // Pill spring stiffness.
  const DAMPING = 7;         // Lower is bouncier.
  const FOLLOW = 3.5;        // How fast the ring catches up with the mouse.
  const LINE_HOLD = 2000;    // Compact: milliseconds a line shows before the greeting returns.
  const INTRO_EACH = 900;    // Touch: milliseconds each social name shows in the opening run.
  const HUE_SWING = 24;      // Most the background hue shifts each way, in degrees. 0 turns it off.

  // Must match the compact media query in css/home.css.
  const compactMQ = matchMedia('(max-width: 820px), (max-height: 600px)');
  const calmMQ = matchMedia('(prefers-reduced-motion: reduce)');

  const stage = document.querySelector('.stage');
  const svg = stage.querySelector('.ink');
  const hub = stage.querySelector('.hub');
  const probe = stage.querySelector('.orbit-probe');
  const zone = stage.querySelector('.zone');
  const tape = stage.querySelector('.tape');
  const pills = [...stage.querySelectorAll('.pill')];
  const socials = [...stage.querySelectorAll('.social a')];
  const buttons = [...stage.querySelectorAll('.btn')];
  const detail = hub.querySelector('.hub-detail');
  const dName = detail.querySelector('.d-name');
  const dDesc = detail.querySelector('.d-desc');
  const dOpen = detail.querySelector('.d-open');
  const say = hub.querySelector('.hub-say');
  const hubBtn = hub.querySelector('.hub-btn');
  // Lines come from js/lines.js, shuffled once per load (Fisher-Yates).
  const lines = (window.HOME_LINES || []).filter((l) => typeof l === 'string' && l.trim());
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }

  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, cls) => {
    const el = document.createElementNS(NS, tag);
    el.setAttribute('class', cls);
    svg.appendChild(el);
    return el;
  };

  // Drawing order: connectors, ring, circle, then the outlined shapes on top.
  const wires = pills.map(() => make('path', 'ink-wire'));
  const ringPath = make('path', 'ink-ring');
  const hubFill = make('path', 'sk-fill');
  const hubStroke = make('path', 'sk-stroke');

  // Calls fn(on, byKey): on for mouse hover or keyboard focus, off when either ends.
  function onHot(el, fn) {
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') fn(true, false); });
    el.addEventListener('pointerleave', () => fn(false, false));
    el.addEventListener('focus', () => { if (el.matches(':focus-visible')) fn(true, true); });
    el.addEventListener('blur', () => fn(false, true));
  }

  // Every link with a sketched outline. Pills ride the ring in compact, social icons in wide.
  const shapes = [];
  function addShape(el, kind, group) {
    const s = {
      el, kind, group,
      id: shapes.length + 5,
      fill: make('path', `sk-fill sk-${kind}`),
      stroke: make('path', `sk-stroke sk-${kind}`),
      rect: null, angle: 0, radius: 0, mode: 'static',
    };
    const hot = (on) => {
      s.fill.classList.toggle('is-hot', on);
      s.stroke.classList.toggle('is-hot', on);
    };
    onHot(el, hot);
    shapes.push(s);
    return s;
  }
  // Compact layout: space the project circles evenly around the ring, starting at the top.
  pills.forEach((p, i) => p.parentElement.style.setProperty('--a', (-90 + (360 * i) / pills.length) + 'deg'));
  const pillShapes = pills.map((p) => addShape(p, 'pill', 'pill'));
  socials.forEach((a) => addShape(a, 'badge', 'social'));
  buttons.forEach((b) => addShape(b, 'btn', 'fixed'));
  addShape(dOpen, 'btn', 'detail');

  const nodes = pills.map(() => {
    const n = make('circle', 'ink-node');
    n.setAttribute('r', 5);
    return n;
  });
  const arrow = make('path', 'ink-arrow');

  // px and py are the stage's page position. edge is how far out still counts as the ring.
  const geo = { cx: 0, cy: 0, hubR: 0, orbitR: 0, edge: 0, px: 0, py: 0, tape: null };
  const springs = pills.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, hot: false }));
  const ptr = { x: 0, y: 0, active: false };
  let theta = 0;          // Ring rotation, in degrees.
  let spin = 0;           // Spin left after a drag, in degrees per second.
  let drag = null;
  let swallowClick = false;
  let selected = null;
  let frame = 0;
  let clock = 0;
  let lastHue = '';

  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const shortest = (d) => ((d + 540) % 360) - 180;
  const local = (e) => ({ x: e.pageX - geo.px, y: e.pageY - geo.py });
  const angleOf = (p) => Math.atan2(p.y - geo.cy, p.x - geo.cx) / DEG;

  // Repeatable noise in the range -1 to 1.
  const noise = (seed, i) => {
    const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
    return (v - Math.floor(v)) * 2 - 1;
  };
  // Same noise, smoothed along x so lines drift instead of jitter.
  const drift = (seed, x) => {
    const i = Math.floor(x), t = x - i, e = t * t * (3 - 2 * t);
    return noise(seed, i) * (1 - e) + noise(seed, i + 1) * e;
  };

  // ---------- Sketching ----------

  const f = (n) => n.toFixed(1);

  // A smooth line through a list of points.
  function smooth(pts, closed) {
    const n = pts.length;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let d;
    if (closed) {
      const m0 = mid(pts[n - 1], pts[0]);
      d = `M${f(m0[0])} ${f(m0[1])}`;
      for (let i = 0; i < n; i++) {
        const m = mid(pts[i], pts[(i + 1) % n]);
        d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(m[0])} ${f(m[1])}`;
      }
      return d + 'Z';
    }
    d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let i = 1; i < n - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(m[0])} ${f(m[1])}`;
    }
    return d + `L${f(pts[n - 1][0])} ${f(pts[n - 1][1])}`;
  }

  // Walks an outline at(distance) -> [x, y, normalX, normalY] and nudges points off it.
  // Modes: open (line), closed (fill), over (loop that overshoots its start).
  function trace(at, len, seed, id, mode) {
    const n = Math.max(8, Math.round(len / 11));
    const stepLen = len / n;
    const start = mode === 'open' ? 0 : (noise(id, 3) * 0.5 + 0.5) * len;
    const count = mode === 'open' ? n : mode === 'closed' ? n - 1 : n + Math.max(1, Math.round(n * 0.05));
    const key = seed * 9.7 + id * 3.1;
    const pts = [];
    for (let i = 0; i <= count; i++) {
      const d = i * stepLen;
      const p = at(mode === 'open' ? d : (start + d) % len);
      const off = drift(key, d / 34) * WOBBLE;
      pts.push([p[0] + p[2] * off, p[1] + p[3] * off]);
    }
    return pts;
  }

  // Two passes of the pen over the same outline.
  const penLoop = (at, len, seed, id) =>
    smooth(trace(at, len, seed, id, 'over'), false) + smooth(trace(at, len, seed + 11, id, 'over'), false);
  const penLine = (at, len, seed, id) =>
    smooth(trace(at, len, seed, id, 'open'), false) + smooth(trace(at, len, seed + 11, id, 'open'), false);
  const wash = (at, len, seed, id) => smooth(trace(at, len, seed, id, 'closed'), true);

  // Outline walkers.
  // a0 is the start angle, for an arc that begins partway around.
  const circleAt = (cx, cy, r, lump, id, a0 = 0) => (d) => {
    const a = a0 + d / r;
    const rr = r + lump * (Math.sin(2 * a + id) + 0.6 * Math.sin(3 * a + id * 2.3));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, Math.cos(a), Math.sin(a)];
  };
  // A pill shape: two straight edges joined by half circles.
  function stadium(x, y, w, h) {
    const r = Math.min(w, h) / 2;
    const flat = Math.max(0, w - 2 * r);
    const curve = Math.PI * r;
    const len = 2 * flat + 2 * curve;
    const at = (d) => {
      if (d < flat) return [x + r + d, y, 0, -1];
      d -= flat;
      if (d < curve) {
        const a = -Math.PI / 2 + d / r;
        return [x + w - r + Math.cos(a) * r, y + r + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
      }
      d -= curve;
      if (d < flat) return [x + w - r - d, y + h, 0, 1];
      d -= flat;
      const a = Math.PI / 2 + d / r;
      return [x + r + Math.cos(a) * r, y + r + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
    };
    return { at, len };
  }
  // A curve from p0 to p1 through two control points.
  function bezier(p0, c1, c2, p1) {
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 1.15;
    const at = (d) => {
      const t = clamp(d / len, 0, 1), u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0];
      const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1];
      // Hold both ends in place so the line still meets what it connects.
      const pin = Math.sin(t * Math.PI);
      return [x, y, 0.5 * pin, 0.85 * pin];
    };
    return { at, len };
  }

  // ---------- Measuring ----------

  function measure() {
    pills.forEach((p) => { p.style.transform = ''; });
    const s = stage.getBoundingClientRect();
    geo.px = s.left + window.scrollX;
    geo.py = s.top + window.scrollY;
    geo.edge = zone.offsetWidth / 2;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
    };
    const h = box(hub);
    geo.cx = h.x + h.w / 2;
    geo.cy = h.y + h.h / 2;
    geo.hubR = h.w / 2;
    geo.orbitR = probe.getBoundingClientRect().width;
    geo.tape = box(tape);

    const compact = compactMQ.matches;
    if (!compact && selected) select(null, true);
    shapes.forEach((sh) => {
      const rides = (sh.group === 'pill' && compact) || (sh.group === 'social' && !compact);
      if (rides) {
        sh.mode = 'orbit';
        sh.angle = parseFloat(getComputedStyle(sh.el.parentElement).getPropertyValue('--a')) || 0;
        sh.radius = sh.el.offsetWidth / 2;
      } else {
        sh.mode = sh.group === 'pill' ? 'spring' : 'static';
        sh.rect = box(sh.el);
      }
    });
    render();
  }

  // ---------- Drawing ----------

  function drawArrow(seed) {
    const tp = geo.tape;
    const tl = tp.x, tr = tp.x + tp.w, tt = tp.y, tb = tp.y + tp.h;
    const tcx = tp.x + tp.w / 2, tcy = tp.y + tp.h / 2;
    let start, end, c1, c2;
    if (compactMQ.matches) {
      // Compact: aim at the ring's center from above. When the label sits beside the ring,
      // drop from under the label instead.
      const beside = tcx > geo.cx + geo.orbitR;
      start = beside ? [tcx, tb + 6] : [tr + 8, tcy];
      const a = beside ? Math.atan2(start[1] - geo.cy, start[0] - geo.cx) : -Math.PI / 2;
      const ux = Math.cos(a), uy = Math.sin(a);
      const R = geo.orbitR + 42;
      end = [geo.cx + ux * R, geo.cy + uy * R];
      const run = Math.max(34, Math.hypot(end[0] - start[0], end[1] - start[1]) * 0.6);
      c2 = [end[0] + ux * run, end[1] + uy * run];
      c1 = beside
        ? [start[0], start[1] + Math.max(20, (c2[1] - start[1]) * 0.8)]
        : [start[0] + (c2[0] - start[0]) * 0.8, start[1]];
    } else {
      // Curl from the label's right end down onto the first pill.
      const first = pillShapes[0].rect;
      start = [tr + 8, tcy];
      end = [Math.max(start[0] + 46, first.x + first.w * 0.62), first.y - 10];
      c1 = [start[0] + (end[0] - start[0]) * 0.7, start[1] - 6];
      c2 = [end[0] + 6, end[1] - 34];
    }
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 24) {
      arrow.setAttribute('d', '');
      return;
    }
    const dir = Math.atan2(end[1] - c2[1], end[0] - c2[0]);
    const head = (off) => [end[0] - Math.cos(dir + off) * 13, end[1] - Math.sin(dir + off) * 13];
    const h1 = head(0.5), h2 = head(-0.5);
    const b = bezier(start, c1, c2, end);
    arrow.setAttribute('d',
      penLine(b.at, b.len, seed, 90)
      + `M${f(h1[0])} ${f(h1[1])}L${f(end[0])} ${f(end[1])}L${f(h2[0])} ${f(h2[1])}`);
  }

  // The ring is drawn as arcs that stop short of each icon riding on it.
  function drawRing(seed, riders) {
    const R = geo.orbitR, lump = R * LUMPY;
    if (!riders.length) {
      ringPath.setAttribute('d', penLoop(circleAt(geo.cx, geo.cy, R, lump, 2), 2 * Math.PI * R, seed, 2));
      return;
    }
    const sorted = riders.slice().sort((a, b) => a.angle - b.angle);
    let d = '';
    sorted.forEach((s, i) => {
      const next = sorted[(i + 1) % sorted.length];
      const from = (theta + s.angle) * DEG + (s.radius + 4) / R;
      let span = (next.angle - s.angle) * DEG;
      if (span <= 0) span += Math.PI * 2;
      span -= (s.radius + next.radius + 8) / R;
      if (span <= 0.05) return;
      d += penLine(circleAt(geo.cx, geo.cy, R, lump, 2, from), span * R, seed, 20 + i);
    });
    ringPath.setAttribute('d', d);
  }

  function render() {
    const calm = calmMQ.matches;
    const seed = calm ? 1 : 1 + (Math.floor(frame / BOIL_EVERY) % 3);
    const wide = !compactMQ.matches;
    stage.style.setProperty('--theta', theta.toFixed(1) + 'deg');
    // Background hue sways around the original palette as the ring turns.
    const hue = Math.sin(theta * DEG) * HUE_SWING;
    if (hue.toFixed(1) !== lastHue) {
      lastHue = hue.toFixed(1);
      document.documentElement.style.setProperty('--hue', lastHue);
    }

    const hubAt = circleAt(geo.cx, geo.cy, geo.hubR, geo.hubR * LUMPY, 1);
    const hubLen = 2 * Math.PI * geo.hubR;
    hubFill.setAttribute('d', wash(hubAt, hubLen, seed, 1));
    hubStroke.setAttribute('d', penLoop(hubAt, hubLen, seed, 1));

    drawRing(seed, shapes.filter((s) => s.mode === 'orbit'));

    shapes.forEach((s) => {
      if (s.group === 'detail' && !selected) {
        s.fill.setAttribute('d', '');
        s.stroke.setAttribute('d', '');
        return;
      }
      let at, len;
      if (s.mode === 'orbit') {
        const a = (theta + s.angle) * DEG;
        at = circleAt(geo.cx + Math.cos(a) * geo.orbitR, geo.cy + Math.sin(a) * geo.orbitR, s.radius, 0, s.id);
        len = 2 * Math.PI * s.radius;
      } else {
        let { x, y, w, h } = s.rect;
        if (s.mode === 'spring') {
          const sp = springs[pillShapes.indexOf(s)];
          const ox = Math.round(sp.x), oy = Math.round(sp.y);
          s.el.style.transform = `translate(${ox}px, ${oy}px)`;
          x += ox;
          y += oy;
        }
        ({ at, len } = stadium(x, y, w, h));
      }
      s.fill.setAttribute('d', wash(at, len, seed, s.id));
      s.stroke.setAttribute('d', penLoop(at, len, seed, s.id));
    });

    pillShapes.forEach((s, i) => {
      if (!wide) {
        wires[i].setAttribute('d', '');
        nodes[i].setAttribute('visibility', 'hidden');
        return;
      }
      const sp = springs[i], rest = s.rect;
      const midY = rest.y + rest.h / 2;
      // Leave the ring on a fanned-out angle, arrive level at the pill's left edge.
      const a = clamp(Math.atan2(midY - geo.cy, rest.x - geo.cx) / DEG * 1.3, -62, 62) * DEG;
      const p0 = [geo.cx + Math.cos(a) * geo.orbitR, geo.cy + Math.sin(a) * geo.orbitR];
      const p1 = [rest.x + Math.round(sp.x), midY + Math.round(sp.y)];
      const reach = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.45;
      const c1 = [p0[0] + Math.cos(a) * reach, p0[1] + Math.sin(a) * reach];
      const c2 = [p1[0] - reach, p1[1]];
      const b = bezier(p0, c1, c2, p1);
      wires[i].setAttribute('d', penLine(b.at, b.len, seed, 60 + i));
      nodes[i].setAttribute('visibility', 'visible');
      nodes[i].setAttribute('cx', f(p0[0]));
      nodes[i].setAttribute('cy', f(p0[1]));
    });

    drawArrow(seed);
    placeNote();
  }

  // ---------- Motion ----------

  function step(dt) {
    clock += dt;

    // Ring: coast after a drag, or lean toward the mouse while it is outside the ring.
    if (!drag) {
      theta += spin * dt;
      spin *= Math.exp(-dt * 2.5);
      if (ptr.active && Math.abs(spin) < 5) {
        const d = Math.hypot(ptr.x - geo.cx, ptr.y - geo.cy);
        if (d > geo.edge) {
          theta += shortest(angleOf(ptr) - theta) * (1 - Math.exp(-dt * FOLLOW));
        }
      }
    }

    if (compactMQ.matches) return;

    // Pills: drift a little, lean toward a nearby mouse, pop out when hovered or focused.
    springs.forEach((s, i) => {
      const rest = pillShapes[i].rect;
      let tx = Math.sin(clock * 0.7 + i * 1.9) * 5;
      let ty = Math.cos(clock * 0.9 + i * 2.3) * 3;
      if (ptr.active) {
        const dx = ptr.x - (rest.x + rest.w / 2);
        const dy = ptr.y - (rest.y + rest.h / 2);
        const near = 1 - Math.min(1, Math.hypot(dx * 0.5, dy) / 150);
        tx += clamp(dx * 0.12, -18, 18) * near;
        ty += clamp(dy * 0.3, -10, 10) * near;
      }
      if (s.hot) tx += 14;
      s.vx += ((tx - s.x) * SPRING - s.vx * DAMPING) * dt;
      s.vy += ((ty - s.y) * SPRING - s.vy * DAMPING) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    });
  }

  let last = 0, acc = 0, raf = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    acc += dt;
    if (acc >= 1 / FPS) {
      acc %= 1 / FPS;
      frame++;
      render();
    }
    raf = requestAnimationFrame(loop);
  }

  function startOrStop() {
    cancelAnimationFrame(raf);
    if (calmMQ.matches) {
      springs.forEach((s) => { s.x = s.y = s.vx = s.vy = 0; });
      spin = 0;
      render();
    } else {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  // ---------- Pointer ----------

  window.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType === 'mouse') {
      ptr.x = p.x;
      ptr.y = p.y;
      ptr.active = true;
    }
    if (drag && e.pointerId === drag.id) {
      const a = angleOf(p);
      const da = shortest(a - drag.a);
      const dt = Math.max(1, e.timeStamp - drag.t) / 1000;
      drag.a = a;
      drag.t = e.timeStamp;
      drag.moved += Math.abs(da) * DEG * geo.orbitR;
      theta += da;
      spin = spin * 0.6 + (da / dt) * 0.4;
      if (calmMQ.matches) render();
    }
  });

  document.documentElement.addEventListener('pointerleave', () => { ptr.active = false; });

  // Touch and pen: drag anywhere on the circle to turn the ring.
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const p = local(e);
    if (Math.hypot(p.x - geo.cx, p.y - geo.cy) > geo.edge) return;
    drag = { id: e.pointerId, a: angleOf(p), t: e.timeStamp, moved: 0 };
    spin = 0;
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved > 10) {
      // The finger turned the ring, so the tap that follows should not open a link.
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
    } else {
      spin = 0;
    }
    if (calmMQ.matches) spin = 0;
    drag = null;
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  stage.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---------- Social notes ----------
  // Hover or focus on a social icon writes its aria-label beside it.

  const note = document.createElement('div');
  note.className = 'social-note';
  note.setAttribute('aria-hidden', 'true');
  stage.appendChild(note);
  let noted = null;

  function placeNote() {
    if (!noted) return;
    const s = noted;
    let cx, cy, ux = 0, uy = -1, r;
    if (s.mode === 'orbit') {
      // On the ring: sit just outside it, on the line out from the center.
      const a = (theta + s.angle) * DEG;
      ux = Math.cos(a);
      uy = Math.sin(a);
      cx = geo.cx + ux * geo.orbitR;
      cy = geo.cy + uy * geo.orbitR;
      r = s.radius;
    } else {
      // In the row at the bottom: sit above the icon.
      cx = s.rect.x + s.rect.w / 2;
      cy = s.rect.y + s.rect.h / 2;
      r = s.rect.w / 2;
    }
    const w = note.offsetWidth, h = note.offsetHeight;
    const W = stage.clientWidth, H = stage.clientHeight;
    const spot = (x, y) => {
      const d = r + 10 + Math.abs(x) * w / 2 + Math.abs(y) * h / 2;
      return [cx + x * d, cy + y * d];
    };
    const fits = (p) => p[0] - w / 2 >= 6 && p[0] + w / 2 <= W - 6 && p[1] - h / 2 >= 6 && p[1] + h / 2 <= H - 6;
    // If it would run off the page, try above the icon, then below.
    let p = spot(ux, uy);
    if (!fits(p)) p = spot(0, -1);
    if (!fits(p)) p = spot(0, 1);
    note.style.left = f(p[0]) + 'px';
    note.style.top = f(p[1]) + 'px';
  }

  function showNote(s) {
    noted = s;
    note.textContent = s.el.getAttribute('aria-label') || '';
    note.classList.remove('is-on');
    placeNote();
    void note.offsetWidth;
    note.classList.add('is-on');
  }

  function hideNote(s) {
    if (noted !== s) return;
    noted = null;
    note.classList.remove('is-on');
  }

  shapes.filter((s) => s.group === 'social').forEach((s) => {
    onHot(s.el, (on) => (on ? showNote(s) : hideNote(s)));
  });

  // No hover on touch: play the names once after load, one at a time. A touch stops it.
  let introTimer = 0;

  function playIntro() {
    const list = shapes.filter((s) => s.group === 'social');
    let i = 0;
    const next = () => {
      if (i > 0) hideNote(list[i - 1]);
      if (i >= list.length) {
        introTimer = 0;
        return;
      }
      showNote(list[i++]);
      introTimer = setTimeout(next, INTRO_EACH);
    };
    next();
  }

  window.addEventListener('pointerdown', () => {
    if (!introTimer) return;
    clearTimeout(introTimer);
    introTimer = 0;
    if (noted) hideNote(noted);
  });

  if (matchMedia('(hover: none)').matches) {
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(() => { introTimer = setTimeout(playIntro, 700); });
  }

  // ---------- Circle lines ----------
  // Mouse hover shows a line and click steps on; touch taps step on, then the greeting returns.
  // Keyboard: focus shows a line, Enter or Space steps on.

  let lineAt = -1;
  let touched = false;
  let holdTimer = 0;
  const greeting = hub.querySelector('h1');

  // Every showing steps to the next line, so none repeats until the whole list has played.
  function showLine() {
    if (!lines.length) return;
    clearTimeout(holdTimer);
    lineAt = (lineAt + 1) % lines.length;
    hub.classList.remove('wipe-in');
    say.textContent = lines[lineAt];
    hub.classList.add('is-saying');
    // Restart the write-on animation.
    say.style.animation = 'none';
    void say.offsetWidth;
    say.style.animation = '';
    // Compact: the greeting returns on its own, and the next tap shows the next line.
    if (compactMQ.matches) holdTimer = setTimeout(hideLine, LINE_HOLD);
  }

  // wipe: write the greeting back in. Off when a project takes over the circle.
  function hideLine(wipe = true) {
    clearTimeout(holdTimer);
    const was = hub.classList.contains('is-saying');
    hub.classList.remove('is-saying', 'wipe-in');
    say.textContent = '';
    if (was && wipe) {
      void greeting.offsetWidth;
      hub.classList.add('wipe-in');
    }
  }
  greeting.addEventListener('animationend', () => hub.classList.remove('wipe-in'));

  hubBtn.addEventListener('pointerdown', (e) => { touched = e.pointerType !== 'mouse'; });
  hubBtn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showLine(); });
  hubBtn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideLine(); });
  hubBtn.addEventListener('focus', () => { if (hubBtn.matches(':focus-visible')) showLine(); });
  hubBtn.addEventListener('blur', () => hideLine());
  hubBtn.addEventListener('click', (e) => {
    const byTouch = touched && e.detail !== 0;
    touched = false;
    if (!hub.classList.contains('is-saying')) {
      showLine();
      return;
    }
    // Touch: after the last line, a tap brings the greeting back before the list starts over.
    if (byTouch && lineAt === lines.length - 1) hideLine();
    else showLine();
  });

  // ---------- Pills ----------

  function select(pill, quiet) {
    if (pill) hideLine(false);
    if (selected) {
      selected.classList.remove('is-selected');
      pillShapes[pills.indexOf(selected)].fill.classList.remove('is-on');
    }
    selected = pill;
    stage.classList.toggle('has-detail', !!pill);
    if (pill) {
      pill.classList.add('is-selected');
      pillShapes[pills.indexOf(pill)].fill.classList.add('is-on');
      const name = pill.querySelector('.name').textContent;
      dName.textContent = name;
      dDesc.textContent = pill.querySelector('.desc').textContent;
      dOpen.href = pill.getAttribute('href');
      dOpen.setAttribute('aria-label', 'Open ' + name);
    }
    // The Open button has just appeared or moved, so its outline needs measuring.
    if (!quiet) measure();
  }

  pills.forEach((p, i) => {
    const s = springs[i];
    // Keyboard focus also shows the project in the circle in compact. A mouse hover doesn't.
    onHot(p, (on, byKey) => {
      s.hot = on;
      if (on && byKey && compactMQ.matches) select(p);
    });
    p.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' && !compactMQ.matches) s.vx += 260;
    });
    // Compact: the first tap shows the project in the circle, the second opens it.
    // Keyboard activation (detail of 0) always opens it.
    p.addEventListener('click', (e) => {
      if (!compactMQ.matches || selected === p || e.detail === 0) return;
      e.preventDefault();
      select(p);
    });
  });

  stage.addEventListener('click', (e) => {
    if (selected && !e.target.closest('.pill, .hub-detail')) select(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) select(null);
  });

  // ---------- Start ----------

  new ResizeObserver(measure).observe(stage);
  compactMQ.addEventListener('change', measure);
  calmMQ.addEventListener('change', startOrStop);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
  startOrStop();
})();
