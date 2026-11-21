/* Nightvault — a heist game.
 *
 * Top-down, one floor, no network and no build step: the page loads this file
 * and index.html and nothing else.
 *
 * The brief asks for a heist shown in one frame: a room the thief is crossing,
 * guards with vision cones, cameras, a loot target and an alarm meter. So the
 * floor is a gallery of four vault rooms off a central hall, each with its own
 * loot case, lit by its own light. Two guards walk patrols with cones, and
 * three cameras sweep fixed arcs -- cameras are mounted, so they cannot chase,
 * but they watch a wider angle than a guard.
 *
 * What makes it a heist rather than a stealth level is the tension between the
 * loot and the alarm. Loot can only be grabbed standing still for a moment,
 * which is exactly when a cone is most dangerous, and each case taken makes the
 * building more suspicious: the alarm floor rises with every case, so the last
 * one is always the hardest. Cameras can be cut with Q while close and facing
 * them, permanently, but cutting one is loud and shoves the alarm up a step --
 * a real decision, not a free win.
 *
 * Escape is the goal: reaching the exit with the alarm short of full pays out
 * whatever is carried, and reaching it with all four pays the full take.
 */

'use strict';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const elAlarm = document.getElementById('alarm');
const elAlarmTxt = document.getElementById('alarmTxt');
const elLoot = document.getElementById('loot');
const elLootMax = document.getElementById('lootMax');
const elMsg = document.getElementById('msg');
const elMsgTitle = document.getElementById('msgTitle');
const elMsgSub = document.getElementById('msgSub');

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* ---------------------------------------------------------------- level ---- */

// Outer wall plus the gallery's interior structure: a central hall with four
// vault rooms off it, each entered through a gap.
const walls = [
  [0, 0, W, 16], [0, H - 16, W, 16], [0, 0, 16, H], [W - 16, 0, 16, H],
  // ceiling of the north rooms / floor of the south rooms, with door gaps
  [16, 190, 250, 18], [390, 190, 250, 18], [740, 190, 204, 18],
  [16, 400, 250, 18], [390, 400, 250, 18], [740, 400, 204, 18],
  // room dividers, with gaps at the hall
  [300, 16, 18, 140], [300, 250, 18, 130],
  [642, 16, 18, 140], [642, 250, 18, 130],
  [300, 452, 18, 130], [642, 452, 18, 130],
  // pillars in the hall, cover to break sight lines
  [460, 286, 40, 40], [300, 286, 30, 30], [620, 286, 30, 30],
];

// Loot cases: one per room. Standing on one and holding E for a moment takes
// it, which is the exposed part of a heist.
const lootSpots = [
  { x: 130, y: 96, taken: false },
  { x: 500, y: 96, taken: false },
  { x: 840, y: 96, taken: false },
  { x: 480, y: 512, taken: false },
];
let lootMax = lootSpots.length;

const exit = { x: 872, y: 520, r: 28 };

// Lights, so the rooms read as rooms.
const lamps = [
  { x: 130, y: 96, r: 170 }, { x: 500, y: 96, r: 170 },
  { x: 840, y: 96, r: 170 }, { x: 480, y: 512, r: 180 },
  { x: 480, y: 300, r: 210 },
];

/* ---------------------------------------------------------------- input ---- */

const keys = new Set();
let started = false;

addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  const k = e.key.toLowerCase();
  keys.add(k);
  if (!started) begin();
  if (k === 'r') reset();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

/* ----------------------------------------------------------------- state --- */

let S;

function reset() {
  S = {
    player: { x: 480, y: 330, r: 11 },
    alarm: 0,
    // The floor the alarm cannot fall below. Each case taken raises it, so the
    // take gets more dangerous as it gets richer.
    floor: 0,
    carried: 0,
    heard: 0,          // noise made by cutting a camera, decays
    won: false,
    lost: false,
    t: 0,
    grab: 0,           // progress on the case underfoot
    cutting: null,     // camera currently being cut, with progress
    trace: [],
    cams: makeCams(),
    guards: makeGuards(),
    cases: lootSpots.map((l) => ({ ...l })),
  };
  elLootMax.textContent = String(lootMax);
  elLoot.textContent = '0';
  setMsg('NIGHTVAULT',
    'Four vaults. Three cameras. One exit.<br>Take the loot and get out before the alarm fills.<br><br>Press any key to begin.');
  paintAlarm();
}

function makeGuards() {
  // Patrols that cover the hall and the two main rooms. Positions are set to
  // the first waypoint: a guard with no position would aim its cone at NaN.
  const specs = [
    { pts: [[480, 330], [480, 250], [250, 250], [250, 330]], i: 0, t: 0,
      speed: 74, fov: 0.7, range: 190, sweep: 0.45, phase: 0.4 },
    { pts: [[480, 330], [740, 330], [740, 250], [560, 250]], i: 0, t: 0,
      speed: 66, fov: 0.78, range: 200, sweep: 0.52, phase: 2.2 },
    { pts: [[480, 300], [480, 460], [200, 460], [200, 300]], i: 0, t: 0,
      speed: 58, fov: 0.66, range: 185, sweep: 0.38, phase: 4.0 },
  ];
  return specs.map((g) => ({ ...g, x: g.pts[0][0], y: g.pts[0][1], face: 0 }));
}

function makeCams() {
  // Cameras are mounted: they sweep a fixed arc from a fixed point, and they
  // see further than a guard but cannot leave their post.
  const specs = [
    { x: 60, y: 60, base: 0.78, arc: 0.9, range: 250, speed: 0.42, phase: 0 },
    { x: 900, y: 60, base: 2.36, arc: 0.9, range: 250, speed: 0.36, phase: 1.9 },
    { x: 900, y: 540, base: 3.92, arc: 0.9, range: 250, speed: 0.48, phase: 3.4 },
  ];
  return specs.map((c) => ({ ...c, cut: false, face: c.base }));
}

function begin() {
  started = true;
  if (S.won || S.lost) reset();
  else setMsg(null);
}

function setMsg(title, sub) {
  if (title === null) { elMsg.classList.add('hide'); return; }
  elMsg.classList.remove('hide');
  elMsgTitle.textContent = title;
  elMsgSub.innerHTML = sub || '';
}

function paintAlarm() {
  const pct = Math.round(S.alarm * 100);
  elAlarm.style.width = pct + '%';
  elAlarm.style.background = S.alarm < 0.4 ? '#63d98a' : S.alarm < 0.72 ? '#e6c05f' : '#e2604f';
  elAlarmTxt.textContent = S.alarm < 0.05 ? 'quiet' : S.alarm < 0.4 ? 'watched'
    : S.alarm < 0.72 ? 'suspicious' : 'alarm rising';
}

/* ------------------------------------------------------------ collision ---- */

function hitsWall(x, y, r) {
  if (x - r < 0 || y - r < 0 || x + r > W || y + r > H) return true;
  for (const [wx, wy, ww, wh] of walls) {
    const cx = clamp(x, wx, wx + ww);
    const cy = clamp(y, wy, wy + wh);
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

function segBlocked(ax, ay, bx, by) {
  for (const [wx, wy, ww, wh] of walls) {
    if (segRect(ax, ay, bx, by, wx, wy, ww, wh)) return true;
  }
  return false;
}

function segRect(ax, ay, bx, by, rx, ry, rw, rh) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - rx, rx + rw - ax, ay - ry, ry + rh - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/* ----------------------------------------------------------------- sense --- */

function inCone(px, py, gx, gy, face, fov, range) {
  const d = dist(gx, gy, px, py);
  if (d > range) return false;
  let da = Math.atan2(py - gy, px - gx) - face;
  while (da > Math.PI) da -= TAU;
  while (da < -Math.PI) da += TAU;
  if (Math.abs(da) > fov / 2) return false;
  return !segBlocked(gx, gy, px, py);
}

function guardSees(g, x, y) {
  return inCone(x, y, g.x, g.y, g.face, g.fov, g.range);
}

function camSees(c, x, y) {
  if (c.cut) return false;
  return inCone(x, y, c.x, c.y, c.face, c.arc, c.range);
}

/* ---------------------------------------------------------------- update --- */

function update(dt) {
  S.t += dt;

  updateGuards(dt);
  for (const c of S.cams) c.face = c.base + Math.sin(S.t * c.speed + c.phase) * (c.arc / 2);

  const p = S.player;
  if (S.won || S.lost) { paintAlarm(); return; }

  const creeping = keys.has('shift');
  const speed = creeping ? 74 : 146;

  let ix = 0, iy = 0;
  if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
  if (keys.has('d') || keys.has('arrowright')) ix += 1;
  if (keys.has('w') || keys.has('arrowup')) iy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) iy += 1;
  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;

  const nx = p.x + ix * speed * dt;
  const ny = p.y + iy * speed * dt;
  if (!hitsWall(nx, p.y, p.r)) p.x = nx;
  if (!hitsWall(p.x, ny, p.r)) p.y = ny;

  S.trace.push([p.x, p.y]);
  if (S.trace.length > 110) S.trace.shift();

  /* --- grabbing a case: hold E, stand still --- */
  const pCase = S.cases.find((c) => !c.taken && dist(p.x, p.y, c.x, c.y) < 26);
  const moving = ix !== 0 || iy !== 0;
  if (pCase && keys.has('e') && !moving) {
    S.grab += dt;
    if (S.grab >= 1.1) {
      pCase.taken = true;
      S.carried += 1;
      S.grab = 0;
      // Taking a case makes the building warier: the alarm floor steps up.
      S.floor = Math.min(0.55, S.floor + 0.13);
      S.alarm = Math.max(S.alarm, S.floor);
      elLoot.textContent = String(S.carried);
    }
  } else {
    S.grab = Math.max(0, S.grab - dt * 2);
  }

  /* --- cutting a camera: close, facing it, hold Q --- */
  const nearCam = S.cams.find((c) => !c.cut && dist(p.x, p.y, c.x, c.y) < 130);
  if (nearCam && keys.has('q')) {
    if (!S.cutting || S.cutting.ref !== nearCam) S.cutting = { ref: nearCam, p: 0 };
    S.cutting.p += dt;
    if (S.cutting.p >= 0.9) {
      nearCam.cut = true;
      S.cutting = null;
      // Cutting is loud, and a dark camera is a thing the guards notice: it
      // costs a fixed step of alarm and nudges the floor up. The step is small
      // enough that cutting a camera before looting is a real option rather
      // than a losing move.
      S.floor = Math.min(0.6, S.floor + 0.06);
      S.alarm = Math.min(1, S.alarm + 0.07);
      S.heard = 1;
    }
  } else {
    S.cutting = null;
  }

  /* --- exposure --- */
  let seen = 0;
  for (const g of S.guards) {
    if (guardSees(g, p.x, p.y)) {
      seen = Math.max(seen, clamp(1 - dist(g.x, g.y, p.x, p.y) / g.range, 0.3, 1));
    }
  }
  for (const c of S.cams) {
    if (camSees(c, p.x, p.y)) {
      // A camera is patient: it holds the alarm up rather than spiking it.
      seen = Math.max(seen, clamp(1 - dist(c.x, c.y, p.x, p.y) / c.range, 0.22, 0.85));
    }
  }

  S.heard = Math.max(0, S.heard - dt * 0.8);

  if (seen > 0) {
    S.alarm += seen * (creeping ? 0.5 : 1) * 1.05 * dt;
  } else {
    S.alarm -= 0.5 * dt;
  }
  // The floor never lets a wanted thief go quiet.
  S.alarm = clamp(S.alarm, S.floor, 1);

  if (S.alarm >= 1) {
    S.lost = true;
    setMsg('THE ALARM TRIPS',
      `Caught with ${S.carried} of ${lootMax} cases.<br>Press R to try the vault again.`);
  }

  if (dist(p.x, p.y, exit.x, exit.y) < exit.r + p.r) {
    S.won = true;
    const all = S.carried === lootMax;
    setMsg(all ? 'CLEAN GETAWAY' : 'OUT, BUT LIGHT',
      all
        ? `All ${lootMax} cases, gone before the alarm filled.<br>Press R to run it again.`
        : `${S.carried} of ${lootMax} cases. The rest stay in the vault.<br>Press R to run it again.`);
  }

  paintAlarm();
}

function updateGuards(dt) {
  for (const g of S.guards) {
    const a = g.pts[g.i];
    const b = g.pts[(g.i + 1) % g.pts.length];
    const d = dist(a[0], a[1], b[0], b[1]) || 1;
    g.t += (g.speed * dt) / d;
    while (g.t >= 1) { g.t -= 1; g.i = (g.i + 1) % g.pts.length; }
    const a2 = g.pts[g.i];
    const b2 = g.pts[(g.i + 1) % g.pts.length];
    const px = g.x, py = g.y;
    g.x = lerp(a2[0], b2[0], g.t);
    g.y = lerp(a2[1], b2[1], g.t);
    const want = Math.atan2(g.y - py, g.x - px);
    if (Number.isFinite(want)) g.face = want + Math.sin(S.t * g.sweep + g.phase) * 0.5;
  }
}

/* ---------------------------------------------------------------- render --- */

const shade = document.createElement('canvas');
shade.width = W; shade.height = H;
const sctx = shade.getContext('2d');

function render() {
  // Floor
  ctx.fillStyle = '#171b22';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1c2129';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Trail
  if (S.trace.length > 1) {
    ctx.strokeStyle = 'rgba(120,190,235,0.26)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(S.trace[0][0], S.trace[0][1]);
    for (const [x, y] of S.trace) ctx.lineTo(x, y);
    ctx.stroke();
  }

  // Lamps
  for (const l of lamps) {
    const grd = ctx.createRadialGradient(l.x, l.y, 4, l.x, l.y, l.r);
    grd.addColorStop(0, 'rgba(255,228,168,0.22)');
    grd.addColorStop(1, 'rgba(255,228,168,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, TAU); ctx.fill();
  }

  // Walls
  for (const [x, y, w, h] of walls) {
    ctx.fillStyle = '#2f3844';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#3e4956';
    ctx.fillRect(x, y, w, 3);
  }

  // Exit
  const pulse = 0.5 + 0.5 * Math.sin(S.t * 2.4);
  ctx.fillStyle = `rgba(120,230,150,${0.16 + 0.16 * pulse})`;
  ctx.beginPath(); ctx.arc(exit.x, exit.y, exit.r + 12, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#72e096'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(exit.x, exit.y, exit.r, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#d6f2e2'; ctx.font = '12px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText('EXIT', exit.x, exit.y + 4);

  // Loot cases
  for (const c of S.cases) {
    if (c.taken) {
      ctx.strokeStyle = 'rgba(120,140,160,0.45)'; ctx.lineWidth = 2;
      ctx.strokeRect(c.x - 12, c.y - 12, 24, 24);
    } else {
      const g2 = 0.6 + 0.4 * Math.sin(S.t * 3 + c.x);
      ctx.fillStyle = `rgba(240,200,90,${0.55 + 0.35 * g2})`;
      ctx.fillRect(c.x - 12, c.y - 12, 24, 24);
      ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2;
      ctx.strokeRect(c.x - 12, c.y - 12, 24, 24);
    }
  }

  // Camera cones (mounted, so drawn as a wide arc)
  for (const c of S.cams) {
    if (c.cut) continue;
    const hot = camSees(c, S.player.x, S.player.y);
    const grd = ctx.createRadialGradient(c.x, c.y, 10, c.x, c.y, c.range);
    grd.addColorStop(0, `rgba(${hot ? '255,110,96' : '150,170,255'},0.26)`);
    grd.addColorStop(1, `rgba(${hot ? '255,110,96' : '150,170,255'},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.arc(c.x, c.y, c.range, c.face - c.arc / 2, c.face + c.arc / 2);
    ctx.closePath(); ctx.fill();
  }

  // Guard cones
  for (const g of S.guards) {
    const hot = guardSees(g, S.player.x, S.player.y);
    const grd = ctx.createRadialGradient(g.x, g.y, 8, g.x, g.y, g.range);
    grd.addColorStop(0, `rgba(${hot ? '255,110,96' : '255,196,110'},0.28)`);
    grd.addColorStop(1, `rgba(${hot ? '255,110,96' : '255,196,110'},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.arc(g.x, g.y, g.range, g.face - g.fov / 2, g.face + g.fov / 2);
    ctx.closePath(); ctx.fill();
  }

  // Player
  const p = S.player;
  ctx.fillStyle = keys.has('shift') ? '#7fd0ff' : '#a9e2ff';
  ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#0b1016'; ctx.lineWidth = 2; ctx.stroke();

  // Grab progress ring
  if (S.grab > 0) {
    ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 20, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, S.grab / 1.1));
    ctx.stroke();
  }
  // Cut progress ring
  if (S.cutting) {
    ctx.strokeStyle = '#9fb4ff'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, S.cutting.p / 0.9));
    ctx.stroke();
  }

  // Guards
  for (const g of S.guards) {
    ctx.fillStyle = '#e8b45f';
    ctx.beginPath(); ctx.arc(g.x, g.y, 10, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#0b1016'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = '#ffe6a6';
    ctx.beginPath(); ctx.moveTo(g.x, g.y);
    ctx.lineTo(g.x + Math.cos(g.face) * 17, g.y + Math.sin(g.face) * 17); ctx.stroke();
  }

  // Cameras
  for (const c of S.cams) {
    ctx.fillStyle = c.cut ? '#4a525e' : '#9fb4ff';
    ctx.beginPath(); ctx.arc(c.x, c.y, 7, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#0b1016'; ctx.lineWidth = 2; ctx.stroke();
    if (c.cut) {
      ctx.strokeStyle = '#e2604f'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.x - 6, c.y - 6); ctx.lineTo(c.x + 6, c.y + 6);
      ctx.moveTo(c.x + 6, c.y - 6); ctx.lineTo(c.x - 6, c.y + 6);
      ctx.stroke();
    }
  }

  // Darkness
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, W, H);
  sctx.fillStyle = 'rgba(5,7,11,0.8)';
  sctx.fillRect(0, 0, W, H);
  sctx.globalCompositeOperation = 'destination-out';
  for (const l of lamps) {
    const grd = sctx.createRadialGradient(l.x, l.y, 6, l.x, l.y, l.r * 1.05);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.82)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grd;
    sctx.beginPath(); sctx.arc(l.x, l.y, l.r * 1.05, 0, TAU); sctx.fill();
  }
  for (const g of S.guards) {
    const grd = sctx.createRadialGradient(g.x, g.y, 8, g.x, g.y, g.range);
    grd.addColorStop(0, 'rgba(0,0,0,0.95)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grd;
    sctx.beginPath();
    sctx.moveTo(g.x, g.y);
    sctx.arc(g.x, g.y, g.range, g.face - g.fov / 2, g.face + g.fov / 2);
    sctx.closePath(); sctx.fill();
  }
  for (const c of S.cams) {
    if (c.cut) continue;
    const grd = sctx.createRadialGradient(c.x, c.y, 10, c.x, c.y, c.range * 0.9);
    grd.addColorStop(0, 'rgba(0,0,0,0.9)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grd;
    sctx.beginPath();
    sctx.moveTo(c.x, c.y);
    sctx.arc(c.x, c.y, c.range * 0.9, c.face - c.arc / 2, c.face + c.arc / 2);
    sctx.closePath(); sctx.fill();
  }
  const pg = sctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 110);
  pg.addColorStop(0, 'rgba(0,0,0,0.96)');
  pg.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = pg;
  sctx.beginPath(); sctx.arc(p.x, p.y, 110, 0, TAU); sctx.fill();

  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(shade, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // Vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // Prompt when standing on something actionable
  ctx.textAlign = 'center';
  ctx.font = '12px ui-monospace, monospace';
  const onCase = S.cases.find((c) => !c.taken && dist(p.x, p.y, c.x, c.y) < 26);
  if (onCase) {
    ctx.fillStyle = 'rgba(255,233,168,0.9)';
    ctx.fillText('hold E to take the case', p.x, p.y - 34);
  }
  const cam = S.cams.find((c) => !c.cut && dist(p.x, p.y, c.x, c.y) < 130);
  if (cam) {
    ctx.fillStyle = 'rgba(159,180,255,0.9)';
    ctx.fillText('hold Q to cut the camera', p.x, p.y - (onCase ? 50 : 34));
  }
}

/* ------------------------------------------------------------- main loop --- */

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    if (started) update(dt);
    render();
  } catch (err) {
    // One bad frame must not kill the canvas for good.
    console.error('frame:', err && err.message);
  }
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);
