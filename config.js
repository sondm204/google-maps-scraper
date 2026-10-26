// Dùng chung cho popup và service worker.
globalThis.REVIEW_COLLECTOR_DEFAULTS = Object.freeze({
  spreadsheetId: '1jyMx0ihlNUwliQndUUi8MYSksxKGNjNYqlHfFpxBu-w',
  sheetName: '01 | Nhập data',
  timeZone: 'Asia/Bangkok',
  dailyHour: 21,
  dailyMinute: 39,
  reviewPeriod: 'day',
  facilities: Object.freeze([
    'Koh Yam 34A Quang Trung',
    'Koh Yam 2D Quang Trung',
    'Koh Yam 3A Bà Triệu',
  ])
});
