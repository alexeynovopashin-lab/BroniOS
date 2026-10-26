/* Сверка JS-копии правила «свет в окнах зала» с эталоном Light Plan.

   Запуск:
     node tools/window_light_check.js <window_light.json> [<window_light.js>]

   Первый путь — числа сверки (`native/Fixtures/window_light.json`, пишет стенд
   паритета Light Plan). Второй — проверяемая копия правила; по умолчанию —
   соседняя `window_light.js`. BroniOS запускает это на своей копии: код 0 —
   копия считает так же, как Swift-приложение Light Plan; код 1 — расходится,
   в выводе первые расхождения.

   Допуски: ответы (код) — строго, высота и азимут солнца — 1e-9°, угол от
   окна — 1e-9°, сдвиг пояса — строго. Сверяются и пороги из паспорта
   фикстуры: если вы поменяли порог в копии, это видно сразу. */
"use strict";

const fs = require("fs");
const path = require("path");

const fxPath = process.argv[2];
if (!fxPath) {
  console.error("нужен путь к window_light.json:  node tools/window_light_check.js <window_light.json> [<window_light.js>]");
  process.exit(2);
}
const libPath = path.resolve(process.argv[3] || path.join(__dirname, "window_light.js"));
const fx = JSON.parse(fs.readFileSync(fxPath, "utf8"));
const WL = require(libPath);

const shown = [];
let total = 0, bad = 0;
function miss(msg) { bad++; if (shown.length < 12) shown.push(msg); }
function code(r) { return fx.meta.codes[r.kind]; }
function ask(p, ms, az, windows) {
  return WL.at({ instant: ms, lat: p.lat, lon: p.lon, timezone: p.zone, windowsAzimuth: az, hasWindows: windows });
}

/* Пороги */
for (const k of Object.keys(fx.meta.thresholds)) {
  total++;
  if (WL.THRESHOLDS[k] !== fx.meta.thresholds[k]) miss("порог " + k + ": в копии " + WL.THRESHOLDS[k] + ", в эталоне " + fx.meta.thresholds[k]);
}

/* Диапазон принимаемых моментов */
total++;
if (!WL.INSTANT_RANGE_MS || WL.INSTANT_RANGE_MS.from !== fx.meta.range.from || WL.INSTANT_RANGE_MS.to !== fx.meta.range.to) {
  miss("диапазон моментов: в копии " + JSON.stringify(WL.INSTANT_RANGE_MS) + ", в эталоне " + JSON.stringify(fx.meta.range));
}

/* Сетка */
const azimuths = fx.meta.azimuths;
for (const day of fx.days) for (const row of day.rows) {
  for (let i = 0; i < azimuths.length; i++) {
    total++;
    const r = ask(day, row[0], azimuths[i], true);
    const tag = day.place + " " + day.date + " мс " + row[0] + " окно " + azimuths[i] + "°";
    if (code(r) !== row[4 + i]) { miss(tag + ": код " + code(r) + " вместо " + row[4 + i]); continue; }
    if (Math.abs(r.sunElevation - row[2]) > 1e-9 || Math.abs(r.sunAzimuth - row[3]) > 1e-9) miss(tag + ": солнце разошлось");
    if (i === 0 && WL._zoneOffsetMs && WL._zoneOffsetMs(row[0], day.zone) !== row[1]) miss(tag + ": сдвиг пояса");
  }
}

/* Пробы порога угла и приведение азимута */
for (const key of ["edge", "norm", "far"]) for (const r of fx[key]) {
  total++;
  const a = ask(r, r.ms, r.windowsAzimuth, true);
  if (code(a) !== r.code || Math.abs(a.offsetFromWindow - r.offset) > 1e-9) miss(key + ": " + r.why + " в " + r.place);
}

/* «Нет данных» и «нет окон» */
for (const c of fx.gaps) {
  total++;
  const i = c.input;
  const a = ask({ lat: i.lat, lon: i.lon, zone: i.zone }, i.ms, i.windowsAzimuth, i.hasWindows);
  if (a.kind !== c.kind || a.reason !== c.reason) miss("«" + c.why + "»: " + a.kind + "/" + a.reason + " вместо " + c.kind + "/" + c.reason);
}

console.log("сверено " + total + " ответов, расхождений: " + bad + "  (копия: " + libPath + ")");
if (bad) { console.log(shown.join("\n")); process.exit(1); }
