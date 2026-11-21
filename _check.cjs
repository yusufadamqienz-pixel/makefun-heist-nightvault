// Runnable self-check for the heist game's logic.
//
// The game is one classic script with closure-scoped state, so this loads it in
// a VM with a stub DOM and drives the same update() the browser runs. It proves
// what a screenshot cannot: guards and cameras have finite positions, cameras
// actually watch, cutting a camera blinds it, taking a case raises the alarm
// floor, reaching the exit wins, and the exit is reachable from the spawn.
//
// Run: node _check.cjs   (beside game/)
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const canvasCtx = new Proxy({}, {
  get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient')
    ? () => ({ addColorStop() {} })
    : () => {},
});

const mkEl = (id) => ({
  id, style: {}, textContent: '', innerHTML: '', width: 960, height: 600,
  classList: { add() {}, remove() {}, contains: () => false },
  getContext: () => canvasCtx, addEventListener() {}, getBoundingClientRect: () => ({}),
});

const els = {};
global.document = {
  getElementById: (id) => (els[id] ||= mkEl(id)),
  createElement: (t) => mkEl(t),
  activeElement: { tagName: 'BODY' },
};
global.window = global;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.addEventListener = () => {};

const gameSrc = fs.readFileSync(path.join(__dirname, 'game', 'game.js'), 'utf8');
vm.runInThisContext(gameSrc +
  '\n;globalThis.__h = { get S(){return S}, update, guardSees, camSees, reset,' +
  ' set started(v){started=v}, get keys(){return keys} };\n');

const T = globalThis.__h;
let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};

T.reset();
T.started = true;

check('guards start at finite positions',
  T.S.guards.every((g) => Number.isFinite(g.x) && Number.isFinite(g.y)),
  JSON.stringify(T.S.guards.map((g) => [Math.round(g.x), Math.round(g.y)])));

check('cameras start at finite positions and angles',
  T.S.cams.every((c) => Number.isFinite(c.x) && Number.isFinite(c.face)));

// Cameras sweep: their facing changes over time.
{
  const before = T.S.cams.map((c) => c.face);
  for (let i = 0; i < 60; i++) T.update(0.016);
  const moved = T.S.cams.some((c, i) => Math.abs(c.face - before[i]) > 0.01);
  check('cameras sweep', moved);
}

// A camera sees inside its arc and is blind once cut.
{
  const c = T.S.cams[0];
  const inside = T.camSees(c, c.x + Math.cos(c.face) * 60, c.y + Math.sin(c.face) * 60);
  check('a camera sees along its facing', inside === true);
  c.cut = true;
  check('a cut camera is blind', T.camSees(c, c.x + Math.cos(c.face) * 60, c.y + Math.sin(c.face) * 60) === false);
  c.cut = false;
}

// Taking a case requires standing still with E, and raises the alarm floor.
{
  T.reset(); T.started = true;
  const floor0 = T.S.floor;
  const c0 = T.S.cases[0];
  T.S.player.x = c0.x; T.S.player.y = c0.y;
  T.keys.add('e');
  let steps = 0;
  while (!c0.taken && steps < 400) { T.update(0.016); steps++; }
  check('holding E on a case takes it', c0.taken === true, `${steps} steps`);
  check('taking a case raises the alarm floor', T.S.floor > floor0,
    `${floor0.toFixed(2)} -> ${T.S.floor.toFixed(2)}`);
  check('carried count follows', T.S.carried === 1);
  T.keys.delete('e');
}

// Movement cancels a grab.
{
  T.reset(); T.started = true;
  const c1 = T.S.cases[1];
  T.S.player.x = c1.x; T.S.player.y = c1.y;
  T.keys.add('e'); T.keys.add('d');
  for (let i = 0; i < 40; i++) T.update(0.016);
  check('moving cancels the grab', c1.taken === false && T.S.grab === 0);
  T.keys.clear();
}

// Cutting a camera needs proximity and Q, and raises the alarm.
{
  T.reset(); T.started = true;
  const c = T.S.cams[0];
  T.S.player.x = c.x + 60; T.S.player.y = c.y + 60;
  const a0 = T.S.alarm;
  T.keys.add('q');
  let steps = 0;
  while (!c.cut && steps < 400) { T.update(0.016); steps++; }
  check('holding Q near a camera cuts it', c.cut === true, `${steps} steps`);
  check('cutting a camera raises the alarm', T.S.alarm > a0,
    `${a0.toFixed(2)} -> ${T.S.alarm.toFixed(2)}`);
  T.keys.clear();
}

// Reaching the exit wins.
{
  T.reset(); T.started = true;
  T.update(0.016);
  T.S.player.x = 872; T.S.player.y = 520;
  T.update(0.016);
  check('reaching the exit wins', T.S.won === true, 'title=' + els.msgTitle.textContent);
}

// The alarm floor keeps a wanted thief visible: alarm cannot fall below it.
{
  T.reset(); T.started = true;
  T.S.floor = 0.3;
  T.S.alarm = 0.5;
  for (let i = 0; i < 300; i++) T.update(0.016);
  check('alarm never falls below the floor', T.S.alarm >= 0.3 - 1e-9,
    'alarm=' + T.S.alarm.toFixed(3));
}

// The floor is winnable: a path exists from spawn to exit.
{
  const walls = [
    [0, 0, 960, 16], [0, 584, 960, 16], [0, 0, 16, 600], [944, 0, 16, 600],
    [16, 190, 250, 18], [390, 190, 250, 18], [740, 190, 204, 18],
    [16, 400, 250, 18], [390, 400, 250, 18], [740, 400, 204, 18],
    [300, 16, 18, 140], [300, 250, 18, 130],
    [642, 16, 18, 140], [642, 250, 18, 130],
    [300, 452, 18, 130], [642, 452, 18, 130],
    [460, 286, 40, 40], [300, 286, 30, 30], [620, 286, 30, 30],
  ];
  const free = (x, y, r = 11) => {
    if (x - r < 16 || y - r < 16 || x + r > 944 || y + r > 584) return false;
    return !walls.some(([wx, wy, ww, wh]) => {
      const cx = Math.min(Math.max(x, wx), wx + ww);
      const cy = Math.min(Math.max(y, wy), wy + wh);
      return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
    });
  };
  const step = 8;
  const start = [480, 330];
  const goal = [872, 520];
  const seen = new Set([start.join()]);
  const queue = [start];
  let found = false;
  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (Math.abs(cx - goal[0]) <= step && Math.abs(cy - goal[1]) <= step) { found = true; break; }
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = cx + dx, ny = cy + dy;
      const k = nx + ',' + ny;
      if (seen.has(k) || nx < 16 || ny < 16 || nx > 944 || ny > 584) continue;
      if (!free(nx, ny)) continue;
      seen.add(k); queue.push([nx, ny]);
    }
  }
  check('a path exists from spawn to exit', found, `${seen.size} tiles reachable`);

  // Every loot case must be reachable too, or the take is impossible.
  const reach = (tx, ty) => {
    const s2 = new Set([start.join()]);
    const q2 = [start];
    while (q2.length) {
      const [cx, cy] = q2.shift();
      if (Math.hypot(cx - tx, cy - ty) < 30) return true;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const nx = cx + dx, ny = cy + dy;
        const k = nx + ',' + ny;
        if (s2.has(k) || nx < 16 || ny < 16 || nx > 944 || ny > 584) continue;
        if (!free(nx, ny)) continue;
        s2.add(k); q2.push([nx, ny]);
      }
    }
    return false;
  };
  const allLootReachable = [[130, 96], [500, 96], [840, 96], [480, 512]].every(([x, y]) => reach(x, y));
  check('every loot case is reachable', allLootReachable);
}

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
