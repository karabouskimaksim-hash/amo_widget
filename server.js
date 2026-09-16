/**
 * CS Response Widget — backend
 * -----------------------------------------------------------------------
 * Считает для воронки Customer Success за вчера:
 *   1) сколько обращений (сделок) создано в каждый час суток
 *   2) среднее время первого ответа (от первого входящего сообщения
 *      до первого следующего исходящего) — по каждому из 4 сотрудников
 *
 * Данные не хранятся — при каждом запросе виджета сервер идёт в amoCRM
 * API v4 и считает всё заново. Для такого объёма (десятки сделок в день)
 * это быстро и не требует базы данных.
 *
 * ЧТО НУЖНО ПРОВЕРИТЬ/ПОДСТАВИТЬ ПЕРЕД ЗАПУСКОМ — см. README.md и .env.example
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.static('public'));

const {
  AMO_SUBDOMAIN,          // например "bitkoganfinance"
  AMO_ACCESS_TOKEN,       // долгосрочный токен приватной интеграции
  PIPELINE_ID,            // id воронки Customer Success
  EMPLOYEE_IDS,           // "12865498,13847354,13847362,13847374"
  TIMEZONE = 'Europe/Moscow',
  PORT = 3000,
} = process.env;

if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN || !PIPELINE_ID || !EMPLOYEE_IDS) {
  console.error(
    '[config] Не заполнен .env — см. .env.example. ' +
    'Нужны AMO_SUBDOMAIN, AMO_ACCESS_TOKEN, PIPELINE_ID, EMPLOYEE_IDS.'
  );
}

const employeeIds = (EMPLOYEE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const api = axios.create({
  baseURL: `https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4`,
  headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` },
  timeout: 15000,
});

// ---------------------------------------------------------------------
// Границы "вчера" в нужной таймзоне -> unix-секунды (amoCRM ждёт unix)
// ---------------------------------------------------------------------
function yesterdayRangeUnix(tz) {
  const now = new Date();
  // сегодняшняя полночь в TZ, затем минус сутки
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = fmt.format(now); // YYYY-MM-DD в нужной таймзоне
  const today = new Date(`${todayStr}T00:00:00`);
  const yStart = new Date(today.getTime() - 24 * 3600 * 1000);
  const yEnd = today; // эксклюзивно
  return {
    from: Math.floor(yStart.getTime() / 1000),
    to: Math.floor(yEnd.getTime() / 1000),
    label: yStart.toISOString().slice(0, 10),
  };
}

function hourInTz(unixSeconds, tz) {
  const d = new Date(unixSeconds * 1000);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(fmt.format(d), 10) % 24;
}

// ---------------------------------------------------------------------
// 1) Сделки, созданные вчера в воронке — источник для часовой разбивки
//    и список lead_id для сопоставления с событиями переписки
// ---------------------------------------------------------------------
async function fetchYesterdayLeads(from, to) {
  const leads = [];
  let page = 1;
  // amoCRM отдаёт максимум 250 на страницу
  while (true) {
    const { data } = await api.get('/leads', {
      params: {
        filter: {
          pipeline_id: PIPELINE_ID,
          created_at: { from, to },
        },
        limit: 250,
        page,
      },
      paramsSerializer: bracketSerializer,
    });
    const batch = data?._embedded?.leads || [];
    leads.push(...batch);
    if (batch.length < 250) break;
    page += 1;
    if (page > 20) break; // защита от бесконечного цикла
  }
  return leads;
}

// amoCRM ждёт filter[pipeline_id]=.. filter[created_at][from]=.. в query,
// axios по умолчанию так вложенные объекты не сериализует — делаем сами.
function bracketSerializer(params) {
  const parts = [];
  const walk = (obj, prefix) => {
    Object.entries(obj).forEach(([key, value]) => {
      const p = prefix ? `${prefix}[${key}]` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, p);
      } else if (Array.isArray(value)) {
        value.forEach((v) => parts.push(`${p}[]=${encodeURIComponent(v)}`));
      } else if (value !== undefined) {
        parts.push(`${p}=${encodeURIComponent(value)}`);
      }
    });
  };
  walk(params, '');
  return parts.join('&');
}

// ---------------------------------------------------------------------
// 2) События переписки (incoming_chat_message / outgoing_chat_message)
//    по конкретным сделкам — для расчёта времени первого ответа
// ---------------------------------------------------------------------
async function fetchMessageEvents(leadIds, from, to) {
  if (leadIds.length === 0) return [];
  const events = [];
  const CHUNK = 10; // на случай, если сделок много — режем на пачки
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const chunk = leadIds.slice(i, i + CHUNK);
    let page = 1;
    while (true) {
      const { data } = await api.get('/events', {
        params: {
          filter: {
            type: ['incoming_chat_message', 'outgoing_chat_message'],
            entity: 'lead',
            entity_id: chunk,
            created_at: { from, to: to + 6 * 3600 }, // +6ч запаса на ответ после полуночи
          },
          limit: 250,
          page,
        },
        paramsSerializer: bracketSerializer,
      });
      const batch = data?._embedded?.events || [];
      events.push(...batch);
      if (batch.length < 250) break;
      page += 1;
      if (page > 20) break;
    }
  }
  return events;
}

// ---------------------------------------------------------------------
// 3) Имена сотрудников — резолвим через /users, чтобы не хардкодить
// ---------------------------------------------------------------------
let userNameCache = null;
async function resolveUserNames(ids) {
  if (userNameCache) return userNameCache;
  const map = {};
  for (const id of ids) {
    try {
      const { data } = await api.get(`/users/${id}`);
      map[id] = data?.name || `#${id}`;
    } catch (e) {
      map[id] = `#${id}`;
    }
  }
  userNameCache = map;
  return map;
}

// ---------------------------------------------------------------------
// Основной подсчёт
// ---------------------------------------------------------------------
async function computeStats() {
  const { from, to, label } = yesterdayRangeUnix(TIMEZONE);

  const leads = await fetchYesterdayLeads(from, to);
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // --- часовая разбивка обращений (по времени создания сделки) ---
  const hourly = Array.from({ length: 24 }, () => 0);
  leads.forEach((l) => {
    const h = hourInTz(l.created_at, TIMEZONE);
    hourly[h] += 1;
  });

  // --- среднее время первого ответа, по сотрудникам ---
  const leadIds = leads.map((l) => l.id);
  const events = await fetchMessageEvents(leadIds, from, to);

  // группируем события по сделке, сортируем по времени
  const byLead = new Map();
  events.forEach((ev) => {
    const leadId = ev.entity_id;
    if (!byLead.has(leadId)) byLead.set(leadId, []);
    byLead.get(leadId).push(ev);
  });

  const namesMap = await resolveUserNames(employeeIds);
  const perEmployee = {};
  employeeIds.forEach((id) => {
    perEmployee[id] = { name: namesMap[id] || `#${id}`, deltas: [] };
  });

  byLead.forEach((evList, leadId) => {
    const lead = leadById.get(leadId);
    if (!lead) return;
    const respId = lead.responsible_user_id;
    if (!employeeIds.includes(respId)) return; // считаем только наших 4

    evList.sort((a, b) => a.created_at - b.created_at);
    const firstIn = evList.find((e) => e.type === 'incoming_chat_message');
    if (!firstIn) return;
    const firstOutAfter = evList.find(
      (e) => e.type === 'outgoing_chat_message' && e.created_at > firstIn.created_at
    );
    if (!firstOutAfter) return; // ещё не ответили

    const deltaSeconds = firstOutAfter.created_at - firstIn.created_at;
    perEmployee[respId].deltas.push(deltaSeconds);
  });

  const employeeStats = employeeIds.map((id) => {
    const { name, deltas } = perEmployee[id];
    const avg =
      deltas.length > 0
        ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
        : null;
    return { id, name, repliedCount: deltas.length, avgResponseSeconds: avg };
  });

  return {
    date: label,
    timezone: TIMEZONE,
    totalLeads: leads.length,
    hourly, // hourly[0..23] — число обращений в этот час
    employees: employeeStats,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// Роуты
// ---------------------------------------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await computeStats();
    res.json(stats);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({
      error: 'Не удалось посчитать статистику',
      details: err?.response?.data || err.message,
    });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CS response widget backend слушает порт ${PORT}`);
});
