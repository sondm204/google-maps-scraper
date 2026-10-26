const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts/review-time.js'), 'utf8'), context);
const time = context.REVIEW_TIME;

test('10:00 minus 11 hours belongs to yesterday in GMT+7', () => {
    const capturedAt = Date.parse('2026-10-27T10:00:00+07:00');
    const postedAt = time.estimateTimestamp('11 giờ trước', capturedAt);
    assert.equal(postedAt, Date.parse('2026-10-26T23:00:00+07:00'));
    assert.equal(time.dateKey(postedAt), '2026-10-26');
    assert.equal(time.sheetDateSerial(postedAt), Date.parse('2026-10-26T00:00:00Z') / 86400000 + 25569);
});

test('Vietnamese and English relative times use the capture timestamp', () => {
    const capturedAt = Date.parse('2026-10-27T10:00:00+07:00');
    for (const [text, minutes] of [
        ['1 phút trước', 1], ['một giờ trước', 60], ['an hour ago', 60],
        ['11 hours ago', 660], ['một tuần trước', 10080], ['2 weeks ago', 20160],
        ['hôm qua', 1440], ['yesterday', 1440], ['vừa xong', 0]
    ]) {
        assert.equal(time.estimateTimestamp(text, capturedAt), capturedAt - minutes * 60000, text);
    }
    assert.equal(time.estimateTimestamp('Unknown date', capturedAt), null);
    assert.equal(time.estimateTimestamp('1 giờ trước', undefined), null);
});

test('calendar month/year estimates clamp month ends and leap days', () => {
    assert.equal(time.dateKey(time.estimateTimestamp('một tháng trước',
        Date.parse('2026-03-31T10:00:00+07:00'))), '2026-02-28');
    assert.equal(time.dateKey(time.estimateTimestamp('một năm trước',
        Date.parse('2024-02-29T10:00:00+07:00'))), '2023-02-28');
});

test('first of month includes midnight and excludes yesterday, even for a weekly period', () => {
    const referenceAt = Date.parse('2026-11-01T10:00:00+07:00');
    const window = time.sessionWindow(referenceAt);
    assert.equal(window.startAt, Date.parse('2026-11-01T00:00:00+07:00'));
    assert.equal(time.inWindow(time.estimateTimestamp('11 giờ trước', referenceAt), window), false);
    assert.equal(time.inWindow(time.estimateTimestamp('10 giờ trước', referenceAt), window), true);
    assert.equal(time.inWindow(time.estimateTimestamp('3 giờ trước', referenceAt), window), true);
    assert.equal(time.sessionWindow(Date.parse('2026-11-02T10:00:00+07:00')).startAt, null);
});

test('month-end window stays on the old month if crawling crosses midnight', () => {
    const window = time.sessionWindow(Date.parse('2026-10-31T23:59:00+07:00'), true);
    const capturedAt = Date.parse('2026-11-01T00:05:00+07:00');
    assert.equal(time.inWindow(time.estimateTimestamp('10 phút trước', capturedAt), window), true);
    assert.equal(time.inWindow(time.estimateTimestamp('1 phút trước', capturedAt), window), false);
    assert.equal(window.endAt, Date.parse('2026-10-31T23:59:59.999+07:00'));
});
