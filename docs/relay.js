// Remplace PeerJS : même API (Peer / connect / on / send) mais via un broker MQTT public (wss),
// qui fonctionne entre n'importe quels réseaux (pas de WebRTC, ni de NAT/TURN).
(function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const rid = () => Math.random().toString(36).slice(2, 12);
  const T = id => 'dpo/' + id;

  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] ||= []).push(f); return this; }
    emit(e, ...a) { (this._h[e] || []).slice().forEach(f => { try { f(...a); } catch (x) { console.error(x); } }); }
  }

  class Link {
    constructor(onUp, onMsg, lwt) { Object.assign(this, { onUp, onMsg, lwt, subs: [], i: 0, dead: false, up: false }); this.start(); }
    start() {
      if (this.dead) return;
      const url = BROKERS[this.i % BROKERS.length];
      const opts = { connectTimeout: 6000, reconnectPeriod: 0, keepalive: 20, clientId: 'dpo_' + rid() };
      if (this.lwt) opts.will = { topic: this.lwt.topic, payload: this.lwt.payload, retain: true, qos: 0 };
      const c = this.c = mqtt.connect(url, opts);
      let ok = false;
      c.on('connect', () => { ok = true; this.up = true; this.subs.forEach(t => c.subscribe(t)); this.onUp(); });
      c.on('message', (t, m) => { try { this.onMsg(t, JSON.parse(m.toString())); } catch (e) {} });
      c.on('error', () => {});
      c.on('close', () => {
        this.up = false;
        if (this.dead || this.c !== c) return;
        if (!ok) this.i++;
        setTimeout(() => this.start(), ok ? 1000 : 500);
      });
    }
    sub(t) { this.subs.push(t); if (this.up) this.c.subscribe(t); }
    pub(t, o, retain) { if (this.up) this.c.publish(t, JSON.stringify(o), { retain: !!retain }); }
    end() { this.dead = true; try { this.c.end(true); } catch (e) {} }
  }

  class HostConn extends Emitter {
    constructor(peer, cid) { super(); this.peer = peer; this.cid = cid; this.open = true; this.seen = Date.now(); }
    send(d) { this.peer._toClient(this, d); }
    close() { if (!this.open) return; this.open = false; this.emit('close'); this.peer._conns.delete(this.cid); }
  }

  class ClientConn extends Emitter {
    constructor(peer, hostId) {
      super();
      Object.assign(this, { peer, hostId, open: false, closed: false, lastAck: 0, tries: 0 });
      peer._link.sub(T(hostId) + '/state');
      peer._link.sub(T(hostId) + '/to/' + peer.id);
      this.timer = setInterval(() => this._tick(), 3000);
      this._hello();
    }
    _hello() { this.peer._link.pub(T(this.hostId) + '/in', { c: this.peer.id, k: 'hello' }); }
    _tick() {
      if (this.closed) return;
      const now = Date.now();
      if (!this.open) {
        if (++this.tries >= 3) { this.peer.emit('error', { type: 'peer-unavailable' }); this.tries = 0; }
        else this._hello();
      } else {
        if (now - this.lastAck > 25000) this._drop();
        else if (now - this.lastAck > 9000) this._hello();
      }
    }
    _drop() { if (this.open) { this.open = false; this.emit('close'); } }
    _in(topic, m) {
      if (this.closed) return;
      if (topic.endsWith('/state')) {
        if (m.t === 'off') { this._pend = null; return this._drop(); }
        if (this.open) this.emit('data', m); else this._pend = m;
        return;
      }
      this.lastAck = Date.now();
      if (!this.open) { this.open = true; this.tries = 0; this.emit('open'); if (this._pend) { this.emit('data', this._pend); this._pend = null; } }
      if (m.k === 'd') this.emit('data', m.d);
    }
    send(d) { this.peer._link.pub(T(this.hostId) + '/in', { c: this.peer.id, k: 'd', d }); }
    close() { this.closed = true; this.open = false; clearInterval(this.timer); }
  }

  window.Peer = class Peer extends Emitter {
    constructor(id) {
      super();
      this.host = !!id; this.id = id || rid(); this._conns = new Map(); this._last = null; this._state = null; this._first = true;
      const lwt = this.host ? { topic: T(this.id) + '/state', payload: JSON.stringify({ t: 'off' }) } : null;
      this._link = new Link(() => this._up(), (t, m) => this._msg(t, m), lwt);
      if (this.host) {
        this._link.sub(T(this.id) + '/in');
        this._gc = setInterval(() => this._conns.forEach(c => { if (Date.now() - c.seen > 45000) c.close(); }), 10000);
      }
    }
    _up() {
      if (this.host && this._state) this._link.pub(T(this.id) + '/state', this._state, true);
      if (this._first) { this._first = false; setTimeout(() => this.emit('open', this.id), 0); }
    }
    _msg(t, m) {
      if (!this.host) { this._client && this._client._in(t, m); return; }
      if (!m || !m.c) return;
      let c = this._conns.get(m.c);
      if (!c) {
        c = new HostConn(this, m.c); this._conns.set(m.c, c);
        this.emit('connection', c);
        setTimeout(() => c.emit('open'), 0);
      }
      c.seen = Date.now();
      if (m.k === 'hello') this._link.pub(T(this.id) + '/to/' + m.c, { k: 'ack' });
      else if (m.k === 'd') c.emit('data', m.d);
    }
    _toClient(c, d) {
      if (d && d.t === 'state') {
        const j = JSON.stringify(d);
        if (j !== this._last) { this._last = j; this._state = d; this._link.pub(T(this.id) + '/state', d, true); }
        return;
      }
      this._link.pub(T(this.id) + '/to/' + c.cid, { k: 'd', d });
    }
    connect(hostId) { return (this._client = new ClientConn(this, hostId)); }
    reconnect() {}
    destroy() {
      clearInterval(this._gc);
      if (this._client) this._client.close();
      if (this.host) this._link.pub(T(this.id) + '/state', { t: 'off' }, true);
      this._link.end();
    }
  };
})();
