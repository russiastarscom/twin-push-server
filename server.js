// ════════════════════════════════════════════════════════════
//  Twin — Push Server (Node.js + Express + web-push)
//  Файл: server.js
//
//  Деплой БЕСПЛАТНО на Railway.app или Render.com
//  Инструкция: см. README_PUSH_SERVER.md
// ════════════════════════════════════════════════════════════

const express    = require('express');
const webpush    = require('web-push');
const bodyParser = require('body-parser');
const cors       = require('cors');

const app = express();
app.use(cors());                          // разрешаем запросы с твоего домена
app.use(bodyParser.json());

// ── VAPID — вставь свои ключи из переменных окружения ───
// На Railway/Render задай env-переменные:
//   VAPID_PUBLIC_KEY  = <публичный ключ>
//   VAPID_PRIVATE_KEY = <приватный ключ>
//   VAPID_EMAIL       = mailto:твой@email.com
webpush.setVapidDetails(
    'mailto:admin@twin.app',
    'BHWhY-ozjg5GkVLxFhhG_VEtj198PkvEjRtTDSfOMtNKGr1RpX_ELO9YAQChg7E0gLIrERJW0LzolDkkD0RBzbM',
    'Qr_85qQc_uWO8xT8nJ9g7Zx7v5_SoKC2180HH6IuuzI'
);

// ── Хранилище подписок (в памяти) ───────────────────────
// ⚠️ При рестарте сервера очищается!
// Для продакшена замени на Firebase Realtime DB или любую БД.
// Ключ = userId, значение = массив subscription-объектов
const subscriptions = new Map();   // userId → [sub1, sub2, ...]

// ════════════════════════════════════════════════════════════
//  API endpoints
// ════════════════════════════════════════════════════════════

// POST /subscribe — сохраняем подписку клиента
app.post('/subscribe', (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription) {
        return res.status(400).json({ error: 'userId и subscription обязательны' });
    }

    if (!subscriptions.has(userId)) {
        subscriptions.set(userId, []);
    }

    const subs = subscriptions.get(userId);
    // Не дублируем одинаковый endpoint
    const exists = subs.some(s => s.endpoint === subscription.endpoint);
    if (!exists) subs.push(subscription);

    console.log(`[Server] Подписка сохранена: ${userId} (всего: ${subs.length})`);
    res.json({ ok: true });
});

// POST /unsubscribe — удаляем подписку клиента
app.post('/unsubscribe', (req, res) => {
    const { userId, endpoint } = req.body;
    if (subscriptions.has(userId)) {
        const filtered = subscriptions.get(userId).filter(s => s.endpoint !== endpoint);
        subscriptions.set(userId, filtered);
    }
    res.json({ ok: true });
});

// POST /send — отправляем push одному пользователю
// Вызывается из твоего бэкенда или Firebase Cloud Functions
// Body: { userId, title, body, url, tag }
app.post('/send', async (req, res) => {
    const { userId, title, body, url, tag, icon } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId обязателен' });

    const subs = subscriptions.get(userId) || [];
    if (subs.length === 0) {
        return res.json({ ok: true, sent: 0, message: 'Нет подписок для пользователя' });
    }

    const payload = JSON.stringify({
        title: title || 'Twin',
        body:  body  || 'Новое сообщение',
        icon:  icon  || '/partner/icon-192x192.png',
        badge: '/partner/icon-192x192.png',
        tag:   tag   || 'twin-msg',
        url:   url   || '/partner/index.html'
    });

    const results = await Promise.allSettled(
        subs.map(sub => webpush.sendNotification(sub, payload))
    );

    // Удаляем протухшие подписки (статус 404 или 410)
    const validSubs = subs.filter((_, i) => {
        const r = results[i];
        if (r.status === 'rejected') {
            const status = r.reason?.statusCode;
            if (status === 404 || status === 410) {
                console.log(`[Server] Удалена протухшая подписка: ${subs[i].endpoint}`);
                return false;
            }
        }
        return true;
    });
    subscriptions.set(userId, validSubs);

    const sent = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[Server] Push отправлен: ${userId}, доставлено: ${sent}/${subs.length}`);
    res.json({ ok: true, sent, total: subs.length });
});

// GET /health — проверка работоспособности сервера
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        users: subscriptions.size,
        uptime: process.uptime()
    });
});

// ── Запуск ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Twin Push Server запущен на порту ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
});
