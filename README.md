# Neon Roll 3D

Neon Roll 3D is a browser-based 3D endless roller with a neon synthwave aesthetic, built with **Three.js**, **TypeScript**, and **Vite** and designed with web game platforms such as **CrazyGames** in mind.

The ball automatically accelerates down a procedurally generated track. The player steers left and right to avoid hazards, clear gaps, collect gems and power-ups, and pass through purple gravity gates that flip the ball onto the underside of the track.

## Gameplay

The core loop is simple to learn and becomes progressively more demanding as speed increases:

- Roll forward automatically while the game continuously increases speed.
- Steer left and right to avoid red obstacles, moving hazards, walls, lasers, and gaps.
- Pass through **purple gravity gates** to invert gravity and continue rolling on the opposite side of the track.
- Collect **gems** for persistent shop currency and bonus score.
- Trigger **near-misses** by passing close to obstacles for additional score.
- Use power-ups such as **Shield**, **Slow**, **x2**, and **Ghost** to survive longer or increase scoring opportunities.
- Hit boost pickups for short bursts of additional speed.
- Revive once per run for **50 gems** when enough currency is available.
- Follow the **Lost Signal** transmission storyline as new environments are reached.

## Maps and Progression

Maps are unlocked through total lifetime distance traveled. The current progression contains ten environments:

1. Neon City
2. Riverside
3. Deep Ocean
4. Tropic Beach
5. Emerald Forest
6. Misty Mountain
7. Golden Desert
8. Volcano
9. Aurora
10. Galaxy Void

Each environment has its own visual palette, fog, lighting accents, preview artwork, and environmental decoration. Progress toward the next map is shown in the map selector and on the game-over screen.

The game also includes:

- Multiple unlockable ball skins.
- Persistent gem currency and owned-skin data.
- Missions and career statistics.
- Daily rewards.
- Best-score tracking.
- Lifetime distance progression.
- Close-call tracking.
- Map unlock notifications.

## Controls

### Desktop

- **A / D** or **Left Arrow / Right Arrow**: steer left or right.
- **P / Esc**: pause or resume the game.

### Mobile

- Tap or hold the **left half** of the screen to steer left.
- Tap or hold the **right half** of the screen to steer right.

## Visual and Gameplay Systems

Neon Roll 3D includes a number of systems intended to make an endless-runner loop feel more dynamic:

- Procedurally generated track segments.
- A shared analytic track centerline used by both rendering and physics.
- Gravity inversion with gameplay on both sides of the track.
- Increasing speed and difficulty.
- Static and moving obstacles.
- Gaps and wall hazards.
- Laser hazards with advance HUD warnings and visual pulses.
- Near-miss detection and score bonuses.
- Gem pickups and persistent currency.
- Power-up timers and HUD indicators.
- Crash particles and ball-break effects.
- Gate and pickup particles.
- Screen shake and impact feedback.
- Bloom post-processing with a performance toggle for weaker devices.
- Reduced-motion support.
- Responsive desktop and mobile input.

## Audio

The soundtrack and sound effects are generated with the **Web Audio API** rather than external audio assets.

The audio system includes:

- A procedural synthwave sequencer.
- Kick, hi-hat, bass, and arpeggiated synth layers.
- Beat-synchronized visual pulse data.
- Gravity-gate sound effects.
- Crash, pickup, shield-break, and gem sounds.
- Persistent mute settings.

## UI

The interface includes:

- In-game HUD with score, speed, gravity state, gem count, active power-ups, and hazard warnings.
- Main menu with skin selection, maps, shop, missions, statistics, and daily rewards.
- Map progression screen.
- Skin shop.
- Pause and accessibility/performance controls.
- Revive countdown screen.
- Game-over statistics and next-map progression.
- Toast messages, unlock notifications, and Lost Signal transmissions.

## Technology Stack

- **Three.js** for 3D rendering.
- **TypeScript** for game logic and type safety.
- **Vite** for development and production builds.
- **Web Audio API** for procedural music and sound effects.
- **EffectComposer / UnrealBloomPass** for post-processing.
- **CrazyGames SDK v3** lifecycle integration.
- **localStorage** for persistent progression, settings, currency, and unlocks.

## Getting Started

### Requirements

- A recent version of Node.js.
- npm.

### Install dependencies

```bash
npm install
```

### Start the development server

```bash
npm run dev
```

Vite normally serves the game at:

```text
http://localhost:5173
```

The included Claude development launch configuration uses port **5177** with strict port selection.

## Type Checking and Production Build

Run TypeScript validation without emitting files:

```bash
npm run typecheck
```

Create a production build:

```bash
npm run build
```

The production output is generated in:

```text
dist/
```

Preview the production build locally:

```bash
npm run preview
```

## Project Structure

```text
neon-roll/
├── .claude/
│   └── launch.json                 # Claude development server configuration
├── asset-sources/
│   ├── map-previews/               # Source artwork for map previews
│   └── neon-roll-key-art-source.png
├── public/
│   └── assets/
│       ├── maps/                   # Optimized map preview images
│       └── neon-roll-key-art.jpg
├── src/
│   ├── main.ts                     # Core gameplay, rendering, physics, audio, progression, and UI logic
│   └── style.css                   # HUD, menus, overlays, shop, map UI, and responsive styling
├── index.html                      # Game shell and UI markup
├── package.json
├── tsconfig.json
└── README.md
```

## Implementation Notes

### Track and Physics

The procedural track uses analytic centerline functions shared by physics and rendering. Keeping both systems on the same mathematical path reduces visual/physics disagreement as the track curves through 3D space.

Track segments are generated ahead of the player and can contain different hazard and pickup combinations as progression increases.

### Gravity Inversion

Purple gates invert the gravity direction and move gameplay to the opposite side of the track. Obstacles can exist on both track faces, and steering behavior is adjusted so left/right input remains intuitive after the camera rolls during a gravity flip.

### Persistence

Progress and settings are stored locally in the browser, including data such as:

- Gem balance.
- Owned and selected skins.
- Map progression and lifetime distance.
- Best score and career statistics.
- Audio, visual-effects, screen-shake, and reduced-motion preferences.

### Performance

Bloom effects can be disabled for lower-powered devices. The game also detects coarse-pointer devices and uses more conservative visual-effect defaults for mobile hardware.

### Debugging

A debug hook is exposed as:

```js
window.__nr
```

It provides access to useful runtime state and manual frame/tick behavior for automated testing and debugging workflows.

## CrazyGames Integration

The main branch includes **CrazyGames SDK v3** lifecycle hooks for gameplay start/stop events and `happytime` events when appropriate.

The current main build uses the gem-based revive system and does **not** depend on rewarded ads for the core revive flow.

Before publishing to a web game portal, run:

```bash
npm run typecheck
npm run build
```

Then upload the generated `dist/` build according to the platform's submission requirements.

## Current Status

Completed systems include:

- [x] Endless rolling core loop.
- [x] Increasing speed and difficulty.
- [x] Procedural curved track generation.
- [x] Obstacles, moving hazards, walls, gaps, and lasers.
- [x] Gravity inversion gates and dual-sided track gameplay.
- [x] Full HUD, pause screen, menus, statistics, and notifications.
- [x] Ten map environments with distance-based progression.
- [x] Multiple ball skins and persistent shop currency.
- [x] Shield, Slow, x2, and Ghost power-ups.
- [x] Boost pickups.
- [x] Gems and score bonuses.
- [x] Near-miss / close-call scoring.
- [x] Gem-based single-run revive.
- [x] Laser warning system.
- [x] Missions and daily rewards.
- [x] Lost Signal narrative transmissions.
- [x] Procedural Web Audio music and sound effects.
- [x] Visual effects, particles, bloom, screen shake, and reduced-motion support.
- [x] CrazyGames SDK v3 lifecycle integration.
- [ ] Final thumbnail and portal submission workflow.
