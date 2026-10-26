/* Свет в окнах зала: «прямой», «рассветный», «закатный», «рассеянный» — по
   солнцу, без погоды.

   Один самодостаточный файл для BroniOS и сайта студии: ни DOM, ни браузерных
   API, ни зависимостей (только стандартный `Intl` для пояса — он есть и в
   Node, и в браузере). Хозяин правила — Light Plan; Swift-версия лежит в
   native: `LightPlanDomain/Rules/WindowLight.swift`, числа сверки — в
   `native/Fixtures/window_light.json`. Справка: `docs/window_light_reference.md`.

   Вход (один объект):
     instant         момент: `Date`, миллисекунды с 1970 (число) или строка ISO
                     с явным сдвигом ("2026-10-08T14:00:00+07:00" или "…Z");
                     строка без сдвига отвергается — её читают по поясу машины,
                     и ответ зависел бы от того, где запущен код. Принимаются
                     моменты с 1970-01-01 до 2100-01-01 (UTC); остальные —
                     "unknown" / "moment_out_of_range"
     lat, lon        координаты студии, градусы (север и восток положительны)
     timezone        имя пояса зала ("Asia/Tomsk")
     hasWindows      есть ли в зале окна: строго true или false
     windowsAzimuth  куда СМОТРЯТ окна, градусы от севера по часовой
                     (0 север, 90 восток, 180 юг, 270 запад); любое число,
                     приводится к 0…360

   Выход: { kind, reason, half, sunElevation, sunAzimuth, offsetFromWindow }
     kind  "direct"   прямой: солнце над горизонтом и светит в окна
           "sunrise"  рассветный: то же, но солнце низкое и тёплое утром
                      (утренний золотой час); half = "morning"
           "sunset"   закатный: то же вечером (вечерний золотой час);
                      half = "evening"
           "diffuse"  рассеянный: солнце в окна не светит (за стеной, у самого
                      горизонта, ниже горизонта, ночью)
           "none"     в зале нет окон
           "unknown"  нет данных; reason говорит каких (см. REASONS) — значение
                      не выдумывается
     sunElevation, sunAzimuth, offsetFromWindow — градусы; offsetFromWindow —
     угол между азимутом солнца и азимутом окон, 0…180. У "none" и "unknown"
     все три null. half заполнен только у "sunrise" и "sunset".

   Что НЕ учтено (честно): погода (облака не смотрим — «по солнцу, без
   погоды»), размер окна, преграды (дом напротив, деревья, козырёк), глубина
   зала, преломление в атмосфере (как и в солнечной модели Light Plan).

   Солнце — копия модели NOAA из `beta/index.html` (`computeSun`, `elevAt`,
   `azAt`); стенд паритета `native/Tools/parity/` на каждом прогоне сверяет её
   с живой бетой до 1e-9° и падает, если бета ушла. Правишь модель в бете —
   правь и здесь. */
(function (root) {
  "use strict";

  /* ============================================================
     ПОРОГИ — выбор исполнителя 08.10, Алексей может подправить.
     Меняются здесь и в Swift (WindowLight.swift) одновременно; сверка
     упадёт, если разойдутся. Обоснование — в docs/window_light_reference.md.
     ============================================================ */
  /* Ниже — солнце у самого горизонта: свет идёт сквозь самый толстый слой
     воздуха и закрыт любым забором. Окно его «не ловит». */
  var MIN_ELEVATION = 2;
  /* Верх золотого часа — та же шестёрка, что `goldA`/`goldB` солнечной модели
     (`tAtElev(6, …)`). Между MIN_ELEVATION и ею — закатный, выше — прямой. */
  var GOLD_ELEVATION = 6;
  /* Солнце «перед окном», если азимут солнца отличается от азимута окон не
     более чем на столько. 90° — плоскость стены (луч идёт вдоль неё), 85° —
     с запасом в 5°: на таком скосе луч лишь скользит по откосу окна. */
  var MAX_OFFSET = 85;
  /* Какие моменты считаем: с 1970-01-01 до 2100-01-01 UTC (мс, правая граница не
     входит). Дальше — нечего ждать от пояса (правила часов известны не дальше
     этого) и от солнечной модели; а очень большое число ломает календарь
     (`Date` кончается на ±8.64e15 мс, Intl бросает исключение). */
  var MIN_INSTANT_MS = 0;
  var MAX_INSTANT_MS = 4102444800000;

  var REASONS = {
    no_windows_flag: "hasWindows не true и не false",
    no_azimuth: "у зала нет азимута окон (windowsAzimuth — не число)",
    no_coordinates: "нет координат студии или они вне диапазона",
    no_zone: "нет пояса зала (timezone)",
    bad_zone: "пояс зала не найден в базе (имя вида Asia/Tomsk)",
    bad_moment: "момент не распознан (нужен Date, число мс или ISO со сдвигом)",
    moment_out_of_range: "момент вне 1970-01-01 … 2100-01-01 (UTC)"
  };

  var LABELS_RU = {
    direct: "прямой",
    sunrise: "рассветный",
    sunset: "закатный",
    diffuse: "рассеянный",
    none: "нет окон",
    unknown: "нет данных"
  };

  var NOTE = "по солнцу, без погоды";

  /* ---------- Мелкая математика (те же rad/deg/clamp, что в бете) ---------- */
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* ---------- Календарь без Date: дни от 1970-01-01, алгоритм Хиннанта ---------- */
  function daysFromCivil(y, m, d) {
    var yy = m <= 2 ? y - 1 : y;
    var era = Math.floor(yy / 400);
    var yoe = yy - era * 400;
    var mp = (m + 9) % 12;
    var doy = Math.floor((153 * mp + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function yearOfDays(z) {
    var z2 = z + 719468;
    var era = Math.floor(z2 / 146097);
    var doe = z2 - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var m = mp < 10 ? mp + 3 : mp - 9;
    return m <= 2 ? y + 1 : y;
  }

  /* ---------- Момент → миллисекунды ---------- */
  function toMs(v) {
    /* не `instanceof`: Date из другого окна или песочницы ему не принадлежит */
    if (Object.prototype.toString.call(v) === "[object Date]") return v.getTime();
    if (isNum(v)) return v;
    if (typeof v === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d(:?\d\d)?)$/.test(v)) {
      return Date.parse(v.replace(" ", "T"));
    }
    return NaN;
  }

  /* ---------- Сдвиг пояса на момент, миллисекунды ---------- */
  var fmtCache = {};
  function zoneOffsetMs(ms, zone) {
    var f = fmtCache[zone];
    if (!f) {
      try {
        f = new Intl.DateTimeFormat("en-US", {
          timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
          hour: "numeric", minute: "numeric", second: "numeric"
        });
      } catch (e) { return null; }
      fmtCache[zone] = f;
    }
    var o = {}, parts = f.formatToParts(new Date(ms));
    for (var i = 0; i < parts.length; i++) o[parts[i].type] = parseInt(parts[i].value, 10);
    var wall = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second);
    return wall - Math.floor(ms / 1000) * 1000;
  }

  /* ---------- Солнце: копия `computeSun` / `elevAt` / `azAt` беты ----------
     doy — номер дня в году по часам зала, tz — сдвиг пояса в часах на момент,
     t — минуты от местной полуночи. */
  function sunAt(lat, lon, doy, tz, t) {
    var g = 2 * Math.PI / 365 * (doy - 1 + 0.5);
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
             - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
             - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
           - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var solarNoon = 720 - 4 * lon - eq + tz * 60;
    var ha = rad((t - solarNoon) * 0.25);
    var s = Math.sin(rad(lat)) * Math.sin(decl) + Math.cos(rad(lat)) * Math.cos(decl) * Math.cos(ha);
    var elevation = deg(Math.asin(clamp(s, -1, 1)));
    var a = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(rad(lat)) - Math.tan(decl) * Math.cos(rad(lat)));
    var azimuth = (deg(a) + 180 + 360) % 360;
    return { elevation: elevation, azimuth: azimuth, afterNoon: t >= solarNoon };
  }

  function answer(kind, reason, half, el, az, off) {
    return {
      kind: kind, reason: reason, half: half,
      sunElevation: el, sunAzimuth: az, offsetFromWindow: off
    };
  }
  function unknown(reason) { return answer("unknown", reason, null, null, null, null); }

  /* ============================================================
     ПРАВИЛО
     ============================================================ */
  function at(input) {
    var p = input || {};
    /* Окон нет — ответ готов и без координат, момента и пояса */
    if (p.hasWindows === false) return answer("none", null, null, null, null, null);
    if (p.hasWindows !== true) return unknown("no_windows_flag");
    if (!isNum(p.windowsAzimuth)) return unknown("no_azimuth");
    if (!isNum(p.lat) || !isNum(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return unknown("no_coordinates");
    if (typeof p.timezone !== "string" || p.timezone === "") return unknown("no_zone");
    var ms = toMs(p.instant);
    if (!isNum(ms)) return unknown("bad_moment");
    if (ms < MIN_INSTANT_MS || ms >= MAX_INSTANT_MS) return unknown("moment_out_of_range");
    var offMs = zoneOffsetMs(ms, p.timezone);
    if (offMs === null) return unknown("bad_zone");

    /* Сутки и минуты — по часам зала на этот момент */
    var localMs = ms + offMs;
    var dayNum = Math.floor(localMs / 86400000);
    var t = (localMs - dayNum * 86400000) / 60000;
    var doy = dayNum - daysFromCivil(yearOfDays(dayNum), 1, 1) + 1;
    var sun = sunAt(p.lat, p.lon, doy, offMs / 3600000, t);

    var wa = ((p.windowsAzimuth % 360) + 360) % 360;
    var d = Math.abs(sun.azimuth - wa);
    if (d > 180) d = 360 - d;

    if (sun.elevation < MIN_ELEVATION || d > MAX_OFFSET) {
      return answer("diffuse", null, null, sun.elevation, sun.azimuth, d);
    }
    if (sun.elevation <= GOLD_ELEVATION) {
      return answer(sun.afterNoon ? "sunset" : "sunrise", null, sun.afterNoon ? "evening" : "morning",
        sun.elevation, sun.azimuth, d);
    }
    return answer("direct", null, null, sun.elevation, sun.azimuth, d);
  }

  var api = {
    at: at,
    THRESHOLDS: { minElevation: MIN_ELEVATION, goldElevation: GOLD_ELEVATION, maxOffset: MAX_OFFSET },
    INSTANT_RANGE_MS: { from: MIN_INSTANT_MS, to: MAX_INSTANT_MS },
    REASONS: REASONS,
    LABELS_RU: LABELS_RU,
    NOTE: NOTE,
    /* Для стенда паритета: солнце без правила */
    _sunAt: sunAt,
    _zoneOffsetMs: zoneOffsetMs
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WindowLight = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
