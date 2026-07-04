import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
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
const GEM_MIN_Z = 100;
const GEM_SCORE = 15;
const ITEM_MIN_Z = 250;
const GATE_MIN_Z = 240;
const MOVER_MIN_Z = 400;
const GAP_MIN_Z = 380;
const WALL_MIN_Z = 800;
const ZONE_LEN = 500; // meters per color zone
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

let musicGain: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

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

    musicGain = audioCtx.createGain();
    musicGain.gain.value = 0.1;
    musicGain.connect(audioCtx.destination);

    noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.06, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  } catch {
    audioCtx = null;
  }
}

function setHum(speed: number, on: boolean) {
  if (!audioCtx || !humOsc || !humGain) return;
  humOsc.frequency.value = 50 + speed * 2.2;
  humGain.gain.value = on && !muted ? 0.013 : 0;
}

// ---------- procedural synthwave sequencer (Am / Am / F / G, 104 BPM)
const BPM = 104;
const STEP16 = 60 / BPM / 4;
const BEAT = 60 / BPM;
const BASS_LINE = [55, 55, 43.65, 49]; // A1 A1 F1 G1
const ARP_CHORDS = [
  [220, 261.63, 329.63, 440], // Am
  [220, 261.63, 329.63, 440],
  [174.61, 220, 261.63, 349.23], // F
  [196, 246.94, 293.66, 392], // G
];
const ARP_PATTERN = [0, 2, 1, 3, 2, 0, 3, 1];

let musicOn = false;
let musicStep = 0;
let musicNextTime = 0;
let musicStartTime = 0;

function mnote(freq: number, t: number, dur: number, vol: number, type: OscillatorType, filterHz = 0) {
  if (!audioCtx || !musicGain) return;
  const o = audioCtx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  if (filterHz > 0) {
    const f = audioCtx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterHz;
    o.connect(f).connect(g).connect(musicGain);
  } else {
    o.connect(g).connect(musicGain);
  }
  o.start(t);
  o.stop(t + dur + 0.05);
}

function mkick(t: number) {
  if (!audioCtx || !musicGain) return;
  const o = audioCtx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(g).connect(musicGain);
  o.start(t);
  o.stop(t + 0.16);
}

function mhat(t: number) {
  if (!audioCtx || !musicGain || !noiseBuf) return;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const f = audioCtx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 6200;
  const g = audioCtx.createGain();
  g.gain.value = 0.16;
  src.connect(f).connect(g).connect(musicGain);
  src.start(t);
}

function playStep(step: number, t: number) {
  const bar = Math.floor(step / 16) % 4;
  if (step % 4 === 0) mkick(t);
  if (step % 4 === 2) mhat(t);
  if (step % 2 === 0) mnote(BASS_LINE[bar], t, 0.19, 0.3, 'sawtooth', 260);
  const arp = ARP_CHORDS[bar][ARP_PATTERN[step % 8] % 4];
  mnote(arp * (step % 16 >= 8 ? 2 : 1), t, 0.1, 0.09, 'triangle');
}

function startMusic() {
  if (!audioCtx) return;
  musicOn = true;
  musicStep = 0;
  musicNextTime = audioCtx.currentTime + 0.05;
  musicStartTime = musicNextTime;
}

function stopMusic() {
  musicOn = false;
}

function musicTick() {
  if (!musicOn || !audioCtx || muted) return;
  const ahead = audioCtx.currentTime + 0.2;
  while (musicNextTime < ahead) {
    playStep(musicStep, musicNextTime);
    musicStep = (musicStep + 1) % 64;
    musicNextTime += STEP16;
  }
}

// 0..1 spike right on each beat — drives the beat-synced visuals
function beatPulse(): number {
  if (!musicOn || !audioCtx || muted) return 0;
  const ph = ((audioCtx.currentTime - musicStartTime) % BEAT) / BEAT;
  if (ph < 0) return 0; // context still suspended (no user gesture yet)
  return Math.pow(Math.max(0, 1 - ph * 2.4), 2);
}

function blip(freqFrom: number, freqTo: number, dur: number, type: OscillatorType = 'sine', gain = 0.12) {
  if (!audioCtx || muted) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freqFrom, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(freqTo, audioCtx.currentTime + dur);
  g.gain.setValueAtTime(gain, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur + 0.05);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + dur + 0.1);
}

const gateSound = () => blip(220, 880, 0.22);
const crashSound = () => blip(140, 28, 0.4, 'square', 0.2);
const pickupSound = () => {
  blip(520, 1040, 0.12);
  setTimeout(() => blip(780, 1560, 0.12), 70);
};
const shieldBreakSound = () => blip(600, 90, 0.25, 'square', 0.16);

const gemSound = () => blip(900, 1500, 0.09, 'sine', 0.08);

// ---------------------------------------------------------------- CrazyGames SDK (no-ops outside the platform)
interface CGAdCallbacks {
  adFinished: () => void;
  adError: (e?: unknown) => void;
  adStarted?: () => void;
}
interface CGSDK {
  init?: () => Promise<void>;
  game?: { gameplayStart?: () => void; gameplayStop?: () => void; happytime?: () => void };
  ad?: { requestAd?: (t: 'rewarded' | 'midgame', cb: CGAdCallbacks) => void };
}
const cg = (): CGSDK | undefined => (window as unknown as { CrazyGames?: { SDK?: CGSDK } }).CrazyGames?.SDK;
let sdkReady = false;
void (async () => {
  try {
    await cg()?.init?.();
    sdkReady = !!cg();
  } catch {
    sdkReady = false;
  }
})();
const sdkStart = () => { try { cg()?.game?.gameplayStart?.(); } catch { /* no-op */ } };
const sdkStop = () => { try { cg()?.game?.gameplayStop?.(); } catch { /* no-op */ } };
const sdkHappy = () => { try { cg()?.game?.happytime?.(); } catch { /* no-op */ } };

function showRewardedAd(onFinish: () => void, onFail: () => void) {
  const s = cg();
  if (!sdkReady || !s?.ad?.requestAd) {
    window.setTimeout(onFinish, 400); // dev fallback: pretend the ad played
    return;
  }
  try {
    s.ad.requestAd('rewarded', { adFinished: onFinish, adError: onFail, adStarted: () => setHum(0, false) });
  } catch {
    onFail();
  }
}

// ---------------------------------------------------------------- three setup
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0618');
scene.fog = new THREE.Fog(new THREE.Color('#0a0618'), 60, 330);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 800);

// bloom post-processing (toggleable — heavy on weak mobile GPUs)
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.5, 0.28));

let fxOn =
  (localStorage.getItem('neonroll_fx') ?? (window.matchMedia('(pointer: coarse)').matches ? '0' : '1')) === '1';

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// stars
let starsMat: THREE.PointsMaterial;
{
  const n = 700;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(320 + Math.random() * 280);
    pos.set([v.x, Math.abs(v.y) * 0.7 + 10, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starsMat = new THREE.PointsMaterial({ color: '#8fa4ff', size: 1.6, sizeAttenuation: false, fog: false });
  const stars = new THREE.Points(geo, starsMat);
  stars.name = 'stars';
  scene.add(stars);
}

// ---------------------------------------------------------------- gem wallet & ownership (shop currency)
let gemWallet = Number(localStorage.getItem('neonroll_gems') || 0);
const ownedSkins = new Set<string>(JSON.parse(localStorage.getItem('neonroll_owned_skins') || '[]') as string[]);
const ownedMaps = new Set<number>(JSON.parse(localStorage.getItem('neonroll_owned_maps') || '[]') as number[]);

function saveWallet() {
  localStorage.setItem('neonroll_gems', String(gemWallet));
  localStorage.setItem('neonroll_owned_skins', JSON.stringify([...ownedSkins]));
  localStorage.setItem('neonroll_owned_maps', JSON.stringify([...ownedMaps]));
}

// ---------------------------------------------------------------- zones (map variety)
interface Zone {
  name: string;
  floor: string;
  rail: string;
  stripe: string;
  ob: string;
  fog: string;
  star: string;
  price: number; // 0 = free, otherwise purchasable in the shop
}

const ZONES: Zone[] = [
  { name: 'NEON CITY', floor: '#141034', rail: '#19e6ff', stripe: '#ff2ea6', ob: '#ff2e55', fog: '#0a0618', star: '#8fa4ff', price: 0 },
  { name: 'INFERNO', floor: '#200a06', rail: '#ffb020', stripe: '#ff5722', ob: '#ff1744', fog: '#170503', star: '#ffb28a', price: 0 },
  { name: 'TOXIC', floor: '#0a1a0c', rail: '#7fff00', stripe: '#00e676', ob: '#ff2e55', fog: '#04120a', star: '#a8ffb0', price: 0 },
  { name: 'FROST', floor: '#0d1626', rail: '#b3e5fc', stripe: '#40c4ff', ob: '#ff2e55', fog: '#0a1220', star: '#e0f2ff', price: 0 },
  { name: 'VOID', floor: '#16081f', rail: '#d500f9', stripe: '#ffd54d', ob: '#ff2e55', fog: '#0d0214', star: '#e2b0ff', price: 0 },
  { name: 'SUNSET DRIVE', floor: '#1d0f24', rail: '#ff8a3d', stripe: '#ff3d81', ob: '#ff1744', fog: '#150818', star: '#ffc9a0', price: 200 },
  { name: 'DEEP OCEAN', floor: '#04141f', rail: '#2ee6c8', stripe: '#1e88e5', ob: '#ff2e55', fog: '#02101a', star: '#a8e6ff', price: 300 },
  { name: 'SAKURA', floor: '#1f1420', rail: '#ffb7d5', stripe: '#ff5c8a', ob: '#ff1744', fog: '#170d18', star: '#ffd9e8', price: 400 },
  { name: 'GOLDEN DESERT', floor: '#201704', rail: '#ffd54d', stripe: '#ff9100', ob: '#ff2e55', fog: '#171004', star: '#ffe9b0', price: 500 },
  { name: 'BLOOD MOON', floor: '#1a0505', rail: '#ff6b6b', stripe: '#ff9e80', ob: '#f5f5f5', fog: '#120303', star: '#ff8a80', price: 700 },
];

// only owned maps enter the zone rotation (first five are free)
function zoneRotation(): Zone[] {
  return ZONES.filter((z, i) => z.price === 0 || ownedMaps.has(i));
}

let zoneIdx = 0;
const zoneTarget = {
  floor: new THREE.Color(ZONES[0].floor),
  rail: new THREE.Color(ZONES[0].rail),
  stripe: new THREE.Color(ZONES[0].stripe),
  ob: new THREE.Color(ZONES[0].ob),
  fog: new THREE.Color(ZONES[0].fog),
  star: new THREE.Color(ZONES[0].star),
};
// smoothly-lerped base colors — materials are derived from these each frame
// so the beat pulse can brighten rails/stripes without fighting the lerp
const zoneBase = {
  floor: new THREE.Color(ZONES[0].floor),
  rail: new THREE.Color(ZONES[0].rail),
  stripe: new THREE.Color(ZONES[0].stripe),
  ob: new THREE.Color(ZONES[0].ob),
  fog: new THREE.Color(ZONES[0].fog),
  star: new THREE.Color(ZONES[0].star),
};

function setZoneTargets(zi: number) {
  const rot = zoneRotation();
  const zn = rot[zi % rot.length];
  zoneTarget.floor.set(zn.floor);
  zoneTarget.rail.set(zn.rail);
  zoneTarget.stripe.set(zn.stripe);
  zoneTarget.ob.set(zn.ob);
  zoneTarget.fog.set(zn.fog);
  zoneTarget.star.set(zn.star);
}

// ---------------------------------------------------------------- ball + skins
const ballGroup = new THREE.Group(); // world position
const ballSpin = new THREE.Group(); // rolling rotation
ballGroup.add(ballSpin);
scene.add(ballGroup);

// shield bubble
const shieldMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R * 1.35, 20, 20),
  new THREE.MeshBasicMaterial({ color: '#19e6ff', transparent: true, opacity: 0.22, wireframe: true })
);
shieldMesh.visible = false;
ballGroup.add(shieldMesh);

// ---------------------------------------------------------------- particles
interface Particle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  max: number;
}

const particlePool: Particle[] = [];
{
  const pGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  for (let i = 0; i < 56; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true });
    const mesh = new THREE.Mesh(pGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    particlePool.push({ mesh, mat, vel: new THREE.Vector3(), life: 0, max: 1 });
  }
}

function burst(x: number, y: number, z: number, color: string, count = 16, speed = 8) {
  let n = 0;
  for (const p of particlePool) {
    if (p.life > 0) continue;
    p.mesh.visible = true;
    p.mat.color.set(color);
    p.mat.opacity = 1;
    p.mesh.position.set(x, y, z);
    p.mesh.scale.setScalar(1);
    p.vel
      .set(Math.random() - 0.5, Math.random() - 0.25, Math.random() - 0.5)
      .normalize()
      .multiplyScalar(speed * (0.5 + Math.random() * 0.9));
    p.life = p.max = 0.55 + Math.random() * 0.5;
    if (++n >= count) break;
  }
}

function tickParticles(dt: number) {
  for (const p of particlePool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.mesh.visible = false;
      continue;
    }
    p.vel.y -= 22 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    const k = p.life / p.max;
    p.mesh.scale.setScalar(Math.max(0.05, k));
    p.mat.opacity = k;
    p.mesh.rotation.x += dt * 6;
    p.mesh.rotation.y += dt * 4;
  }
}

// ---------------------------------------------------------------- ball trail (additive ribbon)
const TRAIL_N = 30;
const trailPts: { x: number; y: number; z: number }[] = [];
const trailGeo = new THREE.BufferGeometry();
{
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
  const idx: number[] = [];
  for (let i = 0; i < TRAIL_N - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeo.setIndex(idx);
}
const trailMesh = new THREE.Mesh(
  trailGeo,
  new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
);
trailMesh.frustumCulled = false;
scene.add(trailMesh);

function updateTrail(tint: THREE.Color) {
  if (trailPts.length < 2) {
    trailMesh.visible = false;
    return;
  }
  trailMesh.visible = true;
  const pos = trailGeo.getAttribute('position') as THREE.BufferAttribute;
  const col = trailGeo.getAttribute('color') as THREE.BufferAttribute;
  const n = trailPts.length;
  for (let i = 0; i < TRAIL_N; i++) {
    const p = trailPts[Math.min(i, n - 1)];
    const k = Math.min(i, n - 1) / (n - 1); // 0 = oldest, 1 = newest
    const w = 0.12 + 0.5 * k;
    pos.setXYZ(i * 2, p.x - w, p.y, p.z);
    pos.setXYZ(i * 2 + 1, p.x + w, p.y, p.z);
    const b = k * k * 0.85; // additive: dark = invisible
    col.setXYZ(i * 2, tint.r * b, tint.g * b, tint.b * b);
    col.setXYZ(i * 2 + 1, tint.r * b, tint.g * b, tint.b * b);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
}

function makeTexture(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const sphereGeo = new THREE.SphereGeometry(BALL_R * 0.98, 28, 28);

function texturedBall(draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.Object3D {
  return new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ map: makeTexture(draw) }));
}

type CanvasDraw = (ctx: CanvasRenderingContext2D, s: number) => void;

interface Skin {
  id: string;
  name: string;
  lockText: string; // achievement condition text ('' if purchasable/free)
  price: number; // 0 = achievement/free, otherwise gem price in the shop
  icon: CanvasDraw; // used for shop card thumbnails
  unlocked: () => boolean;
  build: () => THREE.Object3D;
}

// ---------- texture painters (shared by ball material + shop thumbnails)
const drawBasket: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#e65f1e';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#241205';
  ctx.lineWidth = s * 0.035;
  ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(-s * 0.1, s / 2, s * 0.42, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(s * 1.1, s / 2, s * 0.42, 0, Math.PI * 2); ctx.stroke();
};

const drawSoccer: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#111111';
  const spots = [[0.5, 0.5], [0.15, 0.25], [0.85, 0.25], [0.15, 0.75], [0.85, 0.75], [0.5, 0.06], [0.5, 0.94]];
  for (const [px, py] of spots) {
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      const x = px * s + Math.cos(a) * s * 0.09;
      const y = py * s + Math.sin(a) * s * 0.09;
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
};

const drawEight: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#0c0c10';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#f4f4f4';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0c0c10';
  ctx.font = `bold ${Math.round(s * 0.24)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('8', s / 2, s / 2 + s * 0.01);
};

const drawTennis: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#c8e94a';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#f8f8f8';
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  for (let x = 0; x <= s; x += 4) {
    const y = s * 0.28 + Math.sin((x / s) * Math.PI * 2) * s * 0.12;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let x = 0; x <= s; x += 4) {
    const y = s * 0.72 - Math.sin((x / s) * Math.PI * 2) * s * 0.12;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const drawBeach: CanvasDraw = (ctx, s) => {
  const cols = ['#ff4d4d', '#ffd54d', '#4dff88', '#4dc3ff', '#b34dff', '#ffffff'];
  const w = s / cols.length;
  cols.forEach((c, k) => {
    ctx.fillStyle = c;
    ctx.fillRect(k * w, 0, w + 1, s);
  });
};

const drawEarth: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#2e9e4f';
  const rng = mulberry32(7);
  for (let k = 0; k < 14; k++) {
    const bx = rng() * s, by = rng() * s, br = (0.06 + rng() * 0.1) * s;
    ctx.beginPath();
    ctx.ellipse(bx, by, br * (0.7 + rng()), br, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (let k = 0; k < 8; k++) {
    const bx = rng() * s, by = rng() * s;
    ctx.beginPath();
    ctx.ellipse(bx, by, s * 0.12, s * 0.03, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawDice: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#c62828';
  const p = s * 0.26, r = s * 0.09;
  for (const [px, py] of [[p, p], [s - p, p], [p, s - p], [s - p, s - p]]) {
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
};

const drawDisco: CanvasDraw = (ctx, s) => {
  const n = 10, w = s / n;
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      const v = 150 + ((ix * 7 + iy * 13) % 6) * 20;
      ctx.fillStyle = `rgb(${v},${v},${v + 15})`;
      ctx.fillRect(ix * w + 1, iy * w + 1, w - 2, w - 2);
    }
  }
};

const drawWatermelon: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#ff5252';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(0, s * 0.82, s, s * 0.18);
  ctx.fillStyle = '#a5d6a7';
  ctx.fillRect(0, s * 0.78, s, s * 0.05);
  ctx.fillStyle = '#1b1b1b';
  const rng = mulberry32(3);
  for (let k = 0; k < 16; k++) {
    ctx.beginPath();
    ctx.ellipse(rng() * s, rng() * s * 0.72, s * 0.02, s * 0.04, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawPixel: CanvasDraw = (ctx, s) => {
  const cols = ['#ff2e55', '#19e6ff', '#ffd54d', '#7fff00', '#d500f9', '#ff8a3d'];
  const n = 8, w = s / n;
  const rng = mulberry32(11);
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
      ctx.fillRect(ix * w, iy * w, w + 1, w + 1);
    }
  }
};

const drawCandy: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#ff4d6d';
  const bands = 6;
  for (let k = 0; k < bands; k++) {
    ctx.save();
    ctx.translate(0, (k / bands) * s * 2 - s * 0.5);
    ctx.rotate(-0.35);
    ctx.fillRect(-s * 0.3, 0, s * 1.6, s * 0.09);
    ctx.restore();
  }
};

const drawEye: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#f6f2ec';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#d05050';
  ctx.lineWidth = s * 0.012;
  const rng = mulberry32(5);
  for (let k = 0; k < 9; k++) {
    ctx.beginPath();
    ctx.moveTo(rng() * s, rng() * s);
    ctx.quadraticCurveTo(rng() * s, rng() * s, rng() * s, rng() * s);
    ctx.stroke();
  }
  ctx.fillStyle = '#2e86c1';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(s * 0.56, s * 0.44, s * 0.035, 0, Math.PI * 2); ctx.fill();
};

const drawLava: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#1a0a04';
  ctx.fillRect(0, 0, s, s);
  const rng = mulberry32(13);
  for (let k = 0; k < 26; k++) {
    ctx.fillStyle = k % 2 ? '#ff6d00' : '#ff3d00';
    ctx.beginPath();
    ctx.ellipse(rng() * s, rng() * s, (0.03 + rng() * 0.09) * s, (0.02 + rng() * 0.05) * s, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ffd180';
  for (let k = 0; k < 8; k++) {
    ctx.beginPath();
    ctx.arc(rng() * s, rng() * s, s * 0.015, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawGalaxy: CanvasDraw = (ctx, s) => {
  const grad = ctx.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.7);
  grad.addColorStop(0, '#7e57c2');
  grad.addColorStop(0.5, '#1a0a3c');
  grad.addColorStop(1, '#07031a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  const rng = mulberry32(17);
  for (let k = 0; k < 90; k++) {
    const v = 180 + Math.floor(rng() * 75);
    ctx.fillStyle = `rgb(${v},${v},255)`;
    ctx.fillRect(rng() * s, rng() * s, 2, 2);
  }
  ctx.strokeStyle = 'rgba(179,136,255,0.5)';
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  ctx.ellipse(s / 2, s / 2, s * 0.33, s * 0.12, 0.6, 0, Math.PI * 2);
  ctx.stroke();
};

const drawGold: CanvasDraw = (ctx, s) => {
  const grad = ctx.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, '#ffe082');
  grad.addColorStop(0.45, '#ffb300');
  grad.addColorStop(0.55, '#ff8f00');
  grad.addColorStop(1, '#ffd54d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.save();
  ctx.rotate(-0.4);
  ctx.fillRect(-s * 0.2, s * 0.25, s * 1.5, s * 0.06);
  ctx.fillRect(-s * 0.2, s * 0.4, s * 1.5, s * 0.025);
  ctx.restore();
};

// icon-only painters for skins built from geometry rather than a texture
const iconNeon: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#062b33';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#19e6ff';
  ctx.lineWidth = s * 0.03;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.ellipse(s / 2, s / 2, s * 0.38, s * 0.16, (k / 3) * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
  }
};

const iconDiamond: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#04222b';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#7ff0ff';
  ctx.beginPath();
  ctx.moveTo(s / 2, s * 0.08);
  ctx.lineTo(s * 0.9, s / 2);
  ctx.lineTo(s / 2, s * 0.92);
  ctx.lineTo(s * 0.1, s / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = s * 0.02;
  ctx.stroke();
};

const iconBubble: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#0a1a26';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(191,232,255,0.35)';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(191,232,255,0.8)';
  ctx.lineWidth = s * 0.02;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.ellipse(s * 0.38, s * 0.36, s * 0.09, s * 0.05, -0.6, 0, Math.PI * 2); ctx.fill();
};

const iconHolo: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#03141a';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#19e6ff';
  ctx.lineWidth = s * 0.022;
  for (let k = 1; k <= 4; k++) {
    ctx.globalAlpha = 1 - k * 0.18;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.1 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

const iconBlackhole: CanvasDraw = (ctx, s) => {
  ctx.fillStyle = '#0d0d12';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#ff9100';
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  ctx.ellipse(s / 2, s / 2, s * 0.36, s * 0.14, -0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2); ctx.fill();
};

const SKINS: Skin[] = [
  {
    id: 'neon', name: 'NEON CORE', lockText: '', price: 0, icon: iconNeon,
    unlocked: () => true,
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.96, 24, 24), new THREE.MeshBasicMaterial({ color: '#062b33' })));
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1), new THREE.MeshBasicMaterial({ color: '#19e6ff', wireframe: true })));
      return g;
    },
  },
  { id: 'basket', name: 'BASKETBALL', lockText: 'BEST 150m', price: 0, icon: drawBasket, unlocked: () => state.best >= 150, build: () => texturedBall(drawBasket) },
  { id: 'soccer', name: 'SOCCER BALL', lockText: 'BEST 300m', price: 0, icon: drawSoccer, unlocked: () => state.best >= 300, build: () => texturedBall(drawSoccer) },
  { id: 'eight', name: '8-BALL', lockText: 'BEST 500m', price: 0, icon: drawEight, unlocked: () => state.best >= 500, build: () => texturedBall(drawEight) },
  { id: 'tennis', name: 'TENNIS', lockText: 'TOTAL 2 KM', price: 0, icon: drawTennis, unlocked: () => state.total >= 2000, build: () => texturedBall(drawTennis) },
  { id: 'beach', name: 'BEACH BALL', lockText: 'TOTAL 5 KM', price: 0, icon: drawBeach, unlocked: () => state.total >= 5000, build: () => texturedBall(drawBeach) },
  { id: 'earth', name: 'PLANET EARTH', lockText: 'TOTAL 10 KM', price: 0, icon: drawEarth, unlocked: () => state.total >= 10000, build: () => texturedBall(drawEarth) },
  {
    id: 'dice', name: 'LUCKY DICE', lockText: '15 RUNS', price: 0, icon: drawDice,
    unlocked: () => state.runs >= 15,
    build: () =>
      new THREE.Mesh(new THREE.BoxGeometry(BALL_R * 1.5, BALL_R * 1.5, BALL_R * 1.5), new THREE.MeshBasicMaterial({ map: makeTexture(drawDice) })),
  },
  {
    id: 'diamond', name: 'DIAMOND', lockText: 'BEST 800m', price: 0, icon: iconDiamond,
    unlocked: () => state.best >= 800,
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(BALL_R * 1.05, 0), new THREE.MeshBasicMaterial({ color: '#7ff0ff', transparent: true, opacity: 0.85 })));
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(BALL_R * 1.06, 0), new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true })));
      return g;
    },
  },
  { id: 'disco', name: 'DISCO BALL', lockText: '30 RUNS', price: 0, icon: drawDisco, unlocked: () => state.runs >= 30, build: () => texturedBall(drawDisco) },
  // ---------- shop skins (bought with gems)
  { id: 'melon', name: 'WATERMELON', lockText: '', price: 100, icon: drawWatermelon, unlocked: () => ownedSkins.has('melon'), build: () => texturedBall(drawWatermelon) },
  { id: 'pixel', name: 'PIXEL POP', lockText: '', price: 150, icon: drawPixel, unlocked: () => ownedSkins.has('pixel'), build: () => texturedBall(drawPixel) },
  { id: 'candy', name: 'CANDY SWIRL', lockText: '', price: 200, icon: drawCandy, unlocked: () => ownedSkins.has('candy'), build: () => texturedBall(drawCandy) },
  { id: 'eye', name: 'THE EYE', lockText: '', price: 250, icon: drawEye, unlocked: () => ownedSkins.has('eye'), build: () => texturedBall(drawEye) },
  { id: 'lava', name: 'LAVA CORE', lockText: '', price: 300, icon: drawLava, unlocked: () => ownedSkins.has('lava'), build: () => texturedBall(drawLava) },
  { id: 'galaxy', name: 'GALAXY', lockText: '', price: 400, icon: drawGalaxy, unlocked: () => ownedSkins.has('galaxy'), build: () => texturedBall(drawGalaxy) },
  { id: 'gold', name: 'SOLID GOLD', lockText: '', price: 500, icon: drawGold, unlocked: () => ownedSkins.has('gold'), build: () => texturedBall(drawGold) },
  {
    id: 'bubble', name: 'BUBBLE', lockText: '', price: 600, icon: iconBubble,
    unlocked: () => ownedSkins.has('bubble'),
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: '#bfe8ff', transparent: true, opacity: 0.3 })));
      g.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 14, 14), new THREE.MeshBasicMaterial({ color: '#dff4ff', wireframe: true, transparent: true, opacity: 0.35 })));
      return g;
    },
  },
  {
    id: 'holo', name: 'HOLOGRAM', lockText: '', price: 800, icon: iconHolo,
    unlocked: () => ownedSkins.has('holo'),
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.7, 20, 20), new THREE.MeshBasicMaterial({ color: '#19e6ff', transparent: true, opacity: 0.5 })));
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R * 1.05, 1), new THREE.MeshBasicMaterial({ color: '#7ff0ff', wireframe: true, transparent: true, opacity: 0.7 })));
      return g;
    },
  },
  {
    id: 'hole', name: 'BLACK HOLE', lockText: '', price: 1000, icon: iconBlackhole,
    unlocked: () => ownedSkins.has('hole'),
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.85, 24, 24), new THREE.MeshBasicMaterial({ color: '#000000' })));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(BALL_R * 1.15, 0.09, 8, 40), new THREE.MeshBasicMaterial({ color: '#ff9100' }));
      ring.rotation.x = Math.PI / 2.6;
      g.add(ring);
      return g;
    },
  },
];

let activeSkin = 0;
let currentSkinObj: THREE.Object3D | null = null;

function applySkin(idx: number) {
  activeSkin = idx;
  localStorage.setItem('neonroll_skin', SKINS[idx].id);
  if (currentSkinObj) ballSpin.remove(currentSkinObj);
  currentSkinObj = SKINS[idx].build();
  ballSpin.add(currentSkinObj);
}

// ---------------------------------------------------------------- track geometries / materials
const floorGeo = new THREE.BoxGeometry(TRACK_W, FLOOR_H, SEG_LEN);
const railGeo = new THREE.BoxGeometry(0.4, 0.7, SEG_LEN);
const stripeGeo = new THREE.BoxGeometry(TRACK_W, 0.12, 0.35);
const obGeo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
const itemGeo = new THREE.OctahedronGeometry(0.8, 0);
const gemGeo = new THREE.OctahedronGeometry(0.34, 0);
const gemMat = new THREE.MeshBasicMaterial({ color: '#8affd0' });

const floorMat = new THREE.MeshBasicMaterial({ color: ZONES[0].floor });
const railMat = new THREE.MeshBasicMaterial({ color: ZONES[0].rail });
const stripeMat = new THREE.MeshBasicMaterial({ color: ZONES[0].stripe });
const obMat = new THREE.MeshBasicMaterial({ color: ZONES[0].ob });
const obEdgeMat = new THREE.LineBasicMaterial({ color: '#ffffff' });
const obEdges = new THREE.EdgesGeometry(obGeo);
const gateMat = new THREE.MeshBasicMaterial({ color: '#a26bff' });
const gatePostGeo = new THREE.BoxGeometry(0.55, 8, 0.55);
const gateBarGeo = new THREE.BoxGeometry(TRACK_W + 1.5, 0.55, 0.55);

type PowerKind = 'shield' | 'slow' | 'x2' | 'ghost';
const ITEM_COLORS: Record<PowerKind, string> = {
  shield: '#19e6ff',
  slow: '#f4f4f4',
  x2: '#ffd54d',
  ghost: '#c084ff',
};
const itemMats: Record<PowerKind, THREE.MeshBasicMaterial> = {
  shield: new THREE.MeshBasicMaterial({ color: ITEM_COLORS.shield }),
  slow: new THREE.MeshBasicMaterial({ color: ITEM_COLORS.slow }),
  x2: new THREE.MeshBasicMaterial({ color: ITEM_COLORS.x2 }),
  ghost: new THREE.MeshBasicMaterial({ color: ITEM_COLORS.ghost }),
};

// ---------------------------------------------------------------- track generation
type ObType = 'block' | 'mover';

interface Ob {
  x: number;
  z: number;
  side: 1 | -1;
  type: ObType;
  amp: number; // mover oscillation amplitude
  phase: number;
  dead?: boolean; // destroyed by shield
}

interface Item {
  x: number;
  z: number;
  side: 1 | -1;
  kind: PowerKind;
  taken?: boolean;
}

interface Gem {
  x: number;
  z: number;
  side: 1 | -1;
  taken?: boolean;
}

interface SegInfo {
  gap: boolean;
  gate: boolean;
  obstacles: Ob[];
  item?: Item;
  gems: Gem[];
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
  let item: Item | undefined;
  const obstacles: Ob[] = [];
  const gems: Gem[] = [];

  if (z0 > GAP_MIN_Z && !segInfo(i - 1).gap && !gateNearby(i, 2) && rng() < 0.1) {
    gap = true;
  }

  if (!gap && z0 > GATE_MIN_Z && !gateNearby(i, 10) && rng() < 0.09) {
    gate = true;
  }

  if (!gap && !gate && z0 > ITEM_MIN_Z && rng() < 0.08) {
    const kinds: PowerKind[] = ['shield', 'slow', 'x2', 'ghost'];
    item = {
      x: [-5, -2.5, 0, 2.5, 5][Math.floor(rng() * 5)],
      z: z0 + 4 + rng() * (SEG_LEN - 8),
      side: z0 > GATE_MIN_Z && rng() < 0.5 ? -1 : 1,
      kind: kinds[Math.floor(rng() * kinds.length)],
    };
  }

  if (!gap && !gate && !item && z0 > OBSTACLE_MIN_Z) {
    const side: 1 | -1 = z0 > GATE_MIN_Z && rng() < 0.5 ? -1 : 1;
    if (z0 > WALL_MIN_Z && rng() < 0.13) {
      // wall with one gap: 5 lanes, remove 2 adjacent ones
      const gapLane = Math.floor(rng() * 4); // 0..3 -> lanes k, k+1 open
      const zw = z0 + 4 + rng() * (SEG_LEN - 8);
      [-6.4, -3.2, 0, 3.2, 6.4].forEach((lane, k) => {
        if (k === gapLane || k === gapLane + 1) return;
        obstacles.push({ x: lane, z: zw, side, type: 'block', amp: 0, phase: 0 });
      });
    } else {
      const chance = Math.min(0.75, 0.3 + z0 / 1800);
      if (rng() < chance) {
        const maxCount = Math.min(3, 1 + Math.floor(z0 / 500));
        const count = 1 + Math.floor(rng() * maxCount);
        const lanes = [-6, -3, 0, 3, 6].sort(() => rng() - 0.5).slice(0, count);
        for (const lane of lanes) {
          const mover = z0 > MOVER_MIN_Z && rng() < Math.min(0.45, (z0 - MOVER_MIN_Z) / 2500);
          obstacles.push({
            x: mover ? lane * 0.55 : lane + (rng() - 0.5) * 1.4,
            z: z0 + 3 + rng() * (SEG_LEN - 6),
            side: z0 > GATE_MIN_Z && rng() < 0.5 ? -1 : 1,
            type: mover ? 'mover' : 'block',
            amp: mover ? 2.6 + rng() * 1.4 : 0,
            phase: rng() * Math.PI * 2,
          });
        }
      }
    }
  }

  // gem rows (coexist with obstacles — risk/reward)
  if (!gap && !gate && z0 > GEM_MIN_Z && rng() < 0.26) {
    const lane = [-5, -2.5, 0, 2.5, 5][Math.floor(rng() * 5)];
    const side: 1 | -1 = z0 > GATE_MIN_Z && rng() < 0.5 ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      gems.push({ x: lane, z: z0 + 2.2 + k * 3.4, side });
    }
  }

  const info = { gap, gate, obstacles, item, gems };
  segMemo.set(i, info);
  return info;
}

// current x of an obstacle (movers oscillate)
function obX(o: Ob): number {
  const base = o.x + xCenter(o.z);
  return o.type === 'mover' ? base + Math.sin(state.time * 1.7 + o.phase) * o.amp : base;
}

interface SegRecord {
  group: THREE.Group;
  obs: { mesh: THREE.Mesh; o: Ob }[];
  items: { mesh: THREE.Mesh; it: Item }[];
  gems: { mesh: THREE.Mesh; gm: Gem }[];
}
const segMeshes = new Map<number, SegRecord>();

function obY(side: 1 | -1, z: number): number {
  return side === 1 ? yCenter(z) + 0.85 : yCenter(z) - FLOOR_H - 0.85;
}

function itemY(side: 1 | -1, z: number): number {
  return side === 1 ? yCenter(z) + 1.5 : yCenter(z) - FLOOR_H - 1.5;
}

function buildSeg(i: number) {
  const info = segInfo(i);
  const obs: { mesh: THREE.Mesh; o: Ob }[] = [];
  const items: { mesh: THREE.Mesh; it: Item }[] = [];
  const gems: { mesh: THREE.Mesh; gm: Gem }[] = [];
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
      if (o.dead) continue;
      const box = new THREE.Mesh(obGeo, obMat);
      box.position.set(obX(o), obY(o.side, o.z), o.z);
      box.add(new THREE.LineSegments(obEdges, obEdgeMat));
      scene.add(box);
      obs.push({ mesh: box, o });
    }

    if (info.item && !info.item.taken) {
      const it = info.item;
      const m = new THREE.Mesh(itemGeo, itemMats[it.kind]);
      m.position.set(it.x + xCenter(it.z), itemY(it.side, it.z), it.z);
      scene.add(m);
      items.push({ mesh: m, it });
    }

    for (const gm of info.gems) {
      if (gm.taken) continue;
      const m = new THREE.Mesh(gemGeo, gemMat);
      m.position.set(gm.x + xCenter(gm.z), itemY(gm.side, gm.z), gm.z);
      scene.add(m);
      gems.push({ mesh: m, gm });
    }
  }

  scene.add(group);
  segMeshes.set(i, { group, obs, items, gems });
}

function disposeSeg(rec: SegRecord) {
  scene.remove(rec.group);
  rec.obs.forEach((e) => scene.remove(e.mesh));
  rec.items.forEach((e) => scene.remove(e.mesh));
  rec.gems.forEach((e) => scene.remove(e.mesh));
}

function clearTrack() {
  for (const rec of segMeshes.values()) disposeSeg(rec);
  segMeshes.clear();
}

function updateTrack(ballZ: number) {
  const first = Math.floor(ballZ / SEG_LEN) - 3;
  for (const [i, rec] of segMeshes) {
    if (i < first || i > first + VIEW_SEGS + 4) {
      disposeSeg(rec);
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
  time: 0, // run clock (drives movers), frozen while paused
  score: 0, // float accumulator; display floor(score)
  topSpeed: 0,
  flips: 0,
  best: Number(localStorage.getItem('neonroll_best') || 0),
  runs: Number(localStorage.getItem('neonroll_runs') || 0),
  total: Number(localStorage.getItem('neonroll_total') || 0),
};

const powers = { shield: 0, slow: 0, x2: 0, ghost: 0, invuln: 0 };

let lastMilestone = 0;
let newBestToastShown = false;
let reviveUsed = false;

// ---------------------------------------------------------------- UI refs
const $ = (id: string) => document.getElementById(id)!;
const hudEl = $('hud');
const scoreEl = $('score');
const speedEl = $('speed');
const speedFillEl = $('speedfill');
const gravChipEl = $('gravChip');
const gravLabelEl = $('gravLabel');
const gemCountEl = $('gemCount');
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
const reviveBtnEl = $('reviveBtn') as HTMLButtonElement;
const toastEl = $('toast');
const goEl = $('go');
const vignetteEl = $('vignette');
const appEl = $('app');
const skinNameEl = $('skinName');
const skinLockEl = $('skinLock');
const pChips: Record<Exclude<PowerKind, never>, { chip: HTMLElement; bar: HTMLElement | null }> = {
  shield: { chip: $('pShield'), bar: null },
  slow: { chip: $('pSlow'), bar: $('pSlowBar') },
  x2: { chip: $('pX2'), bar: $('pX2Bar') },
  ghost: { chip: $('pGhost'), bar: $('pGhostBar') },
};

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

function flashVignette(cls: 'flash' | 'flash-purple' | 'flash-cyan') {
  vignetteEl.classList.remove('flash', 'flash-purple', 'flash-cyan');
  void (vignetteEl as HTMLElement).offsetWidth;
  vignetteEl.classList.add(cls);
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

const fxBtn = $('fxBtn');
fxBtn.classList.toggle('muted', !fxOn);
fxBtn.addEventListener('click', () => {
  fxOn = !fxOn;
  localStorage.setItem('neonroll_fx', fxOn ? '1' : '0');
  fxBtn.classList.toggle('muted', !fxOn);
});

// ---------------------------------------------------------------- skin picker
let browseSkin = Math.max(0, SKINS.findIndex((sk) => sk.id === localStorage.getItem('neonroll_skin')));
if (!SKINS[browseSkin].unlocked()) browseSkin = 0;
applySkin(browseSkin);

function renderSkinPicker() {
  const sk = SKINS[browseSkin];
  skinNameEl.textContent = sk.name;
  const open = sk.unlocked();
  skinLockEl.textContent = open ? (browseSkin === activeSkin ? 'SELECTED' : 'TAP TO PREVIEW') : `LOCKED · ${sk.lockText}`;
  skinLockEl.classList.toggle('locked', !open);
  if (open && browseSkin !== activeSkin) applySkin(browseSkin);
  else if (!open && currentSkinObj) {
    // preview locked skins too, but play falls back to last unlocked
    if (currentSkinObj) ballSpin.remove(currentSkinObj);
    currentSkinObj = sk.build();
    ballSpin.add(currentSkinObj);
  }
  skinLockEl.textContent = open
    ? 'SELECTED'
    : sk.price > 0
      ? `${sk.price} \u{1F48E} · BUY IN SHOP`
      : `LOCKED · ${sk.lockText}`;
}
$('skinPrev').addEventListener('click', () => {
  browseSkin = (browseSkin - 1 + SKINS.length) % SKINS.length;
  renderSkinPicker();
});
$('skinNext').addEventListener('click', () => {
  browseSkin = (browseSkin + 1) % SKINS.length;
  renderSkinPicker();
});
renderSkinPicker();

// ---------------------------------------------------------------- shop
const shopEl = $('shop');
const shopGridEl = $('shopGrid');
const walletShopEl = $('walletShop');
const walletMenuEl = $('walletMenu');
const tabBallsEl = $('tabBalls');
const tabMapsEl = $('tabMaps');
let shopTab: 'balls' | 'maps' = 'balls';

function updateWalletUI() {
  walletShopEl.textContent = `${gemWallet}`;
  walletMenuEl.textContent = `${gemWallet}`;
  gemCountEl.textContent = `${gemWallet}`;
}

function iconDataUrl(draw: CanvasDraw, size = 96): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  return c.toDataURL();
}

function rejectCard(card: HTMLElement) {
  card.classList.remove('shake-card');
  void card.offsetWidth;
  card.classList.add('shake-card');
}

function renderShop() {
  updateWalletUI();
  shopGridEl.innerHTML = '';
  if (shopTab === 'balls') {
    SKINS.forEach((sk, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      const open = sk.unlocked();
      const status = open
        ? idx === activeSkin
          ? '<span class="tag selected">SELECTED</span>'
          : '<span class="tag owned">OWNED</span>'
        : sk.price > 0
          ? `<button class="buy">${sk.price} \u{1F48E}</button>`
          : `<span class="tag locked">${sk.lockText}</span>`;
      card.innerHTML = `<img class="thumb ball" src="${iconDataUrl(sk.icon)}" alt=""><div class="card-name">${sk.name}</div>${status}`;
      card.addEventListener('click', () => {
        if (sk.unlocked()) {
          browseSkin = idx;
          applySkin(idx);
          renderShop();
        } else if (sk.price > 0 && gemWallet >= sk.price) {
          gemWallet -= sk.price;
          ownedSkins.add(sk.id);
          saveWallet();
          browseSkin = idx;
          applySkin(idx);
          pickupSound();
          renderShop();
        } else {
          rejectCard(card);
        }
      });
      shopGridEl.appendChild(card);
    });
  } else {
    ZONES.forEach((z, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      const owned = z.price === 0 || ownedMaps.has(idx);
      const status = owned
        ? '<span class="tag owned">IN ROTATION</span>'
        : `<button class="buy">${z.price} \u{1F48E}</button>`;
      card.innerHTML = `<div class="thumb map" style="background:${z.floor}"><i style="background:${z.rail}"></i><i style="background:${z.stripe}"></i><i style="background:${z.star}"></i></div><div class="card-name">${z.name}</div>${status}`;
      card.addEventListener('click', () => {
        if (owned) return;
        if (gemWallet >= z.price) {
          gemWallet -= z.price;
          ownedMaps.add(idx);
          saveWallet();
          pickupSound();
          renderShop();
        } else {
          rejectCard(card);
        }
      });
      shopGridEl.appendChild(card);
    });
  }
}

function setShopTab(tab: 'balls' | 'maps') {
  shopTab = tab;
  tabBallsEl.classList.toggle('active', tab === 'balls');
  tabMapsEl.classList.toggle('active', tab === 'maps');
  renderShop();
}
tabBallsEl.addEventListener('click', () => setShopTab('balls'));
tabMapsEl.addEventListener('click', () => setShopTab('maps'));

$('shopBtn').addEventListener('click', () => {
  menuEl.classList.add('hidden');
  shopEl.classList.remove('hidden');
  setShopTab('balls');
});
$('shopClose').addEventListener('click', () => {
  shopEl.classList.add('hidden');
  showBest();
  renderSkinPicker();
  menuEl.classList.remove('hidden');
});
updateWalletUI();

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
reviveBtnEl.addEventListener('click', () => {
  if (state.phase !== 'over' || reviveUsed) return;
  reviveUsed = true;
  reviveBtnEl.disabled = true;
  reviveBtnEl.textContent = 'LOADING AD…';
  showRewardedAd(
    () => reviveRun(),
    () => reviveBtnEl.classList.add('hidden')
  );
});

function readSteer(): number {
  let s = 0;
  if (keys['ArrowLeft'] || keys['KeyA']) s -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) s += 1;
  if (s === 0) s = touchSide;
  return s;
}

// ---------------------------------------------------------------- run control
function resetPowers() {
  powers.shield = 0;
  powers.slow = 0;
  powers.x2 = 0;
  powers.ghost = 0;
  powers.invuln = 0;
  shieldMesh.visible = false;
  setBallOpacity(1);
  scoreEl.classList.remove('x2');
  for (const k of Object.keys(pChips) as PowerKind[]) pChips[k].chip.classList.add('hidden');
}

function startRun() {
  initAudio();
  audioCtx?.resume();
  // play with the last unlocked selection, not a locked preview
  if (!SKINS[browseSkin].unlocked()) {
    browseSkin = activeSkin;
    renderSkinPicker();
  } else if (browseSkin !== activeSkin) {
    applySkin(browseSkin);
  }

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
  state.time = 0;
  state.score = 0;
  state.topSpeed = 0;
  state.flips = 0;
  lastMilestone = 0;
  newBestToastShown = false;
  reviveUsed = false;
  zoneIdx = 0;
  setZoneTargets(0);
  resetPowers();
  ballSpin.visible = true;

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
  trailPts.length = 0;
  startMusic();
  showGo();
  sdkStart();
}

function pauseRun() {
  if (state.phase !== 'run') return;
  state.phase = 'pause';
  setHum(0, false);
  stopMusic();
  sdkStop();
  pauseEl.classList.remove('hidden');
}

function resumeRun() {
  if (state.phase !== 'pause') return;
  state.phase = 'run';
  pauseEl.classList.add('hidden');
  startMusic();
  sdkStart();
}

function goToMenu() {
  state.phase = 'menu';
  setHum(0, false);
  stopMusic();
  sdkStop();
  ballSpin.visible = true;
  pauseEl.classList.add('hidden');
  overEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  showBest();
  renderSkinPicker();
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
  stopMusic();
  sdkStop();
  flashVignette('flash');
  appEl.classList.remove('shake');
  void appEl.offsetWidth;
  appEl.classList.add('shake');
  // shatter the ball
  burst(state.x, state.y, state.z, '#ff2e55', 18, 11);
  burst(state.x, state.y, state.z, '#19e6ff', 12, 8);
  ballSpin.visible = false;
  shieldMesh.visible = false;

  const score = Math.floor(state.score);
  const isNewBest = score > 0 && score > state.best;
  state.best = Math.max(state.best, score);
  state.runs += 1;
  state.total += score;
  localStorage.setItem('neonroll_best', String(state.best));
  localStorage.setItem('neonroll_runs', String(state.runs));
  localStorage.setItem('neonroll_total', String(state.total));
  showBest();

  statSpeedEl.textContent = `${Math.round(state.topSpeed * 3.6)}`;
  statFlipsEl.textContent = `${state.flips}`;
  statBestEl.textContent = `${state.best}`;
  newBestEl.classList.toggle('hidden', !isNewBest);
  if (isNewBest) sdkHappy();

  reviveBtnEl.classList.toggle('hidden', reviveUsed);
  reviveBtnEl.disabled = false;
  reviveBtnEl.innerHTML = '&#9654; REVIVE <span class="ad-tag">AD</span>';

  setTimeout(() => {
    hudEl.classList.add('hidden');
    overEl.classList.remove('hidden');
    animateFinalScore(score);
  }, 500);
}

// revive via rewarded ad: roll back the stats die() recorded — the run continues
function reviveRun() {
  const score = Math.floor(state.score);
  state.runs = Math.max(0, state.runs - 1);
  state.total = Math.max(0, state.total - score);
  localStorage.setItem('neonroll_runs', String(state.runs));
  localStorage.setItem('neonroll_total', String(state.total));
  showBest();

  // put the ball back on the next safe stretch of track
  let segI = Math.floor(state.z / SEG_LEN) + 1;
  while (segInfo(segI).gap) segI++;
  state.z = segI * SEG_LEN + 2;
  state.x = xCenter(state.z);
  state.y = restY(state.z, state.gravity);
  state.vy = 0;
  state.vx = 0;
  state.grounded = true;
  state.speed = Math.max(SPEED_START, state.speed * 0.8); // ease back in
  powers.invuln = 2;
  ballSpin.visible = true;

  state.phase = 'run';
  overEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  trailPts.length = 0;
  startMusic();
  showGo();
  sdkStart();
}

// ---------------------------------------------------------------- powers
function setBallOpacity(op: number) {
  ballSpin.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.LineSegments).isLineSegments) return;
    const mat = (mesh.material as THREE.Material) || null;
    if (!mat) return;
    mat.transparent = op < 1;
    mat.opacity = op;
  });
}

function applyPower(kind: PowerKind) {
  pickupSound();
  fovKick = 7;
  if (kind === 'shield') {
    powers.shield = 1;
    shieldMesh.visible = true;
    toast('SHIELD!');
    flashVignette('flash-cyan');
  } else if (kind === 'slow') {
    powers.slow = 5;
    toast('SLOW-MO!');
    flashVignette('flash-cyan');
  } else if (kind === 'x2') {
    powers.x2 = 10;
    scoreEl.classList.add('x2');
    toast('SCORE x2!', 'gold');
  } else {
    powers.ghost = 5;
    setBallOpacity(0.35);
    toast('GHOST MODE!', 'purple');
  }
}

function breakShield(o: Ob) {
  o.dead = true;
  powers.shield = 0;
  powers.invuln = 0.6;
  hitstop = 0.12;
  shieldMesh.visible = false;
  shieldBreakSound();
  flashVignette('flash-cyan');
  toast('SHIELD BROKE!');
  // remove the destroyed obstacle's mesh
  for (const rec of segMeshes.values()) {
    const hit = rec.obs.find((e) => e.o === o);
    if (hit) {
      scene.remove(hit.mesh);
      rec.obs = rec.obs.filter((e) => e.o !== o);
      break;
    }
  }
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
  burst(state.x, state.y, state.z, '#a26bff', 16, 7);
  toast('GRAVITY FLIP!', 'purple');
  gravChipEl.classList.toggle('flipped', state.gravity === -1);
  gravLabelEl.textContent = state.gravity === 1 ? 'TOP' : 'UNDER';
  flashVignette('flash-purple');
}

function step(dt: number) {
  state.time += dt;
  state.speed = Math.min(SPEED_MAX, state.speed + ACCEL * dt);
  state.topSpeed = Math.max(state.topSpeed, state.speed);

  // power timers
  powers.invuln = Math.max(0, powers.invuln - dt);
  powers.slow = Math.max(0, powers.slow - dt);
  powers.x2 = Math.max(0, powers.x2 - dt);
  if (powers.ghost > 0) {
    powers.ghost = Math.max(0, powers.ghost - dt);
    if (powers.ghost === 0) setBallOpacity(1);
  }
  if (powers.x2 === 0) scoreEl.classList.remove('x2');

  const moveSpeed = state.speed * (powers.slow > 0 ? 0.55 : 1);

  // lateral
  const targetVx = readSteer() * moveSpeed * LAT_FACTOR;
  state.vx += (targetVx - state.vx) * Math.min(1, dt * 8);
  state.x += state.vx * dt;

  // forward
  const zPrev = state.z;
  state.z += moveSpeed * dt;
  state.score += moveSpeed * dt * (powers.x2 > 0 ? 2 : 1);
  const score = Math.floor(state.score);

  // zones by physical distance
  const zi = Math.floor((state.z - 6) / ZONE_LEN);
  if (zi !== zoneIdx) {
    zoneIdx = zi;
    setZoneTargets(zi);
    const rot = zoneRotation();
    toast(`ZONE ${zi + 1} · ${rot[zi % rot.length].name}`, 'gold');
  }

  // milestone + new-best toasts
  const milestone = Math.floor(score / 100);
  if (milestone > lastMilestone) {
    lastMilestone = milestone;
    if (score % 500 !== 0) toast(`${milestone * 100}m`); // zone toast already covers the 500s
  }
  if (!newBestToastShown && state.best > 0 && score > state.best) {
    newBestToastShown = true;
    toast('NEW BEST!', 'gold');
  }

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
      const offSide = Math.abs(state.x - xCenter(state.z)) >= HALF_W + 0.3;
      if (offSide) {
        // slid off the side: plain fall, away from the surface
        state.vy = -state.speed * 0.28 * g;
      } else {
        // ran off the lip of a gap: hop (top side) / dive (underside) just enough
        // to reach the far lip. The track descends ~0.28/unit, which helps the top
        // side and works against the underside, hence the g-signed slope term.
        const T = SEG_LEN / moveSpeed;
        const slopeDrop = 0.28 * SEG_LEN;
        const mag = 0.5 * GRAVITY * T - (g * slopeDrop) / T + 1.2;
        state.vy = g * Math.min(22, Math.max(2, mag));
      }
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

  const nearGround = Math.abs(state.y - groundY) < 1.5;

  // item + gem pickups
  if (nearGround) {
    for (let i = segIdx - 1; i <= segIdx + 1; i++) {
      if (i < 0) continue;
      const inf = segInfo(i);
      const it = inf.item;
      if (it && !it.taken && it.side === g) {
        const ix = it.x + xCenter(it.z);
        if (Math.abs(state.z - it.z) < 1.6 && Math.abs(state.x - ix) < 1.6) {
          it.taken = true;
          const rec = segMeshes.get(i);
          if (rec) {
            rec.items.forEach((e) => {
              if (e.it === it) scene.remove(e.mesh);
            });
            rec.items = rec.items.filter((e) => e.it !== it);
          }
          burst(ix, itemY(it.side, it.z), it.z, ITEM_COLORS[it.kind], 12, 6);
          applyPower(it.kind);
        }
      }
      for (const gm of inf.gems) {
        if (gm.taken || gm.side !== g) continue;
        const gx = gm.x + xCenter(gm.z);
        if (Math.abs(state.z - gm.z) < 1.4 && Math.abs(state.x - gx) < 1.4) {
          gm.taken = true;
          const rec = segMeshes.get(i);
          if (rec) {
            rec.gems.forEach((e) => {
              if (e.gm === gm) scene.remove(e.mesh);
            });
            rec.gems = rec.gems.filter((e) => e.gm !== gm);
          }
          state.score += GEM_SCORE * (powers.x2 > 0 ? 2 : 1);
          gemWallet += 1;
          saveWallet();
          gemCountEl.textContent = `${gemWallet}`;
          gemSound();
          burst(gx, itemY(gm.side, gm.z), gm.z, '#8affd0', 6, 5);
        }
      }
    }
  }

  // obstacles (check neighbouring segments, same side only)
  if (nearGround && powers.ghost === 0 && powers.invuln === 0) {
    for (let i = segIdx - 1; i <= segIdx + 1; i++) {
      if (i < 0) continue;
      for (const o of segInfo(i).obstacles) {
        if (o.side !== g || o.dead) continue;
        if (Math.abs(state.z - o.z) < 0.85 + BALL_R && Math.abs(state.x - obX(o)) < 0.85 + BALL_R) {
          if (powers.shield > 0) breakShield(o);
          else die();
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
let fovKick = 0;
let hitstop = 0;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
}

function tick(rawDt: number) {
  let dt = rawDt;
  if (hitstop > 0) {
    hitstop -= rawDt;
    dt = rawDt * 0.12; // brief slow-mo (shield break)
  }
  musicTick();

  if (state.phase === 'run') {
    step(dt);
    setHum(state.speed, true);
    scoreEl.textContent = `${Math.floor(state.score)}`;
    speedEl.textContent = `${Math.round(state.speed * 3.6)} km/h`;
    speedFillEl.style.width = `${Math.round((state.speed / SPEED_MAX) * 100)}%`;

    // power chips
    pChips.shield.chip.classList.toggle('hidden', powers.shield === 0);
    pChips.slow.chip.classList.toggle('hidden', powers.slow === 0);
    if (pChips.slow.bar) pChips.slow.bar.style.width = `${(powers.slow / 5) * 100}%`;
    pChips.x2.chip.classList.toggle('hidden', powers.x2 === 0);
    if (pChips.x2.bar) pChips.x2.bar.style.width = `${(powers.x2 / 10) * 100}%`;
    pChips.ghost.chip.classList.toggle('hidden', powers.ghost === 0);
    if (pChips.ghost.bar) pChips.ghost.bar.style.width = `${(powers.ghost / 5) * 100}%`;
  }

  updateTrack(state.z);

  // zone color lerp + beat-synced pulse on the neon parts
  const lerpK = Math.min(1, dt * 2.2);
  zoneBase.floor.lerp(zoneTarget.floor, lerpK);
  zoneBase.rail.lerp(zoneTarget.rail, lerpK);
  zoneBase.stripe.lerp(zoneTarget.stripe, lerpK);
  zoneBase.ob.lerp(zoneTarget.ob, lerpK);
  zoneBase.star.lerp(zoneTarget.star, lerpK);
  zoneBase.fog.lerp(zoneTarget.fog, lerpK);

  const pulse = state.phase === 'run' ? beatPulse() : 0;
  floorMat.color.copy(zoneBase.floor);
  obMat.color.copy(zoneBase.ob);
  starsMat.color.copy(zoneBase.star);
  railMat.color.copy(zoneBase.rail).multiplyScalar(1 + pulse * 0.5);
  stripeMat.color.copy(zoneBase.stripe).multiplyScalar(1 + pulse * 0.5);
  (scene.fog as THREE.Fog).color.copy(zoneBase.fog);
  (scene.background as THREE.Color).copy(zoneBase.fog);
  ballGroup.scale.setScalar(1 + pulse * 0.05);

  // trail follows the ball while running
  if (state.phase === 'run') {
    trailPts.push({ x: state.x, y: state.y, z: state.z });
    if (trailPts.length > TRAIL_N) trailPts.shift();
  }
  updateTrail(zoneBase.rail);

  // animate movers + item/gem spin + particles
  for (const rec of segMeshes.values()) {
    for (const e of rec.obs) {
      if (e.o.type === 'mover') e.mesh.position.x = obX(e.o);
    }
    for (const e of rec.items) {
      e.mesh.rotation.y += dt * 2.5;
      e.mesh.position.y = itemY(e.it.side, e.it.z) + Math.sin(state.time * 3 + e.it.z) * 0.15 * e.it.side;
    }
    for (const e of rec.gems) {
      e.mesh.rotation.y += dt * 3.5;
    }
  }
  tickParticles(dt);

  // ball visual
  ballGroup.position.set(state.x, state.y, state.z);
  ballSpin.rotation.x += (state.phase === 'run' ? state.speed / BALL_R : 0.6) * dt;
  shieldMesh.rotation.y += dt * 1.5;
  shieldMesh.rotation.x = 0; // keep bubble steady while inner ball rolls

  // camera
  if (state.phase === 'menu') {
    // skin-preview camera: slow orbit around the ball
    const t = performance.now() / 1000;
    camPos.set(state.x + Math.sin(t * 0.4) * 2, state.y + 2.6, state.z - 7.5);
    camera.position.lerp(camPos, Math.min(1, dt * 4));
    camera.up.set(0, 1, 0);
    camLook.set(state.x, state.y + 0.6, state.z);
    camera.lookAt(camLook);
    camera.fov = 55;
    ballSpin.rotation.y += dt * 0.8;
  } else {
    // gameplay camera (rolls 180° when gravity is flipped, leans into turns)
    state.camG += (state.gravity - state.camG) * Math.min(1, dt * 4);
    const lean = THREE.MathUtils.clamp(-state.vx * 0.008, -0.2, 0.2) * state.camG;
    const roll = ((1 - state.camG) / 2) * Math.PI + lean; // camG 1 -> 0 rad, camG -1 -> PI
    const back = 11;
    camPos.set(
      state.x * 0.55 + xCenter(state.z) * 0.45,
      state.y + 5.5 * state.camG,
      state.z - back
    );
    camera.position.lerp(camPos, Math.min(1, dt * 6));
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camLook.set(state.x, state.y + 1.2 * state.camG, state.z + 15);
    camera.lookAt(camLook);
    fovKick = Math.max(0, fovKick - dt * 20);
    camera.fov = 75 + (state.speed / SPEED_MAX) * 14 + fovKick;
  }
  camera.updateProjectionMatrix();

  const stars = scene.getObjectByName('stars');
  if (stars) stars.position.copy(camera.position);

  if (fxOn) composer.render();
  else renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// debug hook for automated testing
(window as unknown as Record<string, unknown>).__nr = {
  state,
  powers,
  die,
  startRun,
  segInfo,
  flipGravity,
  applyPower,
  applySkin,
  giveGems: (n: number) => {
    gemWallet += n;
    saveWallet();
    updateWalletUI();
  },
  tick, // manual stepping for automated tests (works even when RAF is throttled)
};
