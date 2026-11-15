// The online co-op's switch: a virtual LAN between the players' browsers (web/src/net.ts), over WebSockets
// on /net. Each browser gets an address of its own (10.77.0.2 and up) and its datagrams go to the address
// they name, or to every other browser for a broadcast (255.255.255.255: the game's DISCOVER). The game
// itself (crashott-pc's online code, runtime/net_wasm.cpp) speaks its own protocol on top: the switch only
// carries datagrams. /net/hosts lists the browsers that host a session (the start page's list).
//
// Frames (binary, big-endian): page -> switch  [to address u32][to port u16][from port u16][payload]
//                              switch -> page  [from address u32][from port u16][to port u16][payload]
// Text frames (JSON): switch -> page {t:'hello', ip} once; page -> switch {t:'info', name, hosting, players,
// maxPlayers, inGame} whenever its session changes (the list).
//
// The WebSocket endpoint (RFC 6455) has no dependencies: GTA San Andreas web's tools/race/ws.mjs (same
// author), with binary frames.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024, MAX_PAYLOAD = 1524, MAX_FRAMES_PER_SECOND = 3000, MAX_MEMBERS = 250;
const BROADCAST = 0xFFFFFFFF, BASE = (10 << 24) | (77 << 16);   // 10.77.0.0/16

export const ipText = ip => `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;

export class NetSwitch {
  constructor(log = console.log) {
    this.log = log;
    this.members = new Map();   // address -> member
  }

  /** the next free address, or 0 */
  address() {
    for (let n = 2; n < 65534; n++) {
      const ip = (BASE | n) >>> 0;
      if (!this.members.has(ip)) return ip;
    }
    return 0;
  }

  /** the sessions being hosted, for the start page */
  hosts() {
    return [...this.members.values()].filter(m => m.info.hosting).map(m => ({
      ip: ipText(m.ip), name: String(m.info.name ?? '').slice(0, 24), players: m.info.players | 0,
      maxPlayers: m.info.maxPlayers | 0, inGame: !!m.info.inGame,
    }));
  }

  /** answers an HTTP upgrade on /net (http.Server 'upgrade') */
  accept(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
    if (this.members.size >= MAX_MEMBERS) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    const ip = this.address();
    if (!ip) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                 `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);

    let open = true, buf = Buffer.alloc(0), parts = [], partOp = 0;
    const frame = (op, data) => {
      if (!open) return;
      const n = data.length, head = n < 126 ? Buffer.from([0x80 | op, n])
        : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
        : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      socket.write(Buffer.concat([head, data]));
    };
    const member = { ip, info: {}, second: 0, frames: 0, sendBinary: data => frame(2, data) };
    this.members.set(ip, member);
    this.log(`[net] ${ipText(ip)} joined (${this.members.size} on the LAN)`);
    frame(1, Buffer.from(JSON.stringify({ t: 'hello', ip: ipText(ip) })));
    const close = () => { if (!open) return; frame(8, Buffer.alloc(0)); open = false; socket.end(); };
    const gone = () => {
      if (!this.members.has(ip)) return;
      open = false;
      this.members.delete(ip);
      this.log(`[net] ${ipText(ip)} left (${this.members.size} on the LAN)`);
    };

    const datagram = data => {
      if (data.length < 8 || data.length - 8 > MAX_PAYLOAD) return;
      const now = Math.floor(Date.now() / 1000);
      if (member.second !== now) { member.second = now; member.frames = 0; }
      if (++member.frames > MAX_FRAMES_PER_SECOND) return;
      const to = data.readUInt32BE(0), toPort = data.readUInt16BE(4), fromPort = data.readUInt16BE(6);
      const out = Buffer.allocUnsafe(data.length);
      out.writeUInt32BE(ip, 0); out.writeUInt16BE(fromPort, 4); out.writeUInt16BE(toPort, 6);
      data.copy(out, 8, 8);
      if (to === BROADCAST || to === ((BASE | 0xFFFF) >>> 0)) {
        for (const m of this.members.values()) if (m !== member) m.sendBinary(out);
      } else {
        this.members.get(to >>> 0)?.sendBinary(out);
      }
    };

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
        let len = buf[1] & 127, at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (len > MAX_MESSAGE || !masked) { close(); socket.destroy(); return; }
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4), data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
        for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(at + 4 + len);
        if (op === 8) { close(); return; }
        if (op === 9) { frame(10, data); continue; }
        if (op === 10) continue;
        if (op === 1 || op === 2) partOp = op;
        if (op === 0 || op === 1 || op === 2) {
          parts.push(data);
          if (!fin) continue;
          const message = Buffer.concat(parts); parts = [];
          if (partOp === 2) { datagram(message); continue; }
          try {
            const msg = JSON.parse(message.toString('utf8'));
            if (msg?.t === 'info' && typeof msg === 'object') member.info = msg;
          } catch { /* not JSON: ignored */ }
        }
      }
    });
    socket.on('close', gone);
    socket.on('error', gone);
  }
}
