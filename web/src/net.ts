// The page's side of the online co-op's virtual LAN: the runtime's mailbox (runtime/net_wasm.cpp, in shared
// memory) to the server's switch (tools/netswitch.mjs) over a WebSocket on /net, and back. The runtime queues
// datagrams in its TX ring and rings a bell; the page sends them, and queues what arrives in the RX ring.
// The block also carries the session's state for the page's panel (a JSON object the runtime writes) and the
// page's commands to the session (text).

const MAGIC = 0x54454E57, VERSION = 1;
const W = { magic: 0, version: 1, state: 2, ip: 3, txHead: 4, txTail: 5, txBell: 6, rxHead: 7, rxTail: 8, rxBell: 9, statusSeq: 10, statusLen: 11 };
const STATUS_AT = 48, STATUS_BYTES = 4096, COMMAND_AT = STATUS_AT + STATUS_BYTES, COMMAND_BYTES = 1024;
const HEADER_BYTES = 8192, SLOT_BYTES = 1536, SLOT_HEADER = 12, TX_SLOTS = 128, RX_SLOTS = 256;

export interface NetInfo { name: string; hosting: boolean; players?: number; maxPlayers?: number; inGame?: boolean }

export interface GameNet {
  /** the session's state, as the runtime last wrote it (null: none yet) */
  status(): Record<string, unknown> | null;
  /** a command to the session (runtime/mp_web.cpp) */
  command(text: string): void;
  /** what the start page's list shows of this browser's session */
  announce(info: NetInfo): void;
  close(): void;
}

// Atomics.waitAsync (ES2024; Chrome 87+): not in this project's TypeScript library
const waitAsync = (Atomics as unknown as { waitAsync(a: Int32Array, i: number, v: number, t: number): { async: boolean; value: Promise<string> | string } }).waitAsync;

const ipNumber = (text: string) => text.split('.').reduce((n, part) => (n << 8 | (Number(part) & 255)) >>> 0, 0);

export function attachNet(memory: WebAssembly.Memory, block: number, log: (s: string) => void, info: NetInfo): GameNet {
  const buf = () => memory.buffer as unknown as ArrayBuffer;
  const words = () => new Int32Array(buf(), block, HEADER_BYTES / 4);
  if ((words()[W.magic] >>> 0) !== MAGIC || words()[W.version] !== VERSION) {
    log('[net] the runtime\'s mailbox has a wrong magic or version');
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/net`);
  ws.binaryType = 'arraybuffer';
  let open = true, sent = 0, received = 0, lastInfo = '';
  const sendInfo = (i: NetInfo) => {
    const text = JSON.stringify({ t: 'info', ...i });
    if (text === lastInfo || ws.readyState !== WebSocket.OPEN) return;
    lastInfo = text;
    ws.send(text);
  };

  // TX: the runtime's datagrams to the switch, as soon as its bell rings
  const drain = () => {
    const w = words();
    let tail = Atomics.load(w, W.txTail) >>> 0;
    const head = Atomics.load(w, W.txHead) >>> 0;
    while (tail !== head) {
      const at = block + HEADER_BYTES + (tail % TX_SLOTS) * SLOT_BYTES;
      const v = new DataView(buf(), at, SLOT_BYTES);
      const len = Math.min(v.getUint32(0, true), SLOT_BYTES - SLOT_HEADER), to = v.getUint32(4, true);
      const toPort = v.getUint16(8, true), fromPort = v.getUint16(10, true);
      const frame = new Uint8Array(8 + len), fv = new DataView(frame.buffer);
      fv.setUint32(0, to); fv.setUint16(4, toPort); fv.setUint16(6, fromPort);
      frame.set(new Uint8Array(buf(), at + SLOT_HEADER, len), 8);
      if (ws.readyState === WebSocket.OPEN) { ws.send(frame); sent++; }
      tail = (tail + 1) >>> 0;
      Atomics.store(w, W.txTail, tail | 0);
    }
  };
  const waitTx = async () => {
    while (open) {
      const w = words(), bell = Atomics.load(w, W.txBell);
      drain();
      const r = waitAsync(w, W.txBell, bell, 1000);
      if (r.async) await r.value;
    }
  };

  // RX: the switch's datagrams to the runtime's ring
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as { t: string; ip?: string };
        if (msg.t === 'hello' && msg.ip) {
          const w = words();
          Atomics.store(w, W.ip, ipNumber(msg.ip) | 0);
          Atomics.store(w, W.state, 1);
          log(`[net] on the virtual LAN as ${msg.ip}`);
          sendInfo(info);
        }
      } catch { /* not JSON */ }
      return;
    }
    const data = new Uint8Array(ev.data as ArrayBuffer);
    if (data.length < 8 || data.length - 8 > SLOT_BYTES - SLOT_HEADER) return;
    const w = words(), head = Atomics.load(w, W.rxHead) >>> 0, tail = Atomics.load(w, W.rxTail) >>> 0;
    if (head - tail >= RX_SLOTS) return;   // the runtime is behind: lost, as a UDP datagram would be
    const dv = new DataView(data.buffer);
    const at = block + HEADER_BYTES + TX_SLOTS * SLOT_BYTES + (head % RX_SLOTS) * SLOT_BYTES;
    const v = new DataView(buf(), at, SLOT_BYTES);
    v.setUint32(0, data.length - 8, true);
    v.setUint32(4, dv.getUint32(0), true);
    v.setUint16(8, dv.getUint16(4), true);
    v.setUint16(10, dv.getUint16(6), true);
    new Uint8Array(buf(), at + SLOT_HEADER, data.length - 8).set(data.subarray(8));
    Atomics.store(w, W.rxHead, (head + 1) | 0);
    Atomics.add(w, W.rxBell, 1);
    Atomics.notify(w, W.rxBell);
    received++;
  };
  ws.onopen = () => { log('[net] connected to the server\'s switch'); void waitTx(); };
  ws.onclose = () => {
    if (open) log('[net] the connection to the server\'s switch closed');
    Atomics.store(words(), W.state, 2);
    open = false;
  };
  ws.onerror = () => log('[net] the server\'s switch could not be reached');
  const stats = setInterval(() => { if (sent || received) log(`[net] ${sent} datagrams sent, ${received} received (last 30 s)`); sent = received = 0; }, 30000);

  let statusSeen = -1, statusValue: Record<string, unknown> | null = null;
  return {
    status() {
      const w = words(), seq = Atomics.load(w, W.statusSeq);
      if (seq !== statusSeen) {
        statusSeen = seq;
        const len = Math.min(Atomics.load(w, W.statusLen) >>> 0, STATUS_BYTES);
        const text = new TextDecoder().decode(new Uint8Array(buf(), block + STATUS_AT, len).slice());
        try { statusValue = JSON.parse(text) as Record<string, unknown>; } catch { /* half written: next time */ }
      }
      return statusValue;
    },
    command(text: string) {
      const bytes = new TextEncoder().encode(text).subarray(0, COMMAND_BYTES - 8);
      new Uint8Array(buf(), block + COMMAND_AT + 8, bytes.length).set(bytes);
      const seq = new Int32Array(buf(), block + COMMAND_AT, 2);
      Atomics.store(seq, 1, bytes.length);
      Atomics.add(seq, 0, 1);
    },
    announce(i: NetInfo) { info = i; sendInfo(i); },
    close() { open = false; clearInterval(stats); ws.close(); },
  };
}

/** The sessions hosted on this server (the start page's list). */
export async function listHosts(): Promise<{ ip: string; name: string; players: number; maxPlayers: number; inGame: boolean }[]> {
  try {
    const r = await fetch('/net/hosts', { cache: 'no-store' });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}
