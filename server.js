/**
 * CS Response Widget — backend
 * -----------------------------------------------------------------------
 * Считает для воронки Customer Success за вчера:
 *   1) сколько обращений (сделок) создано в каждый час суток
 *   2) среднее время ДО ВЗЯТИЯ В РАБОТУ (от создания сделки до первой
 *      смены этапа — то есть момента, когда сотрудник сдвинул её
 *      с «Взять в работу» дальше) — по каждому из 4 сотрудников
 *
 * ВАЖНО: это НЕ время ответа на сообщение клиенту. Настоящее время
 * ответа требует данных из отдельной Chats API amoCRM (сообщения
 * там — не сделки и не обычные события, а объекты в другой системе,
 * amojo.amocrm.ru, с отдельной авторизацией). Это уже другой уровень
 * интеграции. Метрика ниже — рабочая замена на основе тех же данных,
 * что мы и так получаем: "сколько времени сделка провисела в
 * необработанном виде, прежде чем её взяли в работу".
 *
 * Данные не хранятся — при каждом запросе виджета сервер идёт в amoCRM
 * API v4 и считает всё заново.
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
// 1) Сделки, созданные вчера в воронке — источник для часовой разбивки
//    и список lead_id для сопоставления с событиями смены этапа
// ---------------------------------------------------------------------
async function fetchYesterdayLeads(from, to) {
  const leads = [];
  let page = 1;
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

// ---------------------------------------------------------------------
// 2) События определённых типов по конкретным сделкам.
//    amoCRM ограничивает filter[entity_id][] максимум 10 значениями
//    за запрос — при большем количестве отдаёт 400 "More params given
//    than allowed", поэтому режем на пачки по 10.
// ---------------------------------------------------------------------
async function fetchEventsByType(leadIds, types, from, to) {
  if (leadIds.length === 0) return [];
  const events = [];
  const CHUNK = 10;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const chunk = leadIds.slice(i, i + CHUNK);
    let page = 1;
    while (true) {
      const { data } = await api.get('/events', {
        params: {
          filter: {
            type: types,
            entity: 'lead',
            entity_id: chunk,
            created_at: { from, to: to + 6 * 3600 }, // +6ч запаса после полуночи
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

  // --- среднее время до взятия в работу, по сотрудникам ---
  // считаем только по сделкам наших 4 сотрудниц
  const employeeLeads = leads.filter((l) => employeeIds.includes(l.responsible_user_id));
  const employeeLeadIds = employeeLeads.map((l) => l.id);

  const statusEvents = await fetchEventsByType(
    employeeLeadIds,
    ['lead_status_changed'],
    from,
    to
  );

  // группируем по сделке, берём САМОЕ РАННЕЕ изменение этапа —
  // это и есть момент, когда сделку сдвинули с "Взять в работу"
  const firstStatusChangeByLead = new Map();
  statusEvents.forEach((ev) => {
    const leadId = ev.entity_id;
    const existing = firstStatusChangeByLead.get(leadId);
    if (!existing || ev.created_at < existing.created_at) {
      firstStatusChangeByLead.set(leadId, ev);
    }
  });

  const namesMap = await resolveUserNames(employeeIds);
  const perEmployee = {};
  employeeIds.forEach((id) => {
    perEmployee[id] = { name: namesMap[id] || `#${id}`, deltas: [] };
  });

  employeeLeads.forEach((lead) => {
    const firstChange = firstStatusChangeByLead.get(lead.id);
    if (!firstChange) return; // ещё не сдвигали с "Взять в работу"
    const deltaSeconds = firstChange.created_at - lead.created_at;
    if (deltaSeconds < 0) return; // защита от аномалий
    perEmployee[lead.responsible_user_id].deltas.push(deltaSeconds);
  });

  const employeeStats = employeeIds.map((id) => {
    const { name, deltas } = perEmployee[id];
    const avg =
      deltas.length > 0
        ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
        : null;
    return { id, name, pickedUpCount: deltas.length, avgPickupSeconds: avg };
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

// Диагностика: сырые данные для отладки. Можно оставить — не мешает.
app.get('/api/debug', async (req, res) => {
  try {
    const { from, to, label } = yesterdayRangeUnix(TIMEZONE);
    const leads = await fetchYesterdayLeads(from, to);
    const employeeLeads = leads.filter((l) => employeeIds.includes(l.responsible_user_id));
    const employeeLeadIds = employeeLeads.map((l) => l.id);

    const statusEvents = await fetchEventsByType(
      employeeLeadIds,
      ['lead_status_changed'],
      from,
      to
    );

    res.json({
      date: label,
      totalLeads: leads.length,
      employeeLeadCount: employeeLeads.length,
      employeeLeads: employeeLeads.map((l) => ({
        id: l.id,
        responsible_user_id: l.responsible_user_id,
        created_at: l.created_at,
      })),
      statusChangeEventCount: statusEvents.length,
      sampleStatusEvents: statusEvents.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({
      error: 'debug failed',
      details: err?.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`CS response widget backend слушает порт ${PORT}`);
});
