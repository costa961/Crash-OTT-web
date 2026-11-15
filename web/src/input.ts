// Controllers for the game: the browser's gamepads (Gamepad API, "standard" mapping = the Xbox
// layout) and the keyboard as a pad, written once per animation frame into the block the runtime
// reads (runtime/input_wasm.cpp: WebInput). Pad 0 is the first gamepad merged with the keyboard.
//
// The bindings are the player's (the start page's Controls, remembered in this browser): one key per
// pad input (Enter is always A too, for the menus), and which gamepad button is which pad input.
//
// Local co-op (the game's own: a 2nd controller's B joins as player 2): controllers 1-4 are the gamepads in
// order, the keyboard with the first one. With "the keyboard plays player 2" (keyboardPlayer() = 2) and a
// gamepad connected, the first gamepad is controller 1, the keyboard controller 2, the other gamepads 3-4.

// XINPUT_GAMEPAD_* bits
const B = { UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008, START: 0x0010, BACK: 0x0020, LS: 0x0040, RS: 0x0080,
  LB: 0x0100, RB: 0x0200, A: 0x1000, BB: 0x2000, X: 0x4000, Y: 0x8000 } as const;

// ---- the gamepad: which "standard" button (0-15; 6 / 7 are the triggers) is which pad input ----
/** The gamepad's pad inputs, in the order the Controls table shows them (the sticks are not remapped). */
export const PAD_ACTIONS = [
  ['a', 'A (jump)'], ['x', 'X (attack)'], ['b', 'B'], ['y', 'Y'],
  ['lb', 'LB'], ['rb', 'RB'], ['lt', 'LT'], ['rt', 'RT'],
  ['start', 'Start'], ['back', 'Back'],
  ['up', 'D-pad up'], ['down', 'D-pad down'], ['left', 'D-pad left'], ['right', 'D-pad right'],
  ['ls', 'Left stick click'], ['rs', 'Right stick click'],
] as const;
export type PadAction = typeof PAD_ACTIONS[number][0];
export type PadBindings = Record<PadAction, number>;   // pad input -> Gamepad.buttons index
export const DEFAULT_PAD: PadBindings = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11,
  up: 12, down: 13, left: 14, right: 15 };
const PAD_KEY = 'crashott-pad';
export function loadPadBindings(): PadBindings {
  const b: PadBindings = { ...DEFAULT_PAD };
  try {
    const saved = JSON.parse(localStorage.getItem(PAD_KEY) ?? '{}') as Partial<PadBindings>;
    for (const [a] of PAD_ACTIONS) if (Number.isInteger(saved[a]) && saved[a]! >= 0 && saved[a]! < 16) b[a] = saved[a]!;
  } catch { /* defaults */ }
  return b;
}
export function savePadBindings(b: PadBindings) {
  try { localStorage.setItem(PAD_KEY, JSON.stringify(b)); } catch { /* no storage */ }
}
/** A "standard" gamepad button's name, in the Xbox layout. */
export function padButtonName(i: number): string {
  return ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'Left stick', 'Right stick', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →'][i] ?? `Button ${i}`;
}
const PAD_BIT: Record<PadAction, number> = { a: B.A, b: B.BB, x: B.X, y: B.Y, lb: B.LB, rb: B.RB, lt: 0, rt: 0, start: B.START, back: B.BACK,
  up: B.UP, down: B.DOWN, left: B.LEFT, right: B.RIGHT, ls: B.LS, rs: B.RS };

/** The keyboard's pad inputs, in the order the Controls table shows them. */
export const ACTIONS = [
  ['lsUp', 'Left stick up'], ['lsDown', 'Left stick down'], ['lsLeft', 'Left stick left'], ['lsRight', 'Left stick right'],
  ['a', 'A (jump)'], ['x', 'X (attack)'], ['b', 'B'], ['y', 'Y'],
  ['lb', 'LB'], ['rb', 'RB'], ['lt', 'LT'], ['rt', 'RT'],
  ['start', 'Start'], ['back', 'Back'],
  ['up', 'D-pad up'], ['down', 'D-pad down'], ['left', 'D-pad left'], ['right', 'D-pad right'],
  ['rsUp', 'Right stick up'], ['rsDown', 'Right stick down'], ['rsLeft', 'Right stick left'], ['rsRight', 'Right stick right'],
  ['ls', 'Left stick click'], ['rs', 'Right stick click'],
] as const;
export type Action = typeof ACTIONS[number][0];
export type Bindings = Record<Action, string>;   // action -> KeyboardEvent.code

export const DEFAULT_BINDINGS: Bindings = {
  lsUp: 'KeyW', lsDown: 'KeyS', lsLeft: 'KeyA', lsRight: 'KeyD',
  a: 'Space', x: 'KeyJ', b: 'KeyK', y: 'KeyI', lb: 'KeyU', rb: 'KeyO', lt: 'KeyQ', rt: 'KeyE',
  start: 'Escape', back: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  rsUp: 'Numpad8', rsDown: 'Numpad5', rsLeft: 'Numpad4', rsRight: 'Numpad6', ls: 'KeyZ', rs: 'KeyC',
};

const STORAGE_KEY = 'crashott-keys';
/** Keys the game can't have: the page's own (full screen, the in-game options panel). */
export const RESERVED_KEYS = new Set(['KeyF', 'F11', 'F12', 'F2']);

export function loadBindings(): Bindings {
  const b: Bindings = { ...DEFAULT_BINDINGS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Bindings>;
    for (const [a] of ACTIONS) if (typeof saved[a] === 'string' && !RESERVED_KEYS.has(saved[a]!)) b[a] = saved[a]!;
  } catch { /* defaults */ }
  return b;
}

const KEYBOARD_PLAYER_KEY = 'crashott-keyboard-player';
/** Which player the keyboard plays (1, or 2 next to a gamepad playing 1): the start page's Controls. */
export function keyboardPlayer(): 1 | 2 {
  try { return localStorage.getItem(KEYBOARD_PLAYER_KEY) === '2' ? 2 : 1; } catch { return 1; }
}
export function setKeyboardPlayer(player: 1 | 2) {
  try { localStorage.setItem(KEYBOARD_PLAYER_KEY, String(player)); } catch { /* no storage */ }
}

export function saveBindings(b: Bindings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch { /* no storage */ }
}

/** A key's name for people ("KeyW" -> "W", "ArrowUp" -> "↑"). */
export function keyName(code: string): string {
  const names: Record<string, string> = { Space: 'Space', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt',
    AltRight: 'Right Alt', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab' };
  if (names[code]) return names[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

const BUTTON_OF: Partial<Record<Action, number>> = { a: B.A, b: B.BB, x: B.X, y: B.Y, lb: B.LB, rb: B.RB, start: B.START, back: B.BACK,
  up: B.UP, down: B.DOWN, left: B.LEFT, right: B.RIGHT, ls: B.LS, rs: B.RS };

const MAGIC = 0x504E4957, PAD_BYTES = 20, PADS_AT = 8, HIDDEN_AT = PADS_AT + 4 * PAD_BYTES, SKIPPABLE_AT = HIDDEN_AT + 4;
// the in-game options (runtime/input_wasm.cpp ApplyPageOptions): sequence, length, text
const OPTIONS_SEQ_AT = SKIPPABLE_AT + 4, OPTIONS_LEN_AT = OPTIONS_SEQ_AT + 4, OPTIONS_AT = OPTIONS_LEN_AT + 4, OPTIONS_BYTES = 1024;
/** crashott-pc's settings/skip_cinematics.cpp: how long B / START / A is held to skip a cutscene. */
const SKIP_HOLD_MS = 800;

export interface InputOptions {
  /** the "hold to skip" prompt over the game (index.html #skip) */
  skipPrompt?: HTMLElement | null;
}

export interface GameInput {
  /** The game held and its input off (the in-game options panel), or running again. */
  setPaused(paused: boolean): void;
  /** The game goes on but sees no button (an online co-op client waiting at the main menu for the host). */
  setBlocked(blocked: boolean): void;
  /** Graphics options by name (main_wasm.cpp ApplyGraphicsOptions), applied at the game's next frame. */
  sendOptions(options: Record<string, string>): void;
  detach(): void;
}

export function attachInput(memory: WebAssembly.Memory, block: number, log: (s: string) => void, opts: InputOptions = {}): GameInput {
  const bindings = loadBindings();
  const padBindings = loadPadBindings();
  const keyboardAsPlayer2 = keyboardPlayer() === 2;
  let paused = false, blocked = false;
  const keyToActions = new Map<string, Action[]>();
  for (const [a] of ACTIONS) keyToActions.set(bindings[a], [...(keyToActions.get(bindings[a]) ?? []), a]);
  const keys = new Set<string>();
  const handled = (code: string) => keyToActions.has(code) || code === 'Enter' || code === 'NumpadEnter';
  const down = (e: KeyboardEvent) => { if (!paused && handled(e.code)) { keys.add(e.code); e.preventDefault(); } };
  const up = (e: KeyboardEvent) => { keys.delete(e.code); };
  const blur = () => keys.clear();
  // the page hidden (another tab, minimized): the game holds between two frames (runtime/stubs.cpp)
  // (or the in-game options panel open)
  const hold = () => {
    const i32 = new Int32Array(memory.buffer as unknown as ArrayBuffer, block, (HIDDEN_AT >> 2) + 1);
    Atomics.store(i32, HIDDEN_AT >> 2, document.hidden || paused ? 1 : 0);
    if (document.hidden || paused) keys.clear();
  };
  const visibility = () => {
    hold();
    log(`[input] page ${document.hidden ? 'hidden: game paused' : 'visible: game running'}`);
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  let seen = new Set<string>();
  let running = true;

  const held = (a: Action) => keys.has(bindings[a]);
  const axis = (v: number) => {
    const dead = 0.15;
    if (Math.abs(v) < dead) return 0;
    const s = (Math.abs(v) - dead) / (1 - dead) * Math.sign(v);
    return Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  };
  const keyAxis = (neg: Action, pos: Action) => (held(pos) ? 32767 : 0) - (held(neg) ? 32767 : 0);

  // "hold to skip": shown while the runtime says a cutscene or a video can be skipped; the ring fills
  // while one of the skip buttons (B / START / A, or their keys) is held, as crashott-pc's own prompt.
  const prompt = opts.skipPrompt ?? null;
  const ring = prompt?.querySelector<SVGCircleElement>('circle.fill') ?? null;
  const label = prompt?.querySelector<HTMLElement>('.label') ?? null;
  if (label) label.textContent = `Hold ${keyName(bindings.start)} / ${keyName(bindings.b)} or B to skip`;
  let holdSince = 0;

  const frame = () => {
    if (!running) return;
    const buf = memory.buffer as unknown as ArrayBuffer;
    const i32 = new Int32Array(buf, block, (SKIPPABLE_AT >> 2) + 1), dv = new DataView(buf, block + PADS_AT, 4 * PAD_BYTES);
    if (i32[0] !== MAGIC) { log('[input] the input block has a wrong magic'); running = false; return; }
    const pads = (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
    const names = new Set(pads.map(g => g.id));
    for (const n of names) if (!seen.has(n)) log(`[input] gamepad connected: ${n}`);
    seen = names;

    let skipHeld = false;
    Atomics.add(i32, 1, 1);   // odd: writing
    // controller p's gamepad, and whether the keyboard drives it (the header: local co-op)
    const kbSecond = keyboardAsPlayer2 && pads.length > 0;
    for (let p = 0; p < 4; p++) {
      const g = !kbSecond ? pads[p] : p === 0 ? pads[0] : p === 1 ? undefined : pads[p - 1];
      const keyboard = kbSecond ? p === 1 : p === 0;
      let buttons = 0, lt = 0, rt = 0, lx = 0, ly = 0, rx = 0, ry = 0, connected = !!g;
      if (g && !paused && !blocked) {
        for (const [a, bit] of Object.entries(PAD_BIT) as [PadAction, number][]) if (bit && g.buttons[padBindings[a]]?.pressed) buttons |= bit;
        const trigger = (i: number) => { const b = g.buttons[i]; return Math.round((b ? Math.max(b.value, b.pressed ? 1 : 0) : 0) * 255); };
        lt = trigger(padBindings.lt);
        rt = trigger(padBindings.rt);
        lx = axis(g.axes[0] ?? 0); ly = -axis(g.axes[1] ?? 0);   // XInput: up is positive
        rx = axis(g.axes[2] ?? 0); ry = -axis(g.axes[3] ?? 0);
      }
      if (keyboard && !paused && !blocked) {
        connected = true;
        for (const [a, bit] of Object.entries(BUTTON_OF) as [Action, number][]) if (held(a)) buttons |= bit;
        if (keys.has('Enter') || keys.has('NumpadEnter')) buttons |= B.A;
        if (held('lt')) lt = 255;
        if (held('rt')) rt = 255;
        const kx = keyAxis('lsLeft', 'lsRight'), ky = keyAxis('lsDown', 'lsUp');
        if (kx || ky) { lx = kx; ly = ky; }
        const krx = keyAxis('rsLeft', 'rsRight'), kry = keyAxis('rsDown', 'rsUp');
        if (krx || kry) { rx = krx; ry = kry; }
      }
      if (keyboard) connected = true;
      // the cutscene skip reads controller 1 (runtime/input_wasm.cpp)
      if (p === 0) skipHeld = (buttons & (B.A | B.BB | B.START)) !== 0;
      const o = p * PAD_BYTES;
      dv.setUint32(o, connected ? 1 : 0, true);
      dv.setUint16(o + 4, buttons, true);
      dv.setUint8(o + 6, lt); dv.setUint8(o + 7, rt);
      dv.setInt16(o + 8, lx, true); dv.setInt16(o + 10, ly, true);
      dv.setInt16(o + 12, rx, true); dv.setInt16(o + 14, ry, true);
      // the game's rumble (XamInputSetState) to the gamepad
      const vl = dv.getUint16(o + 16, true), vr = dv.getUint16(o + 18, true);
      const act = g?.vibrationActuator as (GamepadHapticActuator & { playEffect?: Function }) | undefined;
      if (act?.playEffect && (vl || vr))
        act.playEffect('dual-rumble', { duration: 100, strongMagnitude: vl / 65535, weakMagnitude: vr / 65535 }).catch(() => {});
    }
    Atomics.add(i32, 1, 1);   // even: done

    if (prompt) {
      const skippable = Atomics.load(i32, SKIPPABLE_AT >> 2) !== 0;
      prompt.hidden = !skippable;
      const now = performance.now();
      if (!skippable || !skipHeld) holdSince = 0;
      else if (!holdSince) holdSince = now;
      const progress = holdSince ? Math.min(1, (now - holdSince) / SKIP_HOLD_MS) : 0;
      if (ring) ring.style.strokeDashoffset = String(100 - progress * 100);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  log('[input] keyboard and gamepads attached');
  return {
    setPaused(p: boolean) {
      if (p === paused) return;
      paused = p;
      hold();
      log(`[input] ${paused ? 'options panel open: game paused' : 'options panel closed: game running'}`);
    },
    setBlocked(b: boolean) {
      if (b === blocked) return;
      blocked = b;
      if (b) keys.clear();
      log(`[input] ${b ? 'buttons off for the game (waiting for the co-op host)' : 'buttons back on for the game'}`);
    },
    sendOptions(options: Record<string, string>) {
      const text = new TextEncoder().encode(Object.entries(options).map(([k, v]) => `${k}=${v}`).join('\n'));
      if (text.length > OPTIONS_BYTES) { log('[input] the options are too long for the input block'); return; }
      const buf = memory.buffer as unknown as ArrayBuffer;
      new Uint8Array(buf, block + OPTIONS_AT, OPTIONS_BYTES).set(text);
      const i32 = new Int32Array(buf, block, (OPTIONS_LEN_AT >> 2) + 1);
      Atomics.store(i32, OPTIONS_LEN_AT >> 2, text.length);
      Atomics.add(i32, OPTIONS_SEQ_AT >> 2, 1);
    },
    detach() {
      running = false;
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
