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

// ---------------------------------------------------------------- three setup
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0618');
scene.fog = new THREE.Fog(new THREE.Color('#0a0618'), 60, 330);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 800);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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

// ---------------------------------------------------------------- zones (map variety)
interface Zone {
  name: string;
  floor: string;
  rail: string;
  stripe: string;
  ob: string;
  fog: string;
  star: string;
}

const ZONES: Zone[] = [
  { name: 'NEON CITY', floor: '#141034', rail: '#19e6ff', stripe: '#ff2ea6', ob: '#ff2e55', fog: '#0a0618', star: '#8fa4ff' },
  { name: 'INFERNO', floor: '#200a06', rail: '#ffb020', stripe: '#ff5722', ob: '#ff1744', fog: '#170503', star: '#ffb28a' },
  { name: 'TOXIC', floor: '#0a1a0c', rail: '#7fff00', stripe: '#00e676', ob: '#ff2e55', fog: '#04120a', star: '#a8ffb0' },
  { name: 'FROST', floor: '#0d1626', rail: '#b3e5fc', stripe: '#40c4ff', ob: '#ff2e55', fog: '#0a1220', star: '#e0f2ff' },
  { name: 'VOID', floor: '#16081f', rail: '#d500f9', stripe: '#ffd54d', ob: '#ff2e55', fog: '#0d0214', star: '#e2b0ff' },
];

let zoneIdx = 0;
const zoneTarget = {
  floor: new THREE.Color(ZONES[0].floor),
  rail: new THREE.Color(ZONES[0].rail),
  stripe: new THREE.Color(ZONES[0].stripe),
  ob: new THREE.Color(ZONES[0].ob),
  fog: new THREE.Color(ZONES[0].fog),
  star: new THREE.Color(ZONES[0].star),
};

function setZoneTargets(zi: number) {
  const zn = ZONES[zi % ZONES.length];
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

interface Skin {
  id: string;
  name: string;
  lockText: string;
  unlocked: () => boolean;
  build: () => THREE.Object3D;
}

const SKINS: Skin[] = [
  {
    id: 'neon',
    name: 'NEON CORE',
    lockText: '',
    unlocked: () => true,
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.96, 24, 24), new THREE.MeshBasicMaterial({ color: '#062b33' })));
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1), new THREE.MeshBasicMaterial({ color: '#19e6ff', wireframe: true })));
      return g;
    },
  },
  {
    id: 'basket',
    name: 'BASKETBALL',
    lockText: 'BEST 150m',
    unlocked: () => state.best >= 150,
    build: () =>
      texturedBall((ctx, s) => {
        ctx.fillStyle = '#e65f1e';
        ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = '#241205';
        ctx.lineWidth = s * 0.035;
        ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(-s * 0.1, s / 2, s * 0.42, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 1.1, s / 2, s * 0.42, 0, Math.PI * 2); ctx.stroke();
      }),
  },
  {
    id: 'soccer',
    name: 'SOCCER BALL',
    lockText: 'BEST 300m',
    unlocked: () => state.best >= 300,
    build: () =>
      texturedBall((ctx, s) => {
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
      }),
  },
  {
    id: 'eight',
    name: '8-BALL',
    lockText: 'BEST 500m',
    unlocked: () => state.best >= 500,
    build: () =>
      texturedBall((ctx, s) => {
        ctx.fillStyle = '#0c0c10';
        ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = '#f4f4f4';
        ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0c0c10';
        ctx.font = `bold ${Math.round(s * 0.24)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('8', s / 2, s / 2 + s * 0.01);
      }),
  },
  {
    id: 'tennis',
    name: 'TENNIS',
    lockText: 'TOTAL 2 KM',
    unlocked: () => state.total >= 2000,
    build: () =>
      texturedBall((ctx, s) => {
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
      }),
  },
  {
    id: 'beach',
    name: 'BEACH BALL',
    lockText: 'TOTAL 5 KM',
    unlocked: () => state.total >= 5000,
    build: () =>
      texturedBall((ctx, s) => {
        const cols = ['#ff4d4d', '#ffd54d', '#4dff88', '#4dc3ff', '#b34dff', '#ffffff'];
        const w = s / cols.length;
        cols.forEach((c, k) => {
          ctx.fillStyle = c;
          ctx.fillRect(k * w, 0, w + 1, s);
        });
      }),
  },
  {
    id: 'earth',
    name: 'PLANET EARTH',
    lockText: 'TOTAL 10 KM',
    unlocked: () => state.total >= 10000,
    build: () =>
      texturedBall((ctx, s) => {
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
      }),
  },
  {
    id: 'dice',
    name: 'LUCKY DICE',
    lockText: '15 RUNS',
    unlocked: () => state.runs >= 15,
    build: () => {
      const tex = makeTexture((ctx, s) => {
        ctx.fillStyle = '#f2f2f2';
        ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = '#c62828';
        const p = s * 0.26, r = s * 0.09;
        for (const [px, py] of [[p, p], [s - p, p], [p, s - p], [s - p, s - p]]) {
          ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        }
      });
      return new THREE.Mesh(new THREE.BoxGeometry(BALL_R * 1.5, BALL_R * 1.5, BALL_R * 1.5), new THREE.MeshBasicMaterial({ map: tex }));
    },
  },
  {
    id: 'diamond',
    name: 'DIAMOND',
    lockText: 'BEST 800m',
    unlocked: () => state.best >= 800,
    build: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(BALL_R * 1.05, 0), new THREE.MeshBasicMaterial({ color: '#7ff0ff', transparent: true, opacity: 0.85 })));
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(BALL_R * 1.06, 0), new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true })));
      return g;
    },
  },
  {
    id: 'disco',
    name: 'DISCO BALL',
    lockText: '30 RUNS',
    unlocked: () => state.runs >= 30,
    build: () =>
      texturedBall((ctx, s) => {
        const n = 10, w = s / n;
        for (let ix = 0; ix < n; ix++) {
          for (let iy = 0; iy < n; iy++) {
            const v = 150 + ((ix * 7 + iy * 13) % 6) * 20;
            ctx.fillStyle = `rgb(${v},${v},${v + 15})`;
            ctx.fillRect(ix * w + 1, iy * w + 1, w - 2, w - 2);
          }
        }
      }),
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

interface SegInfo {
  gap: boolean;
  gate: boolean;
  obstacles: Ob[];
  item?: Item;
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

  const info = { gap, gate, obstacles, item };
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
  }

  scene.add(group);
  segMeshes.set(i, { group, obs, items });
}

function disposeSeg(rec: SegRecord) {
  scene.remove(rec.group);
  rec.obs.forEach((e) => scene.remove(e.mesh));
  rec.items.forEach((e) => scene.remove(e.mesh));
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
  skinLockEl.textContent = open ? 'SELECTED' : `LOCKED · ${sk.lockText}`;
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
  zoneIdx = 0;
  setZoneTargets(0);
  resetPowers();

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
  flashVignette('flash');
  appEl.classList.remove('shake');
  void appEl.offsetWidth;
  appEl.classList.add('shake');

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

  setTimeout(() => {
    hudEl.classList.add('hidden');
    overEl.classList.remove('hidden');
    animateFinalScore(score);
  }, 500);
  // CrazyGames SDK: gameplayStop() + đây là chỗ gắn rewarded ad "REVIVE"
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
    const zn = ZONES[zi % ZONES.length];
    toast(`ZONE ${zi + 1} · ${zn.name}`, 'gold');
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

  // item pickups
  if (nearGround) {
    for (let i = segIdx - 1; i <= segIdx + 1; i++) {
      if (i < 0) continue;
      const it = segInfo(i).item;
      if (!it || it.taken || it.side !== g) continue;
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
        applyPower(it.kind);
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

  // zone color lerp
  const lerpK = Math.min(1, dt * 2.2);
  floorMat.color.lerp(zoneTarget.floor, lerpK);
  railMat.color.lerp(zoneTarget.rail, lerpK);
  stripeMat.color.lerp(zoneTarget.stripe, lerpK);
  obMat.color.lerp(zoneTarget.ob, lerpK);
  starsMat.color.lerp(zoneTarget.star, lerpK);
  (scene.fog as THREE.Fog).color.lerp(zoneTarget.fog, lerpK);
  (scene.background as THREE.Color).lerp(zoneTarget.fog, lerpK);

  // animate movers + item spin
  for (const rec of segMeshes.values()) {
    for (const e of rec.obs) {
      if (e.o.type === 'mover') e.mesh.position.x = obX(e.o);
    }
    for (const e of rec.items) {
      e.mesh.rotation.y += dt * 2.5;
      e.mesh.position.y = itemY(e.it.side, e.it.z) + Math.sin(state.time * 3 + e.it.z) * 0.15 * e.it.side;
    }
  }

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
    // gameplay camera (rolls 180° when gravity is flipped)
    state.camG += (state.gravity - state.camG) * Math.min(1, dt * 4);
    const roll = ((1 - state.camG) / 2) * Math.PI; // camG 1 -> 0 rad, camG -1 -> PI
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
    camera.fov = 75 + (state.speed / SPEED_MAX) * 14;
  }
  camera.updateProjectionMatrix();

  const stars = scene.getObjectByName('stars');
  if (stars) stars.position.copy(camera.position);

  renderer.render(scene, camera);
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
  tick, // manual stepping for automated tests (works even when RAF is throttled)
};
