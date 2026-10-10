// Проверка публичной записи без сети и без Google: календарь подменён списком в памяти.
// Запуск: node broni-auth/test/public.test.mjs
import worker from "../src/index.js";
import assert from "node:assert/strict";

const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const env = { PUBLIC_BOOKING_MODE: "test", TOKENS: Object.assign(kv(), {}), RATE_LIMIT: kv(), STUDIO_KEY: "k" };
await env.TOKENS.put("access_token", "fake");

let events = [];   // «календарь»
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes("googleapis.com/calendar")) throw new Error("unexpected fetch " + u);
  if ((init.method || "GET") === "POST") {
    const body = JSON.parse(init.body);
    const ev = { id: "e" + (events.length + 1), start: { dateTime: body.start.dateTime + "+07:00" }, end: { dateTime: body.end.dateTime + "+07:00" }, summary: body.summary, description: body.description };
    events.push(ev);
    return new Response(JSON.stringify(ev), { status: 200 });
  }
  return new Response(JSON.stringify({ items: events }), { status: 200 });
};

const call = (path, method = "GET", body, ip = "1.1.1.1") => worker.fetch(new Request("https://w.test" + path, {
  method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: "https://alexeynovopashin-lab.github.io" },
  body: body ? JSON.stringify(body) : undefined }), env);

const future = (days) => { const d = new Date(Date.now() + 7 * 3600000 + days * 86400000); return d.toISOString().slice(0, 10); };
const ok = { hall: "edison", date: future(3), start: "12:00", end: "14:00", guests: 4, name: "Тест Тестов", phone: "8 913 000-11-22", consent: true, price: 3200 };

// выключено без переменной
assert.equal((await worker.fetch(new Request("https://w.test/public/config"), { ...env, PUBLIC_BOOKING_MODE: "" })).status, 404);
assert.equal((await call("/public/config")).status, 200);

// заявка создаёт событие и не светит чужого
let r = await call("/public/request", "POST", ok);
assert.equal(r.status, 200); assert.equal(events.length, 1);
assert.match(events[0].summary, /ЗАЯВКА Тест Тестов \+7 913 000-11-22/);
assert.match(events[0].description, /Телефон: \+7 913 000-11-22/);

// занятое время видно как интервал без имён
r = await call(`/public/busy?hall=edison&from=${ok.date}&to=${ok.date}`);
const busy = (await r.json()).busy;
assert.deepEqual(busy, [{ date: ok.date, start: "12:00", end: "14:00" }]);

// пересечение: 409; встык (14:00–15:00) разрешено
assert.equal((await call("/public/request", "POST", { ...ok, start: "13:00", end: "15:00", phone: "89130001133" }, "2.2.2.2")).status, 409);
assert.equal((await call("/public/request", "POST", { ...ok, start: "14:00", end: "15:00", phone: "89130001144" }, "3.3.3.3")).status, 200);

// проверки входа
const bad = async (patch, status = 400) => assert.equal((await call("/public/request", "POST", { ...ok, phone: "89130002200", ...patch }, "9." + Math.random())).status, status, JSON.stringify(patch));
await bad({ start: "12:15" });                    // не кратно получасу
await bad({ start: "12:00", end: "12:30" });      // меньше часа
await bad({ start: "07:00", end: "09:00" });      // раньше открытия
await bad({ start: "22:00", end: "23:30" });      // позже закрытия
await bad({ date: future(-1) });                  // вчера
await bad({ date: future(200) });                 // слишком далеко
await bad({ phone: "123" });
await bad({ name: "" });
await bad({ consent: false });
await bad({ hall: "nope" });

// ловушка для ботов: «принято», но события нет
const before = events.length;
assert.equal((await call("/public/request", "POST", { ...ok, website: "spam" }, "4.4.4.4")).status, 200);
assert.equal(events.length, before);

// лимит по номеру: четвёртая заявка за час отклоняется
for (let i = 0; i < 3; i++) await call("/public/request", "POST", { ...ok, date: future(10 + i), phone: "89130007777" }, "5.5." + i + ".1");
assert.equal((await call("/public/request", "POST", { ...ok, date: future(20), phone: "89130007777" }, "6.6.6.6")).status, 429);

// лимит по адресу: шестой запрос с одного IP за минуту
for (let i = 0; i < 5; i++) await call("/public/request", "POST", { ...ok, website: "x" }, "7.7.7.7");
assert.equal((await call("/public/request", "POST", ok, "7.7.7.7")).status, 429);

console.log("public booking: all checks passed");
