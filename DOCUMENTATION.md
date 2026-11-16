# Asteroids — System Reference & Documentation Guide

**Audience:** future human developers and AI coding agents working on this codebase.
**Source of truth:** `asteroids_js.html` (the entire game) plus the `test/` harness.
**Generated:** 2026-10-24, after the UFO feature, engine stabilization, test-harness build, file rename from `qwen_asteroids.html`, and the completed procedural audio system (Web Audio synthesis, master-bus limiter, game-over silencing — play-tested and tuned by ear). **Updated:** 2026-10-25 — UFO sine-bob retunes, two-tier saucers, saucer-fire rock destruction + rock targeting, debug spawn key, spawn grace, ramming parity (§2.6, §2.10, §3.1, changelogs 18–24).
**Line numbers are approximate** — the file shifts with edits. Locate code by its banner comments (e.g. `/* SHIP — inertia / friction flight model */`), which are stable landmarks.

---

## 0. Project Map & Quick Facts

| Path | Role |
|---|---|
| `asteroids_js.html` | The whole game: markup, CSS, and one `<script>` IIFE (~1,700 lines). No build step, no dependencies, zero installs — runs offline by opening the file. |
| `test/harness.js` | Node test loader: extracts the `<script>` block, runs it in a `vm` sandbox with DOM/canvas/audio stubs and a seeded RNG. |
| `test/engine.test.js` | 28 regression tests: state machine, two-tier UFO lifecycle (large/small saucers, wave-ramped small-saucer chance, debug spawn hook, saucer-fire rock destruction + rock targeting, spawn grace, ramming breaks rocks), laser physics, collisions, HUD layout, particle system, procedural sound synthesis, game-over audio silencing, determinism. |
| `versions/` | Timestamped manual backups. Older backups keep the `qwen_asteroids_*` name — they predate the rename and are never loaded by the harness. |
| `DOCUMENTATION.md` | This guide. |

**Run the game:** open `asteroids_js.html` in any browser.
**Run the tests:** `node --test test/engine.test.js` (Node ≥ 18, built-ins only).
**Controls:** `W`/`↑` thrust · `A`/`←` and `D`/`→` rotate · `Space` fire · `Enter`/`Space` start from menu or game-over · `R` restart after game over. **Debug:** `U` zero the UFO spawn timer (forces a spawn attempt on the next frame, PLAYING only).

---

## 1. Architectural Overview & State Machine

### 1.1 Shape of the codebase

Everything lives in one IIFE inside a single `<script>` block:

1. **`STATE`** — frozen enum: `MENU`, `PLAYING`, `GAME_OVER` (~line 43).
2. **`CONFIG`** — frozen tuning table; the single authority for every gameplay constant (~line 49; full reference in §2.10).
3. **Geometry helpers** — `pointInPolygon`, `circlePolygonHit`, `segPolygonHit` (§3.1).
4. **Entity hierarchy** — `Vector2D`, `Entity`, `Ship`, `Asteroid`, `Laser`, `UFOShip`, `UFOLaser`, `ParticleSystem` (§2).
5. **`Engine`** — facade owning the canvas, input, entity arrays, timers, and both loops.
6. **`SoundEffects`** — procedural Web Audio synth owning every sound effect (§2.11); instantiated by the `Engine`, defined just before the bootstrap.
7. **Bootstrap** — `new Engine(document.getElementById("game"))`, a resize listener, `engine.start()`, then the inert TEST EXPORT hook (§4.1).

There are no modules, imports, or build tooling. Nothing mutates `CONFIG` or `STATE` (both `Object.freeze`d).

### 1.2 The decoupled loop: update vs render

`Engine.start()` installs one `requestAnimationFrame` loop whose body is strictly two phases:

```js
const loop = (now) => {
  requestAnimationFrame(loop);
  let dt = (now - this.lastTime) / 1000;
  this.lastTime = now;
  if (dt > 0.05) dt = 0.05;   // clamp after tab-switch / hitches
  if (dt < 0) dt = 0;
  this.lastDt = dt;
  this.time += dt;
  this.update(dt);            // state mutation only
  this.render();              // drawing only
};
```

- **`update(dt)`** mutates entity state, timers, and scores. It performs **no draw calls** and reads no canvas state. Every entity class has its own `update(dt)`; the engine only sequences them.
- **`render()`** reads state and draws: clear (`#04060c`) → star field → asteroids → lasers → UFOs → UFO lasers → particles → ship (PLAYING only) → vignette → HUD/banner/menu/game-over overlays. It performs **no state mutation**.
- **Determinism caveat:** `render()` consumes `Math.random()` (thrust-flame flicker, twinkle gates). Fine in-game, but the harness deliberately calls `render()` inside `step()` for the same frames a real loop would, so seeded simulations stay lockstep-reproducible (§4.3).

Why the split matters: physics can be simulated headlessly at any timestep (the harness drives `update()` directly), DPR/resize concerns stay confined to render, and each half can be reasoned about — and tested — independently.

### 1.3 States and transitions

`setState(next)` is the **only** transition mechanism; it centralizes all entry actions (~line 783):

| State | Entered from | Entry actions (in `setState`) | In-loop behavior (`Engine.update`) |
|---|---|---|---|
| `MENU` | initial construction | `seedAmbient()`: 5 size-3 asteroids drifting at 0.7× speed, no ship | asteroids keep drifting behind the menu overlay |
| `PLAYING` | `startGame()` (Enter/Space on MENU or GAME_OVER; `R` on GAME_OVER) | reset score/lives/wave, clear all entity arrays, reset `ufoSpawnTimer` to `spawnEvery × [0.5, 1.0]`, clear particles, set `interWaveTimer = 1.1`, reset heartbeat state, deploy `Ship` at field centre | full simulation (§1.4) |
| `GAME_OVER` | `destroyShip()` when `lives` reaches 0 | compute `newRecord`, persist high score to `localStorage["neon-asteroids-highscore"]` (try/catch-guarded), silence all continuous voices | asteroids keep drifting behind the game-over overlay; all voices silent (the mid-frame state guard, §1.4, prevents resurrection) |

**"Testing Mode" is not a `STATE` value.** It is an *external* mode provided by the harness: in the `vm` sandbox `requestAnimationFrame` is stubbed to a no-op, so the browser loop never runs; tests drive `engine.update(dt)` / `engine.render()` manually at a fixed `dt = 1/60`. The engine is unaware it is being tested — which keeps the tests honest.

### 1.4 PLAYING-loop sequence (per frame)

`Engine.update(dt)` (~line 1100) runs, in order:

1. `particles.update(dt)` (always, all states).
2. **State switch.** MENU/GAME_OVER: only ambient asteroid drift. PLAYING:
   - banner timer decay; `ship.fire()` if `input.fire` is held;
   - `ship.update`, lasers update, asteroids update;
   - **UFO spawn scheduling:** `ufoSpawnTimer -= dt`; on expiry reset to `CONFIG.ufo.spawnEvery × [0.75, 1.25]`; if fewer than `maxConcurrent` (2, shared across tiers) non-offscreen UFOs are active, roll the tier — small with chance `smallUfoChance(wave) = min(0.4 + max(0, wave − 1) × 0.1, 0.8)` — and spawn `new UFOShip(engine, tier)`;
   - UFOs update, UFO lasers update;
   - `resolveCollisions()` (§3.1);
   - filter out dead lasers/UFOs/UFO-lasers/asteroids;
   - **mid-frame state guard:** if the state flipped during `resolveCollisions` (the final ship death calls `setState` from inside it, silencing all voices), the case stops here — the syncs below would otherwise resurrect the siren on the game-over screen;
   - **audio sync:** thrust voice polls `input.thrust` (fades in on hold, out on release/death), per-tier siren voices track live UFO presence (start when that tier has a saucer, stop at none — idempotent; both may warble at once at their distinct pitches), and `updateHeartbeat(dt)` drives the accelerating two-tone heartbeat;
   - **wave progression:** if the field is empty, count down `interWaveTimer` (armed at 1.4 s whenever the field is non-empty; 1.1 s before wave 1) and call `nextWave()`.
3. `nextWave()` increments `wave`, spawns `min(2 + wave, 9)` size-3 asteroids with speed multiplier `1 + (wave − 1) × 0.07`, at positions ≥ 240 px from the ship (up to 24 placement attempts), and shows the "WAVE n" banner for 2.2 s.

Ship death flow: `destroyShip()` emits a debris burst and the deep `player` explosion, decrements `lives`; at 0 → `setState(GAME_OVER)`; otherwise arms `respawnTimer = 2.2 s`, after which `Ship.respawn()` redeploys with a rising spawn sweep (§2.3). A ship–asteroid ram destroys the rock first, exactly like a laser hit (split + its own score, original parity).

---

## 2. Class Architecture & Entity Matrix

### 2.1 `Vector2D` (~line 95) — algebra utility

Immutable-style API with **one deliberate trap**: `add()` and `scale()` **mutate `this` in place** (and return it). `clone()`, `fromAngle()`, `random()` exist for safe composition.

> ⚠️ **The destructive-scale trap.** Chaining `a.add(b.scale(dt))` permanently multiplies `b` by `dt`. This exact bug froze the ship once (the comment above `Entity.integrate` documents it) and later nearly froze particle drift in `ParticleSystem.update`. Both are fixed and regression-tested. **Rule:** never chain `scale()`/`add()` on a vector you need again — `clone()` first.

Methods in use: `add`, `scale`, `clone`, `normalize`, `limit(max)`, `magnitude`, `angle`, `distanceTo`, `fromAngle(a)`, `random(speed)`, `sub` (via constructor math in fire aims).

### 2.2 `Entity` (~line 234) — base class

Fields: `position`, `velocity`, `radius`, `alive`, `engine`. Provides:

- **`integrate(dt)`** — advance `position` by `velocity × dt` **without mutating velocity** (explicit x/y increments; see the trap comment), then `wrap()`.
- **`wrap(w, h)`** — *radial* screen wrap (§3.3): teleports the entity to the opposite edge exactly when its outer rim fully clears an edge — no visual snapping.

### 2.3 `Ship` (~line 279) — player

| Field | Meaning |
|---|---|
| `angle` | nose heading, starts `−π/2` (up) |
| `dead` / `visible` | death state / draw gate (also gates UFO-laser and asteroid hits) |
| `fireTimer` | cooldown countdown (`fireCooldown` 0.16 s) |
| `invulnTimer` | post-respawn immunity (2.6 s); ship blinks at ~14 Hz while active |
| `respawnTimer` | armed by `destroyShip`, counts down in `update`, then `respawn()` |

- **`fire()`** — guards on `dead`/`visible`/cooldown; spawns a `Laser` whose velocity is **ship velocity + muzzle direction × `CONFIG.laser.speed`** (360 px/s). Muzzle offset is `radius + 6` px along the nose, applied to a **clone** so the offset can't inflate the shot speed (see §5, KI-0 history). Fires the sawtooth laser plunge via `engine.sfx.playLaser(false)` — placed after the cooldown gate, so held-key autofire can't double-trigger.
- **`respawn()`** — safe-position search: prefers field centre, then up to 32 random candidates ≥ `asteroid.radius + 150` px from every asteroid; resets velocity, angle (up), and grants 2.6 s immunity, emitting a 16-particle cyan debris burst plus the ascending `playSpawn()` materialization sweep.
- **`update(dt)`** — if dead, count down respawn; else: rotate from input at 3.8 rad/s, thrust 1400 px/s² along the nose, apply **frame-rate-independent exponential drag** `v × e^(−0.4·dt)`, hard-cap speed at 700 px/s, decay timers, integrate.
- **`render()`** — wireframe triangle in cool white/cyan with glow; thrust flame streak behind the nose when thrusting.

### 2.4 `Laser` (~line 466) — player projectile

Fields: `radius` 2.6, `life` 1.15 s, `prevPos` (snapshot **before** each `integrate` — the swept-collision segment endpoints). Expires by lifetime, not by leaving the screen. Renders as an 8 px warm-gold streak along its velocity.

### 2.5 `Asteroid` (~line 372) — destructible obstacle

- Constructed with `size` ∈ {3, 2, 1} and an optional `speedMul` (wave scaling / ambient 0.7×).
- **Procedural silhouette:** jagged polygon generated once at construction (see §3.4); rotates at a per-size spin rate and drifts at a per-size random speed.
- **`update(dt)`**: `angle += spin × dt`, integrate, wrap.
- Splitting is driven by `Engine.destroyAsteroid`: children inherit ~114% of parent velocity plus a random perpendicular impulse (55–125 px/s). See the size table in §2.10.

### 2.6 `UFOShip` (~line 540) — hostile saucers, two tiers

Lifecycle was built and debugged this project; the entry/exit cull is the subtle part.

**Two tiers (2026-10-25):** `new UFOShip(engine, tier)` with `tier = "large" | "small"`; every per-tier value comes from the saucer's `CONFIG.ufo.tiers[tier]` row, bound as `ufo.cfg` (radius, scale, score, speed, fireInterval, aimSpread, sirenBase, stroke/glow/burst colors). **Large** is the classic saucer grown 20% (radius 26.4, drawn through a 1.2× transform so the hull stays matched to the hitbox) — otherwise unchanged from the single-tier era. **Small** is the rare elite: 20% smaller (17.6), +50% cruise (217.5 px/s), fires every 1.5 s with ±4.8° jitter (aimSpread 0.084), warbles at 900 Hz, drawn yellow (test palette — reverting to green is a one-object edit), worth 500. Tier-independent: the sine bob, lane band, spawn cadence, and the 2-UFO cap (shared).

- **Spawning** (`new UFOShip(engine, tier)`): spawns **intentionally offscreen** — `x = −40` or `width + 40`, vertical lane `y = height × (0.25 + rand × 0.45)` stored as `baseY` (band [0.25h, 0.70h], chosen so the full bobbed path — saucer rim included — stays on screen down to ~472 px tall windows for both tiers); cruises horizontally at the tier's `speed` toward the field; `hasEntered = false`; first shot fires half the tier's interval after spawn.
- **Spawn grace (2026-10-25):** `CONFIG.ufo.spawnGrace` (0.5 s) of rock-immunity. The clock **holds during the offscreen corridor** and starts counting down once the saucer enters the field; on expiry, a clear-to-exit hold pins a 0.05 s floor while any rock still overlaps the hull — so the saucer never dies to the rock it is phasing out of, and denser fields automatically get longer effective protection. Rocks **pass through** a graced saucer (ship-parity; the asteroid × UFO pair skips it) while player lasers stay lethal throughout.
- **Entry/exit cull (`update`)** — never wrap:
  - while `!hasEntered`: once the UFO is *fully inside* the screen bounds it sets `hasEntered = true`;
  - once entered: if it later moves *fully past* the far boundary (rim-clear on either side), it is culled (`alive = false`, `offscreen = true`) and removed by the engine's filter.
  - The `hasEntered` guard exists because the spawn point would otherwise satisfy the exit test on frame one (the original "UFO never spawns" bug).
- **Bobbing:** drawn `y = baseY + sin(phase) × bobAmp (96 px)` at `bobFreq` 1.6 rad/s — a prominent sine path (~1.7 wave cycles per crossing; raised +50% from 64 px after play-testing, and originally 22 px @ 1.15 rad/s, which read as a straight line). Peak vertical speed 153.6 px/s slightly exceeds the 145 px/s cruise. `baseY` is the collision lane — the bob moves the hitbox with the sprite.
- **`fire()`** — picks its target via `chooseFireTarget()`: with the ship alive, `rockTargetChance` (30%) of shots aim at the **closest asteroid** (nearest by centre distance at fire time, no lead prediction) and the rest at the ship; with the ship dead, **every** shot aims at the closest rock; with no live rocks it falls back to the ship, or a random bearing when both are gone. Adds ±the tier's `aimSpread` of jitter via `fromAngle(dir.angle() + jitter)`, then launches a `UFOLaser` at **the shared muzzle speed `CONFIG.laser.speed`** (360 px/s). Muzzle offset is `radius × 0.7` along the aim — applied to a clone. Targeting alters aim only — saucers never steer toward or away from rocks.
- **Death:** `Engine.destroyUFO` sets `alive = false`, `offscreen = true` (so it doesn't count toward the concurrency cap), awards the **tier's** score (large 200 / small 500), emits a tier-colored debris burst.
- **Saucer fire vs rocks (2026-10-25):** UFO lasers break asteroids with the same swept test as the player's lasers — splitting them WITHOUT awarding the player score (original parity); rocks in turn consume saucer shots (§3.1), so a saucer can split or clear the field and even trigger the next wave by destroying the last rock.
- **Rendering:** classic vector saucer (§3.4) drawn through a `ctx.scale(tierScale)` transform with counter-scaled stroke widths — one geometry, two sizes; green (large) / yellow (small).

### 2.7 `UFOLaser` (~line 618) — hostile projectile

Same shape as `Laser` but: `radius` 2.8, `life` 2.2 s (crosses more of the field than the player's), red styling with a 15 px tail. Shares the swept-segment collision treatment. Red for both tiers — projectile color signals hostility, not the shooter tier.

### 2.8 `ParticleSystem` (~line 658) — debris bursts

- `burst(pos, rgb, count, speedMin, speedMax, lifeMin, lifeMax)` spawns plain-object particles with randomized speeds/lifespans and ±45 RGB jitter per channel.
- `update(dt)`: drift via explicit non-mutating increments, exponential drag `e^(−1.7·dt)`, life decay, **swap-pop removal** (O(1), order not preserved). (An earlier version chained the destructive `scale()` here — velocity collapsed by `dt` each frame and drift nearly froze; fixed and regression-tested.)
- `render(ctx)`: streaks — tail length proportional to velocity (×0.035), alpha tied to remaining life.

### 2.9 `Engine` (~line 705) — facade and owner of everything

Responsibilities: canvas/DPR sizing (`onResize`, dpr capped at 2), star field generation (60–220 stars, density-scaled), input binding (§0 controls; `blur` clears all held keys and stops the thruster voice), high-score persistence, state machine, timers (`ufoSpawnTimer`, `interWaveTimer`, `bannerTimer`, heartbeat), entity arrays (`ship`, `asteroids`, `lasers`, `ufos`, `ufoLasers`, `particles`), collision resolution, destruction routines (`destroyAsteroid`, `destroyUFO`, `destroyShip` — each firing its explosion voice), both loops, and ownership of `sfx` (§2.11). Every `setState` entry starts from silence (continuous voices force-stopped; they re-engage from the per-frame syncs) — and because `setState` can fire mid-frame (the final ship death, from inside `resolveCollisions`), the PLAYING case bails out after its entity filters when the state is no longer PLAYING, so the per-frame syncs can never resurrect a silenced voice on the game-over screen.

### 2.10 `CONFIG` reference (all gameplay constants)

| Group | Key | Value | Notes |
|---|---|---|---|
| root | `startLives` | 3 | |
| ship | `radius` | 12 | collision radius |
| | `rotateSpeed` | 3.8 | rad/s |
| | `thrust` | 1400 | px/s² |
| | `drag` | 0.4 | exponential decay coefficient (per-second) |
| | `maxSpeed` | 700 | px/s hard cap |
| | `fireCooldown` | 0.16 | s between lasers |
| | `respawnDelay` | 2.2 | s before redeploy |
| | `invulnerable` | 2.6 | s of post-respawn immunity |
| laser | `radius` / `life` / `speed` | 2.6 / 1.15 s / **360** | `speed` is the **single shared muzzle speed** for player and UFO lasers |
| ufo | `bobAmp` / `bobFreq` | 96 / 1.6 | sine-bob amplitude (px) / rate (rad/s), shared by both tiers; lane band [0.25h, 0.70h] keeps the full bobbed path on screen |
| | `spawnEvery` | 24 | mean seconds between attempts (actual delay ×[0.5,1.0] initial, ×[0.75,1.25] after) |
| | `maxConcurrent` | 2 | cap on active (non-offscreen) UFOs, shared across tiers |
| | `smallChanceBase / WaveStep / Max` | 0.4 / 0.1 / 0.8 | small-saucer chance per attempt: min(0.4 + max(0, wave−1) × 0.1, 0.8) — 40% at wave 1, 80% from wave 5 |
| | `rockTargetChance` | 0.3 | chance a saucer shot aims at the closest asteroid (always when the ship is dead; ship/random fallback when no rocks) |
| | `spawnGrace` | 0.5 s | rock-immunity after spawn; the clock starts at field entry and holds while the hull overlaps any rock (clear-to-exit) |
| ufo.tiers.large | radius / scale | 26.4 / 1.2 | classic saucer grown 20%; drawn hull ≈ hitbox |
| | score / speed | 200 / 145 | unchanged from the single-tier era |
| | fireInterval / aimSpread | 2.0 s / 0.12 rad | ±6.9° aim jitter |
| | sirenBase | 750 Hz | siren carrier pitch |
| ufo.tiers.small | radius / scale | 17.6 / 0.8 | elite saucer, 20% smaller (yellow test palette) |
| | score / speed | 500 / 217.5 | +50% cruise |
| | fireInterval / aimSpread | 1.5 s / 0.084 rad | fires more often; ±4.8° jitter (+30% accuracy) |
| | sirenBase | 900 Hz | higher-pitched warble |
| ufoLaser | `radius` / `life` | 2.8 / 2.2 s | |
| asteroid.3 | radius / score / speed / spin | 56 / 20 / 28–85 px/s / 0.55 rad/s | |
| asteroid.2 | radius / score / speed / spin | 31 / 50 / 70–145 / 1.25 | |
| asteroid.1 | radius / score / speed / spin | 16 / 100 / 125–230 / 2.20 | |
| split | `inherit` | 1.14 | child keeps ~114% of parent velocity |
| | `lateralMin` / `lateralMax` | 55 / 125 | perpendicular impulse (px/s) |
| audio | `master` | 0.5 | master output level (linear) |
| | `limiter` | −3 dB threshold / ratio 20 / knee 0 / 2 ms attack / 120 ms release | master-bus ceiling guard (DynamicsCompressorNode) — transparently holds sums that would clip |
| | `lead` | 0.02 s | schedule-ahead so envelopes never land behind the audio playhead (click prevention) |
| | `spawn` | sine 100→1200 Hz / 0.40 s | respawn materialization sweep |
| | `laser.player` | sawtooth 800→100 Hz / 0.15 s | player fire |
| | `laser.ufo` | triangle 1400→400 Hz / 0.12 s | saucer fire |
| | `thrust` | looped white noise → lowpass 800 Hz / gain 1.0 | continuous whoosh; 0.10 s attack, 0.06 s release; ramps fire on state transitions only |
| | `siren` | large 750 / small 900 Hz ± 100 @ 4 Hz | per-tier carriers; LFO depth/rate, gain 0.14 |
| | `explosion.player` | 1.8 s / lowpass 250 Hz | deep catastrophic rumble |
| | `explosion.ufo` | 0.4 s / lowpass 1200 Hz | metallic crunch |
| | `explosion.asteroid-large` | 0.8 s / lowpass 400 Hz | heavy impact (sizes 3–2) |
| | `explosion.asteroid-small` | 0.25 s / lowpass 800 Hz | crisp pop (size 1) |
| | `heartbeat` | 80/65 Hz, 1.2 → 0.05 s | triangle thump w/ 2×→1× pitch drop; 0.22 s decay |

> **Gain values are hand-tuned by ear** against real playback hardware (bass-limited speakers need far larger low-frequency amplitudes — hence heartbeat 1.99, asteroid explosions 1.70/1.55, thrust 1.0). Do not "normalize" them back below 1.0 without listening on real speakers.

### 2.11 `SoundEffects` (~line 1445) — procedural Web Audio synth

Defined immediately before the BOOTSTRAP banner; the `Engine` owns one instance as `engine.sfx`. No audio assets and no Base64: every voice is synthesized live from oscillators, a white-noise `AudioBuffer`, `BiquadFilterNode`s and gain envelopes. All tuning lives in `CONFIG.audio`.

- **Lazy + gesture-safe:** the `AudioContext` is created on first use, and `unlock()` (called from every `keydown`) resumes it, satisfying browser autoplay policy. Every entry point is a guarded no-op when audio is unavailable (test sandbox, old browsers) and wrapped in try/catch — the game never breaks for lack of audio.
- **Master-bus limiter:** a `DynamicsCompressorNode` sits between the master gain and the destination (`CONFIG.audio.limiter`: threshold −3 dB, knee 0, ratio 20, attack 2 ms, release 120 ms). Per-voice gains are hand-tuned by ear — low frequencies need large amplitudes to *perceive* as loud (equal-loudness contours) — and overlapping voices can sum past the digital ±1.0 ceiling (worst-case stack ≈ 2×: heartbeat peak + explosion + thrust + laser). The limiter transparently holds such peaks just under the ceiling instead of hard-clipping them into crackle, which makes every gain knob **safe to turn up** — pushing any voice louder can no longer cause clipping elsewhere. (Standard-compressor caveat: no look-ahead, so an extreme simultaneous transient can overshoot for ~2 ms — inaudible in practice.)
- **One-shot sweep voices** (`_sweep`): 12 ms **linear** attack from true zero, exponential pitch ramp, exponential decay to `0.0001` (never to literal 0 — that throws in real browsers). Every voice also schedules `CONFIG.audio.lead` (20 ms) **ahead of the playhead**: zero-lead envelope events can land behind the live audio thread and get crushed into full-volume steps, which are heard as clicks — at repeating cadences those clicks stack into a machine-gun buzz (this bit the heartbeat in real-browser testing; the JS-side cadence was measured correct, avg 1.02 s per beat). Used by `playSpawn()` (sine 100→1200 Hz, 0.4 s — hooked in `Ship.respawn`), `playLaser(false)` (sawtooth 800→100 Hz, 0.15 s — `Ship.fire`), `playLaser(true)` (triangle 1400→400 Hz, 0.12 s — `UFOShip.fire`), and `playHeartbeat(high)` (triangle thump with a 2×→1× pitch drop down to the 80/65 Hz identity pitch — a pure sine that low is below most speakers' range, so the sweep and harmonics keep it audible; 0.22 s decay, gain hand-tuned per §2.10 — driven by `Engine.updateHeartbeat`).
- **Persistent gain-gated voices:** `startThrust()`/`stopThrust()` — a **looped white-noise buffer** (one second of private-LCG noise, generated once at first use) through a lowpass biquad (`CONFIG.audio.thrust.cutoff`, 800 Hz), gain-gated: ramps up over 0.10 s on hold and out over 0.06 s on release. No tonal oscillator, so no harmonic stack to read as "buzz". Ramps are scheduled on **state transitions only** (guarded by an `active` flag — re-anchoring the ramp every frame would churn the audio graph 60×/s), polled per frame against `input.thrust` (also stopped on death/hidden ship, blur, and every non-PLAYING state entry). `startUFOSiren(tier)`/`stopUFOSiren(tier)` — **one independent voice per saucer tier** (`sirens.large`/`sirens.small`): a sine carrier warbled by a square LFO wired directly into the carrier's `frequency` AudioParam — large 750 Hz (650–850 Hz warble band), small 900 Hz (800–1000 Hz) — looping cleanly with no scheduling; started in the `UFOShip` constructor and tracked per-frame against **per-tier** presence (idempotent in both directions; both voices may run at once at their distinct pitches).
- **Noise explosions** (`playExplosion(type)`): a private LCG (Numerical Recipes constants) fills an `AudioBuffer` with white noise at trigger time, routed through a lowpass biquad and a decay envelope with a soft 8 ms linear onset (slamming noise in at full level reads as a click, and rapid destruction bursts then stack into a buzz), one-shot. Four variants from `CONFIG.audio.explosion`: `player` (1.8 s / 250 Hz), `ufo` (0.4 s / 1200 Hz), `asteroid-large` (0.8 s / 400 Hz — sizes ≥ 2), `asteroid-small` (0.25 s / 800 Hz — size 1).
- **Determinism contract:** the audio layer **never** consumes `Math.random()` — noise comes from the private LCG and all cadence math is deterministic — so the harness's seeded gameplay stream is untouched (locked in by the sound-system regression test and the determinism test).
- **Heartbeat** (`Engine.updateHeartbeat`, PLAYING only): alternating 80/65 Hz thumps with interval `intervalMin + (intervalMax − intervalMin) × clamp(asteroids.length ÷ wave-start count, 0, 1)` (bounds hand-tuned in `CONFIG.audio.heartbeat`: 0.05 s floor, 1.2 s ceiling) — a full field beats at ~1.2 s, thinning accelerates it linearly toward the floor, and an empty field (inter-wave beat) goes silent with the accumulator reset so the next wave opens on a thump. `heartbeatMax` is captured at each `nextWave()`.

---

## 3. Collision Mechanics & Graphics Engine

### 3.1 Collision pipeline

`Engine.resolveCollisions()` (PLAYING only) runs after all per-entity updates. Two helper layers do the work:

- **Broad phase** — cheap circle tests using plain radius sums (e.g. `ship.radius + ast.radius`, `ufo.radius + ast.radius`); pairs failing the distance check are skipped before any polygon math.
- **Narrow phase (polygons)** —
  - `circlePolygonHit(cx, cy, r, pts)`: true if the centre is inside the polygon (`pointInPolygon`) or within `r` of any edge (`pointSegmentDistSq`). Used for ship × asteroid (with the ship circle at 85% radius as a forgiveness factor).
  - `segPolygonHit(ax, ay, bx, by, r, pts)`: **swept** test for fast projectiles — does the segment (previous position → current position) cross a polygon edge, or pass within the laser radius of one? Used for laser × asteroid; catches tunnelling and concave-corner passes that a per-frame point test would miss.

**Collision matrix** (verified against `resolveCollisions()`, ~lines 1022–1096):

| Pair | Test | Outcome |
|---|---|---|
| laser × asteroid | **swept** `segPolygonHit` over the laser's frame travel, vs asteroid polygon | laser dies (+spark burst); asteroid splits/scores (`destroyAsteroid`) |
| laser × UFO | circle–circle: `laser.position.distanceTo(ufo.position) ≤ laser.radius + ufo.radius` (tier radius: large 26.4 / small 17.6) | laser dies (+tier-colored spark burst); `destroyUFO` (+tier score: large 200 / small 500) |
| UFO laser × asteroid | **swept** `segPolygonHit` (same as the player's lasers) | laser dies (+spark); asteroid splits, **no score** (original parity) |
| UFO laser × ship | circle–circle: `ulaser.position.distanceTo(ship.position) ≤ ulaser.radius + ship.radius` | laser dies; `destroyShip` |
| asteroid × ship | broad-phase circle (`ship.radius + ast.radius`), then `circlePolygonHit` with the ship circle at **85% radius** (forgiveness factor) vs the asteroid polygon | **both destroyed** (2026-10-25, original parity): the rock splits + scores exactly like a laser kill — the asteroid goes first so its points land before the game-over high-score snapshot — plus `destroyShip` |
| asteroid × UFO | broad-phase circle only (`ufo.radius + ast.radius`); **skipped during spawn grace** (rocks pass through a graced saucer) | both destroyed: `destroyUFO` **plus** the asteroid's own score |
| asteroid × asteroid | none | pass through (original game behaviour) |

Note the deliberate asymmetries (updated 2026-10-25): **rocks shield whatever is behind them from saucer fire** — the UFO-laser × asteroid pair runs before the UFO-laser × ship pair, so a rock consumes the shot first; saucer fire breaks rocks WITHOUT awarding the player score (original parity); and both laser × asteroid pairs use the swept test.

**Immunity & gating:** while `ship.invulnTimer > 0` the ship ignores hits — and a ramming invulnerable ship leaves the rock fully intact (no laser effect); a dead/hidden ship (`dead || !visible`) is skipped entirely by UFO-laser and asteroid checks. Ship bullets never harm the ship; UFO lasers never harm the UFO.

> **Regression to know about (fixed this project):** `segPolygonHit` computed the edge/segment intersection with `t = denom !== 0 && ...`. The boolean short-circuit made `t`/`u` become `false` → coerced to `0` for **parallel** edges (including a degenerate zero-length segment), silently passing the `0..1` range check — a phantom hit at any distance. The fix treats `denom === 0` as "no crossing" (`t = u = −1`); the proximity clause (b) still catches grazes. Locked in by `test/engine.test.js` ("stationary segments never phantom-hit; real swept hits still register").

### 3.2 Scoring

| Source | Points |
|---|---|
| Large asteroid (size 3) | 20 |
| Medium (2) | 50 |
| Small (1) | 100 |
| UFO (large) | 200 |
| UFO (small, rare) | 500 |

Saucer fire destroying asteroids awards the player **nothing** (original parity) — otherwise baiting saucers into rocks would print free points.

### 3.3 Screen wrap — the no-snap guarantee

`Entity.wrap(w, h)` keys the wrap to the entity's **radial boundary**, not its centre:

```js
wrap(w, h) {
  const r = this.radius;
  const p = this.position;
  if (p.x + r < 0) p.x += w;          // fully past the left edge
  else if (p.x - r > w) p.x -= w;     // fully past the right edge
  if (p.y + r < 0) p.y += h;
  else if (p.y - r > h) p.y -= h;
}
```

An entity teleports to the opposite side exactly when its outer rim has fully left the current edge. Consequences:

- Nothing is ever half-rendered on one edge and half on the other — no clipping seams.
- Teleport distance is constant (±`w`/±`h`), so velocity and the swept-collision segment stay valid; the laser `prevPos` snapshots happen *before* integrate, so a wrap frame simply yields a longer segment — swept tests still catch anything the beam crossed.
- **UFOs deliberately do not wrap**: they cruise in, patrol once, and are culled off the far side (§2.6).

### 3.4 Procedural graphics via canvas paths

All drawing is stroked paths in a dark space palette (`#04060c` background, cached radial-gradient vignette). DPR handling: backing store is scaled by `min(devicePixelRatio, 2)` and the context transform is set once, so game coordinates are CSS pixels.

**Glow technique (used by asteroids, saucer, HUD):** draw the path twice — a wide, low-alpha under-stroke (soft neon halo) followed by a crisp, narrower top stroke. Lasers instead use `shadowBlur`.

- **Asteroids** — at construction, a jagged polygon is generated once: irregular radii around the centre (per-vertex jitter) and a per-size vertex count. Points are cached in local space; each frame `worldPoints()` rotates them by `angle` and translates to `position`. One-time generation = stable silhouette + cheap per-frame math.
- **The saucer (`UFOShip.render`)** — a fixed 15-segment path mirroring the original game's vector display: a wide hexagonal hull (tips at ±20 px, top/bottom edges at ±7 px wide, ±6 px tall), a trapezoid dome peaking at −11 px, and two vertical hull divider lines at x = ±4. Two strokes (4.5 px @ 12% alpha halo, 1.7 px @ 95% alpha line). Deliberately straight lines only — no `ellipse()` — to match the vector-display aesthetic; each tier draws the shared geometry through a `ctx.scale` transform (large 1.2×, small 0.8×) with counter-scaled stroke widths, and the HUD saucer glyph reuses the silhouette at 0.45× the tier's scale in the tier's color.
- **Player ship** — wireframe triangle; a thrust flame streak is drawn with a random flicker gate while thrusting (this is the render-phase RNG consumer noted in §1.2).
- **Lasers** — tail streak backwards along the normalized velocity (8 px player, 15 px UFO), warm/red glow via `shadowBlur`.
- **Particles** — short streaks: tail offset ∝ velocity ×0.035, alpha = `life / maxLife`.
- **Stars** — 60–220 points (density = area/9000, clamped), 1–2 px, twinkling via phase offsets; regenerated on resize.

---

## 4. Test Harness & Development Hooks

### 4.1 Hook inventory

| Hook | Location | Input / trigger | Purpose |
|---|---|---|---|
| **TEST EXPORT** | `asteroids_js.html`, immediately after `engine.start()`, just before the closing `})()` of the IIFE | Fires only if a function is assigned to `globalThis.__ASTEROIDS_TEST__` **before** the script evaluates; it receives `{ engine, CONFIG, STATE }` | Makes the live engine reachable from a test sandbox. In a normal browser nothing defines that symbol, so the hook is inert — zero runtime cost, single-file promise preserved. |
| **Seeded RNG swap** | `test/harness.js` (sandbox setup) | Replaces `Math.random` inside the vm context with a seeded mulberry32 stream | Makes spawn delays, UFO sides, lanes, and wave layouts fully reproducible. No game-code changes needed for determinism. |
| **Recording canvas** | `test/harness.js` (`makeRecordingCtx`) | The game's single canvas context is a Proxy that logs every method call (`op`, `args`) into `ctx._calls` and stores property writes | Lets tests assert on *what was drawn* (HUD text, saucer geometry) without a browser. |
| **`lastDt` debug field** | `Engine` (`this.lastDt = dt` in the loop) | Read by nothing at present | Deliberate debug hook; reuse for future telemetry without re-plumbing the loop. |
| **`U` debug key** | `Engine.bindInput` keydown handler + `Engine.debugSpawnUfo()` | `U` during PLAYING (`e.repeat`-guarded) | Zeroes `ufoSpawnTimer` so the next frame runs the real spawn path (tier roll + shared concurrency cap) — forces saucers without waiting 18–30 s between natural spawns. In tests: call `e.debugSpawnUfo()` directly. |

### 4.2 Harness API (`test/harness.js`)

```js
const { loadGame, makeRecordingCtx, DT } = require("./harness.js");

const g = loadGame({ seed: 20261024 });
g.engine;     // live Engine instance (mutate/inspect freely)
g.CONFIG;     // the frozen CONFIG table
g.STATE;      // { MENU, PLAYING, GAME_OVER }
g.canvas;     // stubbed 960×600 canvas
g.ctx;        // recording context (g.ctx._calls = [{op, args}, ...])

g.step(frames = 1, dt = 1/60);  // advance the sim: clears ctx log,
                                // then engine.update(dt) + engine.render()
                                // per frame; after it returns, ctx._calls
                                // holds the LAST rendered frame.
g.hudTexts();                   // [{text, x, y}] fillText calls from the
                                // last rendered frame.
```

Sandbox details: DOM stubs (`document`, `window`, `localStorage` — in-memory `Map`), stubbed `requestAnimationFrame` (the loop never auto-runs; **tests are the loop**), and a seeded `Math.random`. The window stub is 960×600 — tests assert against that size.

### 4.3 Recipes for future iterations

- **Run the suite:** `node --test test/engine.test.js` (17 tests, ~0.8 s).
- **Spawn a UFO on demand:**
  ```js
  g.engine.startGame();
  g.engine.ufoSpawnTimer = 0.001;
  g.step(1);                    // UFO spawns offscreen; cruise it in with more steps
  ```
- **Force a UFO tier (tests):** monkey-patch the chance method on the live engine — `e.smallUfoChance = () => 1;` guarantees a small saucer, `() => 0` guarantees a large one; restore the original function afterwards (see the tier-forcing test).
- **Force a UFO spawn (debug):** press `U` in-browser during play, or call `e.debugSpawnUfo()` in tests — it zeroes `ufoSpawnTimer` so the next frame runs the real spawn path (tier roll + shared cap; with two saucers already active nothing happens until a slot frees).
- **Fire the player laser:** set `g.engine.input.fire = true;` then `g.step(1)` (cooldown 0.16 s applies).
- **Pause the engine:** simply stop calling `g.step()` — nothing advances outside the loop. To freeze *inside* a scenario, manipulate timers (e.g. `engine.ufoSpawnTimer = 1e9`).
- **Isolate physics cycles:** call `g.engine.update(dt)` directly without `render()` for pure-physics stepping; use a fixed `dt` (the harness default 1/60) for reproducibility.
- **Defuse interference in long sims:** the suite's `defuseHazards(g)` helper freezes asteroids, shrinks their collision reach, parks them below the UFO cruise band, and hides the ship — so a test can isolate exactly one collision pair. Copy that pattern for new scenario tests.
- **Determinism:** two `loadGame({ seed: X })` runs step in lockstep (asserted by the "same seed produces an identical gameplay timeline" test). New engine code that consumes randomness *in `update`* stays deterministic under the seed; randomness in `render` must stay render-only (flame flicker) to preserve lockstep.

### 4.4 Adding tests & gotchas

- Add new `test(...)` blocks to `test/engine.test.js`; helpers live at the top (`stepUntil`, `spawnUfo`, `defuseHazards`, `parkAsteroids`).
- The harness reads the game file by path: **`test/harness.js` → `GAME_PATH`**. If the game file is ever renamed, update that constant (it was updated for the `qwen_asteroids.html` → `asteroids_js.html` rename).
- The sandbox stubs only the DOM APIs the game currently uses — plus an inert recording `AudioContextStub` (added for the sound system: oscillator/gain/biquad/buffer/buffer-source/dynamics-compressor factories, node creations logged into `ctx._calls`, and oscillator/gain AudioParam calls recorded with their values so tests can assert scheduled pitches — e.g. the per-tier siren carriers). New engine code touching another new browser API will still need a corresponding stub in `test/harness.js`.
- Don't mutate `CONFIG` in tests — it is frozen; mutate entity/engine state instead (that's what the suite does).
- Cross-realm caveat: objects created inside the vm have their own `Array.prototype`; prefer `assert.deepEqual` on spread plain arrays (see the determinism test) rather than comparing vm-realm arrays by identity.

---

## 5. Known Issues & Technical Debt (remaining as of 2026-10-24)

| ID | Location | Issue | Suggested fix |
|---|---|---|---|
| KI-1 | `Engine.lastDt` | Debug field with no current readers — intentional hook, keep or remove at will. | — |
| KI-2 | `versions/` | Backup snapshots predate the file rename and keep the old `qwen_asteroids_*` names. Harmless (never loaded), just a naming inconsistency. | Optionally rename for consistency. |

*(Former KI-1/KI-2 — the swapped `Ship.respawn()` burst arguments and the destructive-scale velocity collapse in `ParticleSystem.update()` — were fixed on 2026-10-24 and locked in by regression tests 11 and 12.)*

## Appendix — Change log (recent sessions)

1. UFO spawning fixed (the `hasEntered` entry guard in `UFOShip.update` — spawn points are offscreen by design and must not trip the exit cull).
2. UFO laser retuned: muzzle speed unified with the player laser via `CONFIG.laser.speed` (360 px/s — single source of truth, behavior-neutral refactor); aim jitter added (`CONFIG.ufo.aimSpread`, ±0.12 rad).
3. UFO redesigned to the classic vector saucer silhouette (straight-line path, no ellipses); HUD glyph matches.
4. All debug HUD telemetry removed (DEAD/VIS/STHR/RT/INV/WAVE/LIVES/DT/TIME/X/Y and SPD/THRUST/CAP/KEY); the UFO status row (ACTIVE/NEXT) retained and repositioned beneath SCORE.
5. `segPolygonHit` phantom-hit fix (parallel edges / zero-length segments) + regression test.
6. Permanent test harness built (`test/harness.js`, `test/engine.test.js`), inert TEST EXPORT hook added to the game.
7. Game file renamed `qwen_asteroids.html` → `asteroids_js.html`; harness path updated.
8. This documentation written.
9. Fixed the two latent particle bugs: `Ship.respawn()`'s swapped burst arguments (the burst silently emitted zero particles) and `ParticleSystem.update()`'s destructive-scale velocity collapse (drift nearly frozen); both locked in with regression tests 11–12.
10. Documentation updated to reflect the fixes (§0, §2.1, §2.3, §2.8, §5) and the expanded 13-test suite.
11. Sound effects added: procedural Web Audio synth (`SoundEffects` class + `CONFIG.audio` tuning) — spawn sweep, dual laser voices, thruster hum, UFO siren, four noise-explosion variants, and the accelerating two-tone heartbeat. The harness gained a recording `AudioContextStub`; the suite grew to 14 tests. Audio never touches `Math.random()`, keeping seeded timelines intact.
12. Documentation updated for the audio system (§0, §1.1, §1.3, §1.4, §2.3, §2.9–§2.11, §4.4).
13. Real-browser audio polish — fixed the reported heartbeat "buzz". Diagnosis: the JS cadence was measured correct (150 s simulated session: 146 beats, gaps 0.45–1.9 s, avg 1.02 s, none near the 0.25 s floor), but every thump landed as a full-volume **click** in a real browser — the 5 ms *exponential* attack bunches its rise into the final millisecond, and zero-lead scheduling can drop envelope events behind the live audio playhead where they get crushed into instant steps. At the accelerating wave-tail cadence, with the thump as the loudest repeating voice (0.5 gain vs the laser's 0.25), those clicks stacked into the perceived machine-gun buzz. Fixes: all one-shot voices now use a 12 ms linear attack from zero and schedule 20 ms ahead (`CONFIG.audio.lead`), explosions get a soft 8 ms onset, the heartbeat thump is retuned softer/longer/quieter (0.22 s decay, gain 0.22), and thrust ramps fire on state transitions only.
14. Heartbeat audibility fix — after the click removal the thump went **silent** on real speakers: a pure 65–80 Hz sine has no harmonics and sits below the roll-off of typical laptop/monitor speakers (the earlier "buzz" had in fact been the click artifact — the only audible part of the thump). `playHeartbeat` is now kick-voiced: triangle wave (gentle 195/240 Hz + 325/400 Hz harmonics) with a 2×→1× pitch drop (160→80 / 130→65 Hz) and gain 0.26 — audible everywhere, still soft.
15. Thrust voice redesigned per play-testing: the 60 Hz sawtooth hum (a tonal oscillator whose harmonic stack reads as "buzz") is now a looped one-second white-noise buffer — generated once from the private LCG — through a lowpass biquad (`CONFIG.audio.thrust.cutoff`, 800 Hz), gain-gated with the same transition-only ramps. Also recorded the session's hand-tuned gain levels (heartbeat 1.99 @ intervalMin 0.05, asteroid explosions 1.70/1.55) with a documentation warning against "normalizing" them: bass-limited speakers need large low-frequency amplitudes. Regression test extended: the thrust voice must be noise-based (buffer + bufferSource + biquadFilter, no oscillator).
16. Master-bus limiter added (`CONFIG.audio.limiter`, `DynamicsCompressorNode` between master gain and destination, threshold −3 dB / ratio 20 / knee 0 / 2 ms attack): the hand-tuned mix regularly summed past the digital ±1.0 ceiling (worst-case ≈ 2.1× — heartbeat 1.99 peak + explosion + thrust + laser overlapping), hard-clipping at the output. The limiter transparently holds such peaks, keeping the ear-tuned balance intact and making every gain knob safe to push without clip risk. Harness stub gained a recording `createDynamicsCompressor`; the sound test asserts the limiter node exists and its ratio/threshold are wired from CONFIG.
17. Game-over audio silencing fixed: the UFO siren kept playing after the final ship died. Root cause — `setState` (called from `destroyShip` inside `resolveCollisions`) silenced all voices, but the same frame's PLAYING case continued to the per-frame siren sync, which saw the still-live UFO and resurrected the siren; nothing ever stopped it again on the game-over screen. Fix: the PLAYING case now bails out after its entity filters when the state flipped mid-frame (also preventing a stray heartbeat thump and a stray `nextWave` spawn on the death frame). New regression test: UFO active + final ship killed by a parked asteroid mid-update → the siren must be null and stay null on the game-over screen. Suite now 15 tests.
18. UFO bob retune (2026-10-25): the sine bob was so subtle the flight path read as a straight line (amplitude 22 px ≈ the saucer's own collision radius; peak vertical speed only 25 px/s vs the 145 px/s cruise; ~1.2 wave cycles per crossing). `CONFIG.ufo.bobAmp` raised 22 → 64 and `bobFreq` 1.15 → 1.6 (~1.7 cycles per crossing), and the spawn lane narrowed from `0.16 + rand × 0.68` to `0.20 + rand × 0.55` so the full bobbed path stays on screen while the defused-test parking depth (`height − 24`) keeps its safety margin (worst-case gap 62 px vs the 22.01 px collision reach). Tests: lane-band assertion updated to the new band, config invariants extended with `bobAmp`/`bobFreq`, and the cruise/cull test now asserts per-frame on-screen rim bounds plus a full-amplitude swing across a crossing. Suite still 15 tests.
19. UFO bob raised another +50% (2026-10-25): `CONFIG.ufo.bobAmp` 64 → 96 after play-testing confirmed the first retune was visible but still too subtle. Spawn lane narrowed [0.20h, 0.75h] → [0.25h, 0.70h] to restore the safety margins: the bobbed rim stays within the screen (32 px from the top at the worst lane, 60 px gap to the defused-test parking depth vs the 22.01 px collision reach), and the on-screen guarantee now holds down to ~472 px tall windows (vs ~590 px had the band stayed). Verified non-risks: peak relative displacement ~9.5 px/frame vs a 24.6 px minimum collision reach (no tunneling); the x-only entry/exit cull, aim/fire, siren, and determinism are untouched. `bobFreq` stays 1.6 — peak vertical speed (153.6 px/s) now slightly exceeds the 145 px/s cruise; drop it to ~1.3 if play-testing reads the path as too "elevator"-like. Suite still 15 tests.
20. Two-tier UFO system (2026-10-25): classic large/small saucer pairing. `CONFIG.ufo` gained a `tiers` table — large (radius 26.4 = 22 × 1.2, scale 1.2, score 200, speed 145, fireInterval 2.0, aimSpread 0.12, siren 750 Hz, green) and small (radius 17.6 = 22 × 0.8, scale 0.8, score 500, speed 217.5 = 145 × 1.5, fireInterval 1.5, aimSpread 0.084 = −30% spread, siren 900 Hz, yellow test palette — reverting to green is a one-object edit); bob (96/1.6), lane band, spawn cadence, and the 2-UFO cap stay tier-independent, with the cap shared across tiers. Spawning rolls the tier only when a slot is free, via the new `Engine.smallUfoChance(wave) = min(0.4 + max(0, wave − 1) × 0.1, 0.8)` — 40% at wave 1, 80% from wave 5, wave term floored at 0 for the pre-wave-1 beat. `UFOShip` takes `(engine, tier)` and reads its row as `ufo.cfg`; rendering scales the shared silhouette per tier with counter-scaled strokes; `destroyUFO` and the laser-vs-UFO spark use tier score/colors; HUD saucer icons are tier-sized/colored. Sirens became per-tier independent voices (`sirens.{large, small}`, both may run at once; `startUFOSiren`/`stopUFOSiren` take a tier, default "large"; `setState` silences both). Harness: `AudioContextStub` now records oscillator/gain AudioParam calls with values (pitch assertions). Tests: config invariants rewritten for the tier table, spawn-drift and score assertions made tier-aware, siren-lifecycle/game-over tests cover both slots, determinism snapshot includes the tier, plus new chance-ramp and end-to-end tier-forcing tests (forcing = monkey-patching `e.smallUfoChance`). Suite 15 → 17 tests.
21. Debug UFO-spawn key (2026-10-25): `U` during play zeroes `ufoSpawnTimer` via the new `Engine.debugSpawnUfo()` — the next frame runs the real spawn path (tier roll + shared cap), making two-tier behavior observable without waiting 18–30 s between spawns. Also verified the integrated tier roll end to end with a 10-minute seeded census (wave 1: 13 spawns, 5 small ≈ 38% against the configured 40%; wave 2: 50% chance behaving) — the "no small UFOs" report was spawn-rarity math, not a bug: at 40–50% early-game chance with spawns minutes apart, short sessions can easily see none. Suite 17 → 18 tests.
22. Saucer fire now breaks asteroids (2026-10-25): parity with the original — UFO lasers use the same swept `segPolygonHit` as player lasers, split rocks WITHOUT awarding the player score (kills the baiting-for-points exploit), and the pair runs before the UFO-laser × ship pair so rocks shield the player; a saucer destroying the last rock can trigger the next wave. Plus rock targeting: `chooseFireTarget()` — ship alive: `rockTargetChance` (30%) of shots aim at the closest asteroid (nearest centre, no lead), the rest at the ship; ship dead: always the closest rock; no live rocks: ship if alive, else a random bearing. Movement unchanged (aim only). Fixed in the same pass: `destroyAsteroid`'s split lateral impulses reused the destructive `perp` vector — both children veered to one side and child #2 was magnitude-squared into the speed cap; now `perp.clone().scale(...)` with a separation regression test. Suite 18 → 24 tests.
23. Saucer spawn survival (2026-10-25): fresh saucers were dying to the asteroid × UFO pair before the player ever saw them — they spawn at x = −40 INSIDE the edge-wrap corridor where rocks transit (`offscreen` only marks "already dead", so live pre-entry saucers were fully collidable), then plowed into dense fields seconds later. Fix: `CONFIG.ufo.spawnGrace` (0.5 s) of rock-immunity with refined semantics — the clock HOLDS during the offscreen corridor and starts counting down at field entry; on expiry a clear-to-exit hold pins a 0.05 s floor while any rock still overlaps the hull (auto-scaling protection in denser fields); rocks pass through a graced saucer (ship-parity) while player lasers stay lethal. Rejected alternatives: rock repulsion (non-classical field physics), skip-spawn-if-corridor-occupied (saucers rarest when densest), laser immunity (un-interactive). Suite 24 → 26 tests.
24. Ship-asteroid ramming now breaks the rock (2026-10-25): parity with the original — the collision runs `destroyAsteroid(ast)` (split children + the rock's own score) BEFORE `destroyShip()`, so the points land before the game-over high-score snapshot; an invulnerable ship still phases through leaving the rock intact (regression-tested both ways). Suite 26 → 28 tests.







