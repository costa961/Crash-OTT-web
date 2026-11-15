// Controllers for the game: the browser's gamepads (Gamepad API, "standard" mapping = the Xbox
// layout) and the keyboard as a pad, written once per animation frame into the block the runtime
// reads (runtime/input_wasm.cpp: WebInput). Pad 0 is the first gamepad merged with the keyboard.
//
// Keyboard: WASD left stick, arrows D-pad, Space / Enter A, J X, K B, I Y, U / O shoulders,
// Q / E triggers, Esc Start, Tab Back, numpad 8456 right stick.

// XINPUT_GAMEPAD_* bits
const B = { UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008, START: 0x0010, BACK: 0x0020, LS: 0x0040, RS: 0x0080,
  LB: 0x0100, RB: 0x0200, A: 0x1000, BB: 0x2000, X: 0x4000, Y: 0x8000 } as const;

// "standard" gamepad buttons -> XInput bits (6/7 are the triggers, 16 the guide button)
const PAD_BUTTONS: Record<number, number> = { 0: B.A, 1: B.BB, 2: B.X, 3: B.Y, 4: B.LB, 5: B.RB, 8: B.BACK, 9: B.START,
  10: B.LS, 11: B.RS, 12: B.UP, 13: B.DOWN, 14: B.LEFT, 15: B.RIGHT };

const KEY_BUTTONS: Record<string, number> = { Space: B.A, Enter: B.A, NumpadEnter: B.A, KeyJ: B.X, KeyK: B.BB, KeyI: B.Y,
  KeyU: B.LB, KeyO: B.RB, Escape: B.START, Tab: B.BACK, ArrowUp: B.UP, ArrowDown: B.DOWN, ArrowLeft: B.LEFT, ArrowRight: B.RIGHT,
  KeyZ: B.LS, KeyC: B.RS };

const MAGIC = 0x504E4957, PAD_BYTES = 20, PADS_AT = 8;

export function attachInput(memory: WebAssembly.Memory, block: number, log: (s: string) => void): () => void {
  const keys = new Set<string>();
  const handled = new Set([...Object.keys(KEY_BUTTONS), 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Numpad8', 'Numpad4', 'Numpad5', 'Numpad6']);
  const down = (e: KeyboardEvent) => { if (handled.has(e.code)) { keys.add(e.code); e.preventDefault(); } };
  const up = (e: KeyboardEvent) => { keys.delete(e.code); };
  const blur = () => keys.clear();
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  let seen = new Set<string>();
  let running = true;

  const axis = (v: number) => {
    const dead = 0.15;
    if (Math.abs(v) < dead) return 0;
    const s = (Math.abs(v) - dead) / (1 - dead) * Math.sign(v);
    return Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  };
  const keyAxis = (neg: string, pos: string) => (keys.has(pos) ? 32767 : 0) - (keys.has(neg) ? 32767 : 0);

  const frame = () => {
    if (!running) return;
    const buf = memory.buffer as unknown as ArrayBuffer;
    const i32 = new Int32Array(buf, block, 2), dv = new DataView(buf, block + PADS_AT, 4 * PAD_BYTES);
    if (i32[0] !== MAGIC) { log('[input] the input block has a wrong magic'); running = false; return; }
    const pads = (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
    const names = new Set(pads.map(g => g.id));
    for (const n of names) if (!seen.has(n)) log(`[input] gamepad connected: ${n}`);
    seen = names;

    Atomics.add(i32, 1, 1);   // odd: writing
    for (let p = 0; p < 4; p++) {
      const g = pads[p];
      let buttons = 0, lt = 0, rt = 0, lx = 0, ly = 0, rx = 0, ry = 0, connected = !!g;
      if (g) {
        for (const [i, bit] of Object.entries(PAD_BUTTONS)) if (g.buttons[Number(i)]?.pressed) buttons |= bit;
        lt = Math.round((g.buttons[6]?.value ?? 0) * 255);
        rt = Math.round((g.buttons[7]?.value ?? 0) * 255);
        lx = axis(g.axes[0] ?? 0); ly = -axis(g.axes[1] ?? 0);   // XInput: up is positive
        rx = axis(g.axes[2] ?? 0); ry = -axis(g.axes[3] ?? 0);
      }
      if (p === 0) {
        // the keyboard is always a pad 0, with the first gamepad or alone
        connected = true;
        for (const k of keys) buttons |= KEY_BUTTONS[k] ?? 0;
        if (keys.has('KeyQ')) lt = 255;
        if (keys.has('KeyE')) rt = 255;
        const kx = keyAxis('KeyA', 'KeyD'), ky = keyAxis('KeyS', 'KeyW');
        if (kx || ky) { lx = kx; ly = ky; }
        const krx = keyAxis('Numpad4', 'Numpad6'), kry = keyAxis('Numpad5', 'Numpad8');
        if (krx || kry) { rx = krx; ry = kry; }
      }
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
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  log('[input] keyboard and gamepads attached');
  return () => {
    running = false;
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
  };
}
