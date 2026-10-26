// Dùng chung cho popup và service worker.
globalThis.REVIEW_COLLECTOR_DEFAULTS = Object.freeze({
  spreadsheetId: '1jyMx0ihlNUwliQndUUi8MYSksxKGNjNYqlHfFpxBu-w',
  sheetName: '01 | Nhập data',
  timeZone: 'Asia/Bangkok',
  dailyHour: 10,
  dailyMinute: 0,
  reviewPeriod: 'day',
  facilities: Object.freeze([
    'Koh Yam 34A Quang Trung',
    'Koh Yam 2D Quang Trung',
    'Koh Yam 3A Bà Triệu',
    'Koh Yam 116K1 Giảng Võ',
    'Koh Yam 330 Thái Hà',
    'Koh Yam 26 Vũ Phạm Hàm',
    'Koh Yam 137 Nguyễn Văn Lộc',
    'Koh Yam Ocean Park',
    'Koh Yam Xuân La',
    'Koh Yam 111 Hồ Tùng Mậu',
    'Koh Yam 24 Bà Huyện Thanh Quan',
  ])
});
