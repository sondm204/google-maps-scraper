const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIST = 'div[jsname="GmP9w"] > div.OG9A1';

function container(times) {
  const children = times.map(time => ({
    querySelector: selector => selector === '.y3Ibjb' ? { textContent: time } : null
  }));
  return { children, firstElementChild: children[0], innerHTML: times.join('|') };
}

function createHarness() {
  const nodes = new Map();
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  class ClockDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: ClockDate,
    console,
    document: { querySelector: selector => nodes.get(selector) || null },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      async sendMessage() { return { config: null }; }
    } },
    setTimeout(callback, ms) { timers.set(++timerId, { callback, at: now + ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts/review-time.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts/content.js'), 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    nodes,
    run: code => vm.runInContext(code, context),
    async advance(ms) {
      const target = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

test('does not read the old list before delayed sorting; the example retains nine hourly reviews', async () => {
  const h = createHarness();
  h.nodes.set(LIST, container(['2 tháng trước']));
  let resolved = false;
  const waiting = h.run('waitForReviewList({ beforeSort: readReviewListState(), sortStartedAt: Date.now() })')
    .then(value => { resolved = true; return value; });
  await h.advance(2000);
  assert.equal(resolved, false);

  const times = ['3 giờ trước', '3 giờ trước', '3 giờ trước', '8 giờ trước', '8 giờ trước',
    '8 giờ trước', '9 giờ trước', '9 giờ trước', '22 giờ trước', '1 ngày trước'];
  const sorted = container(times);
  h.nodes.set(LIST, sorted);
  await h.advance(800);
  assert.equal(await waiting, sorted);
  const boundary = times.findIndex(time => h.run(`isPeriodBoundary(${JSON.stringify(time)}, 'day')`));
  assert.equal(boundary, 9);
});

test('waits for the exact delayed container even if an unrelated .OG9A1 already exists', async () => {
  const h = createHarness();
  h.nodes.set('.OG9A1', container(['old irrelevant element']));
  let resolved = false;
  const waiting = h.run('waitForReviewList()').then(value => { resolved = true; return value; });
  await h.advance(2000);
  assert.equal(resolved, false);
  h.nodes.set(LIST, container([]));
  await h.advance(1000);
  assert.equal(resolved, false);
  const ready = container(['3 giờ trước']);
  h.nodes.set(LIST, ready);
  await h.advance(800);
  assert.equal(await waiting, ready);
});

test('allows an unchanged list if it was already sorted, after the five-second grace period', async () => {
  const h = createHarness();
  const ready = container(['3 giờ trước']);
  h.nodes.set(LIST, ready);
  let resolved = false;
  const waiting = h.run('waitForReviewList({ beforeSort: readReviewListState(), sortStartedAt: Date.now() })')
    .then(value => { resolved = true; return value; });
  await h.advance(4800);
  assert.equal(resolved, false);
  await h.advance(400);
  assert.equal(await waiting, ready);
});

test('restarts the stability window when Google replaces a loaded container', async () => {
  const h = createHarness();
  h.nodes.set(LIST, container(['3 giờ trước']));
  let resolved = false;
  const waiting = h.run('waitForReviewList()').then(value => { resolved = true; return value; });
  await h.advance(400);
  const replacement = container(['2 giờ trước']);
  h.nodes.set(LIST, replacement);
  await h.advance(400);
  assert.equal(resolved, false);
  await h.advance(400);
  assert.equal(await waiting, replacement);
});

test('missing list has a bounded timeout', async () => {
  const h = createHarness();
  const waiting = h.run('waitForReviewList({ timeoutMs: 1000 })');
  const rejected = assert.rejects(waiting, /Danh sách review chưa tải ổn định/);
  await h.advance(1200);
  await rejected;
});

test('first-day crawl stops at yesterday even if the time unit is hours and period is week', () => {
  const h = createHarness();
  const capturedAt = Date.parse('2026-11-01T10:00:00+07:00');
  assert.equal(h.run(`isReviewBoundary('11 giờ trước', 'week', ${capturedAt}, REVIEW_TIME.sessionWindow(${capturedAt}))`), true);
  assert.equal(h.run(`isReviewBoundary('3 giờ trước', 'week', ${capturedAt}, REVIEW_TIME.sessionWindow(${capturedAt}))`), false);
});
