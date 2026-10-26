// Dùng chung trong content script và background, luôn tính ngày theo GMT+7.
(() => {
    const DAY_MS = 86400000;
    const OFFSET_MS = 7 * 60 * 60 * 1000;

    function dateKey(timestamp) {
        return new Date(timestamp + OFFSET_MS).toISOString().slice(0, 10);
    }

    function startOfDay(timestamp) {
        return Date.parse(`${dateKey(timestamp)}T00:00:00+07:00`);
    }

    function estimateTimestamp(value, capturedAt) {
        if (!Number.isFinite(capturedAt)) return null;
        const text = String(value || '').normalize('NFC').toLowerCase().trim();
        if (/vừa xong|mới đây|ngay bây giờ|just now|a moment ago|hôm nay|today/.test(text)) return capturedAt;
        if (/hôm qua|yesterday/.test(text)) return capturedAt - DAY_MS;

        const match = text.match(/(\d+|một|mot|one|an?|vài|a few)\s+(giây|phút|giờ|ngày|tuần|tháng|năm|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)/);
        if (!match) return null;
        const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : /vài|a few/.test(match[1]) ? 3 : 1;
        const unit = match[2];
        if (/^(giây|sec)/.test(unit)) return capturedAt - amount * 1000;
        if (/^(phút|min)/.test(unit)) return capturedAt - amount * 60000;
        if (/^(giờ|hour|hr)/.test(unit)) return capturedAt - amount * 3600000;
        if (/^(ngày|day)/.test(unit)) return capturedAt - amount * DAY_MS;
        if (/^(tuần|week)/.test(unit)) return capturedAt - amount * 7 * DAY_MS;

        // Tháng/năm tính theo lịch địa phương, chặn tràn ngày 31 sang tháng kế.
        const local = new Date(capturedAt + OFFSET_MS);
        const day = local.getUTCDate();
        local.setUTCDate(1);
        if (/^(tháng|month)/.test(unit)) local.setUTCMonth(local.getUTCMonth() - amount);
        else if (/^(năm|year)/.test(unit)) local.setUTCFullYear(local.getUTCFullYear() - amount);
        else return null;
        const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
        local.setUTCDate(Math.min(day, lastDay));
        return local.getTime() - OFFSET_MS;
    }

    function sessionWindow(referenceAt, monthEnd = false) {
        const isFirstDay = new Date(referenceAt + OFFSET_MS).getUTCDate() === 1;
        return {
            startAt: monthEnd || isFirstDay ? startOfDay(referenceAt) : null,
            endAt: monthEnd ? startOfDay(referenceAt) + DAY_MS - 1 : null
        };
    }

    function inWindow(timestamp, window = {}) {
        return Number.isFinite(timestamp) &&
            (window.startAt == null || timestamp >= window.startAt) &&
            (window.endAt == null || timestamp <= window.endAt);
    }

    function sheetDateSerial(timestamp) {
        return Date.parse(`${dateKey(timestamp)}T00:00:00Z`) / DAY_MS + 25569;
    }

    globalThis.REVIEW_TIME = Object.freeze({ dateKey, estimateTimestamp, sessionWindow, inWindow, sheetDateSerial });
})();
