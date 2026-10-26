const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const headers = ['Ngày', 'Kênh', 'Địa điểm', 'Rate', 'Phân loại', 'Lý do', 'Chi tiết'];
const copy = value => JSON.parse(JSON.stringify(value));
const settingsContext = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), settingsContext);
const defaults = copy(settingsContext.REVIEW_COLLECTOR_DEFAULTS);
const scheduledTime = Date.UTC(2026, 9, 26, defaults.dailyHour - 7, defaults.dailyMinute);
const timeLabel = `${String(defaults.dailyHour).padStart(2, '0')}:${String(defaults.dailyMinute).padStart(2, '0')}`;

async function harness(shared = {}) {
  shared.store ||= {};
  shared.alarms ||= new Map();
  shared.rows ||= [['old date', 'CRM', 'old place', 3, 'old classification', 'old reason', 'old comment']];
  shared.now ??= Date.parse('2026-10-26T02:59:00Z');
  const messages = [];
  const notifications = [];
  const tabs = [];
  const requests = [];
  const timers = new Map();
  const listeners = {};
  let timerId = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [shared.now])); }
    static now() { return shared.now; }
  }
  const chrome = {
    runtime: {
      onMessage: { addListener: cb => { listeners.message = cb; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }
    },
    storage: { local: {
      async get(keys) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (shared.store[key] !== undefined) result[key] = shared.store[key];
        }
        return copy(result);
      },
      async set(values) { Object.assign(shared.store, copy(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete shared.store[key]; }
    } },
    alarms: {
      async get(name) { return shared.alarms.get(name); },
      async create(name, alarm) { shared.alarms.set(name, copy(alarm)); },
      async clear(name) { return shared.alarms.delete(name); },
      onAlarm: { addListener: cb => { listeners.alarm = cb; } }
    },
    identity: {
      getAuthToken(options, cb) { cb('test-token'); },
      async clearAllCachedAuthTokens() {}
    },
    notifications: { async create(id, options) { notifications.push({ id, ...copy(options) }); } },
    tabs: {
      onRemoved: { addListener() {} },
      async create(options) { const tab = { id: 100 + tabs.length, ...options }; tabs.push(tab); return tab; },
      async sendMessage(id, message) { messages.push({ id, ...message }); }
    }
  };
  const context = vm.createContext({
    chrome, Date: ClockDate, crypto: { randomUUID },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(cb, delay) { timers.set(++timerId, { cb, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, body });
      let data;
      if (url.includes('?fields=')) data = { sheets: [{ properties: { title: '01 | Nhập data', sheetId: 15651655 } }] };
      else if (decodeURIComponent(url).includes('!A4:G4')) data = { values: [shared.header || headers] };
      else if (url.includes(':append?')) {
        const start = shared.rows.length + 5;
        shared.rows.push(...copy(body.values));
        data = { updates: { updatedRange: `'01 | Nhập data'!A${start}:G${shared.rows.length + 4}` } };
      } else if (url.endsWith(':batchUpdate')) {
        if (shared.failFormat) return { ok: false, status: 400, async json() { return { error: { message: 'format error' } }; } };
        data = {};
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, async json() { return data; } };
    }
  });
  context.importScripts = (...files) => files.forEach(file =>
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const flush = () => vm.runInContext('taskQueue', context);
  await flush();
  const message = (request, tabId) => new Promise(resolve => listeners.message(request,
    tabId === undefined ? {} : { tab: { id: tabId } }, resolve));
  return { shared, context, chrome, tabs, requests, timers, notifications, message, flush,
    async alarm(name, scheduledTime) { listeners.alarm({ name, scheduledTime }); await flush(); } };
}

test('daily job uses the configured GMT+7 time and locations, announces and waits 10s', async () => {
  const h = await harness({ now: scheduledTime - 60000 });
  assert.equal(h.shared.alarms.get('dailyReviewCrawl').when, scheduledTime);
  h.shared.now = scheduledTime;
  await h.alarm('dailyReviewCrawl');
  assert.equal(h.tabs.length, 0);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].message, /10 giây/);
  assert.equal(h.shared.alarms.get('dailyReviewCrawl').when, scheduledTime + 86400000);
  const timer = [...h.timers.values()].find(item => item.delay === 10000);
  assert.ok(timer);
  h.shared.now += 10000;
  timer.cb();
  await h.flush();
  assert.equal(h.tabs.length, 1);
  const config = h.shared.store.crawlConfig;
  assert.deepEqual(config.facilities, defaults.facilities);
  assert.equal(config.reviewPeriod, 'day');
  assert.equal(config.collectedDate, '2026-10-26');
  assert.equal(config.sheetName, '01 | Nhập data');
  assert.equal(config.source, 'daily');
  await h.alarm('startDailyReviewCrawl');
  assert.equal(h.tabs.length, 1);
});

test('reload replaces the saved 10:00 alarm and allows testing after an earlier daily run', async () => {
  const h = await harness({
    now: scheduledTime - 60000,
    store: { dailyScheduleTime: '10:00', lastDailyStarted: '2026-10-26' },
    alarms: new Map([['dailyReviewCrawl', { when: Date.parse('2026-10-27T03:00:00Z') }]])
  });
  assert.equal(h.shared.alarms.get('dailyReviewCrawl').when, scheduledTime);
  assert.equal(h.shared.store.dailyScheduleTime, timeLabel);
  h.shared.now = scheduledTime;
  await h.alarm('dailyReviewCrawl');
  assert.equal(h.notifications.length, 1);
  assert.ok(h.shared.store.pendingDailyJob);
});

test('append below row 4 preserves existing data, skips E/F and formats only new date/dropdown cells', async () => {
  const h = await harness();
  const oldRows = copy(h.shared.rows);
  assert.equal((await h.message({ action: 'startMultiProcess', values: { facilities: ['Koh Yam 34A Quang Trung'] } })).success, true);
  assert.ok(decodeURIComponent(h.tabs[0].url).includes('Koh Yam 34A Quang Trung'));
  const result = await h.message({ action: 'cacheData', values: { number: 1, rate: ['4,0'], comment: ['=hello\nsecond line'],
    time: ['1 giờ trước'], capturedAt: [h.shared.now] } }, 100);
  assert.equal(result.success, true);
  assert.deepEqual(h.shared.rows.slice(0, oldRows.length), oldRows);
  const row = h.shared.rows.at(-1);
  assert.deepEqual(row.slice(1), ['Google Map', '34A Quang Trung', 4, null, null, '=hello\nsecond line']);
  assert.equal(row[0], Date.parse('2026-10-26T00:00:00Z') / 86400000 + 25569);
  const append = h.requests.find(item => item.url.includes(':append?'));
  assert.match(append.url, /valueInputOption=RAW&insertDataOption=INSERT_ROWS/);
  assert.match(append.url, /1jyMx0ihlNUwliQndUUi8MYSksxKGNjNYqlHfFpxBu-w/);
  assert.ok(decodeURIComponent(append.url).includes("'01 | Nhập data'!A4:G:append"));
  assert.equal(row.length, 7);
  const format = h.requests.find(item => item.url.endsWith(':batchUpdate')).body.requests;
  assert.equal(format.length, 2);
  assert.equal(format[0].repeatCell.range.startRowIndex, 5);
  assert.equal(format[1].setDataValidation.range.startColumnIndex, 2);
  assert.equal(format[1].setDataValidation.range.endColumnIndex, 3);
  const dropdownValues = format[1].setDataValidation.rule.condition.values.map(item => item.userEnteredValue);
  assert.ok(dropdownValues.includes('34A Quang Trung'));
  assert.ok(!dropdownValues.some(value => value.startsWith('Koh Yam ')));
  // Duplicate delivery must not append the same batch twice.
  await h.message({ action: 'cacheData', values: { number: 1, rate: ['4,0'], comment: ['duplicate'] } }, 100);
  assert.equal(h.shared.rows.length, 2);
  await h.message({ action: 'tabProcessed' }, 100);
  assert.equal(h.shared.store.crawlConfig.status, 'completed');
});

test('worker restart retains active session and append position; formatting error never retries saved rows', async () => {
  const first = await harness();
  await first.message({ action: 'startMultiProcess', values: { facilities: ['Place 1', 'Place 2'] } });
  await first.message({ action: 'cacheData', values: { number: 0, rate: [], comment: [] } }, 100);
  await first.message({ action: 'tabProcessed' }, 100);
  const restarted = await harness(first.shared);
  restarted.shared.failFormat = true;
  const result = await restarted.message({ action: 'cacheData', values: { number: 1, rate: ['5,0'], comment: ['text'],
    time: ['1 giờ trước'], capturedAt: [restarted.shared.now] } }, 101);
  assert.equal(result.success, true);
  assert.equal(result.warning, 'format error');
  assert.equal(restarted.shared.rows.at(-1)[2], 'Place 2');
  assert.equal(restarted.shared.rows.length, 2);
  await restarted.message({ action: 'tabProcessed' }, 101);
  assert.equal(restarted.shared.store.crawlConfig.status, 'completed');
});

test('wrong destination header stops before opening Google or writing data', async () => {
  const h = await harness({ header: ['Wrong header'] });
  const result = await h.message({ action: 'startMultiProcess', values: { facilities: ['Test Place'] } });
  assert.equal(result.success, false);
  assert.match(result.error, /Header A4:G4/);
  assert.equal(h.tabs.length, 0);
  assert.equal(h.requests.filter(item => item.body).length, 0);
});

test('empty data table appends from row 5, never writing into the header or title rows', async () => {
  const h = await harness({ rows: [] });
  await h.message({ action: 'startMultiProcess', values: { facilities: ['Test Place'] } });
  const result = await h.message({ action: 'cacheData', values: {
    number: 1, rate: ['5,0'], comment: ['First review'], time: ['1 giờ trước'], capturedAt: [h.shared.now]
  } }, 100);
  assert.equal(result.success, true);
  assert.equal(result.updatedRange, "'01 | Nhập data'!A5:G5");
  const writes = h.requests.filter(item => item.body);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body.requests[0].repeatCell.range.startRowIndex, 4);
});

test('each row stores its estimated posting date instead of the collection date', async () => {
  const capturedAt = Date.parse('2026-10-27T10:00:00+07:00');
  const h = await harness({ now: capturedAt, rows: [] });
  await h.message({ action: 'startMultiProcess', values: { facilities: ['Test Place'] } });
  const result = await h.message({ action: 'cacheData', values: {
    number: 2, rate: ['4,0', '5,0'], comment: ['yesterday', 'today'],
    time: ['11 giờ trước', '3 giờ trước'], capturedAt: [capturedAt, capturedAt]
  } }, 100);
  assert.equal(result.savedCount, 2);
  assert.equal(h.shared.rows[0][0], Date.parse('2026-10-26T00:00:00Z') / 86400000 + 25569);
  assert.equal(h.shared.rows[1][0], Date.parse('2026-10-27T00:00:00Z') / 86400000 + 25569);
});

test('first-day session filters yesterday before append', async () => {
  const capturedAt = Date.parse('2026-11-01T10:00:00+07:00');
  const h = await harness({ now: capturedAt, rows: [] });
  await h.message({ action: 'startMultiProcess', values: { facilities: ['Test Place'], reviewPeriod: 'week' } });
  const result = await h.message({ action: 'cacheData', values: {
    number: 2, rate: ['4,0', '5,0'], comment: ['yesterday', 'today'],
    time: ['11 giờ trước', '3 giờ trước'], capturedAt: [capturedAt, capturedAt]
  } }, 100);
  assert.equal(result.savedCount, 1);
  assert.equal(h.shared.rows.length, 1);
  assert.equal(h.shared.rows[0][6], 'today');
});

test('month-end alarm handles 30/31 days, leap February and December rollover', async () => {
  const h = await harness();
  for (const [now, expected] of [
    ['2026-10-01T00:00:00+07:00', '2026-10-31T23:59:00+07:00'],
    ['2026-11-01T00:00:00+07:00', '2026-11-30T23:59:00+07:00'],
    ['2024-02-01T00:00:00+07:00', '2024-02-29T23:59:00+07:00'],
    ['2026-02-01T00:00:00+07:00', '2026-02-28T23:59:00+07:00'],
    ['2026-12-31T23:59:00+07:00', '2027-01-31T23:59:00+07:00']
  ]) {
    assert.equal(vm.runInContext(`nextMonthEndTime(${Date.parse(now)})`, h.context), Date.parse(expected));
  }
});

test('month-end job is separate from daily job and waits if a session is running', async () => {
  const referenceAt = Date.parse('2026-10-31T23:59:00+07:00');
  const h = await harness({ now: referenceAt, rows: [], store: {
    lastDailyStarted: `2026-10-31@${timeLabel}`, crawlConfig: { status: 'running' }
  } });
  await h.alarm('monthEndReviewCrawl', referenceAt);
  assert.equal(h.tabs.length, 0);
  assert.match(h.notifications[0].title, /cuối tháng/);
  assert.equal(h.shared.alarms.get('monthEndReviewCrawl').when, Date.parse('2026-11-30T23:59:00+07:00'));
  h.shared.now += 10000;
  await h.alarm('startMonthEndReviewCrawl');
  assert.equal(h.tabs.length, 0);
  assert.ok(h.shared.store.pendingMonthEndJob);
  h.shared.store.crawlConfig.status = 'completed';
  h.shared.now = h.shared.store.pendingMonthEndJob.startAt;
  await h.alarm('startMonthEndReviewCrawl');
  assert.equal(h.tabs.length, 1);
  const config = h.shared.store.crawlConfig;
  assert.equal(config.source, 'month-end');
  assert.equal(config.reviewWindow.startAt, Date.parse('2026-10-31T00:00:00+07:00'));
  assert.equal(config.reviewWindow.endAt, Date.parse('2026-10-31T23:59:59.999+07:00'));
  const result = await h.message({ action: 'cacheData', values: {
    number: 2, rate: ['4,0', '5,0'], comment: ['old month', 'new month'],
    time: ['2 phút trước', 'vừa xong'], capturedAt: [h.shared.now, h.shared.now]
  } }, 100);
  assert.equal(result.savedCount, 1);
  assert.equal(h.shared.rows[0][6], 'old month');
  assert.equal(h.shared.rows[0][0], Date.parse('2026-10-31T00:00:00Z') / 86400000 + 25569);
});
