// ════════════════════════════════════════════════════════════
//  Twin — Push Server v2  (подписки в Firebase, авто-push)
//
//  Переменные окружения на Railway (Settings → Variables):
//    VAPID_PUBLIC_KEY   = BHWhY-ozjg5GkVLxFhhG_VEtj198PkvEjRtTDSfOMtNKGr1RpX_ELO9YAQChg7E0gLIrERJW0LzolDkkD0RBzbM
//    VAPID_PRIVATE_KEY  = Qr_85qQc_uWO8xT8nJ9g7Zx7v5_SoKC2180HH6IuuzI
//    VAPID_EMAIL        = mailto:admin@twin.app
//    FIREBASE_DB_URL    = https://ukraine-52ad4-default-rtdb.firebaseio.com
// ════════════════════════════════════════════════════════════

const express    = require('express');
const webpush    = require('web-push');
const bodyParser = require('body-parser');
const cors       = require('cors');
const https      = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ── VAPID ────────────────────────────────────────────────
webpush.setVapidDetails(
    process.env.VAPID_EMAIL       || 'mailto:admin@twin.app',
    process.env.VAPID_PUBLIC_KEY  || 'BHWhY-ozjg5GkVLxFhhG_VEtj198PkvEjRtTDSfOMtNKGr1RpX_ELO9YAQChg7E0gLIrERJW0LzolDkkD0RBzbM',
    process.env.VAPID_PRIVATE_KEY || 'Qr_85qQc_uWO8xT8nJ9g7Zx7v5_SoKC2180HH6IuuzI'
);

const DB = process.env.FIREBASE_DB_URL || 'https://ukraine-52ad4-default-rtdb.firebaseio.com';

// ── Firebase REST ────────────────────────────────────────
function fbGet(path) {
    return new Promise((resolve, reject) => {
        https.get(`${DB}${path}.json`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
        }).on('error', e => { console.error('[FB GET]', e.message); resolve(null); });
    });
}

function fbPut(path, value) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(value);
        const u    = new URL(`${DB}${path}.json`);
        const req  = https.request({
            hostname: u.hostname, path: u.pathname,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve()); });
        req.on('error', e => { console.error('[FB PUT]', e.message); resolve(); });
        req.write(body); req.end();
    });
}

function encodeUser(userId) {
    return encodeURIComponent(userId).replace(/\./g, '%2E');
}

// ── Подписки в Firebase ──────────────────────────────────
async function getSubs(userId) {
    const data = await fbGet(`/push_subscriptions/${encodeUser(userId)}`);
    if (!data) return [];
    if (Array.isArray(data)) return data.filter(Boolean);
    return Object.values(data).filter(s => s && s.endpoint);
}

async function saveSubs(userId, subs) {
    await fbPut(`/push_subscriptions/${encodeUser(userId)}`, subs);
}

// ── Отправка push ────────────────────────────────────────
async function pushTo(userId, opts) {
    const subs = await getSubs(userId);
    if (!subs.length) { console.log(`[Push] Нет подписок: ${userId}`); return { sent:0, total:0 }; }

    const payload = JSON.stringify({
        title: opts.title || 'Twin',
        body:  opts.body  || 'Новое сообщение',
        icon:  'https://russiastarscom.github.io/partner/icon-192x192.png',
        badge: 'https://russiastarscom.github.io/partner/icon-192x192.png',
        tag:   opts.tag   || 'twin-msg',
        url:   opts.url   || 'https://russiastarscom.github.io/partner/index.html'
    });

    const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));

    const valid = subs.filter((_, i) => {
        const r = results[i];
        if (r.status === 'rejected' && [404,410].includes(r.reason?.statusCode)) {
            console.log(`[Push] Удалена протухшая подписка ${userId}`);
            return false;
        }
        return true;
    });
    if (valid.length !== subs.length) await saveSubs(userId, valid);

    const sent = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[Push] ✓ ${userId}: ${sent}/${subs.length}`);
    return { sent, total: subs.length };
}

// ════════════════════════════════════════════════════════════
//  Firebase Listener — опрос каждые 3 сек
// ════════════════════════════════════════════════════════════
const lastTs  = new Map(); // `userId:chatId` → timestamp
const sentIds = new Set(); // messageId уже отправленных push

async function initTimestamps() {
    console.log('[Listener] Инициализация...');
    try {
        const allSubs = await fbGet('/push_subscriptions');
        if (!allSubs) return;
        const users = Object.keys(allSubs).map(k => decodeURIComponent(k.replace(/%2E/gi,'.')));
        const messages = await fbGet('/messages');
        const now = Date.now();
        for (const u of users) {
            if (messages) {
                for (const chatId of Object.keys(messages)) {
                    lastTs.set(`${u}:${chatId}`, now);
                    // Запоминаем ID всех существующих сообщений
                    const msgs = messages[chatId];
                    if (msgs) Object.keys(msgs).forEach(id => sentIds.add(id));
                }
            }
        }
        console.log(`[Listener] Готов. Пользователей: ${users.length}`);
    } catch(e) { console.error('[Listener] init error:', e.message); }
}

async function poll() {
    try {
        const allSubs = await fbGet('/push_subscriptions');
        if (!allSubs) return;
        const users = Object.keys(allSubs).map(k => decodeURIComponent(k.replace(/%2E/gi,'.')));

        const messages  = await fbGet('/messages');
        const groups    = await fbGet('/groups');
        const channels  = await fbGet('/channels');
        const now       = Date.now();

        for (const userId of users) {
            if (!messages) continue;
            for (const [chatId, chatMsgs] of Object.entries(messages)) {
                if (!chatMsgs) continue;
                const msgMap = typeof chatMsgs === 'object' ? chatMsgs : {};
                for (const [msgId, msg] of Object.entries(msgMap)) {
                    if (!msg || !msg.timestamp) continue;
                    if (sentIds.has(msgId)) continue;              // уже обработали
                    if (msg.sender === userId) continue;           // своё сообщение
                    if (msg.timestamp < now - 30000) {             // старше 30 сек — пропуск
                        sentIds.add(msgId);
                        continue;
                    }

                    const text      = msg.text || 'Новое сообщение';
                    const shortText = text.length > 100 ? text.slice(0,100)+'…' : text;
                    let   notify    = false;
                    let   title, tag;

                    const isPrivate = !chatId.startsWith('group_') && !chatId.startsWith('channel_');
                    const isGroup   = chatId.startsWith('group_');
                    const isChan    = chatId.startsWith('channel_');

                    if (isPrivate && chatId.includes(userId)) {
                        // Личный чат
                        notify = true;
                        title  = `💬 ${msg.sender}`;
                        tag    = `msg-${msg.sender}`;

                    } else if (isGroup && groups && groups[chatId]) {
                        const g = groups[chatId];
                        if (g.participants && g.participants.includes(userId)) {
                            notify = true;
                            title  = `👥 ${g.name || 'Группа'}`;
                            tag    = `group-${chatId}`;
                            title  = `👥 ${g.name || 'Группа'}`;
                            shortText && (title = `👥 ${g.name || 'Группа'}`);
                        }

                    } else if (isChan && channels && channels[chatId]) {
                        const ch = channels[chatId];
                        if (ch.subscribers && ch.subscribers.includes(userId)) {
                            notify = true;
                            title  = `📢 ${ch.name || 'Канал'}`;
                            tag    = `channel-${chatId}`;
                        }
                    }

                    if (notify) {
                        sentIds.add(msgId);
                        const body = isGroup
                            ? `${msg.sender}: ${shortText}`
                            : shortText;
                        await pushTo(userId, { title, body, tag });
                    }
                }
            }

            // Уведомления: group_invite
            const notifs = await fbGet(`/users/${encodeUser(userId)}/notifications`);
            if (notifs) {
                for (const [nid, n] of Object.entries(notifs)) {
                    const key = `notif:${userId}:${nid}`;
                    if (sentIds.has(key)) continue;
                    if (n.read) { sentIds.add(key); continue; }
                    if (!n.timestamp || now - n.timestamp > 30000) { sentIds.add(key); continue; }
                    sentIds.add(key);
                    if (n.type === 'group_invite') {
                        await pushTo(userId, {
                            title: '👥 Вас добавили в группу',
                            body:  `${n.from} добавил вас в «${n.groupName}»`,
                            tag:   `group-invite-${nid}`
                        });
                    }
                }
            }
        }

        // Чистим sentIds если слишком вырос
        if (sentIds.size > 50000) {
            const arr = [...sentIds];
            arr.slice(0, 25000).forEach(k => sentIds.delete(k));
        }

    } catch(e) { console.error('[Poll] error:', e.message); }
}

// ════════════════════════════════════════════════════════════
//  HTTP API
// ════════════════════════════════════════════════════════════

app.post('/subscribe', async (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription?.endpoint)
        return res.status(400).json({ error: 'userId и subscription обязательны' });

    const subs   = await getSubs(userId);
    const exists = subs.some(s => s.endpoint === subscription.endpoint);
    if (!exists) { subs.push(subscription); await saveSubs(userId, subs); }

    // Инициализируем метки для нового юзера
    const messages = await fbGet('/messages');
    if (messages) {
        const now = Date.now();
        Object.keys(messages).forEach(chatId => {
            const key = `${userId}:${chatId}`;
            if (!lastTs.has(key)) lastTs.set(key, now);
            // Помечаем все существующие сообщения как "уже виденные"
            Object.keys(messages[chatId] || {}).forEach(id => sentIds.add(id));
        });
    }

    console.log(`[Server] ✓ Подписка сохранена (Firebase): ${userId}`);
    res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
    const { userId, endpoint } = req.body;
    if (!userId || !endpoint) return res.status(400).json({ error: 'Нужны userId и endpoint' });
    const subs = await getSubs(userId);
    await saveSubs(userId, subs.filter(s => s.endpoint !== endpoint));
    console.log(`[Server] Отписка: ${userId}`);
    res.json({ ok: true });
});

app.post('/send', async (req, res) => {
    const { userId, title, body, url, tag, icon } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId обязателен' });
    const result = await pushTo(userId, { title, body, url, tag, icon });
    res.json({ ok: true, ...result });
});

app.get('/health', async (req, res) => {
    const subs = await fbGet('/push_subscriptions');
    res.json({ status:'ok', users: subs ? Object.keys(subs).length : 0, uptime: Math.floor(process.uptime()), sentIds: sentIds.size });
});

// ── Старт ────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`[Server] Twin Push Server v2 — порт ${PORT}`);
    await initTimestamps();
    setInterval(poll, 3000);
    console.log('[Server] ✓ Polling Firebase каждые 3 сек');
});
