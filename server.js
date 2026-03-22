// ════════════════════════════════════════════════════════════
//  Twin — Push Server (Node.js + Express + web-push)
//  ИСПРАВЛЕНО: постоянное хранение подписок + правильный payload
// ════════════════════════════════════════════════════════════

const express    = require('express');
const webpush    = require('web-push');
const bodyParser = require('body-parser');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ── VAPID — из переменных окружения ────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BANapkW0GhUBLNbQBvsZbHBdcjGm_kVIifEYNBsivgzSkYztpF37z1Ij7YvX3s03J-6RRvNE-PvZ5K2JJVfS_vQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'lMV3yjtcsVZ_ZNwq4XzjirmJIMCht3xWtCGGPA0zkXU';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@twin.app';


// Проверяем длину приватного ключа ДО вызова setVapidDetails
const _privCheck = Buffer.from(VAPID_PRIVATE.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64").length;
if (_privCheck < 31 || _privCheck > 33) {
    console.error(`[Server] FATAL: VAPID_PRIVATE_KEY неверный (${_privCheck} байт, нужно 32).`);
    console.error("[Server] Сгенерируйте новую пару: npx web-push generate-vapid-keys");
    process.exit(1);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ── Хранилище подписок — файл /tmp/subscriptions.json ──────
// На Railway /tmp сохраняется между деплоями (пока volume не сброшен)
const DB_FILE = '/tmp/subscriptions.json';

function loadSubscriptions() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            const map = new Map();
            for (const [k, v] of Object.entries(data)) map.set(k, v);
            console.log(`[Server] Загружено ${map.size} пользователей из файла`);
            return map;
        }
    } catch (e) {
        console.warn('[Server] Ошибка загрузки подписок:', e.message);
    }
    return new Map();
}

function saveSubscriptions(map) {
    try {
        const obj = {};
        for (const [k, v] of map.entries()) obj[k] = v;
        fs.writeFileSync(DB_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) {
        console.warn('[Server] Ошибка сохранения подписок:', e.message);
    }
}

const subscriptions = loadSubscriptions();

// ════════════════════════════════════════════════════════════
//  API endpoints
// ════════════════════════════════════════════════════════════

// POST /subscribe — сохраняем подписку клиента
app.post('/subscribe', (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'userId и subscription.endpoint обязательны' });
    }

    if (!subscriptions.has(userId)) subscriptions.set(userId, []);

    const subs = subscriptions.get(userId);
    const exists = subs.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
        subs.push(subscription);
        saveSubscriptions(subscriptions);
    }

    console.log(`[Server] /subscribe: ${userId} (подписок: ${subs.length})`);
    res.json({ ok: true });
});

// POST /unsubscribe — удаляем подписку
app.post('/unsubscribe', (req, res) => {
    const { userId, endpoint } = req.body;
    if (subscriptions.has(userId)) {
        const filtered = subscriptions.get(userId).filter(s => s.endpoint !== endpoint);
        subscriptions.set(userId, filtered);
        saveSubscriptions(subscriptions);
    }
    res.json({ ok: true });
});

// POST /send — отправляем push пользователю
// Принимает ДВА формата:
//   Плоский:   { userId, title, body, url, tag, icon }
//   Вложенный: { userId, payload: { title, body, ... } }
app.post('/send', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId обязателен' });

    // Нормализуем payload — поддерживаем оба формата
    const src = req.body.payload && typeof req.body.payload === 'object'
        ? req.body.payload
        : req.body;

    const payloadStr = JSON.stringify({
        title: src.title || 'Twin',
        body:  src.body  || 'Новое сообщение',
        icon:  src.icon  || 'https://russiastarscom.github.io/partner/icon-192x192.png',
        badge: src.badge || 'https://russiastarscom.github.io/partner/icon-192x192.png',
        tag:   src.tag   || 'twin-msg',
        url:   src.url   || 'https://russiastarscom.github.io/partner/index.html'
    });

    const subs = subscriptions.get(userId) || [];
    if (subs.length === 0) {
        console.log(`[Server] /send: нет подписок для ${userId}`);
        return res.json({ ok: true, sent: 0, total: 0 });
    }

    console.log(`[Server] /send → ${userId}, подписок: ${subs.length}`);

    const results = await Promise.allSettled(
        subs.map(sub => webpush.sendNotification(sub, payloadStr))
    );

    // Удаляем протухшие подписки (404/410)
    let changed = false;
    const validSubs = subs.filter((sub, i) => {
        const r = results[i];
        if (r.status === 'rejected') {
            const status = r.reason?.statusCode;
            if (status === 404 || status === 410) {
                console.log(`[Server] Удалена устаревшая подписка для ${userId}`);
                changed = true;
                return false;
            }
            console.warn(`[Server] Push ошибка (${status}):`, r.reason?.body || r.reason?.message);
        }
        return true;
    });

    if (changed) {
        subscriptions.set(userId, validSubs);
        saveSubscriptions(subscriptions);
    }

    const sent = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[Server] ✓ Отправлено ${sent}/${subs.length} для ${userId}`);
    res.json({ ok: true, sent, total: subs.length });
});

// GET /health
app.get('/health', (req, res) => {
    const total = [...subscriptions.values()].reduce((s, a) => s + a.length, 0);
    res.json({ status: 'ok', users: subscriptions.size, subscriptions: total, uptime: Math.round(process.uptime()) });
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Twin Push Server → порт ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
});
