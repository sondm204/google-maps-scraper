importScripts('config.js', 'scripts/review-time.js');

const DEFAULTS = globalThis.REVIEW_COLLECTOR_DEFAULTS;
const DAILY_TIME = `${String(DEFAULTS.dailyHour).padStart(2, '0')}:${String(DEFAULTS.dailyMinute).padStart(2, '0')}`;
const DAILY_ALARM = 'dailyReviewCrawl';
const START_ALARM = 'startDailyReviewCrawl';
const START_NOTIFICATION = 'daily-review-start';
const MONTH_END_ALARM = 'monthEndReviewCrawl';
const JOBS = {
  daily: { pendingKey: 'pendingDailyJob', lastKey: 'lastDailyStarted', startAlarm: START_ALARM, time: DAILY_TIME },
  'month-end': { pendingKey: 'pendingMonthEndJob', lastKey: 'lastMonthEndStarted', startAlarm: 'startMonthEndReviewCrawl', time: '23:59' }
};
const EXPECTED_HEADERS = ['Ngày', 'Kênh', 'Địa điểm', 'Rate', 'Phân loại', 'Lý do', 'Chi tiết'];
const SHEET_RANGE = `'${DEFAULTS.sheetName.replace(/'/g, "''")}'`;
const SHEETS_URL = `https://sheets.googleapis.com/v4/spreadsheets/${DEFAULTS.spreadsheetId}`;

// Tuần tự hóa các event để hai session không ghi đè cấu hình của nhau.
let taskQueue = Promise.resolve();
const countdownTimers = new Map();
function enqueue(task) {
  const result = taskQueue.then(task);
  taskQueue = result.catch(error => console.error(error));
  return result;
}

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      const error = chrome.runtime.lastError;
      if (error || !token) reject(new Error(error?.message || 'Vui lòng đăng nhập Google trước khi chạy.'));
      else resolve(token);
    });
  });
}

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: 'logo.png', title, message });
  } catch (error) {
    console.warn('Không hiển thị được thông báo:', error);
  }
}

function bangkokDateKey(timestamp = Date.now()) {
  return new Date(timestamp + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextDailyTime(timestamp = Date.now()) {
  const local = new Date(timestamp + 7 * 60 * 60 * 1000);
  // Quy đổi giờ GMT+7 sang UTC, không phụ thuộc múi giờ máy chạy Chrome.
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    DEFAULTS.dailyHour - 7, DEFAULTS.dailyMinute);
  if (next <= timestamp) next += 24 * 60 * 60 * 1000;
  return next;
}

async function armDailyAlarm() {
  await chrome.alarms.create(DAILY_ALARM, { when: nextDailyTime() });
}

function nextMonthEndTime(timestamp = Date.now()) {
  const local = new Date(timestamp + 7 * 60 * 60 * 1000);
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0, 16, 59);
  if (next <= timestamp) next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 2, 0, 16, 59);
  return next;
}

async function armMonthEndAlarm() {
  await chrome.alarms.create(MONTH_END_ALARM, { when: nextMonthEndTime() });
}

async function apiRequest(token, path, options = {}) {
  const response = await fetch(`${SHEETS_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Google Sheets API: HTTP ${response.status}`);
  return data;
}

async function getDestination(token) {
  const metadata = await apiRequest(token, '?fields=sheets.properties');
  const sheet = metadata.sheets?.find(item => item.properties.title === DEFAULTS.sheetName);
  if (!sheet) throw new Error(`Không tìm thấy tab ${DEFAULTS.sheetName} trong spreadsheet đã cấu hình.`);

  const header = await apiRequest(token, `/values/${encodeURIComponent(`${SHEET_RANGE}!A4:G4`)}`);
  if (!EXPECTED_HEADERS.every((title, index) => header.values?.[0]?.[index]?.trim() === title)) {
    throw new Error(`Header A4:G4 của ${DEFAULTS.sheetName} phải là: ` + EXPECTED_HEADERS.join(' | '));
  }
  return sheet.properties.sheetId;
}

async function startCrawlSession(values = {}, source = 'manual') {
  const stored = await chrome.storage.local.get('crawlConfig');
  if (stored.crawlConfig?.status === 'running') {
    throw new Error('Một session đang chạy. Vui lòng đợi hoàn tất.');
  }

  const facilities = [...new Set((values.facilities || DEFAULTS.facilities)
    .map(item => item.trim()).filter(Boolean))];
  if (!facilities.length) throw new Error('Vui lòng nhập ít nhất một địa điểm.');
  const reviewPeriod = ['day', 'week', 'month', 'year'].includes(values.reviewPeriod)
    ? values.reviewPeriod : DEFAULTS.reviewPeriod;

  // Kiểm tra quyền và đúng tab/header trước khi mở các trang Google.
  const token = await getAuthToken();
  const sheetId = await getDestination(token);
  const config = {
    sessionId: crypto.randomUUID(), status: 'running', source,
    spreadsheetId: DEFAULTS.spreadsheetId, sheetName: DEFAULTS.sheetName, sheetId,
    facilities, reviewPeriod, currentTabIndex: 0, facility: facilities[0],
    collectedDate: bangkokDateKey(), startedAt: Date.now(), totalReviews: 0,
    reviewWindow: REVIEW_TIME.sessionWindow(values.referenceAt ?? Date.now(), source === 'month-end')
  };
  try {
    await openNextTab(config);
  } catch (error) {
    await failSession(error);
    throw error;
  }
}

async function openNextTab(config) {
  const facility = config.facilities[config.currentTabIndex];
  const next = { ...config, facility, phase: 'crawling', activeTabId: null };
  await chrome.storage.local.set({ crawlConfig: next });
  const tab = await chrome.tabs.create({ url: 'https://www.google.com/search?q=' + encodeURIComponent(facility) });
  await chrome.storage.local.set({ crawlConfig: { ...next, activeTabId: tab.id } });
}

function requireCurrentTab(config, sender) {
  if (!config || config.status !== 'running' || config.activeTabId !== sender.tab?.id) {
    throw new Error('Tab này không thuộc địa điểm đang được xử lý.');
  }
}

function toRating(value) {
  const rating = Number(String(value || '').replace(',', '.'));
  return rating >= 1 && rating <= 5 ? rating : '';
}

function toFacilityAddress(value) {
  return String(value || '').trim().replace(/^Koh\s+Yam\s+/i, '').trim();
}

async function appendReviews(config, feedback) {
  if (!Number.isInteger(feedback?.number) || feedback.number < 0 ||
      !Array.isArray(feedback.comment) || !Array.isArray(feedback.rate) ||
      feedback.comment.length !== feedback.number || feedback.rate.length !== feedback.number) {
    throw new Error('Dữ liệu review không hợp lệ.');
  }
  if (!feedback.number) return { savedCount: 0 };
  if (!Array.isArray(feedback.time) || !Array.isArray(feedback.capturedAt) ||
      feedback.time.length !== feedback.number || feedback.capturedAt.length !== feedback.number) {
    throw new Error('Thiếu thời gian review hoặc thời điểm đọc review. Hãy reload extension và chạy session mới.');
  }

  const values = feedback.comment.flatMap((comment, index) => {
    const postedAt = REVIEW_TIME.estimateTimestamp(feedback.time[index], feedback.capturedAt[index]);
    if (postedAt === null) throw new Error(`Không quy đổi được thời gian review: ${feedback.time[index]}`);
    if (!REVIEW_TIME.inWindow(postedAt, config.reviewWindow)) return [];
    return [[REVIEW_TIME.sheetDateSerial(postedAt), 'Google Map', toFacilityAddress(config.facility),
      toRating(feedback.rate[index]), null, null, comment]];
  });
  if (!values.length) return { savedCount: 0 };
  const token = await getAuthToken();

  // Append quyết định dòng cuối từ dữ liệu thực tế, không dùng biến nextRow.
  // RAW giữ nguyên comment, kể cả khi nội dung bắt đầu bằng dấu '='.
  const appended = await apiRequest(token,
    `/values/${encodeURIComponent(`${SHEET_RANGE}!A4:G`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }) });

  let warning;
  try {
    const range = appended.updates?.updatedRange?.match(/!\$?A\$?(\d+):\$?[A-Z]+\$?(\d+)$/);
    if (!range) throw new Error('API không trả về vị trí các dòng vừa thêm.');
    const startRowIndex = Number(range[1]) - 1;
    const endRowIndex = Number(range[2]);
    const dropdownValues = [...new Set(
      [...DEFAULTS.facilities, ...config.facilities].map(toFacilityAddress).filter(Boolean)
    )];
    await apiRequest(token, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [
        { repeatCell: {
          range: { sheetId: config.sheetId, startRowIndex, endRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/MM/yyyy' } } },
          fields: 'userEnteredFormat.numberFormat'
        } },
        { setDataValidation: {
          range: { sheetId: config.sheetId, startRowIndex, endRowIndex, startColumnIndex: 2, endColumnIndex: 3 },
          rule: { condition: { type: 'ONE_OF_LIST', values: dropdownValues.map(userEnteredValue => ({ userEnteredValue })) },
            strict: true, showCustomUi: true }
        } }
      ] })
    });
  } catch (error) {
    // Append đã thành công: không retry để tránh thêm trùng cả batch.
    warning = error.message;
    console.warn('Đã thêm review, nhưng chưa định dạng được ngày/dropdown:', error);
  }
  return { savedCount: values.length, warning, updatedRange: appended.updates?.updatedRange };
}

async function failSession(error) {
  const { crawlConfig } = await chrome.storage.local.get('crawlConfig');
  if (crawlConfig?.status === 'running') {
    await chrome.storage.local.set({ crawlConfig: { ...crawlConfig, status: 'failed', error: error.message } });
  }
  await notify('review-crawl-error', 'Không hoàn thành lấy review', error.message);
}

async function processMessage(request, sender) {
  if (request.action === 'authorize') {
    const token = await getAuthToken(true);
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const profile = await response.json();
    if (!response.ok || profile.error) throw new Error(profile.error?.message || 'Không lấy được thông tin Google.');
    await chrome.storage.local.set({ userProfile: profile });
    return { success: true, profile };
  }
  if (request.action === 'logout') {
    await chrome.identity.clearAllCachedAuthTokens();
    await chrome.storage.local.remove('userProfile');
    return { success: true };
  }
  if (request.action === 'startMultiProcess') {
    await startCrawlSession(request.values);
    return { success: true };
  }
  const { crawlConfig: config } = await chrome.storage.local.get('crawlConfig');
  if (request.action === 'getActiveCrawlConfig') {
    return { success: true, config: config?.status === 'running' && config.activeTabId === sender.tab?.id
      && config.phase === 'crawling' ? config : null };
  }
  requireCurrentTab(config, sender);
  if (request.action === 'crawlFailed') {
    await failSession(new Error(request.error || 'Không đọc được danh sách review.'));
    return { success: true };
  }
  if (request.action === 'cacheData') {
    if (config.phase === 'saved') return { success: true };
    console.log('cacheData:', JSON.stringify(request.values, null, 2));
    try {
      const result = await appendReviews(config, request.values);
      await chrome.storage.local.set({ crawlConfig: {
        ...config, phase: 'saved', totalReviews: config.totalReviews + result.savedCount
      } });
      return { success: true, ...result };
    } catch (error) {
      await failSession(error);
      throw error;
    }
  }
  if (request.action === 'tabProcessed') {
    if (config.phase !== 'saved') throw new Error('Review của địa điểm này chưa được lưu.');
    const currentTabIndex = config.currentTabIndex + 1;
    if (currentTabIndex < config.facilities.length) {
      try {
        await openNextTab({ ...config, currentTabIndex });
      } catch (error) {
        await failSession(error);
        throw error;
      }
    } else {
      await chrome.storage.local.set({ crawlConfig: { ...config, status: 'completed', completedAt: Date.now() } });
      await notify('review-crawl-complete', 'Đã lưu Google Reviews',
        `Đã lưu ${config.totalReviews} review từ ${config.facilities.length} địa điểm vào ${DEFAULTS.sheetName}.`);
      // Giữ alert hoàn tất cho các session chạy thủ công.
      if (config.source === 'manual') {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'processComplete', processedCount: config.facilities.length })
          .catch(error => console.warn(error));
      }
    }
    return { success: true };
  }
  throw new Error('Action không được hỗ trợ.');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  enqueue(() => processMessage(request, sender))
    .then(sendResponse)
    .catch(error => {
      console.error(error);
      sendResponse({ success: false, error: error.message });
    });
  return true;
});

function resumeCountdown(pending) {
  const source = pending.source || 'daily';
  clearTimeout(countdownTimers.get(source));
  countdownTimers.set(source, setTimeout(() => enqueue(() => runPendingDailyJob(source)),
    Math.max(0, pending.startAt - Date.now())));
}

async function runPendingDailyJob(source = 'daily') {
  const job = JOBS[source];
  const stored = await chrome.storage.local.get([job.pendingKey, job.lastKey, 'crawlConfig']);
  const pending = stored[job.pendingKey];
  if (!pending) return;
  if (Date.now() < pending.startAt) {
    resumeCountdown(pending);
    return;
  }
  if (stored.crawlConfig?.status === 'running') {
    const retry = { ...pending, startAt: Date.now() + 60000 };
    await chrome.storage.local.set({ [job.pendingKey]: retry });
    await chrome.alarms.create(job.startAlarm, { when: retry.startAt });
    resumeCountdown(retry);
    return;
  }
  await chrome.storage.local.remove(job.pendingKey);
  await chrome.alarms.clear(job.startAlarm);
  if (stored[job.lastKey] === pending.date) return;
  await chrome.storage.local.set({ [job.lastKey]: pending.date });
  try {
    await startCrawlSession({ facilities: DEFAULTS.facilities, reviewPeriod: DEFAULTS.reviewPeriod,
      referenceAt: pending.referenceAt ?? Date.now() }, source);
  } catch (error) {
    await notify(`${source}-review-error`, `Job ${job.time} chưa thể chạy`, error.message);
  }
}

async function queueDailyJob(source = 'daily', referenceAt = Date.now()) {
  const job = JOBS[source];
  const stored = await chrome.storage.local.get([job.lastKey, job.pendingKey]);
  // Cho phép chạy lịch test mới dù job 10:00 đã chạy trong ngày.
  const date = `${bangkokDateKey(referenceAt)}@${job.time}`;
  if (stored[job.lastKey] === date || stored[job.pendingKey]) return;
  const pending = { date, source, referenceAt, startAt: Date.now() + 10000 };
  await chrome.storage.local.set({ [job.pendingKey]: pending });
  // Timer cho 10 giây; alarm dự phòng nếu service worker bị ngắt/khởi động lại.
  await chrome.alarms.create(job.startAlarm, { when: pending.startAt });
  await notify(`${START_NOTIFICATION}-${source}`, source === 'month-end' ? 'Đến giờ lấy review cuối tháng' : 'Đến giờ lấy Google Reviews',
    `Job sẽ tự bắt đầu sau 10 giây với ${DEFAULTS.facilities.length} địa điểm.${source === 'month-end' ? ' Chỉ lấy review của ngày cuối tháng.' : ''}`);
  resumeCountdown(pending);
}

chrome.alarms.onAlarm.addListener(alarm => {
  enqueue(async () => {
    if (alarm.name === DAILY_ALARM) {
      await armDailyAlarm();
      await queueDailyJob();
    }
    if (alarm.name === MONTH_END_ALARM) {
      await armMonthEndAlarm();
      await queueDailyJob('month-end', alarm.scheduledTime ?? Date.now());
    }
    if (alarm.name === START_ALARM) await runPendingDailyJob();
    if (alarm.name === JOBS['month-end'].startAlarm) await runPendingDailyJob('month-end');
  });
});

async function initializeSchedules() {
  // Cập nhật alarm đã lưu khi giờ chạy trong config.js thay đổi.
  await chrome.alarms.clear('scheduledReviewCrawl');
  await chrome.storage.local.remove('scheduledCrawlConfig');
  const { dailyScheduleTime } = await chrome.storage.local.get('dailyScheduleTime');
  if (dailyScheduleTime !== DAILY_TIME || !await chrome.alarms.get(DAILY_ALARM)) {
    await armDailyAlarm();
    await chrome.storage.local.set({ dailyScheduleTime: DAILY_TIME });
  }
  if (!await chrome.alarms.get(MONTH_END_ALARM)) await armMonthEndAlarm();
  const stored = await chrome.storage.local.get(Object.values(JOBS).map(job => job.pendingKey));
  for (const [source, job] of Object.entries(JOBS)) {
    const pending = stored[job.pendingKey];
    if (pending) {
      await chrome.alarms.create(job.startAlarm, { when: Math.max(Date.now(), pending.startAt) });
      resumeCountdown({ ...pending, source });
    }
  }
}

chrome.runtime.onInstalled.addListener(() => enqueue(initializeSchedules));
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  // Các tab/ID của lần mở Chrome trước không bảo đảm còn tồn tại.
  const { crawlConfig } = await chrome.storage.local.get('crawlConfig');
  if (crawlConfig?.status === 'running') {
    await chrome.storage.local.set({ crawlConfig: {
      ...crawlConfig, status: 'interrupted', error: 'Chrome đã đóng khi session còn đang chạy.'
    } });
    await notify('review-crawl-interrupted', 'Session trước bị gián đoạn',
      `Chrome đã đóng trước khi lấy xong review. Dữ liệu đã lưu được giữ nguyên; lịch ${DAILY_TIME} vẫn tiếp tục.`);
  }
  await initializeSchedules();
}));

chrome.tabs.onRemoved.addListener(tabId => enqueue(async () => {
  const { crawlConfig } = await chrome.storage.local.get('crawlConfig');
  if (crawlConfig?.status === 'running' && crawlConfig.activeTabId === tabId) {
    await failSession(new Error('Tab đang lấy review đã bị đóng trước khi hoàn tất.'));
  }
}));
enqueue(initializeSchedules);
