// ════════════════════════════════════════════════════════════
//  Twin — Push Server v2 (ИСПРАВЛЕННАЯ ВЕРСИЯ)
//  Исправления:
//  1. TTL подписок — удаляем старые неактивные подписки
//  2. Логирование VAPID ключа при старте для диагностики
//  3. Endpoint /debug для быстрой проверки состояния
// ════════════════════════════════════════════════════════════

const express    = require('express');
const webpush    = require('web-push');
const bodyParser = require('body-parser');
const cors       = require('cors');
const fs         = require('fs');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json({ limit: '10mb' }));

// ── VAPID ────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BANapkW0GhUBLNbQBvsZbHBdcjGm_kVIifEYNBsivgzSkYztpF37z1Ij7YvX3s03J-6RRvNE-PvZ5K2JJVfS_vQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'lMV3yjtcsVZ_ZNwq4XzjirmJIMCht3xWtCGGPA0zkXU';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@twin.app';

try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    // ⚠️ ИСПРАВЛЕНО: логируем ключ при старте — легко проверить совпадение с push-init.js
    console.log('[Server] VAPID настроен. Публичный ключ:');
    console.log('[Server]', VAPID_PUBLIC);
} catch (error) {
    console.error('[Server] Ошибка настройки VAPID:', error.message);
    console.error('[Server] Сгенерируйте новую пару: npx web-push generate-vapid-keys');
}

// ── Хранилище подписок ───────────────────────────────────
// ⚠️ ИСПРАВЛЕНО: Railway сбрасывает /tmp при рестарте.
// Используем переменную окружения для пути к БД или /tmp как fallback.
const DB_FILE        = process.env.DB_PATH || '/tmp/subscriptions.json';
const DB_BACKUP_FILE = DB_FILE + '.backup';

// TTL: удаляем подписки старше 90 дней (они всё равно невалидны)
const SUB_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function loadSubscriptions() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            if (!data.trim()) return new Map();

            const parsed = JSON.parse(data);
            const map = new Map();
            const now = Date.now();

            for (const [k, v] of Object.entries(parsed)) {
                if (Array.isArray(v)) {
                    const validSubs = v.filter(sub => {
                        if (!sub || !sub.endpoint) return false;
                        // Удаляем очень старые подписки
                        if (sub.createdAt && (now - sub.createdAt) > SUB_TTL_MS) return false;
                        return true;
                    });
                    if (validSubs.length > 0) map.set(k, validSubs);
                }
            }

            console.log(`[Server] Загружено подписок: ${map.size} пользователей`);
            return map;
        }
    } catch (e) {
        console.error('[Server] Ошибка загрузки подписок:', e.message);
        try {
            if (fs.existsSync(DB_BACKUP_FILE)) {
                const backupData = JSON.parse(fs.readFileSync(DB_BACKUP_FILE, 'utf8'));
                const map = new Map(Object.entries(backupData));
                console.log(`[Server] Восстановлено из бэкапа: ${map.size} пользователей`);
                return map;
            }
        } catch (backupErr) {
            console.error('[Server] Ошибка восстановления из бэкапа:', backupErr.message);
        }
    }
    return new Map();
}

function saveSubscriptions(map) {
    try {
        const obj = {};
        for (const [k, v] of map.entries()) {
            if (v && v.length > 0) obj[k] = v;
        }
        const data = JSON.stringify(obj, null, 2);

        if (fs.existsSync(DB_FILE)) {
            fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
        }

        fs.writeFileSync(DB_FILE, data, 'utf8');
    } catch (e) {
        console.error('[Server] Ошибка сохранения подписок:', e.message);
    }
}

let subscriptions = loadSubscriptions();

// Автосохранение каждые 5 минут
setInterval(() => {
    if (subscriptions.size > 0) saveSubscriptions(subscriptions);
}, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════════
//  API endpoints
// ════════════════════════════════════════════════════════════

// GET /vapidPublicKey
app.get('/vapidPublicKey', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC });
});

// POST /subscribe
app.post('/subscribe', (req, res) => {
    try {
        const { userId, subscription } = req.body;

        if (!userId || typeof userId !== 'string' || !userId.trim()) {
            return res.status(400).json({ error: 'userId обязателен' });
        }
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ error: 'subscription.endpoint обязателен' });
        }
        if (!subscription.keys || !subscription.keys.auth || !subscription.keys.p256dh) {
            return res.status(400).json({ error: 'subscription.keys.auth и p256dh обязательны' });
        }

        const uid = userId.trim();

        if (!subscriptions.has(uid)) subscriptions.set(uid, []);

        const subs = subscriptions.get(uid);
        const exists = subs.some(s => s.endpoint === subscription.endpoint);

        if (!exists) {
            subs.push({
                endpoint:  subscription.endpoint,
                keys:      { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh },
                createdAt: Date.now()  // ⚠️ ИСПРАВЛЕНО: сохраняем время для TTL
            });
            saveSubscriptions(subscriptions);
            console.log(`[Server] /subscribe: ${uid} — новая подписка (всего: ${subs.length})`);
        } else {
            console.log(`[Server] /subscribe: ${uid} — подписка уже существует`);
        }

        res.json({ ok: true, totalSubscriptions: subs.length });
    } catch (error) {
        console.error('[Server] Ошибка в /subscribe:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// POST /unsubscribe
app.post('/unsubscribe', (req, res) => {
    try {
        const { userId, endpoint } = req.body;

        if (!userId || !endpoint) {
            return res.status(400).json({ error: 'userId и endpoint обязательны' });
        }

        if (subscriptions.has(userId)) {
            const filtered = subscriptions.get(userId).filter(s => s.endpoint !== endpoint);
            if (filtered.length === 0) {
                subscriptions.delete(userId);
            } else {
                subscriptions.set(userId, filtered);
            }
            saveSubscriptions(subscriptions);
            console.log(`[Server] /unsubscribe: ${userId}`);
        }

        res.json({ ok: true });
    } catch (error) {
        console.error('[Server] Ошибка в /unsubscribe:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// POST /send
app.post('/send', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId || typeof userId !== 'string' || !userId.trim()) {
            return res.status(400).json({ error: 'userId обязателен' });
        }

        const uid = userId.trim();

        const src = (req.body.payload && typeof req.body.payload === 'object')
            ? req.body.payload
            : req.body;

        const payloadObj = {
            title:     (src.title  || 'Twin').substring(0, 100),
            body:      (src.body   || 'Новое сообщение').substring(0, 200),
            icon:      src.icon  || 'https://russiastarscom.github.io/partner/icon-192x192.png',
            badge:     src.badge || 'https://russiastarscom.github.io/partner/icon-192x192.png',
            tag:       (src.tag  || 'twin-msg').substring(0, 50),
            url:       src.url   || 'https://russiastarscom.github.io/partner/index.html',
            timestamp: Date.now()
        };

        // Проверяем URL
        try { new URL(payloadObj.url); } catch {
            payloadObj.url = 'https://russiastarscom.github.io/partner/index.html';
        }

        const payloadStr = JSON.stringify(payloadObj);

        const subs = subscriptions.get(uid) || [];

        if (subs.length === 0) {
            console.log(`[Server] /send: нет подписок для ${uid}`);
            return res.json({ ok: true, sent: 0, total: 0, message: 'Нет активных подписок' });
        }

        console.log(`[Server] /send → ${uid}, подписок: ${subs.length}`);

        const sendPromises = subs.map(sub =>
            Promise.race([
                webpush.sendNotification(sub, payloadStr),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ])
        );

        const results = await Promise.allSettled(sendPromises);

        let sentCount = 0;
        let changed   = false;
        const validSubs = [];

        results.forEach((result, i) => {
            const sub = subs[i];
            if (result.status === 'fulfilled') {
                validSubs.push(sub);
                sentCount++;
            } else {
                const statusCode = result.reason?.statusCode;
                if (statusCode === 404 || statusCode === 410 || result.reason?.message === 'Timeout') {
                    console.log(`[Server] Удалена невалидная подписка ${uid}: ${statusCode || result.reason?.message}`);
                    changed = true;
                } else {
                    console.warn(`[Server] Push ошибка ${uid}:`, result.reason?.message);
                    validSubs.push(sub); // временная ошибка, оставляем
                }
            }
        });

        if (changed) {
            if (validSubs.length === 0) {
                subscriptions.delete(uid);
            } else {
                subscriptions.set(uid, validSubs);
            }
            saveSubscriptions(subscriptions);
        }

        console.log(`[Server] ✓ Отправлено ${sentCount}/${subs.length} для ${uid}`);
        res.json({ ok: true, sent: sentCount, total: subs.length });

    } catch (error) {
        console.error('[Server] Ошибка в /send:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// DELETE /subscriptions/:userId
app.delete('/subscriptions/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        if (subscriptions.has(userId)) {
            subscriptions.delete(userId);
            saveSubscriptions(subscriptions);
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('[Server] Ошибка в DELETE /subscriptions:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// GET /subscriptions/:userId
app.get('/subscriptions/:userId', (req, res) => {
    const subs = subscriptions.get(req.params.userId) || [];
    res.json({
        userId: req.params.userId,
        count: subs.length,
        subscriptions: subs.map(s => ({ endpoint: s.endpoint, createdAt: s.createdAt }))
    });
});

// ⚠️ НОВОЕ: GET /debug — быстрая диагностика
app.get('/debug', (req, res) => {
    const total = [...subscriptions.values()].reduce((s, a) => s + a.length, 0);
    res.json({
        vapidPublicKey: VAPID_PUBLIC,
        users: subscriptions.size,
        totalSubscriptions: total,
        userList: [...subscriptions.keys()].map(uid => ({
            uid,
            subs: subscriptions.get(uid).length
        })),
        uptime: Math.round(process.uptime()),
        dbFile: DB_FILE,
        dbExists: fs.existsSync(DB_FILE)
    });
});

// GET /health
app.get('/health', (req, res) => {
    const total = [...subscriptions.values()].reduce((s, a) => s + a.length, 0);
    res.json({
        status: 'ok',
        users: subscriptions.size,
        subscriptions: total,
        uptime: Math.round(process.uptime()),
        vapidConfigured: !!(VAPID_PUBLIC && VAPID_PRIVATE),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// GET /
app.get('/', (req, res) => {
    res.json({
        name: 'Twin Push Server v2',
        endpoints: {
            health:             'GET /health',
            debug:              'GET /debug',
            vapidPublicKey:     'GET /vapidPublicKey',
            subscribe:          'POST /subscribe',
            unsubscribe:        'POST /unsubscribe',
            send:               'POST /send',
            subscriptions:      'GET /subscriptions/:userId',
            deleteSubscriptions:'DELETE /subscriptions/:userId'
        }
    });
});

app.use((req, res) => res.status(404).json({ error: 'Endpoint не найден' }));

app.use((err, req, res, next) => {
    console.error('[Server] Необработанная ошибка:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

process.on('SIGTERM', () => { saveSubscriptions(subscriptions); process.exit(0); });
process.on('SIGINT',  () => { saveSubscriptions(subscriptions); process.exit(0); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Twin Push Server v2 запущен → порт ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
    console.log(`[Server] Debug:  http://localhost:${PORT}/debug`);
});
