import * as THREE from 'three';
import './style.css';

// ---------------------------------------------------------------- constants
const SEG_LEN = 12;
const TRACK_W = 16;
const HALF_W = TRACK_W / 2;
const BALL_R = 0.9;

const SPEED_START = 18;
const SPEED_MAX = 62;
const ACCEL = 0.6;
const GRAVITY = 38;
const LAT_FACTOR = 0.62; // max lateral speed = forward speed * factor

const VIEW_SEGS = 34; // segments rendered ahead
const OBSTACLE_MIN_Z = 70;
const GAP_MIN_Z = 380;
const GATE_MIN_Z = 240; // gravity gates appear after this distance
const FLOOR_H = 1; // track slab thickness

// track centerline (analytic — physics & rendering share the same functions)
const yCenter = (z: number) => -0.28 * z + Math.sin(z * 0.035) * 3;
const xCenter = (z: number) => Math.sin(z * 0.013) * 9 + Math.sin(z * 0.007) * 7;

// ---------------------------------------------------------------- utils
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- audio (tiny, no assets)
let muted = localStorage.getItem('neonroll_muted') === '1';
let audioCtx: AudioContext | null = null;
let humOsc: OscillatorNode | null = null;
let humGain: GainNode | null = null;

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
    humOsc = audioCtx.createOscillator();
    humOsc.type = 'sawtooth';
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 240;
    humGain = audioCtx.createGain();
    humGain.gain.value = 0;
    humOsc.connect(filter).connect(humGain).connect(audioCtx.destination);
    humOsc.start();
  } catch {
    audioCtx = null;
  }
}

function setHum(speed: number, on: boolean) {
  if (!audioCtx || !humOsc || !humGain) return;
  humOsc.frequency.value = 50 + speed * 2.2;
  humGain.gain.value = on && !muted ? 0.025 : 0;
}

function gateSound() {
  if (!audioCtx || muted) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(220, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.22);
  g.gain.setValueAtTime(0.12, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.32);
}

function crashSound() {
  if (!audioCtx || muted) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(140, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(28, audioCtx.currentTime + 0.4);
  g.gain.setValueAtTime(0.2, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.5);
}

// ---------------------------------------------------------------- three setup
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const BG = new THREE.Color('#0a0618');
scene.background = BG;
scene.fog = new THREE.Fog(BG, 60, 330);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 800);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// stars
{
  const n = 700;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(320 + Math.random() * 280);
    pos.set([v.x, Math.abs(v.y) * 0.7 + 10, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: '#8fa4ff', size: 1.6, sizeAttenuation: false, fog: false })
  );
  stars.name = 'stars';
  scene.add(stars);
}

// ball
const ballGroup = new THREE.Group();
const ballCore = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R * 0.96, 24, 24),
  new THREE.MeshBasicMaterial({ color: '#062b33' })
);
const ballWire = new THREE.Mesh(
  new THREE.IcosahedronGeometry(BALL_R, 1),
  new THREE.MeshBasicMaterial({ color: '#19e6ff', wireframe: true })
);
ballGroup.add(ballCore, ballWire);
scene.add(ballGroup);

// shared geometries / materials for track
const floorGeo = new THREE.BoxGeometry(TRACK_W, 1, SEG_LEN);
const railGeo = new THREE.BoxGeometry(0.4, 0.7, SEG_LEN);
const stripeGeo = new THREE.BoxGeometry(TRACK_W, 0.12, 0.35);
const obGeo = new THREE.BoxGeometry(1.7, 1.7, 1.7);

const floorMat = new THREE.MeshBasicMaterial({ color: '#141034' });
const railMat = new THREE.MeshBasicMaterial({ color: '#19e6ff' });
const stripeMat = new THREE.MeshBasicMaterial({ color: '#ff2ea6' });
const obMat = new THREE.MeshBasicMaterial({ color: '#ff2e55' });
const obEdgeMat = new THREE.LineBasicMaterial({ color: '#ffffff' });
const obEdges = new THREE.EdgesGeometry(obGeo);
const gateMat = new THREE.MeshBasicMaterial({ color: '#a26bff' });
const gatePostGeo = new THREE.BoxGeometry(0.55, 8, 0.55);
const gateBarGeo = new THREE.BoxGeometry(TRACK_W + 1.5, 0.55, 0.55);

// ---------------------------------------------------------------- track generation
interface SegInfo {
  gap: boolean;
  gate: boolean; // gravity-flip gate at the middle of this segment
  obstacles: { x: number; z: number; side: 1 | -1 }[]; // side 1 = top, -1 = underside
}

let seed = (Math.random() * 2 ** 31) | 0;
let segMemo = new Map<number, SegInfo>();

function gateNearby(i: number, back: number): boolean {
  for (let j = Math.max(0, i - back); j < i; j++) {
    if (segInfo(j).gate) return true;
  }
  return false;
}

function segInfo(i: number): SegInfo {
  const memo = segMemo.get(i);
  if (memo) return memo;
  const z0 = i * SEG_LEN;
  const rng = mulberry32((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
  let gap = false;
  let gate = false;
  const obstacles: { x: number; z: number; side: 1 | -1 }[] = [];

  if (z0 > GAP_MIN_Z && !segInfo(i - 1).gap && !gateNearby(i, 2) && rng() < 0.1) {
    gap = true;
  }

  if (!gap && z0 > GATE_MIN_Z && !gateNearby(i, 10) && rng() < 0.09) {
    gate = true;
  }

  if (!gap && !gate && z0 > OBSTACLE_MIN_Z) {
    const chance = Math.min(0.75, 0.3 + z0 / 1800);
    if (rng() < chance) {
      const maxCount = Math.min(3, 1 + Math.floor(z0 / 500));
      const count = 1 + Math.floor(rng() * maxCount);
      const lanes = [-6, -3, 0, 3, 6].sort(() => rng() - 0.5).slice(0, count);
      for (const lane of lanes) {
        obstacles.push({
          x: lane + (rng() - 0.5) * 1.4,
          z: z0 + 3 + rng() * (SEG_LEN - 6),
          side: z0 > GATE_MIN_Z && rng() < 0.5 ? -1 : 1,
        });
      }
    }
  }

  const info = { gap, gate, obstacles };
  segMemo.set(i, info);
  return info;
}

interface SegRecord {
  group: THREE.Group;
  obs: THREE.Mesh[];
}
const segMeshes = new Map<number, SegRecord>();

function buildSeg(i: number) {
  const info = segInfo(i);
  const obs: THREE.Mesh[] = [];
  const group = new THREE.Group();

  if (!info.gap) {
    const z0 = i * SEG_LEN;
    const z1 = z0 + SEG_LEN;
    const y0 = yCenter(z0);
    const y1 = yCenter(z1);
    const x0 = xCenter(z0);
    const x1 = xCenter(z1);

    group.position.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.5, (z0 + z1) / 2);
    group.rotation.x = Math.atan2(y0 - y1, SEG_LEN);
    group.rotation.y = Math.atan2(x1 - x0, SEG_LEN);

    const floor = new THREE.Mesh(floorGeo, floorMat);
    group.add(floor);
    // rails + stripe on both faces so the underside is readable after a gravity flip
    for (const side of [1, -1]) {
      const railL = new THREE.Mesh(railGeo, railMat);
      railL.position.set(-(HALF_W + 0.2), 0.6 * side, 0);
      const railR = new THREE.Mesh(railGeo, railMat);
      railR.position.set(HALF_W + 0.2, 0.6 * side, 0);
      const stripe = new THREE.Mesh(stripeGeo, stripeMat);
      stripe.position.set(0, 0.56 * side, -SEG_LEN / 2);
      group.add(railL, railR, stripe);
    }

    if (info.gate) {
      const postL = new THREE.Mesh(gatePostGeo, gateMat);
      postL.position.set(-(HALF_W + 0.5), 0, 0);
      const postR = new THREE.Mesh(gatePostGeo, gateMat);
      postR.position.set(HALF_W + 0.5, 0, 0);
      const barTop = new THREE.Mesh(gateBarGeo, gateMat);
      barTop.position.set(0, 4, 0);
      const barBot = new THREE.Mesh(gateBarGeo, gateMat);
      barBot.position.set(0, -4, 0);
      group.add(postL, postR, barTop, barBot);
    }

    for (const o of info.obstacles) {
      const box = new THREE.Mesh(obGeo, obMat);
      const oy = o.side === 1 ? yCenter(o.z) + 0.85 : yCenter(o.z) - FLOOR_H - 0.85;
      box.position.set(o.x + xCenter(o.z), oy, o.z);
      box.add(new THREE.LineSegments(obEdges, obEdgeMat));
      scene.add(box);
      obs.push(box);
    }
  }

  scene.add(group);
  segMeshes.set(i, { group, obs });
}

function clearTrack() {
  for (const rec of segMeshes.values()) {
    scene.remove(rec.group);
    rec.obs.forEach((o) => scene.remove(o));
  }
  segMeshes.clear();
}

function updateTrack(ballZ: number) {
  const first = Math.floor(ballZ / SEG_LEN) - 3;
  for (const [i, rec] of segMeshes) {
    if (i < first || i > first + VIEW_SEGS + 4) {
      scene.remove(rec.group);
      rec.obs.forEach((o) => scene.remove(o));
      segMeshes.delete(i);
    }
  }
  for (let i = Math.max(0, first); i < first + VIEW_SEGS; i++) {
    if (!segMeshes.has(i)) buildSeg(i);
  }
}

// ---------------------------------------------------------------- game state
type Phase = 'menu' | 'run' | 'pause' | 'over';

const state = {
  phase: 'menu' as Phase,
  z: 6,
  x: xCenter(6),
  y: yCenter(6) + BALL_R,
  vy: 0,
  vx: 0,
  grounded: true,
  gravity: 1 as 1 | -1, // 1 = rolling on top, -1 = rolling on the underside
  camG: 1, // smoothed gravity for camera roll animation
  speed: SPEED_START,
  score: 0,
  topSpeed: 0,
  flips: 0,
  best: Number(localStorage.getItem('neonroll_best') || 0),
  runs: Number(localStorage.getItem('neonroll_runs') || 0),
  total: Number(localStorage.getItem('neonroll_total') || 0),
};

let lastMilestone = 0;
let newBestToastShown = false;

let steer = 0; // -1 .. 1

// ---------------------------------------------------------------- UI refs
const $ = (id: string) => document.getElementById(id)!;
const hudEl = $('hud');
const scoreEl = $('score');
const speedEl = $('speed');
const speedFillEl = $('speedfill');
const gravChipEl = $('gravChip');
const gravLabelEl = $('gravLabel');
const menuEl = $('menu');
const pauseEl = $('pause');
const overEl = $('over');
const finalScoreEl = $('finalScore');
const bestMenuEl = $('bestMenu');
const statsMenuEl = $('statsMenu');
const statSpeedEl = $('statSpeed');
const statFlipsEl = $('statFlips');
const statBestEl = $('statBest');
const newBestEl = $('newBest');
const toastEl = $('toast');
const goEl = $('go');
const vignetteEl = $('vignette');

function showBest() {
  bestMenuEl.textContent = state.best > 0 ? `BEST ${state.best}m` : '';
  const km = (state.total / 1000).toFixed(1);
  statsMenuEl.textContent = state.runs > 0 ? `${state.runs} RUNS · ${km} KM ROLLED` : '';
}
showBest();

// ---------------------------------------------------------------- toasts & flashes
let toastTimer = 0;

function toast(text: string, kind: '' | 'gold' | 'purple' = '') {
  toastEl.textContent = text;
  toastEl.className = kind; // resets animation classes
  toastEl.classList.remove('hidden');
  void (toastEl as HTMLElement).offsetWidth; // restart css animation
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 1300);
}

function showGo() {
  goEl.classList.remove('hidden');
  void (goEl as HTMLElement).offsetWidth;
  window.setTimeout(() => goEl.classList.add('hidden'), 800);
}

// ---------------------------------------------------------------- sound toggle
const soundBtns = [$('soundBtn'), $('soundBtnMenu')];

function renderSoundBtns() {
  for (const b of soundBtns) {
    b.innerHTML = muted ? '&#128263;' : '&#128266;';
    b.classList.toggle('muted', muted);
  }
}
renderSoundBtns();

function toggleSound() {
  muted = !muted;
  localStorage.setItem('neonroll_muted', muted ? '1' : '0');
  renderSoundBtns();
  setHum(state.speed, state.phase === 'run');
}
soundBtns.forEach((b) => b.addEventListener('click', toggleSound));

// ---------------------------------------------------------------- input
const keys: Record<string, boolean> = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space' || e.code === 'Enter') {
    if (state.phase === 'menu' || state.phase === 'over') startRun();
    else if (state.phase === 'pause') resumeRun();
  }
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (state.phase === 'run') pauseRun();
    else if (state.phase === 'pause') resumeRun();
  }
});
window.addEventListener('keyup', (e) => (keys[e.code] = false));

let touchSide = 0;
window.addEventListener('pointerdown', (e) => {
  initAudio();
  if (state.phase === 'run') touchSide = e.clientX < window.innerWidth / 2 ? -1 : 1;
});
window.addEventListener('pointermove', (e) => {
  if (touchSide !== 0) touchSide = e.clientX < window.innerWidth / 2 ? -1 : 1;
});
window.addEventListener('pointerup', () => (touchSide = 0));
window.addEventListener('pointercancel', () => (touchSide = 0));

$('playBtn').addEventListener('click', startRun);
$('retryBtn').addEventListener('click', startRun);
$('pauseRestartBtn').addEventListener('click', startRun);
$('pauseBtn').addEventListener('click', () => pauseRun());
$('resumeBtn').addEventListener('click', () => resumeRun());
$('menuBtn').addEventListener('click', () => goToMenu());
$('pauseMenuBtn').addEventListener('click', () => goToMenu());

function readSteer(): number {
  let s = 0;
  if (keys['ArrowLeft'] || keys['KeyA']) s -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) s += 1;
  if (s === 0) s = touchSide;
  return s;
}

// ---------------------------------------------------------------- run control
function startRun() {
  initAudio();
  audioCtx?.resume();
  seed = (Math.random() * 2 ** 31) | 0;
  segMemo = new Map();
  clearTrack();

  state.phase = 'run';
  state.z = 6;
  state.x = xCenter(6);
  state.y = yCenter(6) + BALL_R;
  state.vy = 0;
  state.vx = 0;
  state.grounded = true;
  state.gravity = 1;
  state.camG = 1;
  state.speed = SPEED_START;
  state.score = 0;
  state.topSpeed = 0;
  state.flips = 0;
  lastMilestone = 0;
  newBestToastShown = false;

  // snap the camera behind the ball instead of lerping across the whole track
  camera.position.set(state.x, state.y + 5.5, state.z - 11);
  camera.up.set(0, 1, 0);

  gravChipEl.classList.remove('flipped');
  gravLabelEl.textContent = 'TOP';
  toastEl.classList.add('hidden');
  menuEl.classList.add('hidden');
  overEl.classList.add('hidden');
  pauseEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  showGo();
  // CrazyGames SDK: window.CrazyGames.SDK.game.gameplayStart()
}

function pauseRun() {
  if (state.phase !== 'run') return;
  state.phase = 'pause';
  setHum(0, false);
  pauseEl.classList.remove('hidden');
}

function resumeRun() {
  if (state.phase !== 'pause') return;
  state.phase = 'run';
  pauseEl.classList.add('hidden');
}

function goToMenu() {
  state.phase = 'menu';
  setHum(0, false);
  pauseEl.classList.add('hidden');
  overEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  showBest();
  menuEl.classList.remove('hidden');
}

// count-up animation for the final score (setTimeout so it works even when RAF is throttled)
function animateFinalScore(to: number) {
  const dur = 700;
  const t0 = performance.now();
  const tickUp = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    finalScoreEl.textContent = `${Math.round(to * eased)}m`;
    if (p < 1) window.setTimeout(tickUp, 16);
  };
  tickUp();
}

function die() {
  if (state.phase !== 'run') return;
  state.phase = 'over';
  crashSound();
  setHum(0, false);
  vignetteEl.classList.remove('flash');
  void (vignetteEl as HTMLElement).offsetWidth; // restart css animation
  vignetteEl.classList.add('flash');

  const isNewBest = state.score > 0 && state.score > state.best;
  state.best = Math.max(state.best, state.score);
  state.runs += 1;
  state.total += state.score;
  localStorage.setItem('neonroll_best', String(state.best));
  localStorage.setItem('neonroll_runs', String(state.runs));
  localStorage.setItem('neonroll_total', String(state.total));
  showBest();

  statSpeedEl.textContent = `${Math.round(state.topSpeed * 3.6)}`;
  statFlipsEl.textContent = `${state.flips}`;
  statBestEl.textContent = `${state.best}`;
  newBestEl.classList.toggle('hidden', !isNewBest);

  setTimeout(() => {
    hudEl.classList.add('hidden');
    overEl.classList.remove('hidden');
    animateFinalScore(state.score);
  }, 500);
  // CrazyGames SDK: gameplayStop() + đây là chỗ gắn rewarded ad "REVIVE"
}

// ---------------------------------------------------------------- physics
// resting ball-center height for a given gravity side
function restY(z: number, g: 1 | -1): number {
  return g === 1 ? yCenter(z) + BALL_R : yCenter(z) - FLOOR_H - BALL_R;
}

function flipGravity() {
  state.gravity = state.gravity === 1 ? -1 : 1;
  state.y = restY(state.z, state.gravity); // phase through the slab
  state.vy = 0;
  state.grounded = true;
  state.flips += 1;
  gateSound();
  toast('GRAVITY FLIP!', 'purple');
  gravChipEl.classList.toggle('flipped', state.gravity === -1);
  gravLabelEl.textContent = state.gravity === 1 ? 'TOP' : 'UNDER';
  vignetteEl.classList.remove('flash', 'flash-purple');
  void (vignetteEl as HTMLElement).offsetWidth;
  vignetteEl.classList.add('flash-purple');
}

function step(dt: number) {
  state.speed = Math.min(SPEED_MAX, state.speed + ACCEL * dt);
  state.topSpeed = Math.max(state.topSpeed, state.speed);

  // milestone + new-best toasts
  const milestone = Math.floor(state.score / 100);
  if (milestone > lastMilestone) {
    lastMilestone = milestone;
    toast(`${milestone * 100}m`);
  }
  if (!newBestToastShown && state.best > 0 && state.score > state.best) {
    newBestToastShown = true;
    toast('NEW BEST!', 'gold');
  }

  // lateral
  const targetVx = readSteer() * state.speed * LAT_FACTOR;
  state.vx += (targetVx - state.vx) * Math.min(1, dt * 8);
  state.x += state.vx * dt;

  // forward
  const zPrev = state.z;
  state.z += state.speed * dt;
  state.score = Math.max(state.score, Math.floor(state.z - 6));

  const segIdx = Math.floor(state.z / SEG_LEN);
  const info = segInfo(segIdx);
  const g = state.gravity;
  const groundY = restY(state.z, g);
  const onTrack = !info.gap && Math.abs(state.x - xCenter(state.z)) < HALF_W + 0.3;

  // gravity gate at the middle of a gate segment
  if (info.gate) {
    const zGate = segIdx * SEG_LEN + SEG_LEN / 2;
    if (zPrev < zGate && state.z >= zGate && Math.abs(state.y - groundY) < 2.5) {
      flipGravity();
      return;
    }
  }

  if (state.grounded) {
    if (onTrack) {
      state.y = groundY;
    } else {
      state.grounded = false;
      state.vy = -state.speed * 0.28; // keep downhill momentum (track descends in +z)
    }
  } else {
    state.vy -= g * GRAVITY * dt;
    state.y += state.vy * dt;
    // forgiving landing window on the current gravity side
    const above = (state.y - groundY) * g; // >0 means "not yet reached the surface"
    if (onTrack && above <= 0 && above > -1.4) {
      state.y = groundY;
      state.vy = 0;
      state.grounded = true;
    }
    if ((state.y - groundY) * g < -3) die();
  }

  // obstacles (check neighbouring segments, same side only)
  if (Math.abs(state.y - groundY) < 1.5) {
    for (let i = segIdx - 1; i <= segIdx + 1; i++) {
      if (i < 0) continue;
      for (const o of segInfo(i).obstacles) {
        if (o.side !== g) continue;
        const ox = o.x + xCenter(o.z);
        if (Math.abs(state.z - o.z) < 0.85 + BALL_R && Math.abs(state.x - ox) < 0.85 + BALL_R) {
          die();
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- render loop
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let last = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
}

function tick(dt: number) {
  if (state.phase === 'run') {
    step(dt);
    setHum(state.speed, true);
    scoreEl.textContent = `${state.score}`;
    speedEl.textContent = `${Math.round(state.speed * 3.6)} km/h`;
    speedFillEl.style.width = `${Math.round((state.speed / SPEED_MAX) * 100)}%`;
  }

  updateTrack(state.z);

  // ball visual
  ballGroup.position.set(state.x, state.y, state.z);
  ballWire.rotation.x += (state.phase === 'run' ? state.speed / BALL_R : 0.6) * dt;
  ballCore.rotation.x = ballWire.rotation.x;

  // camera (rolls 180° when gravity is flipped)
  state.camG += (state.gravity - state.camG) * Math.min(1, dt * 4);
  const roll = ((1 - state.camG) / 2) * Math.PI; // camG 1 -> 0 rad, camG -1 -> PI
  const back = 11;
  const camTargetPos = camPos.set(
    state.x * 0.55 + xCenter(state.z) * 0.45,
    state.y + 5.5 * state.camG,
    state.z - back
  );
  camera.position.lerp(camTargetPos, Math.min(1, dt * 6));
  camera.up.set(Math.sin(roll), Math.cos(roll), 0);
  camLook.set(state.x, state.y + 1.2 * state.camG, state.z + 15);
  camera.lookAt(camLook);
  camera.fov = 75 + (state.speed / SPEED_MAX) * 14;
  camera.updateProjectionMatrix();

  const stars = scene.getObjectByName('stars');
  if (stars) stars.position.copy(camera.position);

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// debug hook for automated testing
(window as unknown as Record<string, unknown>).__nr = {
  state,
  die,
  startRun,
  segInfo,
  flipGravity,
  tick, // manual stepping for automated tests (works even when RAF is throttled)
};
