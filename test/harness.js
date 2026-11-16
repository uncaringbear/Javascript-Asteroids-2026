"use strict";

/*
 * Test harness for asteroids_js.html.
 *
 * Loads the game's single <script> block into a Node vm context with
 * browser stubs (canvas, window, document, localStorage, rAF), runs it,
 * and returns the live engine plus helpers to step the simulation.
 *
 * - DOM/canvas calls are recorded, so tests can assert on what the game
 *   *draws* (HUD text, geometry) without a real browser.
 * - Math.random is replaced with a seeded PRNG (mulberry32), so gameplay
 *   timelines are fully reproducible: same seed, same UFO spawns.
 * - The game exposes its engine through the inert TEST EXPORT hook at
 *   the bottom of the script; in a normal browser that hook never fires.
 *
 * Run the suite with:  node --test test/
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const GAME_PATH = path.join(__dirname, "..", "asteroids_js.html");

/* Fixed timestep used by the harness simulation loop. */
const DT = 1 / 60;

/* Deterministic PRNG (mulberry32). Each load gets its own stream. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 61), t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Recording 2-D context: every method call is logged as
 * { op, args } in _calls; property writes (fillStyle, lineWidth, ...)
 * are stored and returned on read. Unknown methods are no-ops, with
 * special cases for factories the game consumes.
 */
function makeRecordingCtx() {
  const calls = [];
  const props = Object.create(null);
  const methods = Object.create(null);
  return new Proxy({}, {
    get(target, key) {
      if (key === "_calls") return calls;
      if (key in props) return props[key];
      if (!(key in methods)) {
        methods[key] = (...args) => {
          calls.push({ op: key, args });
          if (key === "createRadialGradient" ||
              key === "createLinearGradient") {
            return { addColorStop() {} };
          }
          if (key === "measureText") return { width: 10 };
          return undefined;
        };
      }
      return methods[key];
    },
    set(target, key, value) {
      props[key] = value;
      return true;
    },
  });
}

/*
 * Load the game. Options: { seed } — the RNG seed for this run.
 * Returns the engine, shared config/state tables, the recording canvas
 * context, and step()/hudTexts() helpers.
 */
function loadGame({ seed = 1 } = {}) {
  const html = fs.readFileSync(GAME_PATH, "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no <script> block found in " + GAME_PATH);

  const lsStore = new Map();
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
  };

  const ctx = makeRecordingCtx();
  const canvas = {
    width: 960,
    height: 600,
    style: {},
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ width: 960, height: 600, left: 0, top: 0 }),
  };

  /*
   * AudioContext stub: the game synthesizes all sound effects through the
   * Web Audio API. This inert stub supplies the node factories the
   * SoundEffects class touches (oscillators, gain, biquad filter, noise
   * buffer, buffer source, dynamics compressor) so loading and stepping
   * the game never throws in the sandbox. Node creations are logged into
   * `_calls` so tests can assert that sounds fired. Strictly a recording
   * of construction — no real audio is produced.
   */
  class AudioContextStub {
    constructor() { this._calls = []; }
    createOscillator() {
      this._calls.push("oscillator");
      const calls = this._calls;
      /* AudioParam calls are recorded ({op, args, param}) so tests can
         assert scheduled values — e.g. a siren carrier's base pitch. */
      const recParam = (name) => ({
        value: 0,
        setValueAtTime: (v, t) => calls.push({ op: "setValueAtTime", args: [v, t], param: name }),
        exponentialRampToValueAtTime: () => {},
        linearRampToValueAtTime: (v, t) => calls.push({ op: "linearRampToValueAtTime", args: [v, t], param: name }),
        cancelScheduledValues: () => {},
        connect: () => {},          // LFOs connect to this AudioParam
      });
      return {
        type: "",
        frequency: recParam("frequency"),
        connect: () => {},
        start: () => {},
        stop: () => {},
      };
    }
    createGain() {
      this._calls.push("gain");
      const calls = this._calls;
      return {
        gain: {
          value: 0,
          setValueAtTime: (v, t) => calls.push({ op: "setValueAtTime", args: [v, t], param: "gain" }),
          exponentialRampToValueAtTime: () => {},
          linearRampToValueAtTime: (v, t) => calls.push({ op: "linearRampToValueAtTime", args: [v, t], param: "gain" }),
          cancelScheduledValues: () => {},
        },
        connect: () => {},
      };
    }
    createBufferSource() {
      this._calls.push("bufferSource");
      return { buffer: null, connect: () => {}, start: () => {}, stop: () => {} };
    }
    createBiquadFilter() {
      this._calls.push("biquadFilter");
      return {
        type: "",
        frequency: { value: 0, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        Q: { value: 0, setValueAtTime: () => {} },
        connect: () => {},
      };
    }
    createBuffer(channels, length) {
      this._calls.push("buffer");
      const len = Math.max(1, length || 100);
      return { getChannelData: () => new Float32Array(len), length: len };
    }
    createDynamicsCompressor() {
      this._calls.push("dynamicsCompressor");
      const param = () => ({ value: 0, setValueAtTime: () => {} });
      return {
        threshold: param(),
        knee: param(),
        ratio: param(),
        attack: param(),
        release: param(),
        reduction: 0,
        connect: () => {},
      };
    }
    get destination() { return {}; }
    resume() { return Promise.resolve(); }
    currentTime = 0;
    state = "running";
  }

  const sandbox = {
    AudioContext: AudioContextStub,
    document: {
      getElementById: () => canvas,
      addEventListener: () => {},
      removeEventListener: () => {},
      hidden: false,
      visibilityState: "visible",
    },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      innerWidth: 960,
      innerHeight: 600,
      devicePixelRatio: 1,
      localStorage,
      pageXOffset: 0,
      pageYOffset: 0,
      AudioContext: AudioContextStub,
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => {},   // the rAF loop is stubbed; tests drive update() directly
    localStorage,
    console,
    /* Keep the real Math methods but swap in the seeded random stream. */
    Math: Object.create(Math),
    Object, Number, String, Boolean, Array, Date, JSON, RegExp, Error,
    Infinity, NaN, undefined,
    isNaN, parseInt, parseFloat,
    setTimeout: () => {}, clearTimeout: () => {},
    setInterval: () => {}, clearInterval: () => {},
  };
  sandbox.Math.random = mulberry32(seed);

  let api = null;
  sandbox.__ASTEROIDS_TEST__ = (exported) => { api = exported; };

  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "asteroids_js.html (inline)" });

  if (!api || !api.engine) {
    throw new Error("game did not export the test API (TEST EXPORT hook missing?)");
  }

  return {
    engine: api.engine,
    CONFIG: api.CONFIG,
    STATE: api.STATE,
    canvas,
    ctx,
    /* Advance the simulation n frames; update + render each frame, like
       the real loop. The recording log is cleared at the start of each
       frame so after step() it holds exactly the last frame's calls. */
    step(frames = 1, dt = DT) {
      for (let i = 0; i < frames; i++) {
        ctx._calls.length = 0;
        api.engine.update(dt);
        api.engine.render();
      }
    },
    /* HUD text calls from the most recent rendered frame:
       [{ text, x, y }, ...] */
    hudTexts() {
      return ctx._calls
        .filter((c) => c.op === "fillText")
        .map((c) => ({ text: c.args[0], x: c.args[1], y: c.args[2] }));
    },
  };
}

module.exports = { loadGame, mulberry32, makeRecordingCtx, DT, GAME_PATH };
