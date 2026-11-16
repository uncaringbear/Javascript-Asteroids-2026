"use strict";

/*
 * Regression tests for asteroids_js.html.
 *
 * Covers the behaviour built and fixed in recent sessions:
 *   - UFO spawn timing, placement, and timer reset
 *   - UFO entry/exit culling (the original spawn bug)
 *   - UFO laser speed parity (CONFIG.laser.speed) and aim jitter
 *   - UFO destruction scoring through the real collision paths
 *   - segPolygonHit parallel-edge regression (phantom laser hits)
 *   - HUD layout (SCORE + UFO row) and telemetry cleanup
 *   - classic vector saucer silhouette
 *   - procedural SoundEffects voices (lazy AudioContext, noise explosions,
 *     siren, thrust, heartbeat) that never touch the seeded gameplay RNG
 *   - game-over audio silencing (no mid-frame siren resurrection)
 *   - deterministic simulation under a fixed seed
 *
 * Run the suite with:  node --test test/engine.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGame, makeRecordingCtx, DT } = require("./harness.js");

/* Step until the predicate holds; returns true if it ever did. */
function stepUntil(g, frames, predicate) {
  for (let i = 0; i < frames; i++) {
    g.step(1);
    if (predicate()) return true;
  }
  return false;
}

/* Wait for a UFO to spawn (up to the spawn delay's upper bound + slack). */
function spawnUfo(g) {
  const ok = stepUntil(g, Math.ceil(g.CONFIG.ufo.spawnEvery * 1.5 / DT) + 60,
    () => g.engine.ufos.length > 0);
  assert.ok(ok, "a UFO spawned within the spawn window");
  return g.engine.ufos[0];
}

/*
 * Remove gameplay hazards that make long sims flaky. The first wave spawns
 * ~1.1s after startGame, so wait for it first (defusing an empty array
 * would do nothing); ship invulnerability (2.6s) covers that wait. Then:
 * freeze asteroids, shrink their collision reach to ~0, and park them just
 * above the bottom edge — outside the UFO cruise band (y <= 0.70h + bob).
 * Hiding the ship makes it immune to UFO lasers and asteroid strikes while
 * UFOs still aim at it (fire() only checks that the ship is alive).
 */
function defuseHazards(g) {
  const e = g.engine;
  if (e.asteroids.length === 0) g.step(Math.ceil(1.4 / DT));
  for (const a of e.asteroids) {
    a.velocity.x = 0;
    a.velocity.y = 0;
    a.radius = 0.01;
    a.position.y = e.height - 24;
  }
  e.ship.visible = false;
  e.ship.invulnTimer = 0;
}

/* ---------------- Test 1: config invariants ---------------- */

test("config invariants: shared laser speed, two-tier UFO tuning table", () => {
  const g = loadGame({ seed: 1 });
  assert.equal(g.CONFIG.laser.speed, 360,
    "CONFIG.laser.speed is the single shared muzzle speed");
  assert.equal(g.CONFIG.ufo.spawnEvery, 24);
  assert.equal(g.CONFIG.ufo.maxConcurrent, 2);
  assert.equal(g.CONFIG.ufo.bobAmp, 96);
  assert.equal(g.CONFIG.ufo.bobFreq, 1.6);
  assert.equal(g.CONFIG.ufo.smallChanceBase, 0.4);
  assert.equal(g.CONFIG.ufo.smallChanceWaveStep, 0.1);
  assert.equal(g.CONFIG.ufo.smallChanceMax, 0.8);

  const large = g.CONFIG.ufo.tiers.large;
  assert.equal(large.radius, 26.4, "large = classic model grown 20%");
  assert.equal(large.scale, 1.2);
  assert.equal(large.score, 200);
  assert.equal(large.speed, 145);
  assert.equal(large.fireInterval, 2.0);
  assert.equal(large.aimSpread, 0.12);
  assert.equal(large.sirenBase, 750);

  const small = g.CONFIG.ufo.tiers.small;
  assert.equal(small.radius, 17.6, "small = classic model shrunk 20%");
  assert.equal(small.scale, 0.8);
  assert.equal(small.score, 500);
  assert.equal(small.speed, 217.5, "small cruises +50% faster");
  assert.equal(small.fireInterval, 1.5, "small fires more often");
  assert.equal(small.aimSpread, 0.084, "+30% accuracy (spread -30%)");
  assert.equal(small.sirenBase, 900, "small warbles higher");
});

/* ---------------- Test 2: boot & state machine ---------------- */

test("boots into MENU, startGame flips to PLAYING with fresh state", () => {
  const g = loadGame({ seed: 2 });
  const e = g.engine;

  assert.equal(e.state, g.STATE.MENU, "starts on the menu");
  assert.equal(e.width, 960, "engine sized from the stubbed window");
  assert.equal(e.height, 600);
  assert.ok(e.stars.length > 0, "star field generated");

  e.startGame();
  assert.equal(e.state, g.STATE.PLAYING);
  assert.equal(e.lives, g.CONFIG.startLives);
  assert.ok(e.ship, "player ship deployed");
  assert.ok(e.ufoSpawnTimer > 0, "UFO timer armed");

  /* Wave 1 spawns after the inter-wave beat (~1.1s), not instantly. */
  g.step(Math.ceil(1.3 / DT));
  assert.ok(e.asteroids.length > 0, "wave 1 asteroids spawned after the beat");

  /* Real collision path: teleport an asteroid onto the ship. */
  const ast = e.asteroids[0];
  e.ship.invulnTimer = 0;            // ships spawn with post-respawn immunity
  e.ship.position.x = ast.position.x;
  e.ship.position.y = ast.position.y;
  const lives0 = e.lives;
  g.step(1);
  assert.equal(e.ship.dead, true, "asteroid strike destroys the ship");
  assert.equal(e.lives, lives0 - 1, "a life is lost");
  assert.ok(e.ship.respawnTimer > 0, "respawn timer armed");
});

/* ---------------- Test 3: UFO spawn delay + placement ---------------- */

test("UFO spawns after its randomized delay, offscreen, and resets the timer", () => {
  const g = loadGame({ seed: 20261024 });
  const { CONFIG, engine: e } = g;
  e.startGame();

  const t0 = e.ufoSpawnTimer;
  assert.ok(t0 > CONFIG.ufo.spawnEvery * 0.5 - 1e-9 &&
            t0 <= CONFIG.ufo.spawnEvery * 1.5 + 1e-9,
    "delay within the [12, 24]s band, got " + t0.toFixed(3));

  defuseHazards(g);   // includes the ~1.4s wait for wave 1 to spawn

  /* Remaining delay after the defuse wait; step up to (not into) the
     spawn frame. */
  const remaining = e.ufoSpawnTimer;
  assert.ok(remaining > 0, "timer still armed after the defuse wait");
  g.step(Math.floor(remaining / DT));
  assert.equal(e.ufos.length, 0, "no UFO before the delay elapses");

  g.step(1);
  assert.equal(e.ufos.length, 1, "exactly one UFO spawned on schedule");
  const ufo = e.ufos[0];
  assert.ok(ufo.tier === "small" || ufo.tier === "large",
    "spawned UFO carries a tier tag, got " + ufo.tier);
  assert.equal(ufo.cfg, g.CONFIG.ufo.tiers[ufo.tier],
    "tier config bound to its tuning row");

  /* The UFO updates once inside its spawn frame, so it has drifted at most
     one frame of cruise distance from its exact spawn point. */
  const fromLeft = ufo.velocity.x > 0;
  const drift = fromLeft
    ? ufo.position.x + 40
    : (e.width + 40) - ufo.position.x;
  assert.ok(drift >= -1e-9 &&
            drift <= CONFIG.ufo.tiers[ufo.tier].speed * DT + 1e-9,
    "spawned 40px offscreen (+<=1 tier-speed frame drift), x=" +
    ufo.position.x);

  /* Vertical lane: baseY = h * (0.25 + rand * 0.45) in [0.25h, 0.70h];
     the drawn y bobs ±bobAmp around that lane. */
  assert.ok(ufo.baseY >= e.height * 0.25 - 1e-9 &&
            ufo.baseY <= e.height * 0.70 + 1e-9,
    "spawn lane within the vertical band, baseY=" + ufo.baseY);
  assert.ok(Math.abs(ufo.position.y - ufo.baseY) <= CONFIG.ufo.bobAmp + 1e-9,
    "current y bobs around the lane");

  const t1 = e.ufoSpawnTimer;
  assert.ok(t1 > CONFIG.ufo.spawnEvery * 0.75 - 1e-9 &&
            t1 <= CONFIG.ufo.spawnEvery * 1.25 + 1e-9,
    "next delay within the [18, 30]s band, got " + t1.toFixed(3));
});

/* ---------------- Test 4: UFO cruise, entry, exit cull ---------------- */

test("UFO cruises into view, then is culled after fully exiting", () => {
  const g = loadGame({ seed: 20261024 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;   // cruising/culling test - keep the saucer's guns
                         // quiet: rock-fire would split the parked rocks
                         // and drifting children could kill the saucer

  /* Cruise in and out, asserting per frame that the bob never carries the
     saucer's rim offscreen vertically, and tracking the true swing of the
     sine wave across the crossing. */
  let minY = Infinity;
  let maxY = -Infinity;
  const onScreen = () => {
    minY = Math.min(minY, ufo.position.y);
    maxY = Math.max(maxY, ufo.position.y);
    return ufo.position.y - ufo.radius >= 0 &&
           ufo.position.y + ufo.radius <= e.height;
  };
  let entered = false;
  for (let i = 0; i < 60 * 10 && !entered; i++) {
    g.step(1);
    assert.ok(onScreen(), "bobbed path stays on-screen during entry, y=" +
      ufo.position.y.toFixed(1));
    if (ufo.hasEntered) entered = true;
  }
  assert.ok(entered, "UFO entered the field within 10s of cruising");
  assert.ok(e.ufos.includes(ufo), "still active after entering");

  /* Cruise out the far side: ~7.1s at 145 px/s; allow 30s. With hazards
     defused the only death path is the exit cull. */
  let culled = false;
  for (let i = 0; i < 60 * 30; i++) {
    g.step(1);
    assert.ok(onScreen(), "bobbed path stays on-screen, y=" +
      ufo.position.y.toFixed(1));
    if (!ufo.alive) {
      culled = true;
      assert.equal(ufo.offscreen, true, "exit cull marks offscreen");
      const pastLeft = ufo.position.x + ufo.radius < 0;
      const pastRight = ufo.position.x - ufo.radius > e.width;
      assert.ok(pastLeft || pastRight,
        "culled only once fully past the boundary, x=" + ufo.position.x);
      break;
    }
  }
  assert.ok(culled, "UFO exited and was culled within 30s");
  assert.ok(!e.ufos.includes(ufo), "culled UFO removed from the active list");

  /* A full crossing (~7s) spans ~11 rad of phase at bobFreq 1.6 — far
     more than the π rad between |sin| peaks — so the wave must have swept
     its full amplitude. This locks in the retune: the path is a real
     wave, not a straight line. */
  const swing = Math.max(maxY - ufo.baseY, ufo.baseY - minY);
  assert.ok(swing >= g.CONFIG.ufo.bobAmp - 0.05,
    "bob swept its full amplitude across a crossing, swing=" +
    swing.toFixed(2));
});

/* ---------------- Test 5: UFO laser speed + jitter ---------------- */

test("UFO lasers use the shared muzzle speed and vary in aim (jitter)", () => {
  const g = loadGame({ seed: 31 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  /* UFOs fire every 2s starting 1s after spawn; count distinct lasers
     seen across frames (lasers expire after 2.2s, so track births). */
  const seen = new Set();
  let ok = false;
  for (let i = 0; i < 60 * 45 && !ok; i++) {
    g.step(1);
    for (const l of e.ufoLasers) seen.add(l);
    ok = seen.size >= 3;
  }
  assert.ok(ok, "at least 3 UFO lasers fired (got " + seen.size + ")");

  const angles = new Set();
  for (const laser of seen) {
    const speed = laser.velocity.magnitude();
    assert.ok(Math.abs(speed - CONFIG.laser.speed) < 1e-6,
      "laser muzzle speed equals CONFIG.laser.speed, got " + speed);
    angles.add(laser.velocity.angle().toFixed(9));
  }
  /* With aim jitter, repeated shots cannot all share one bearing. */
  assert.ok(angles.size > 1,
    "shots vary in direction (jitter present), unique angles: " + angles.size);
});

/* ---------------- Test 6: UFO destruction scoring ---------------- */

test("asteroid strike destroys the UFO and awards the bonus score", () => {
  const g = loadGame({ seed: 20261024 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  /* Cruise into the field first: the teleported asteroid must not wrap
     (in-field positions are safe; the spawn point is offscreen). */
  assert.ok(stepUntil(g, 60 * 5, () => ufo.hasEntered),
    "UFO cruised into the field");
  ufo.spawnGrace = 0;   // the strike must land: grace off for this test
  assert.ok(e.asteroids.length > 0, "an asteroid is available for the test");

  /* Real collision path: asteroids × UFOs. Asteroid[0] is frozen by
     defuseHazards, so it stays exactly where it is teleported. */
  const ast = e.asteroids[0];
  ast.position.x = ufo.position.x;
  ast.position.y = ufo.position.y;
  const score0 = e.score;
  g.step(1);

  assert.ok(!e.ufos.includes(ufo), "UFO removed after the collision");
  assert.equal(ufo.alive, false, "UFO marked dead");
  assert.equal(ufo.offscreen, true, "destroyUFO flags offscreen");
  const tierCfg = CONFIG.ufo.tiers[ufo.tier];
  assert.equal(e.score, score0 + tierCfg.score +
               CONFIG.asteroid[ast.size].score,
    "score gained the tier's UFO bonus plus the asteroid's own value");
  assert.ok(!e.asteroids.includes(ast), "striking asteroid destroyed too");
});

test("player laser hit destroys the UFO and awards the bonus score", () => {
  const g = loadGame({ seed: 20261024 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);

  /* Laser fixture: the lasers-vs-UFO branch uses only position/radius/
     alive, so a minimal stub exercises the real branch (a full Laser
     cannot be constructed from outside the IIFE). prevPos is offset so
     the swept segment is a real (non-degenerate) segment. */
  const prev = ufo.position.clone();
  prev.x -= 0.5;
  prev.y -= 0.37;
  const fixture = {
    position: ufo.position.clone(),
    prevPos: prev,
    radius: CONFIG.laser.radius,
    alive: true,
    update() {},
    render() {},
  };
  e.lasers.push(fixture);
  const score0 = e.score;
  g.step(1);

  assert.equal(fixture.alive, false, "laser consumed by the hit");
  assert.equal(e.score, score0 + CONFIG.ufo.tiers[ufo.tier].score,
    "bonus score awarded");
  assert.ok(!e.ufos.includes(ufo), "UFO removed from the field");
});

/* ---------------- Test 7: segPolygonHit regression ---------------- */

test("stationary segments never phantom-hit; real swept hits still register", () => {
  const g = loadGame({ seed: 5 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);

  /* Spread the frozen asteroids across the bottom so a swept segment
     crosses exactly one of them. */
  e.asteroids.forEach((a, i) => {
    a.position.x = 80 + i * 220;
    a.position.y = e.height - 24;
  });

  /* (1) A stationary (zero-length) segment parked in a far corner. Before
     the segPolygonHit fix, a degenerate segment made denom === 0 on every
     edge, and the resulting boolean-false t/u coerced to 0 — "inside" the
     0..1 range — so ANY polygon registered a phantom hit at any distance. */
  const idlePos = ufo.position.clone();
  idlePos.x = 20;
  idlePos.y = 20;
  const idle = {
    position: idlePos,
    prevPos: idlePos.clone(),   // zero-length segment
    radius: CONFIG.laser.radius,
    alive: true,
    update() {},
    render() {},
  };

  /* (2) A real swept segment straight through asteroid[0]: the legitimate
     lasers-vs-asteroids path must still register and destroy it. */
  const target = e.asteroids[0];
  const sweepPos = target.position.clone();
  const sweep = {
    position: sweepPos,
    prevPos: { x: sweepPos.x - 80, y: sweepPos.y },
    radius: CONFIG.laser.radius,
    alive: true,
    update() {},
    render() {},
  };
  e.lasers.push(idle, sweep);

  const score0 = e.score;
  g.step(1);

  assert.equal(idle.alive, true,
    "stationary segment registers no phantom hit");
  assert.equal(sweep.alive, false, "real crossing sweep consumed");
  assert.equal(e.score, score0 + CONFIG.asteroid[target.size].score,
    "exactly the struck asteroid's score awarded");
  assert.ok(!e.asteroids.includes(target), "struck asteroid destroyed");
  for (const a of e.asteroids) {
    assert.notEqual(a, target, "other parked asteroids untouched");
  }
  assert.ok(e.ufos.includes(ufo), "UFO untouched");
});

/* ---------------- Test 8: HUD layout + telemetry cleanup ---------------- */

test("HUD: UFO row sits beneath SCORE and all debug telemetry is gone", () => {
  const g = loadGame({ seed: 20261024 });
  const e = g.engine;
  e.startGame();
  g.step(2);

  const texts = g.hudTexts();
  const joined = texts.map((t) => t.text).join("  ||  ");

  const score = texts.find((t) => t.text.startsWith("SCORE"));
  const ufoRow = texts.find((t) => t.text.startsWith("UFO"));
  assert.ok(score, "SCORE row present");
  assert.ok(ufoRow, "UFO row present");
  assert.deepEqual([score.x, score.y], [22, 18], "SCORE unchanged at (22,18)");
  assert.deepEqual([ufoRow.x, ufoRow.y], [22, 40],
    "UFO row directly beneath SCORE at (22,40)");
  assert.match(ufoRow.text, /^UFO  ACTIVE \d+  NEXT \d+\.\ds$/,
    "UFO row format unchanged: " + ufoRow.text);

  /* Debug telemetry disabled in earlier sessions must stay gone. */
  const forbidden = ["DEAD", "  VIS ", "STHR", "  RT ", "  INV ",
                     "  LIVES ", "  DT ", "  TIME ", "  X ", "  Y ",
                     "SPD ", "THRUST ", "CAP ", "KEY "];
  for (const label of forbidden) {
    assert.ok(!joined.includes(label),
      'telemetry "' + label.trim() + '" must not appear in the HUD');
  }

  assert.ok(texts.some((t) => t.text.startsWith("HI")), "HI score kept");
  assert.ok(texts.some((t) => t.text.includes("WAVE")), "WAVE kept");
});

/* ---------------- Test 9: saucer silhouette ---------------- */

test("the saucer renders as a pure vector silhouette (no ellipses)", () => {
  const g = loadGame({ seed: 20261024 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);
  const ufo = spawnUfo(g);

  const rec = makeRecordingCtx();
  ufo.render(rec);

  const ops = rec._calls.map((c) => c.op);
  assert.ok(!ops.includes("ellipse"), "no ellipse() calls — straight lines only");
  assert.equal(ops.filter((o) => o === "stroke").length, 2,
    "two strokes: wide glow under-stroke + crisp top stroke");

  /* Hull geometry from the recorded path points (local space). */
  const pts = [];
  for (const c of rec._calls) {
    if (c.op === "moveTo" || c.op === "lineTo") pts.push([c.args[0], c.args[1]]);
  }
  assert.ok(pts.length >= 12, "saucer outline has its full vertex set");
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.equal(Math.min(...xs), -20, "hull spans 40px: left tip at -20");
  assert.equal(Math.max(...xs), 20, "hull spans 40px: right tip at +20");
  assert.equal(Math.min(...ys), -11, "dome apex at -11");
  assert.equal(Math.max(...ys), 6, "hull base at +6");
});

/* ---------------- Test 10: deterministic simulation ---------------- */

test("same seed produces an identical gameplay timeline", () => {
  const a = loadGame({ seed: 424242 });
  const b = loadGame({ seed: 424242 });
  a.engine.startGame();
  b.engine.startGame();

  /* Snapshot a sim: primitives + host-realm arrays (spread the vm-realm
     ufos array so deepStrictEqual does not compare cross-realm prototypes). */
  const snap = (g) => {
    const ufos = [...g.engine.ufos].map((u) => [
      u.tier, u.position.x.toFixed(3), u.position.y.toFixed(3),
      u.hasEntered]);
    return [g.engine.ufos.length, g.engine.ufoSpawnTimer.toFixed(6),
            g.engine.score, ufos];
  };

  for (let f = 0; f < 60 * 40; f++) {   // 40 simulated seconds, both sims
    a.step(1);
    b.step(1);
    if (f % 300 === 0) {                // sample every 5 simulated seconds
      assert.deepEqual(snap(a), snap(b), "sims diverged at frame " + f);
    }
  }
});

/* ---------------- Test 11: particle velocity preservation ---------------- */

test("ParticleSystem keeps velocity magnitude across updates (KI-2 fix)", () => {
  const g = loadGame({ seed: 77 });
  const e = g.engine;
  e.startGame();

  /* One particle drifting at a known speed, built from a real vm-realm
     Vector2D (cloned from the ship's velocity, since ParticleSystem.update
     calls velocity.scale(drag) and needs real vector methods). */
  e.particles.particles.length = 0;
  const v = e.ship.velocity.clone();
  v.x = 60;
  v.y = 0;
  e.particles.particles.push({
    position: e.ship.position.clone(),
    velocity: v,
    life: 1,
    maxLife: 1,
    r: 255, g: 255, b: 255,
  });
  const startX = e.particles.particles[0].position.x;

  /* Frame 1: drift exactly velocity * dt from the start position; velocity
     shrinks by drag ONLY (the old bug collapsed 60 px/s to 1 px/s by
     scaling velocity by dt). */
  g.step(1);
  let p = e.particles.particles[0];
  assert.ok(Math.abs(p.position.x - startX - 60 * DT) < 1e-9,
    "drift advances by velocity * dt, got dx=" + (p.position.x - startX));
  assert.ok(Math.abs(p.velocity.x - 60 * Math.exp(-1.7 * DT)) < 1e-9,
    "velocity retains its magnitude (drag only), got " + p.velocity.x);

  /* Frame 2: drift continues at the drag-reduced speed (~58 px/s). */
  g.step(1);
  p = e.particles.particles[0];
  assert.ok(p.position.x - startX > 1.5,
    "drift continues across frames (no velocity collapse), dx=" +
    (p.position.x - startX));
});

/* ---------------- Test 12: respawn burst argument order ---------------- */

test("Ship.respawn emits its 16-particle burst (KI-1 fix)", () => {
  const g = loadGame({ seed: 78 });
  const e = g.engine;
  e.startGame();

  e.particles.particles.length = 0;
  e.ship.respawn();

  /* The old call passed count and colour swapped: burst(pos, 16, [rgb], ...)
     made the loop condition `i < [160,230,255]` (NaN) and emitted nothing. */
  assert.equal(e.particles.particles.length, 16,
    "respawn burst emits exactly its 16 particles");
  for (const p of e.particles.particles) {
    assert.ok(p.r >= 0 && p.r <= 255 && p.g >= 0 && p.g <= 255 &&
              p.b >= 0 && p.b <= 255, "particle colours within range");
    assert.ok(p.maxLife > 0 && p.life <= p.maxLife, "lifespans sane");
  }
});

/* ---------------- Test 12b: small-saucer chance ramp ---------------- */

test("small-saucer spawn chance ramps 40% → 80% and floors the wave term", () => {
  const g = loadGame({ seed: 3 });
  const e = g.engine;
  e.startGame();

  const expect = [[0, 0.4], [1, 0.4], [2, 0.5], [3, 0.6],
                  [4, 0.7], [5, 0.8], [9, 0.8]];
  for (const [wave, expected] of expect) {
    assert.ok(Math.abs(e.smallUfoChance(wave) - expected) < 1e-9,
      "wave " + wave + " chance = " + expected +
      ", got " + e.smallUfoChance(wave));
  }
});

/* ---------------- Test 12c: tier forcing — per-tier tuning rows ---------------- */

test("small and large saucers use their own tuning row end to end", () => {
  const g = loadGame({ seed: 5 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  for (const forced of ["small", "large"]) {
    const before = e.ufos.length;
    const orig = e.smallUfoChance;
    e.smallUfoChance = () => (forced === "small" ? 1 : 0);
    e.ufoSpawnTimer = 0.001;
    g.step(1);
    e.smallUfoChance = orig;

    assert.equal(e.ufos.length, before + 1, forced + " saucer spawned");
    const ufo = e.ufos[e.ufos.length - 1];
    assert.equal(ufo.tier, forced, "rolled tier is " + forced);
    const cfg = CONFIG.ufo.tiers[forced];
    assert.equal(ufo.cfg, cfg, "tier config bound to its row");
    assert.equal(ufo.radius, cfg.radius,
      forced + " collision radius from its tier row");
    assert.equal(Math.abs(ufo.velocity.x), cfg.speed,
      forced + " cruise speed from its tier row");
    assert.ok(Math.abs(ufo.fireTimer - (cfg.fireInterval * 0.5 - DT)) < 1e-9,
      forced + " first-shot delay from its row (one frame elapsed)");

    /* Per-tier siren pitch: the stub records setValueAtTime values. */
    const scheduled = e.sfx.ctx._calls
      .filter((c) => c.op === "setValueAtTime").map((c) => c.args[0]);
    assert.ok(scheduled.includes(cfg.sirenBase),
      forced + " siren carrier at " + cfg.sirenBase + " Hz");

    /* Per-tier visuals: tier stroke color, shared silhouette geometry. */
    const rec = makeRecordingCtx();
    ufo.render(rec);
    assert.equal(rec.strokeStyle, cfg.stroke,
      forced + " stroke color from its tier row");
    const ops = rec._calls.map((c) => c.op);
    assert.ok(!ops.includes("ellipse"), forced + " stays pure vector");
    assert.equal(ops.filter((o) => o === "stroke").length, 2,
      forced + " keeps the two-stroke glow rendering");

    /* Clean the sky so the next iteration's spawn is unobstructed. */
    for (const u of e.ufos) { u.alive = false; u.offscreen = true; }
    g.step(1);
    assert.equal(e.ufos.length, 0, "sky cleared between tiers");
  }
});

/* ---------------- Test 13: procedural sound system ---------------- */

test("SoundEffects synthesizes every voice and never touches the game RNG", () => {
  const g = loadGame({ seed: 9001 });
  const e = g.engine;

  /* The synth exists with its full API but stays inert until a sound is
     requested — the AudioContext is created lazily (autoplay policy). */
  assert.ok(e.sfx, "engine owns a SoundEffects instance");
  for (const m of ["unlock", "playSpawn", "playLaser", "startThrust",
                   "stopThrust", "startUFOSiren", "stopUFOSiren",
                   "playExplosion", "playHeartbeat"]) {
    assert.equal(typeof e.sfx[m], "function", "sfx." + m + " exists");
  }
  assert.equal(e.sfx.ctx, null, "AudioContext is created lazily");

  /* Firing the player laser synthesizes a sweep voice (osc + gain). */
  e.startGame();
  e.input.fire = true;
  g.step(1);
  e.input.fire = false;
  assert.ok(e.sfx.ctx, "first sound created the AudioContext");
  assert.ok(e.sfx.ctx._calls.length >= 2,
    "laser fire created oscillator + gain nodes");

  /* The master bus carries the limiter ceiling guard, wired and tuned
     from CONFIG — it protects the hand-tuned gains from digital clipping
     when overlapping voices sum past the ±1.0 output ceiling. */
  assert.ok(e.sfx.ctx._calls.includes("dynamicsCompressor"),
    "master-bus limiter node created");
  assert.equal(e.sfx.limiter.ratio.value, g.CONFIG.audio.limiter.ratio,
    "limiter ratio wired from CONFIG");
  assert.equal(e.sfx.limiter.threshold.value, g.CONFIG.audio.limiter.threshold,
    "limiter threshold wired from CONFIG");

  /* Thrust polls into a persistent gain-gated voice, and survives the
     key release (faded out, never torn down). The voice is the looped
     filtered-noise recipe: buffer + looping source + lowpass — and
     crucially no tonal oscillator, so nothing to buzz. */
  const beforeThrust = e.sfx.ctx._calls.length;
  e.input.thrust = true;
  g.step(1);
  e.input.thrust = false;
  g.step(1);
  assert.ok(e.sfx.thrust, "persistent thrust voice exists after release");
  const thrustNodes = e.sfx.ctx._calls.slice(beforeThrust);
  assert.ok(thrustNodes.includes("buffer") &&
            thrustNodes.includes("bufferSource") &&
            thrustNodes.includes("biquadFilter") &&
            !thrustNodes.includes("oscillator"),
    "thrust is a looped filtered-noise voice (no tonal oscillator)");

  /* Ship death through the real destroy path generates filtered noise:
     buffer + bufferSource + biquadFilter (+ envelope gain). */
  const beforeShip = e.sfx.ctx._calls.length;
  e.ship.invulnTimer = 0;
  e.destroyShip();
  const shipNodes = e.sfx.ctx._calls.slice(beforeShip);
  assert.ok(shipNodes.includes("buffer") &&
            shipNodes.includes("bufferSource") &&
            shipNodes.includes("biquadFilter"),
    "player explosion generated noise through a lowpass filter");

  /* Asteroid destruction picks an explosion voice by size. */
  g.step(Math.ceil(1.3 / DT));          // wave 1 spawns
  assert.ok(e.asteroids.length > 0, "wave 1 on the field");
  const beforeAst = e.sfx.ctx._calls.length;
  e.destroyAsteroid(e.asteroids[0]);
  const astNodes = e.sfx.ctx._calls.slice(beforeAst);
  assert.ok(astNodes.includes("buffer") && astNodes.includes("biquadFilter"),
    "asteroid explosion synthesized filtered noise");

  /* Heartbeat: armed with a density-derived interval inside the
     0.25–1.2 s band, alternating tones, silent on an empty field. */
  const cfg = g.CONFIG.audio.heartbeat;
  assert.ok(e.heartbeatToggle === true,
    "heartbeat thumped when the wave spawned");
  assert.ok(e.heartbeatTimer > 0 &&
            e.heartbeatTimer <= cfg.intervalMax,
    "heartbeat timer re-armed inside the cadence band");
  e.asteroids.splice(0, 1);             // drop the just-destroyed entry
  while (e.asteroids.length > 1) e.asteroids.pop();
  assert.ok(e.asteroids.length === 1 && e.asteroids[0].alive,
    "one live rock left on the field");
  e.heartbeatTimer = 0.0001;
  g.step(1);
  const thin = cfg.intervalMin +
    (cfg.intervalMax - cfg.intervalMin) * (1 / Math.max(1, e.heartbeatMax));
  assert.ok(Math.abs(e.heartbeatTimer - thin) < 1e-9,
    "thinned field accelerates the cadence per the linear formula");
  assert.equal(e.heartbeatToggle, false, "tones alternate each thump");

  /* Sirens: each tier's voice starts when its saucer spawns and stops
     when the sky clears of that tier; the carrier is tuned per tier. */
  e.ufoSpawnTimer = 0.001;
  g.step(1);
  const tier = e.ufos[0].tier;
  const otherTier = tier === "small" ? "large" : "small";
  assert.ok(e.sfx.sirens[tier], "UFO spawn started its tier's siren voice");
  assert.equal(e.sfx.sirens[otherTier], null,
    "the other tier's siren stays silent");
  const scheduled = e.sfx.ctx._calls
    .filter((c) => c.op === "setValueAtTime").map((c) => c.args[0]);
  assert.ok(scheduled.includes(g.CONFIG.ufo.tiers[tier].sirenBase),
    "siren carrier tuned to the tier's base pitch (" +
    g.CONFIG.ufo.tiers[tier].sirenBase + " Hz)");
  e.ufos[0].alive = false;
  g.step(1);
  assert.equal(e.sfx.sirens[tier], null,
    "siren stopped once no UFO of that tier remains");
});

/* ---------------- Test 14: game-over audio silencing ---------------- */

test("no voice is resurrected after the game-over transition", () => {
  const g = loadGame({ seed: 4242 });
  const e = g.engine;
  e.startGame();
  g.step(Math.ceil(1.3 / DT));              // wave 1 on the field

  /* Park the asteroids low (below the UFO cruise band) and freeze them,
     so the saucer survives to keep its siren running. */
  for (const a of e.asteroids) {
    a.velocity.x = 0;
    a.velocity.y = 0;
    a.radius = 0.01;
    a.position.y = e.height - 24;
  }
  e.ufoSpawnTimer = 0.001;
  g.step(1);                                // UFO spawns offscreen → siren on
  const sirenTier = e.ufos[0].tier;
  assert.ok(e.sfx.sirens[sirenTier],
    "siren active while the UFO is on screen");

  /* Final life: park one (defused-radius) asteroid exactly on the ship so
     the very next collision kills the last ship INSIDE update — the state
     flip happens mid-frame, exactly where the old bug resurrected the
     siren after setState had silenced it. */
  e.lives = 1;
  e.ship.invulnTimer = 0;
  const ast = e.asteroids[0];
  ast.position.x = e.ship.position.x;
  ast.position.y = e.ship.position.y;
  g.step(1);
  assert.equal(e.state, g.STATE.GAME_OVER,
    "final ship death reached GAME_OVER");
  assert.equal(e.sfx.sirens[sirenTier], null,
    "siren silenced by the game-over transition, not resurrected");
  assert.equal(e.sfx.sirens.large, null, "large siren slot clear");
  assert.equal(e.sfx.sirens.small, null, "small siren slot clear");
  g.step(60);                               // a full second on the game-over screen
  assert.equal(e.sfx.sirens.large, null,
    "large siren stays silent on the game-over screen");
  assert.equal(e.sfx.sirens.small, null,
    "small siren stays silent on the game-over screen");
});

/* ---------------- Test 18: debug UFO spawn key hook ---------------- */

test("debugSpawnUfo zeroes the timer; the next frame runs the real spawn path", () => {
  const g = loadGame({ seed: 11 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);

  e.debugSpawnUfo();
  assert.equal(e.ufoSpawnTimer, 0, "debug hook zeroes the spawn timer");
  g.step(1);
  assert.equal(e.ufos.length, 1, "a UFO spawned on the next frame");
  assert.ok(e.ufos[0].tier === "small" || e.ufos[0].tier === "large",
    "the spawn ran the real tier roll");
  assert.ok(e.ufoSpawnTimer > 0, "timer re-armed by the real spawn path");

  /* The shared concurrency cap is respected: two live saucers -> no third. */
  e.debugSpawnUfo();
  g.step(1);
  assert.equal(e.ufos.length, 2, "second attempt fills the cap");
  e.debugSpawnUfo();
  g.step(1);
  assert.equal(e.ufos.length, 2,
    "no third saucer while two are active");

  /* Clearing the sky re-enables the hook. */
  for (const u of e.ufos) { u.alive = false; u.offscreen = true; }
  g.step(1);
  e.debugSpawnUfo();
  g.step(1);
  assert.equal(e.ufos.length, 1, "hook works again after the sky clears");
});

/* ---------------- Test 19: saucer fire breaks rocks, scores nothing ---------------- */

test("UFO laser destroys an asteroid: splits, no score, laser consumed", () => {
  const g = loadGame({ seed: 21 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;              // only the fixture shot below
  ufo.velocity.x = 0;               // pin the saucer at its lane
  ufo.baseY = 300;
  ufo.phase = 0;
  ufo.position.x = 480;
  ufo.position.y = 300;

  /* A moving size-3 rock ahead of the saucer (moving so the split's
     perpendicular axis is well-defined). */
  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 60;
  ast.position.x = 580;
  ast.position.y = 300;

  /* Real-geometry fixture: a swept segment crossing the rock, exactly
     like the UFO-laser x asteroid pair sees it. */
  const shot = {
    position: { x: 560, y: 300 },
    prevPos: { x: 500, y: 300 },
    radius: CONFIG.ufoLaser.radius,
    alive: true,
    update() {},
    render() {},
  };
  e.ufoLasers.push(shot);
  const score0 = e.score;
  g.step(1);

  /* Consumed lasers are filtered out of ufoLasers the same frame, so
     assert on the held fixture reference, not the array slot. */
  assert.ok(!shot.alive, "saucer shot consumed by the rock");
  assert.ok(!e.asteroids.includes(ast), "rock destroyed by saucer fire");
  assert.ok(e.asteroids.some((a) => a.size === 2),
    "size-3 rock split into size-2 children");
  assert.equal(e.score, score0,
    "saucer fire awards the player nothing (original parity)");
});

/* ---------------- Test 20: split separation (perp destructive-scale fix) -------- */

test("split children separate with true opposite lateral impulses", () => {
  const g = loadGame({ seed: 23 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ast = e.asteroids[0];       // wave 1: size 3
  ast.velocity.x = 0;
  ast.velocity.y = 80;              // perp = normalize(-80, 0) = (-1, 0)
  ast.position.x = e.width / 2;
  ast.position.y = e.height / 2;

  e.destroyAsteroid(ast);
  const kids = e.asteroids.slice(-2);
  assert.equal(kids.length, 2, "size-3 rock split into two mediums");
  assert.ok(kids.every((k) => k.size === 2), "children are size 2");

  /* Signed projection of each child's velocity on the perpendicular
     axis (-1, 0): the lateral components must be opposite-signed and
     neither child pinned at the speed cap (the old bug zeroed one side
     and squared the other into maxV). */
  const lat = kids.map((k) => -k.velocity.x);
  assert.ok(Math.abs(lat[0]) > 1 && Math.abs(lat[1]) > 1,
    "both children carry a lateral impulse");
  assert.ok(Math.sign(lat[0]) === -Math.sign(lat[1]),
    "lateral impulses opposite-signed, got " + lat[0] + " / " + lat[1]);
  const cap = CONFIG.asteroid[2].speedMax * 1.7;
  for (const k of kids) {
    assert.ok(k.velocity.magnitude() <= cap + 1e-9,
      "child respects the velocity cap");
    assert.ok(k.velocity.magnitude() < cap - 1,
      "second child is NOT pinned at the cap (old bug)");
  }
});

/* ---------------- Test 21: rocks shield the ship from saucer fire --------------- */

test("a rock between the saucer and the ship consumes the shot", () => {
  const g = loadGame({ seed: 27 });
  const engine_e = g.engine;
  const e = engine_e;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;
  ufo.velocity.x = 0;
  ufo.baseY = 300;
  ufo.phase = 0;
  ufo.position.x = 480;
  ufo.position.y = 300;

  e.ship.visible = true;
  e.ship.dead = false;
  e.ship.invulnTimer = 0;
  e.ship.position.x = 480;
  e.ship.position.y = 540;
  e.ship.velocity.x = 0;
  e.ship.velocity.y = 0;
  const lives0 = e.lives;

  /* The rock sits on the saucer-ship line, closer to the saucer. */
  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 0;
  ast.position.x = 480;
  ast.position.y = 430;

  /* Force a real ship-aimed shot down the line. */
  const orig = ufo.chooseFireTarget;
  ufo.chooseFireTarget = () => "ship";
  ufo.fireTimer = 0;               // <= 0 at frame start -> fires now
  g.step(1);
  ufo.chooseFireTarget = orig;
  assert.equal(e.ufoLasers.length, 1, "one shot in flight");
  const laser0 = e.ufoLasers[0];

  assert.ok(stepUntil(g, 90, () => !laser0.alive),
    "the rock consumed the shot within 1.5s");
  assert.ok(!e.asteroids.includes(ast), "shielding rock destroyed");
  assert.ok(e.ship.visible && !e.ship.dead,
    "the ship behind the rock was never hit");
  assert.equal(e.lives, lives0, "no life lost by the shielded shot");
});

/* ---------------- Test 22: dead player -> always target a rock ---------------- */

test("a dead player means the saucer always aims at the closest rock", () => {
  const g = loadGame({ seed: 29 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;
  ufo.velocity.x = 0;               // pin the saucer at (480, ~300)
  ufo.baseY = 300;
  ufo.phase = 0;
  ufo.position.x = 480;
  ufo.position.y = 300;

  /* Ship dead for the whole test (respawn never triggers). */
  e.ship.dead = true;
  e.ship.respawnTimer = 1e9;

  /* Three frozen rocks at spread-out spots; (480, 380) is closest. */
  const spots = [[300, 150], [650, 200], [480, 430]];
  const rocks = spots.map(([x, y], i) => {
    const a = e.asteroids[i];
    a.velocity.x = 0;
    a.velocity.y = 0;
    a.radius = 12;
    a.position.x = x;
    a.position.y = y;
    return a;
  });

  ufo.fireTimer = 0;                // <= 0 at frame start -> fires now
  g.step(1);
  assert.equal(e.ufoLasers.length, 1, "one shot fired");
  const shot = e.ufoLasers[0];

  /* The closest rock at fire time (post-step saucer position is the
     position fire() used; rocks are frozen). */
  const dists = rocks.map((r) => ufo.position.distanceTo(r.position));
  const closest = rocks[dists.indexOf(Math.min(...dists))];
  const sorted = dists.slice().sort((a, b) => a - b);
  assert.ok(sorted[1] - sorted[0] >= 15,
    "closest rock unambiguous (gap " + (sorted[1] - sorted[0]).toFixed(1) + ")");

  const trueBearing = Math.atan2(closest.position.y - ufo.position.y,
                                 closest.position.x - ufo.position.x);
  const spread = CONFIG.ufo.tiers[ufo.tier].aimSpread;
  const diff = Math.abs(shot.velocity.angle() - trueBearing);
  assert.ok(diff <= spread + 1e-9,
    "shot aimed at the closest rock within the tier's jitter, diff=" + diff);
});

/* ---------------- Test 23: alive-player targeting mixes near 30% ---------------- */

test("alive-player targeting mixes ship and rock aims near 30%", () => {
  const g = loadGame({ seed: 31 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;              // no shots; sample the chooser only

  /* Ship alive (hidden but not dead) + live parked rocks. */
  const picks = { rock: 0, ship: 0, random: 0 };
  for (let i = 0; i < 200; i++) picks[e.ufos[0].chooseFireTarget()]++;
  const share = picks.rock / 200;
  assert.ok(share > 0.15 && share < 0.45,
    "rock-aim share near 30% over 200 picks, got " + share +
    " (ship=" + picks.ship + " random=" + picks.random + ")");
});

/* ---------------- Test 24: rock-aimed shots stay lethal to the ship ------------ */

test("a rock-aimed saucer shot still kills a ship standing on the line", () => {
  const g = loadGame({ seed: 33 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;
  ufo.velocity.x = 0;
  ufo.baseY = 300;
  ufo.phase = 0;
  ufo.position.x = 480;
  ufo.position.y = 300;

  e.ship.visible = true;
  e.ship.dead = false;
  e.ship.invulnTimer = 0;
  e.ship.position.x = 480;
  e.ship.position.y = 340;          // 40 px below the saucer, on the line
  e.ship.velocity.x = 0;
  e.ship.velocity.y = 0;
  const lives0 = e.lives;
  const score0 = e.score;

  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 0;
  ast.position.x = 480;
  ast.position.y = 430;             // the aim target, below the ship

  const orig = ufo.chooseFireTarget;
  ufo.chooseFireTarget = () => "rock";
  ufo.fireTimer = 0;               // <= 0 at frame start -> fires now
  g.step(1);
  ufo.chooseFireTarget = orig;
  g.step(1);
  assert.ok(e.ship.dead,
    "the rock-aimed shot killed the ship standing on its line");
  assert.equal(e.lives, lives0 - 1, "a life was lost");
  /* The ship-kill consumes the shot (UFO-laser x ship pair) — it never
     reaches the aimed rock. */
  assert.equal(e.ufoLasers.length, 0,
    "the kill consumed the shot");
  assert.ok(e.asteroids.includes(ast),
    "the aimed rock survived (the shot died with the ship)");
});

/* ---------------- Test 25: spawn grace + clear-to-exit hold ---------------- */

test("spawn grace: strikes cannot land; the hold keeps protection while overlapped", () => {
  const g = loadGame({ seed: 41 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  const ufo = spawnUfo(g);          // real spawn path -> grace armed
  assert.ok(ufo.spawnGrace > 0, "grace armed on spawn");
  ufo.fireTimer = 1e9;              // this test is about survival

  /* A frozen rock re-striking every frame for 2 full seconds - across
     the wrap corridor, entry, the grace window, and the hold. */
  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 0;
  for (let f = 0; f < Math.ceil(2.0 / DT); f++) {
    ast.position.x = ufo.position.x;
    ast.position.y = ufo.position.y;
    g.step(1);
  }
  assert.ok(ufo.alive && e.ufos.includes(ufo),
    "saucer survived 2s of continuous rock strikes (grace + hold)");

  /* Clear the rock: the hold's 0.05 s floor runs out and grace ends. */
  ast.alive = false;
  g.step(Math.ceil(0.2 / DT));
  assert.equal(ufo.spawnGrace, 0, "grace fully expired once the hull is clear");

  /* A fresh strike now lands and kills. */
  const strike = e.asteroids[1];
  strike.velocity.x = 0;
  strike.velocity.y = 0;
  strike.position.x = ufo.position.x;
  strike.position.y = ufo.position.y;
  g.step(1);
  assert.ok(!e.ufos.includes(ufo), "post-grace strike destroys the saucer");
});

/* ---------------- Test 26: grace expires cleanly with no rocks in reach ---------- */

test("grace counts down to zero with no rocks in reach", () => {
  const g = loadGame({ seed: 47 });
  const e = g.engine;
  e.startGame();
  defuseHazards(g);                 // rocks parked below the cruise band

  const ufo = spawnUfo(g);
  ufo.fireTimer = 1e9;
  assert.ok(stepUntil(g, 60 * 3, () => ufo.spawnGrace === 0 && ufo.hasEntered),
    "grace expired naturally after entry (3s window)");
  assert.ok(e.ufos.includes(ufo) && ufo.alive, "saucer alive throughout");
});

/* ---------------- Test 27: ramming breaks the rock like a laser ---------------- */

test("ship-asteroid collision destroys the rock exactly like a laser hit", () => {
  const g = loadGame({ seed: 55 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);                 // wave-1 field: all size 3

  /* Park the ship mid-field, visible and killable. */
  e.ship.visible = true;
  e.ship.dead = false;
  e.ship.invulnTimer = 0;
  e.ship.position.x = 480;
  e.ship.position.y = 300;
  e.ship.velocity.x = 0;
  e.ship.velocity.y = 0;

  /* Ram: teleport a frozen rock onto the ship. */
  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 0;
  ast.position.x = 480;
  ast.position.y = 300;
  const score0 = e.score;
  const lives0 = e.lives;
  g.step(1);

  assert.ok(e.ship.dead, "the ram destroyed the ship");
  assert.equal(e.lives, lives0 - 1, "a life was lost");
  assert.ok(!e.asteroids.includes(ast), "the rammed rock was destroyed");
  assert.ok(e.asteroids.filter((a) => a.size === 2).length >= 2,
    "the size-3 rock split into two mediums (laser-equivalent effect)");
  assert.equal(e.score, score0 + CONFIG.asteroid[3].score,
    "the rock's own score was awarded (laser-equivalent)");
  assert.ok(e.ship.respawnTimer > 0, "respawn timer armed");
});

/* ---------------- Test 28: invulnerable ships phase through intact ---------------- */

test("an invulnerable ship phases through rocks without destroying them", () => {
  const g = loadGame({ seed: 57 });
  const { CONFIG, engine: e } = g;
  e.startGame();
  defuseHazards(g);

  e.ship.visible = true;
  e.ship.dead = false;
  e.ship.invulnTimer = CONFIG.ship.invulnerable;   // fully invulnerable
  e.ship.position.x = 480;
  e.ship.position.y = 300;
  e.ship.velocity.x = 0;
  e.ship.velocity.y = 0;

  const ast = e.asteroids[0];
  ast.velocity.x = 0;
  ast.velocity.y = 0;
  ast.position.x = 480;
  ast.position.y = 300;
  const score0 = e.score;
  g.step(1);

  assert.ok(!e.ship.dead, "the invulnerable ship survives");
  assert.ok(e.asteroids.includes(ast),
    "the rock stays intact (no laser effect while invulnerable)");
  assert.equal(e.score, score0, "no score from a phased-through rock");
});



