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

// ── Настройка middleware с ограничениями ────────────────────
app.use(cors({
    origin: '*', // В продакшене лучше ограничить доменами
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json({ limit: '10mb' })); // Добавляем лимит для больших данных

// ── VAPID — из переменных окружения ────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BANapkW0GhUBLNbQBvsZbHBdcjGm_kVIifEYNBsivgzSkYztpF37z1Ij7YvX3s03J-6RRvNE-PvZ5K2JJVfS_vQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'lMV3yjtcsVZ_ZNwq4XzjirmJIMCht3xWtCGGPA0zkXU';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@twin.app';

// Исправленная проверка приватного ключа
try {
    // Более надежная проверка формата VAPID ключа
    if (!VAPID_PRIVATE || VAPID_PRIVATE.length < 20) {
        throw new Error('VAPID_PRIVATE_KEY слишком короткий или отсутствует');
    }
    
    // Попытка декодировать ключ для проверки формата
    const decodedKey = Buffer.from(VAPID_PRIVATE.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decodedKey.length !== 32) {
        console.warn(`[Server] Предупреждение: VAPID_PRIVATE_KEY имеет длину ${decodedKey.length} байт (ожидается 32).`);
        console.warn("[Server] Некоторые браузеры могут отклонять уведомления.");
    }
    
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('[Server] VAPID настроен успешно');
} catch (error) {
    console.error('[Server] Ошибка настройки VAPID:', error.message);
    console.error('[Server] Сгенерируйте новую пару ключей: npx web-push generate-vapid-keys');
    // Не завершаем процесс, чтобы сервер хотя бы запустился для health-check
}

// ── Хранилище подписок — улучшенная версия ──────────────────
const DB_FILE = '/tmp/subscriptions.json';
const DB_BACKUP_FILE = '/tmp/subscriptions.backup.json';

function loadSubscriptions() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            if (!data.trim()) {
                console.warn('[Server] Файл подписок пуст');
                return new Map();
            }
            
            const parsed = JSON.parse(data);
            const map = new Map();
            
            for (const [k, v] of Object.entries(parsed)) {
                // Валидация данных подписки
                if (Array.isArray(v)) {
                    const validSubs = v.filter(sub => sub && sub.endpoint);
                    if (validSubs.length > 0) {
                        map.set(k, validSubs);
                    }
                }
            }
            
            console.log(`[Server] Загружено ${map.size} пользователей из файла`);
            return map;
        } else {
            console.log('[Server] Файл подписок не найден, создаем новый');
        }
    } catch (e) {
        console.error('[Server] Ошибка загрузки подписок:', e.message);
        
        // Пытаемся восстановить из бэкапа
        try {
            if (fs.existsSync(DB_BACKUP_FILE)) {
                const backupData = JSON.parse(fs.readFileSync(DB_BACKUP_FILE, 'utf8'));
                const map = new Map(Object.entries(backupData));
                console.log(`[Server] Восстановлено ${map.size} подписок из бэкапа`);
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
            if (v && v.length > 0) {
                obj[k] = v;
            }
        }
        
        const data = JSON.stringify(obj, null, 2);
        
        // Сначала создаем бэкап
        if (fs.existsSync(DB_FILE)) {
            fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
        }
        
        // Сохраняем новые данные
        fs.writeFileSync(DB_FILE, data, 'utf8');
        console.log(`[Server] Сохранено ${map.size} пользователей в файл`);
    } catch (e) {
        console.error('[Server] Ошибка сохранения подписок:', e.message);
        
        // Попытка сохранить без форматирования как fallback
        try {
            const simpleData = JSON.stringify(Object.fromEntries(map));
            fs.writeFileSync(DB_FILE, simpleData, 'utf8');
        } catch (fallbackErr) {
            console.error('[Server] Критическая ошибка сохранения:', fallbackErr.message);
        }
    }
}

let subscriptions = loadSubscriptions();

// Периодическое автосохранение (каждые 5 минут)
setInterval(() => {
    if (subscriptions.size > 0) {
        saveSubscriptions(subscriptions);
        console.log(`[Server] Автосохранение: ${subscriptions.size} пользователей`);
    }
}, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════════
//  API endpoints
// ════════════════════════════════════════════════════════════

// GET /vapidPublicKey - для получения публичного ключа клиентом
app.get('/vapidPublicKey', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC });
});

// POST /subscribe — сохраняем подписку клиента
app.post('/subscribe', (req, res) => {
    try {
        const { userId, subscription } = req.body;
        
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({ error: 'userId обязателен и должен быть строкой' });
        }
        
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ error: 'subscription и subscription.endpoint обязательны' });
        }
        
        // Валидация структуры подписки
        if (!subscription.keys || !subscription.keys.auth || !subscription.keys.p256dh) {
            return res.status(400).json({ error: 'Неполная структура подписки: требуются keys.auth и keys.p256dh' });
        }
        
        const userIdClean = userId.trim();
        
        if (!subscriptions.has(userIdClean)) {
            subscriptions.set(userIdClean, []);
        }
        
        const subs = subscriptions.get(userIdClean);
        const exists = subs.some(s => s.endpoint === subscription.endpoint);
        
        if (!exists) {
            // Сохраняем только нужные поля
            const cleanSubscription = {
                endpoint: subscription.endpoint,
                keys: {
                    auth: subscription.keys.auth,
                    p256dh: subscription.keys.p256dh
                }
            };
            subs.push(cleanSubscription);
            saveSubscriptions(subscriptions);
            console.log(`[Server] /subscribe: ${userIdClean} добавлена новая подписка (всего: ${subs.length})`);
        } else {
            console.log(`[Server] /subscribe: ${userIdClean} подписка уже существует`);
        }
        
        res.json({ ok: true, totalSubscriptions: subs.length });
    } catch (error) {
        console.error('[Server] Ошибка в /subscribe:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// POST /unsubscribe — удаляем подписку
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
            console.log(`[Server] /unsubscribe: ${userId} удалена подписка`);
        }
        
        res.json({ ok: true });
    } catch (error) {
        console.error('[Server] Ошибка в /unsubscribe:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// POST /send — отправляем push пользователю
app.post('/send', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({ error: 'userId обязателен' });
        }
        
        const userIdClean = userId.trim();
        
        // Нормализуем payload
        const src = req.body.payload && typeof req.body.payload === 'object'
            ? req.body.payload
            : req.body;
        
        // Валидация payload
        const payloadObj = {
            title: src.title && typeof src.title === 'string' ? src.title.substring(0, 100) : 'Twin',
            body: src.body && typeof src.body === 'string' ? src.body.substring(0, 200) : 'Новое сообщение',
            icon: src.icon && typeof src.icon === 'string' ? src.icon : 'https://russiastarscom.github.io/partner/icon-192x192.png',
            badge: src.badge && typeof src.badge === 'string' ? src.badge : 'https://russiastarscom.github.io/partner/icon-192x192.png',
            tag: src.tag && typeof src.tag === 'string' ? src.tag.substring(0, 50) : 'twin-msg',
            url: src.url && typeof src.url === 'string' ? src.url : 'https://russiastarscom.github.io/partner/index.html',
            timestamp: Date.now()
        };
        
        // Проверяем URL на корректность
        try {
            new URL(payloadObj.url);
        } catch (e) {
            payloadObj.url = 'https://russiastarscom.github.io/partner/index.html';
        }
        
        const payloadStr = JSON.stringify(payloadObj);
        
        // Проверяем размер payload (макс 4096 байт для Chrome)
        const payloadSize = Buffer.byteLength(payloadStr, 'utf8');
        if (payloadSize > 4000) {
            console.warn(`[Server] Payload слишком большой (${payloadSize} байт), обрезаем`);
            // Обрезаем body если нужно
            payloadObj.body = payloadObj.body.substring(0, 100);
            const trimmedPayload = JSON.stringify(payloadObj);
            if (Buffer.byteLength(trimmedPayload, 'utf8') > 4096) {
                return res.status(400).json({ error: 'Payload превышает максимальный размер 4096 байт' });
            }
        }
        
        const subs = subscriptions.get(userIdClean) || [];
        
        if (subs.length === 0) {
            console.log(`[Server] /send: нет подписок для ${userIdClean}`);
            return res.json({ ok: true, sent: 0, total: 0, message: 'Нет активных подписок' });
        }
        
        console.log(`[Server] /send → ${userIdClean}, подписок: ${subs.length}`);
        
        // Отправляем уведомления с таймаутом
        const sendPromises = subs.map(sub => {
            return Promise.race([
                webpush.sendNotification(sub, payloadStr),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ]);
        });
        
        const results = await Promise.allSettled(sendPromises);
        
        // Обрабатываем результаты
        let changed = false;
        const validSubs = [];
        let sentCount = 0;
        
        results.forEach((result, index) => {
            const sub = subs[index];
            
            if (result.status === 'fulfilled') {
                validSubs.push(sub);
                sentCount++;
            } else {
                const error = result.reason;
                const statusCode = error.statusCode;
                
                if (statusCode === 404 || statusCode === 410 || error.message === 'Timeout') {
                    console.log(`[Server] Удалена невалидная подписка для ${userIdClean}: ${statusCode || error.message}`);
                    changed = true;
                } else {
                    console.warn(`[Server] Push ошибка для ${userIdClean}:`, error.message || error);
                    validSubs.push(sub); // Сохраняем подписку, возможно временная ошибка
                }
            }
        });
        
        if (changed && validSubs.length !== subs.length) {
            if (validSubs.length === 0) {
                subscriptions.delete(userIdClean);
            } else {
                subscriptions.set(userIdClean, validSubs);
            }
            saveSubscriptions(subscriptions);
        }
        
        console.log(`[Server] ✓ Отправлено ${sentCount}/${subs.length} для ${userIdClean}`);
        res.json({ ok: true, sent: sentCount, total: subs.length });
        
    } catch (error) {
        console.error('[Server] Ошибка в /send:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// DELETE /subscriptions/:userId - удалить все подписки пользователя
app.delete('/subscriptions/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        if (subscriptions.has(userId)) {
            subscriptions.delete(userId);
            saveSubscriptions(subscriptions);
            console.log(`[Server] Удалены все подписки для ${userId}`);
            res.json({ ok: true, message: 'Все подписки удалены' });
        } else {
            res.json({ ok: true, message: 'Пользователь не найден' });
        }
    } catch (error) {
        console.error('[Server] Ошибка в DELETE /subscriptions:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// GET /subscriptions/:userId - получить подписки пользователя
app.get('/subscriptions/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const subs = subscriptions.get(userId) || [];
        res.json({ userId, subscriptions: subs.map(s => ({ endpoint: s.endpoint })) });
    } catch (error) {
        console.error('[Server] Ошибка в GET /subscriptions:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// GET /health - улучшенная проверка здоровья
app.get('/health', (req, res) => {
    const total = [...subscriptions.values()].reduce((s, a) => s + a.length, 0);
    const vapidStatus = !!VAPID_PUBLIC && !!VAPID_PRIVATE;
    
    res.json({
        status: 'ok',
        users: subscriptions.size,
        subscriptions: total,
        uptime: Math.round(process.uptime()),
        vapidConfigured: vapidStatus,
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// GET / - корневой эндпоинт для проверки
app.get('/', (req, res) => {
    res.json({
        name: 'Twin Push Server',
        version: '1.0.0',
        endpoints: {
            health: 'GET /health',
            subscribe: 'POST /subscribe',
            unsubscribe: 'POST /unsubscribe',
            send: 'POST /send',
            vapidPublicKey: 'GET /vapidPublicKey',
            subscriptions: 'GET /subscriptions/:userId',
            deleteSubscriptions: 'DELETE /subscriptions/:userId'
        }
    });
});

// Обработка несуществующих маршрутов
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint не найден' });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
    console.error('[Server] Необработанная ошибка:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Элегантное завершение работы
process.on('SIGTERM', () => {
    console.log('[Server] Получен SIGTERM, сохраняем данные...');
    saveSubscriptions(subscriptions);
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Server] Получен SIGINT, сохраняем данные...');
    saveSubscriptions(subscriptions);
    process.exit(0);
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Twin Push Server запущен → порт ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
    console.log(`[Server] VAPID Public Key: ${VAPID_PUBLIC.substring(0, 30)}...`);
});