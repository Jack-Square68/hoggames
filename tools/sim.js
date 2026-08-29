const fs = require('fs');

const html = fs.readFileSync('/workspace/index.html', 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') {
      return () => ({ addColorStop: noop });
    }
    if (k === 'measureText') return () => ({ width: 10 });
    return noop;
  },
  set: () => true
});

const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      textContent: '',
      classList: { add: noop, remove: noop },
      getContext: () => ctxStub,
      addEventListener: noop,
      width: 390,
      height: 844,
      style: {}
    };
  }
  return elements[id];
}

const documentStub = {
  getElementById: el,
  querySelectorAll: () => [el('menu'), el('gameOver')],
  addEventListener: noop
};

const windowStub = { innerWidth: 390, innerHeight: 844, addEventListener: noop };
const store = {};
const localStorageStub = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; }
};
// Decode the sprite the page actually ships so the stub reports real dimensions
// and the physics below run against production geometry.
const sprite = (() => {
  const m = html.match(/hedgehogImg\.src = 'data:image\/png;base64,([^']*)'/);
  if (!m) throw new Error('no PNG sprite data URI found in index.html');
  const b64 = m[1];

  const illegal = [...b64].findIndex(c => !/[A-Za-z0-9+/=]/.test(c));
  if (illegal !== -1) {
    throw new Error(`sprite base64 has an illegal character at offset ${illegal}`);
  }

  const bytes = Buffer.from(b64, 'base64');
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(magic)) throw new Error('sprite is not a PNG');

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
    bytes: bytes.length,
    base64: b64
  };
})();

function ImageStub() {
  this.complete = false;
  Object.defineProperty(this, 'src', {
    set(value) {
      this.complete = true;
      this.naturalWidth = sprite.width;
      this.naturalHeight = sprite.height;
      this.width = sprite.width;
      this.height = sprite.height;
      if (this.onload) this.onload();
    }
  });
}

let rafCb = null;
const rafStub = cb => { rafCb = cb; return 1; };

const exportNames = [
  'startGame', 'startJump', 'updateGame', 'gameLoop', 'player', 'obstacles',
  'gameState', 'speed', 'score', 'canvas', 'ROCK_CLEAR_HEIGHT', 'spawnObstacle',
  'resizeCanvas', 'particles', 'popups'
];
const wrapper = new Function(
  'document', 'window', 'localStorage', 'Image', 'requestAnimationFrame',
  src + '\nreturn {' + exportNames.map(n => `get ${n}(){return ${n}}`).join(',') + '};'
);

const g = wrapper(documentStub, windowStub, localStorageStub, ImageStub, rafStub);

const AIR_SCALE_BONUS = 0.45;

console.log('--- Test 0: embedded sprite is a valid, transparent PNG ---');
const spriteOk = sprite.colorType === 6 && sprite.width > 0 && sprite.height > 0;
console.log(`  ${sprite.width}x${sprite.height}, colour type ${sprite.colorType}` +
            ` (6 = RGBA), ${(sprite.bytes / 1024).toFixed(0)} KB decoded` +
            ` from ${(sprite.base64.length / 1024).toFixed(0)} KB base64`);
console.log(`  sprite drawn at ${g.player.width}x${g.player.height.toFixed(1)}` +
            ` (source aspect ${(sprite.width / sprite.height).toFixed(3)},` +
            ` drawn aspect ${(g.player.width / g.player.height).toFixed(3)})`);
const aspectOk = Math.abs(
  (g.player.width / g.player.height) - (sprite.width / sprite.height)
) < 1e-6;
console.log('RESULT:', spriteOk && aspectOk ? 'PASS' : 'FAIL');

// Mirror of the drawn sprite bounds, including the apex scale-up.
function drawnBounds() {
  const p = g.player;
  const altitude = Math.min(p.airHeight / p.peakHeight, 1);
  const half = (p.height * (1 + altitude * AIR_SCALE_BONUS)) / 2;
  return { top: p.y - half, bottom: p.y + half };
}

console.log('--- Test 1: on-screen containment (jump spammed every frame) ---');
let allContained = true;

[[390, 844], [320, 568], [430, 932], [812, 375], [280, 300]].forEach(([w, h]) => {
  windowStub.innerWidth = w;
  windowStub.innerHeight = h;
  elements['gameCanvas'].width = w;
  elements['gameCanvas'].height = h;
  windowStub.onresize && windowStub.onresize();
  g.resizeCanvas();
  g.startGame();

  let minTop = Infinity;
  let maxBottom = -Infinity;
  let maxAir = 0;

  for (let frame = 0; frame < 4000; frame++) {
    // Spam jump every frame: worst case for an "off screen" bug.
    g.startJump();
    g.updateGame();

    const b = drawnBounds();
    minTop = Math.min(minTop, b.top);
    maxBottom = Math.max(maxBottom, b.bottom);
    maxAir = Math.max(maxAir, g.player.airHeight);

    if (g.gameState !== 'playing') g.startGame();
  }

  const ok = minTop >= 0 && maxBottom <= h;
  if (!ok) allContained = false;
  console.log(
    `  ${String(w + 'x' + h).padEnd(9)} maxAir=${maxAir.toFixed(0).padStart(4)}` +
    ` lift=${g.player.maxLift.toFixed(0).padStart(4)}` +
    ` drawnTop=${minTop.toFixed(1).padStart(7)}` +
    ` drawnBottom=${maxBottom.toFixed(1).padStart(7)} / ${h}  ${ok ? 'ok' : 'OFF SCREEN'}`
  );
});

console.log('RESULT:', allContained ? 'PASS' : 'FAIL');

// Restore the phone-sized viewport for the remaining tests.
windowStub.innerWidth = 390;
windowStub.innerHeight = 844;
elements['gameCanvas'].width = 390;
elements['gameCanvas'].height = 844;
g.resizeCanvas();

// ---- Test 2: a single jump clears a rock; a tree stays lethal.
function obstacleRun(type, jumpAtFrame) {
  g.startGame();
  g.obstacles.length = 0;
  g.obstacles.push({
    x: g.player.x,
    y: g.player.baseY + 260,
    width: type === 'tree' ? 50 : 40,
    height: type === 'tree' ? 80 : 35,
    type: type
  });

  for (let f = 0; f < 2000; f++) {
    if (jumpAtFrame !== null && f === jumpAtFrame) g.startJump();
    g.updateGame();
    if (g.gameState !== 'playing') return { survived: false, frame: f };
    if (g.obstacles.length && g.obstacles[0].y + g.obstacles[0].height < g.player.baseY - 150) {
      return { survived: true, frame: f };
    }
  }
  return { survived: true, frame: -1 };
}

console.log('\n--- Test 2: rock clearance / tree lethality ---');
const noJump = obstacleRun('rock', null);
console.log('rock, no jump ->', noJump.survived ? 'survived (BAD)' : `crashed at frame ${noJump.frame} (expected)`);

const impact = noJump.frame;
let cleared = 0;
const offsets = [];
for (let lead = 0; lead <= 60; lead += 2) offsets.push(impact - lead);
offsets.filter(f => f >= 0).forEach(f => {
  if (obstacleRun('rock', f).survived) cleared++;
});
console.log(`rock, jump timed before impact: cleared ${cleared}/${offsets.length} timings`);

const treeJump = obstacleRun('tree', Math.max(0, impact - 20));
console.log('tree, well-timed jump ->', treeJump.survived ? 'survived (BAD: jumped a tree)' : 'crashed (expected)');

console.log('RESULT:', !noJump.survived && cleared > 0 && !treeJump.survived ? 'PASS' : 'FAIL');

// ---- Test 2b: a passable lane always exists across the obstacle field.
console.log('\n--- Test 2b: passable lane always exists ---');
g.startGame();

let worstLane = Infinity;
let worstFrame = -1;
const laneNeeded = g.player.width + 10;

for (let frame = 0; frame < 20000; frame++) {
  g.updateGame();
  if (g.gameState !== 'playing') g.startGame();

  // Group obstacles into depth bands and measure the widest free horizontal gap.
  const bands = new Map();
  g.obstacles.forEach(o => {
    const band = Math.round(o.y / 120);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(o);
  });

  bands.forEach(group => {
    const blocked = group
      .map(o => [o.x - o.width / 2, o.x + o.width / 2])
      .sort((a, b) => a[0] - b[0]);

    let widest = 0;
    let cursor = 0;
    blocked.forEach(([lo, hi]) => {
      widest = Math.max(widest, lo - cursor);
      cursor = Math.max(cursor, hi);
    });
    widest = Math.max(widest, g.canvas.width - cursor);

    if (widest < worstLane) {
      worstLane = widest;
      worstFrame = frame;
    }
  });
}

console.log('frames simulated: 20000');
console.log(`narrowest gap seen: ${worstLane.toFixed(1)}px (need >= ${laneNeeded} for the hedgehog to fit)`);
console.log('first seen at frame:', worstFrame);
console.log('RESULT:', worstLane >= laneNeeded ? 'PASS' : 'FAIL');

// ---- Test 2c: is the game actually survivable? Drive it with an auto-player.
console.log('\n--- Test 2c: survivability with a simple auto-player ---');

function autoPlay(maxFrames) {
  g.startGame();

  for (let frame = 0; frame < maxFrames; frame++) {
    const p = g.player;

    // Look at obstacles approaching the player over the next stretch of slope.
    const ahead = g.obstacles
      .filter(o => o.y > p.baseY - 40 && o.y < p.baseY + 320)
      .sort((a, b) => a.y - b.y);

    if (ahead.length) {
      const blocked = ahead
        .map(o => [o.x - o.width / 2 - p.width / 2, o.x + o.width / 2 + p.width / 2])
        .sort((a, b) => a[0] - b[0]);

      // Steer toward the middle of the widest free lane.
      let best = null;
      let bestW = 0;
      let cursor = 0;
      blocked.forEach(([lo, hi]) => {
        if (lo - cursor > bestW) {
          bestW = lo - cursor;
          best = (cursor + lo) / 2;
        }
        cursor = Math.max(cursor, hi);
      });
      if (g.canvas.width - cursor > bestW) {
        bestW = g.canvas.width - cursor;
        best = (cursor + g.canvas.width) / 2;
      }
      if (best !== null) {
        p.targetX = Math.max(p.width / 2, Math.min(g.canvas.width - p.width / 2, best));
      }

      // If a rock is closing in on our line, jump it.
      const rock = ahead.find(o =>
        o.type === 'rock' &&
        Math.abs(o.x - p.x) < (p.width + o.width) / 2 &&
        o.y - p.baseY < 150
      );
      if (rock) g.startJump();
    }

    g.updateGame();
    if (g.gameState !== 'playing') return frame;
  }
  return maxFrames;
}

const runs = [];
for (let i = 0; i < 5; i++) runs.push(autoPlay(9000));
const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
console.log('survival frames per run:', runs.join(', '));
console.log(`average: ${avg.toFixed(0)} frames (~${(avg / 60).toFixed(1)}s at 60fps)`);
console.log('RESULT:', avg > 600 ? 'PASS' : 'FAIL (too punishing)');

// ---- Test 3: speed resets on every restart (the earlier bug).
console.log('\n--- Test 3: speed resets each run ---');
const speeds = [];
for (let run = 0; run < 3; run++) {
  g.startGame();
  speeds.push(g.speed);
  for (let f = 0; f < 1200; f++) g.updateGame();
}
console.log('speed at start of runs 1-3:', speeds.map(s => s.toFixed(2)).join(', '));
console.log('RESULT:', speeds.every(s => Math.abs(s - speeds[0]) < 1e-9) ? 'PASS' : 'FAIL');
