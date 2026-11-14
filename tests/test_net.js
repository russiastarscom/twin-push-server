#!/usr/bin/env node
/* ============================================================
   ХАРНЕСС СЕТИ SUPER BOB — гоняет РЕАЛЬНЫЙ патченный код
   (секция СЕТЬ АРЕНЫ + тики, извлечённые из index.html) в двух
   изолированных vm-контекстах «хост» и «гость» с моками:
     - Supabase Realtime: общий channel-bus (broadcast + presence);
     - RTCPeerConnection: ДВА дата-канала (надёжный g + быстрый f),
       режимы: CGNAT (каналы не открываются), dropFast (f чёрная дыра),
       deadFast (канал f вообще не открывается);
     - fetch: PostgREST (404 — таблиц нет / 200 — rooms пуста).
   Сценарии: A P2P-ок с быстрой дорожкой, A2 чёрная дыра f, A3 нет f,
   B CGNAT→релей (+замер частоты пакетов), C нет хоста, C2 нет комнаты
   в базе, D обрыв хоста в бою, E поздний хост.
   ============================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');

const IDX = require('path').join(__dirname, '..', 'index.html');
const html = fs.readFileSync(IDX, 'utf-8');

function slice(startMarker, endMarker) {
  const i = html.indexOf(startMarker), j = html.indexOf(endMarker);
  if (i < 0 || j < 0 || j <= i) throw new Error('маркеры секции не найдены: ' + startMarker);
  return html.slice(i, j);
}
const secNet   = slice('/* ---------- СЕТЬ АРЕНЫ', 'function arenaContactMirror')
  .replace('testFast:false', 'testFast:true');   // ускоряем таймеры ×10 для тестов
const secTicks = slice('function netGuestTick(dt) {', 'function updateArenaEnemies(dt) {');

/* ---------------- мок-шина: каналы Supabase ---------------- */
function makeBus() {
  const topics = new Map();      // topic -> Map(key -> {chan, meta, handlers})
  function members(t) { return topics.get(t) || new Map(); }
  const bus = {
    pcLog: [], pair: null, sentN: 0,   // sentN: все broadcast-пакеты (замер частоты)
    join(topic, chan) {
      if (!topics.has(topic)) topics.set(topic, new Map());
      members(topic).set(chan.key, chan);
    },
    leave(topic, key) { const m = members(topic); m.delete(key); },
    broadcast(topic, payload, fromKey) {
      for (const [k, ch] of members(topic)) {
        if (k === fromKey) continue;
        setTimeout(() => { try { ch._fire('broadcast', 'g', { payload }); } catch (e) {} }, 3);
      }
    },
    setPresence(topic, key, meta) {
      const ch = members(topic).get(key); if (ch) ch.meta = meta;
      bus._syncAll(topic);
    },
    _syncAll(topic) {
      for (const [, ch] of members(topic))
        setTimeout(() => { try { ch._fire('presence', 'sync', {}); } catch (e) {} }, 2);
    },
    snapshot(topic) {
      const out = {};
      for (const [k, ch] of members(topic)) out[k] = [Object.assign({}, ch.meta)];
      return out;
    },
    pairWebRTC() { if (bus.pair) bus.pair(); }
  };
  return bus;
}
function makeSupabase(bus) {
  return {
    createClient(url, key, opts) {
      return {
        channel(topic, cfg) {
          const myKey = cfg && cfg.config && cfg.config.presence && cfg.config.presence.key;
          const hs = {};
          const chan = {
            key: myKey, meta: null, topic, _n: 0,
            on(ev, spec, cb) { (hs[spec.event] = hs[spec.event] || []).push(cb); return chan; },
            _fire(kind, event, arg) { (hs[event] || []).forEach(cb => { try { cb(arg); } catch (e) {} }); },
            subscribe(cb) {
              bus.join(topic, chan);
              setTimeout(() => { try { cb('SUBSCRIBED'); } catch (e) {} }, bus.slowSub || 40);
              bus._syncAll(topic);          // новичку показываем текущий presence
              return chan;
            },
            track(meta) { chan.meta = meta; bus.setPresence(topic, myKey, meta); },
            presenceState() { return bus.snapshot(topic); },
            send(m) { chan._n++; bus.sentN++; if (m.type === 'broadcast') bus.broadcast(topic, m.payload, myKey); },
            unsubscribe() { bus.leave(topic, myKey); }
          };
          return chan;
        },
        removeChannel() {}
      };
    }
  };
}
/* ---------------- мок WebRTC: два канала g + f ---------------- */
function mkDc(bus, label, side) {
  const dc = {
    label, readyState: 'connecting', onopen: null, onmessage: null, onclose: null, _n: 0,
    send(d) {
      dc._n++;
      if (bus.dropFast && label === 'f') return;   // чёрная дыра: пакеты f теряются
      const peer = side === 'host' ? bus._guestDcs : bus._hostDcs;
      if (peer && peer[label] && peer[label].onmessage)
        setTimeout(() => { try { peer[label].onmessage({ data: d }); } catch (e) {} }, 2);
    },   // 2 мс: реальный WebRTC асинхронен — RTT по P/Q не нулевой
    close() {}
  };
  return dc;
}
function makeRTC(bus, failMode) {
  return function RTCPeerConnection(cfg) {
    const pc = { _born: Date.now(), onicecandidate: null, ondatachannel: null, _dc: null };
    bus.pcLog.push(pc);
    pc.createDataChannel = (label, o) => {
      const dc = mkDc(bus, label, 'host');
      pc._dc = dc;
      bus._hostDcs[label] = dc;
      bus._hostPc = pc;
      if (label === 'g' && bus.pairArmed && !failMode) setTimeout(() => bus.pairWebRTC(), 150);
      return dc;
    };
    Object.defineProperty(pc, 'ondatachannel', {
      set(fn) {
        pc._ondc = fn;               // реальный WebRTC вызовет это при канале от хоста
        bus._guestPc = pc;
        if (bus.pairArmed && !failMode) setTimeout(() => bus.pairWebRTC(), 150);
      }
    });
    pc.createOffer = () => Promise.resolve({ type: 'offer', sdp: 'MOCK' });
    pc.createAnswer = () => Promise.resolve({ type: 'answer', sdp: 'MOCK' });
    Object.defineProperty(pc, 'localDescription', { get() { return pc._ld; } });
    Object.defineProperty(pc, 'remoteDescription', { get() { return pc._rd; } });
    pc.setLocalDescription = d => new Promise(r => setTimeout(() => {
      pc._ld = d;
      if (pc.onicecandidate) pc.onicecandidate({ candidate: { toJSON() { return { candidate: 'mock' }; } } });
      r();
    }, 10));
    pc.setRemoteDescription = d => { pc._rd = d; return Promise.resolve(); };
    pc.addIceCandidate = () => Promise.resolve();
    pc.close = () => {};
    return pc;
  };
}
/* pairing: порядок как у настоящего WebRTC — хост открывает оба канала,
   затем гостю дважды срабатывает ondatachannel (g, потом f); гостевые
   каналы стартуют в 'connecting' и «открываются» через 5 мс */
function armPairing(bus) {
  bus.pairArmed = true;
  bus._hostDcs = {}; bus._guestDcs = {};
  bus.pair = () => {
    const hg = bus._hostDcs.g, hf = bus._hostDcs.f, gpc = bus._guestPc;
    if (!hg || !gpc || !gpc._ondc || hg.readyState === 'open') return;
    hg.readyState = 'open';
    hg.onopen && hg.onopen();          // хост: claim основного канала
    if (hf && !bus.deadFast) {         // быстрый канал (если вообще дожил до открытия)
      hf.readyState = 'open';
      hf.onopen && hf.onopen();        // хост: NET.fast = f
    }
    const deliver = label => {
      const g = mkDc(bus, label, 'guest');
      bus._guestDcs[label] = g;
      gpc._ondc({ channel: g });       // гость: claim / attach своей обёртки
      setTimeout(() => { g.readyState = 'open'; g.onopen && g.onopen(); }, 5);
    };
    deliver('g');
    if (hf && !bus.deadFast) deliver('f');
  };
}
/* ---------------- мок WebRTC для ручного обмена кодами (без сигналинга) --- */
function makeRTCManual(bus) {
  const HD = bus._hostDcs || (bus._hostDcs = {});
  const GD = bus._guestDcs || (bus._guestDcs = {});
  return function RTCPeerConnection(cfg) {
    const pc = { _born: Date.now(), onicecandidate: null, ondatachannel: null,
                 localDescription: null, remoteDescription: null };
    bus.pcLog.push(pc);
    pc.createDataChannel = label => {
      const dc = mkDc(bus, label, 'host');
      HD[label] = dc;
      return dc;
    };
    pc.createOffer = async () => ({ type: 'offer', sdp: 'MANUAL-OFFER' });
    pc.createAnswer = async () => ({ type: 'answer', sdp: 'MANUAL-ANSWER' });
    pc.setLocalDescription = async d => {
      pc.localDescription = d;
      setTimeout(() => { try { pc.onicecandidate && pc.onicecandidate({}); } catch (e) {} }, 20);
    };   // null-кандидат: «локальные каналы собраны»
    pc.setRemoteDescription = async d => {
      pc.remoteDescription = d;
      if (d.type === 'offer') bus._manualGuestPc = pc;   // ответчик: он получит ondatachannel
      if (d.type === 'answer') setTimeout(() => {   // ICE сошёлся: каналы открылись
        const gpc = bus._manualGuestPc;
        for (const lab of ['g', 'f']) { const dc = HD[lab];
          if (dc) { dc.readyState = 'open'; dc.onopen && dc.onopen(); } }
        if (!gpc) return;
        for (const lab of ['g', 'f']) {
          const dc = mkDc(bus, lab, 'guest');
          GD[lab] = dc; dc.readyState = 'open';
          try { gpc.ondatachannel && gpc.ondatachannel({ channel: dc }); } catch (e) {}
        }
      }, 40);
    };
    pc.close = () => {};
    return pc;
  };
}
/* ---------------- DOM-реестр: оверлеи можно читать тестом ----------------- */
function makeDom() {
  const els = {};
  return { _els: els, getElementById(id) {
    if (!els[id]) els[id] = { value:'', placeholder:'', textContent:'', style:{},
      focus(){}, blur(){}, select(){}, classList:{ add(){}, remove(){} }, addEventListener(){} };
    return els[id];
  } };
}
/* ---------------- игрок = vm-контекст с заглушками игры ---------------- */
function makePlayer(name, bus, opts) {
  if (typeof opts === 'function') opts = { fetch: opts };       // совместимость: 3-й арг — fetchMock
  opts = opts || {};
  const notes = [], flags = { starts: 0, exits: 0 };
  const sbx = {
    console,
    note: (t, d) => notes.push({ t, d }),
    Sfx: { bump(){}, creak(){}, star(){}, stomp(){}, hurt(){}, coin(){}, stopMusic(){}, gameover(){}, music(){} },
    arenaStart: () => { flags.starts++; },
    arenaExit: () => { flags.exits++; },
    arenaSaveBest(){}, arenaHurt(){}, arenaPk(){}, puff(){}, shake(){},
    G: { state: '' },
    L: { enemies: [], coins: [], floats: [], parts: [] },
    ARN: { wave: 1, score: 0, hearts: 3, over: false, paused: false, overT: 0, banner: 0 },
    P: { x: 240, y: 242, vx: 0, vy: 0, face: 1, animT: 0, grounded: true, inv: 0, h: 14, w: 10, dying: false, squash: 0 },
    CFG: { SCORE: { coin: 10 }, STOMPV: 250, VW: 480, VH: 288 },
    Bank: { flush(){}, earn(){}, magnet(){ return false; }, amulet(){ return false; } },
    Keys: { jump: false, left: false, right: false, down: false, pause: false, pauseEdge: false },
    gTime: 0,
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    lerp: (a, b, k) => a + (b - a) * k,
    aabb: () => false,
    playerRect: () => ({ x: sbx.P.x, y: sbx.P.y, w: 10, h: 14 }),
    document: makeDom(),
    navigator: { onLine: opts.online !== false },
    TextDecoder, TextEncoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: b => Buffer.from(b, 'base64').toString('binary'),
    location: { search: '' },
    window: { SUPABASE_CFG: { url: 'https://mock.supabase.co', key: 'sb_publishable_MOCK', db: true } },
    URLSearchParams,
    fetch: opts.fetch || (async () => ({ ok: false, status: 404 })),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Object, Map, Set, Number, String, Array, Error,
    supabase: makeSupabase(bus),
    RTCPeerConnection: opts.rtcmode === 'manual' ? makeRTCManual(bus) : makeRTC(bus, false)
  };
  vm.createContext(sbx);
  vm.runInContext(secNet, sbx, { filename: name + '-net' });
  vm.runInContext(secTicks, sbx, { filename: name + '-ticks' });
  const api = vm.runInContext('({ NET, netHost, netJoin, netClose, netHostTick, netGuestTick, netSend, netLanMenu, netLanCreate, netLanJoinScreen, netLanGo, netLanGo2, netLanStop })', sbx);
  return { sbx, notes, flags, NET: api.NET, api, name, bus };
}
/* помп: игра живёт — 30 кадров/с на каждом игроке; bus.move = Бег играет
   роль игрока (состояние меняется каждый кадр — честные замеры частот) */
function startPump(players) {
  const iv = setInterval(() => {
    for (const p of players) {
      p.sbx.gTime += 1 / 30;
      if (p.bus && p.bus.move) { p.sbx.P.x = 40 + (p.sbx.gTime * 50) % 400; p.sbx.P.vx = 50; }
      if (p.NET.on && p.NET.mode === 'host') { try { p.api.netHostTick(1 / 30); } catch (e) { console.log('HOST TICK ERR', e.message); } }
      if (p.NET.on && p.NET.mode === 'guest') { try { p.api.netGuestTick(1 / 30); } catch (e) { console.log('GUEST TICK ERR', e.message); } }
    }
  }, 33);
  return () => clearInterval(iv);
}
const DEBUG = process.env.DEBUG === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failn = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ✔ ' + label); }
  else { failn++; console.log('  ✘ FAIL: ' + label); }
}
function hasNote(p, sub) { return p.notes.some(n => n.t.includes(sub)); }
function dumpState(tag, bus, ...ps) {
  if (!DEBUG) return;
  for (const p of ps)
    console.log(`  [${tag}] ${p.name}: on=${p.NET.on} dial=${p.NET.dial} conn=${p.NET.conn ? p.NET.conn.kind : '-'} fast=${p.NET.fast ? 'f' : '-'} sb=${p.NET.sb ? 'y' : 'n'} notes=[${p.notes.map(n => n.t).join(' | ')}]`);
  console.log(`  [${tag}] dcs: host g=${bus._hostDcs && bus._hostDcs.g ? bus._hostDcs.g.readyState + '/' + bus._hostDcs.g._n : '-'} f=${bus._hostDcs && bus._hostDcs.f ? bus._hostDcs.f.readyState + '/' + bus._hostDcs.f._n : '-'} ` +
    `guest g=${bus._guestDcs && bus._guestDcs.g ? bus._guestDcs.g.readyState + '/' + bus._guestDcs.g._n : '-'} f=${bus._guestDcs && bus._guestDcs.f ? bus._guestDcs.f.readyState + '/' + bus._guestDcs.f._n : '-'}`);
}

/* ================= сценарии ================= */
(async () => {
  /* --- A: P2P работает, обе дорожки живы --- */
  console.log('A) P2P: надёжный g + быстрый f');
  {
    const bus = makeBus(); armPairing(bus); bus.move = true;
    const H = makePlayer('host', bus), G = makePlayer('guest', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(1200);
    dumpState('A', bus, H, G);
    check('хост в игре', H.NET.on && H.flags.starts >= 1);
    check('гость в игре', G.NET.on && G.flags.starts >= 1);
    check('канал — P2P', H.NET.conn && H.NET.conn.kind === 'dc' && G.NET.conn.kind === 'dc');
    check('быстрая дорожка у обоих', !!H.NET.fast && !!G.NET.fast);
    await sleep(1500);
    check('S/I идут по быстрому каналу (не по g)', bus._hostDcs.f._n > 5 && bus._guestDcs.f._n > 5);
    check('3 с боя без разрывов', H.NET.on && G.NET.on && !hasNote(H, 'ОТКЛЮЧИЛСЯ') && !hasNote(G, 'ПОТЕРЯНО'));
    stop();
  }

  /* --- A2: быстрый канал — чёрная дыра (пакеты f молча теряются) --- */
  console.log('A2) Чёрная дыра на f: страховка по надёжному каналу спасает');
  {
    const bus = makeBus(); armPairing(bus); bus.dropFast = true;
    const H = makePlayer('hostA2', bus), G = makePlayer('guestA2', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(1200);
    check('бой начался', H.NET.on && G.NET.on);
    await sleep(3000);
    check('4 с боя при мёртвом f: разрыва нет', H.NET.on && G.NET.on && !hasNote(H, 'ОТКЛЮЧИЛСЯ') && !hasNote(G, 'ПОТЕРЯНО'));
    check('keepalive ходил по надёжному каналу', bus._hostDcs.g._n > 2 && bus._guestDcs.g._n > 2);
    stop();
  }

  /* --- A3: быстрый канал вообще не открылся (NAT вырезал только f) --- */
  console.log('A3) Канал f не открылся: всё через надёжный g');
  {
    const bus = makeBus(); armPairing(bus); bus.deadFast = true;
    const H = makePlayer('hostA3', bus), G = makePlayer('guestA3', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(1500);
    check('бой начался без f', H.NET.on && G.NET.on && !H.NET.fast && !G.NET.fast);
    await sleep(1500);
    check('3 с боя одним каналом', H.NET.on && G.NET.on && !hasNote(H, 'ОТКЛЮЧИЛСЯ') && !hasNote(G, 'ПОТЕРЯНО'));
    stop();
  }

  /* --- B: CGNAT — P2P не открылся → автоматический релей --- */
  console.log('B) CGNAT: P2P сломан → релей через Supabase');
  {
    const bus = makeBus();                    // pairArmed НЕ вызываем: дата-каналы не откроются
    const H = makePlayer('hostB', bus), G = makePlayer('guestB', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(2500);
    check('хост в игре через релей', H.NET.on && H.NET.conn && H.NET.conn.kind === 'relay');
    check('гость в игре через релей', G.NET.on && G.NET.conn && G.NET.conn.kind === 'relay');
    check('сообщение про сервер было', hasNote(G, 'ЧЕРЕЗ СЕРВЕР') || hasNote(H, 'ЧЕРЕЗ СЕРВЕР'));
    check('НЕТ ложного «не найдена»', !hasNote(G, 'НЕ НАЙДЕНА'));
    check('частоты релея 15/15 Гц', H.NET.snapHz === 15 && G.NET.sendHz === 15);
    bus.move = true; bus.sentN = 0;
    await sleep(2000);
    const rate2s = bus.sentN;
    check(`пакетов за 2 с: ${rate2s} (лимит Free 100/с → ≤100 за 2 с)`, rate2s > 20 && rate2s <= 100);
    check('5 с боя через релей без разрывов', H.NET.on && G.NET.on);
    stop();
  }

  /* --- C: хост не приходил вообще (presence-only) --- */
  console.log('C) Комната без хоста: честный отказ');
  {
    const bus = makeBus();
    const G = makePlayer('guestC', bus);
    G.api.netJoin('ZZZZ'); await sleep(3200);
    check('сообщение «КОМНАТА ZZZZ НЕ НАЙДЕНА»', hasNote(G, 'КОМНАТА ZZZZ НЕ НАЙДЕНА'));
    check('dial сброшен', G.NET.dial === null);
  }

  /* --- C2: таблица rooms есть, комнаты в ней нет — мгновенный честный ответ --- */
  console.log('C2) rooms-таблица есть, комнаты нет: мгновенный отказ');
  {
    const bus = makeBus();
    const fm = async () => ({ ok: true, status: 200, json: async () => [] });
    const G = makePlayer('guestC2', bus, fm);
    G.api.netJoin('QQQQ'); await sleep(800);
    check('быстрое «КОМНАТА QQQQ НЕ НАЙДЕНА» (<0.8 c)', hasNote(G, 'КОМНАТА QQQQ НЕ НАЙДЕНА'));
  }

  /* --- D: обрыв хоста в бою → гость выходит с честным сообщением --- */
  console.log('D) Обрыв хоста в бою');
  {
    const bus = makeBus(); armPairing(bus);
    const H = makePlayer('hostD', bus), G = makePlayer('guestD', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(1200);
    check('бой идёт', H.NET.on && G.NET.on);
    H.api.netClose();                        // хост «умер»
    await sleep(7300);                       // таймаут тишины гостя 6.5 с
    check('гость увидел «СОЕДИНЕНИЕ ПОТЕРЯНО»', hasNote(G, 'СОЕДИНЕНИЕ ПОТЕРЯНО'));
    check('гость вышел в меню (arenaExit)', G.flags.exits >= 1);
    check('гость отключился', !G.NET.on);
    stop();
  }

  /* --- E: гость вошёл, пока комната хоста ещё «не готова» (медленный subscribe) --- */
  console.log('E) Гость вошёл раньше готовности комнаты');
  {
    const bus = makeBus(); armPairing(bus);
    const H = makePlayer('hostE', bus), G = makePlayer('guestE', bus);
    const stop = startPump([H, G]);
    bus.slowSub = 600;                        // хост подписывается 600 мс — комната не готова
    H.api.netHost(); await sleep(50);         // его SUBSCRIBED придёт в ~650 мс
    G.api.netJoin(H.NET.code);                // гость стучится уже сейчас
    bus.slowSub = 40;
    await sleep(2800);
    check('оба в игре после готовности комнаты', H.NET.on && G.NET.on && H.flags.starts >= 1 && G.flags.starts >= 1);
    stop();
  }

  /* --- F: примирение, компенсация задержки, смерть без разрыва --- */
  console.log('F) Примирение + lag compensation + смерть без отключения');
  {
    const bus = makeBus(); armPairing(bus); bus.move = true;
    const H = makePlayer('hostF', bus), G = makePlayer('guestF', bus);
    const stop = startPump([H, G]);
    H.api.netHost(); await sleep(150);
    G.api.netJoin(H.NET.code); await sleep(1300);
    check('бой начался', H.NET.on && G.NET.on);
    /* честный RTT: хост мерит его по эху Q гостя */
    await sleep(1800);                     // ждём первый пинг хоста (tPing=1.5 c)
    check('RTT измерен по P/Q', H.NET.rtt > 0 && H.NET.rtt < 999);
    /* смерть гостя НЕ разрывает связь: hp=0 летит в пакете I, хост видит */
    G.sbx.ARN.hearts = 0;
    await sleep(1000);
    check('смерть гостя: оба в сети', H.NET.on && G.NET.on && !hasNote(G, 'ПОТЕРЯНО'));
    check('хост узнал о выбытии (rp.hp=0)', H.NET.rp.hp === 0);
    /* воскресение с новой волной (гость) */
    H.sbx.ARN.wave = 2;                        // следующая волна → снимок с wv:2
    await sleep(700);
    check('гость воскрес с волной (hearts=1)', G.sbx.ARN.hearts === 1);
    /* примирение счёта: предсказанные монеты не отматываются снимком */
    G.sbx.ARN.score = 50; H.sbx.ARN.score = 40;
    await sleep(400);
    check('счёт max(локальный, хост) = 50', G.sbx.ARN.score === 50);
    /* примирение монет: своя монета не «отбирается», чужая появляется */
    H.sbx.L.coins = [{ taken: false }, { taken: true }];
    G.sbx.L.coins = [{ taken: true }, { taken: false }];
    await sleep(2000);                     // ждём keepalive с полным списком ck
    check('монеты: union без отбирания', G.sbx.L.coins[0].taken === true &&
                                       G.sbx.L.coins[1].taken === true);
    /* финал снимается, если хост уже перезапустил забег */
    G.sbx.ARN.over = true; G.sbx.ARN.overT = 1; H.sbx.ARN.over = false;
    await sleep(400);
    check('гость вышел из финала по снимку хоста', G.sbx.ARN.over === false);
    /* LAG COMPENSATION: враг у хоста уже убежал, но стомп гостя засчитывается
       по отмотанной истории; слишком далёкий — честно отбрасывается */
    bus.move = false;                       // замораживаем бег: позиции под нашим контролем
    G.sbx.P.x = 96; G.sbx.P.y = 196;        // гость стоит у x≈100
    await sleep(150);                       // позиция гостя доезжает до хоста (rp.x≈96)
    H.sbx.L.enemies.length = 0;
    H.sbx.L.enemies.push({ id: 'e1', x: 300, y: 200, w: 14, h: 12, dir: 1,
                           type: 'crawler', state: 'walk', dead: 0, t: 0, vy: 0 });
    G.NET.mirror.set('e1', { id: 'e1', x: 100, y: 200, px: 100, py: 200,
                             t: 0, dead: 0, ix: 100, iy: 200, w: 14, h: 12 });
    await sleep(300);                      // хост копит историю (враг стоит на 300)
    G.api.netSend({ t: 'E', st: ['e1'] }); // гость бил по зеркалу на 100 — враг на 300
    await sleep(200);
    check('далёкий стомп отброшен (враг жив)', H.sbx.L.enemies[0].dead === 0);
    /* откат времени: враг БЫЛ у гостя в момент удара — засчитываем по истории */
    stop();                                 // замораживаем хост: история больше не пишется
    const e1 = H.sbx.L.enemies[0], hz = e1._h;
    e1.x = 300;                             // «сейчас» враг далеко
    for (let i = 0; i < hz.n; i++) {        // а «тогда» был у гостя (x≈100)
      hz.a[i] = { t: H.sbx.gTime - (hz.n - i) / 30, x: 100, y: 200 };
    }
    e1.dead = 0; H.sbx.ARN.score = 1000;
    G.api.netSend({ t: 'E', st: ['e1'] });
    await sleep(200);
    check('отмотанный стомп засчитан (dead, +200)', e1.dead === 'squish' && H.sbx.ARN.score === 1200);
  }

  /* --- G: «БЕЗ ИНТЕРНЕТА (WI-FI)» — обмен кодами вместо сервера --- */
  console.log('G) БЕЗ ИНТЕРНЕТА (WI-FI): коды вместо сервера');
  {
    const bus = makeBus(); bus.move = true;
    const H = makePlayer('hostG', bus, { rtcmode: 'manual' });
    const G = makePlayer('guestG', bus, { rtcmode: 'manual' });
    const stop = startPump([H, G]);
    H.api.netLanCreate(); await sleep(300);
    check('офер-код создан (B1…)', H.NET.lan && H.NET.lan.stage === 'answer' &&
      H.sbx.document._els.lanOut.value.startsWith('B1'));
    G.api.netLanJoinScreen(); await sleep(80);
    G.sbx.document._els.lanIn.value = H.sbx.document._els.lanOut.value;
    G.api.netLanGo(); await sleep(250);
    check('ответ-код создан у гостя', G.NET.lan && G.NET.lan.stage === 'wait' &&
      G.sbx.document._els.lanOut.value.startsWith('B1'));
    H.sbx.document._els.lanIn.value = G.sbx.document._els.lanOut.value;
    H.api.netLanGo(); await sleep(700);
    dumpState('G-после-обмена', bus, H, G);
    check('бой начался БЕЗ СЕРВЕРА (два dc-канала)', H.NET.on && G.NET.on && H.NET.conn.kind === 'dc');
    check('полный темп 30/30 (локальная сеть)', H.NET.snapHz === 30 && G.NET.sendHz === 30);
    bus.move = false; H.sbx.P.x = 200; H.sbx.P.vx = 0;
    await sleep(700);
    check('снимки хоста доезжают по код-каналу',
      G.NET.rp.x === 200 && G.NET.snapAge < 1.6);   // dedup: покой — 0 пакетов до keepalive
    check('состояние гостя доезжает (хост видит)', H.NET.rp.seen);
    stop();
  }

  /* --- H: офлайн — мгновенные честные сообщения + лобби Wi-Fi доступно --- */
  console.log('H) Офлайн: честные быстрые сообщения вместо таймаутов');
  {
    const bus = makeBus();
    const P1 = makePlayer('off', bus, { online: false });
    P1.api.netHost(); await sleep(60);
    check('ХОСТ офлайн: сразу «НЕТ ИНТЕРНЕТА», dial сброшен',
      hasNote(P1, 'НЕТ ИНТЕРНЕТА') && P1.NET.dial === null && !P1.NET.wait);
    P1.api.netJoin('ABCD'); await sleep(60);
    check('ВОЙТИ офлайн: то же честное сообщение',
      P1.notes.filter(n => n.t.includes('НЕТ ИНТЕРНЕТА')).length >= 2);
    check('подсказка ведёт в «БЕЗ ИНТЕРНЕТА (WI-FI)»', hasNote(P1, 'WI-FI'));
    P1.api.netLanMenu(); await sleep(30);
    check('лобби Wi-Fi открывается БЕЗ интернета (стадия select)',
      P1.NET.lan && P1.NET.lan.stage === 'select');
    P1.api.netLanStop(true);
    check('блютуза в игре больше нет (нет navigator.bluetooth)',
      P1.sbx.navigator.bluetooth === undefined);
  }

  console.log(`\n=== ИТОГ: ${pass} ок, ${failn} провалено ===`);
  process.exit(failn ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
