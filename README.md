# Google Review Collector

Chrome extension thu thập review từ trang Google Search và nối dữ liệu vào
[Google Sheet](https://docs.google.com/spreadsheets/d/1jyMx0ihlNUwliQndUUi8MYSksxKGNjNYqlHfFpxBu-w/edit#gid=15651655),
tab **01 | Nhập data**. Cấu hình mặc định nằm trong `config.js`.

## Lịch tự động

- Lịch tự đăng ký khi cài, reload extension hoặc khởi động Chrome.
- Chạy hằng ngày theo giờ GMT+7 và danh sách địa điểm trong `config.js`, lấy review trong **1 ngày**.
  Đổi `dailyHour` / `dailyMinute` trong `config.js` rồi reload extension để thay giờ chạy.
- Ngày 1 mỗi tháng chỉ giữ review từ **00:00 hôm đó**, kể cả khi chọn khoảng review rộng hơn.
- Ngày cuối tháng chạy thêm lúc **23:59 GMT+7**, thông báo rồi đợi 10 giây.
  Job này chỉ giữ review của ngày cuối tháng, kể cả khi các tab được crawl sau nửa đêm.
  Nếu session khác đang chạy, job chờ và thử lại mỗi phút.
- Đến giờ hiện notification, sau 10 giây tự chạy, không cần xác nhận.
- Job kế tiếp được lên lịch cho ngày hôm sau; trạng thái countdown và session được lưu trong storage.
- Cần Chrome đang chạy, tài khoản đã cấp quyền Google Sheets và quyền sửa spreadsheet.
  Khi máy ngủ hoặc Chrome bị đóng, Chrome có thể trì hoãn alarm. Timer 10 giây
  có alarm dự phòng nếu service worker bị gián đoạn; khi đó thời điểm bắt đầu có thể trễ hơn.
- Chạy thủ công bằng nút **Bắt đầu**; có thể thay danh sách địa điểm và khoảng review.
  Các thay đổi thủ công không thay danh sách/chu kỳ mặc định của job hằng ngày.

## Dữ liệu

Tab và header phải tồn tại sẵn, đúng thứ tự A4:G4. Dữ liệu nối tiếp từ hàng 5 trở xuống;
ba hàng phía trên header được giữ nguyên.

| Ngày | Kênh | Địa điểm | Rate | Phân loại | Lý do | Chi tiết |
| --- | --- | --- | --- | --- | --- | --- |

- Ngày: ngày đăng review ước tính theo GMT+7, định dạng `dd/MM/yyyy`.
  Ví dụ đọc lúc 10:00 với `11 giờ trước` sẽ ghi ngày hôm qua (khoảng 23:00).
  Thời gian tương đối được gắn với thời điểm đọc từng review, không dùng ngày bắt đầu session.
  Google làm tròn thời gian tương đối nên review sát nửa đêm vẫn có thể lệch ngày thực tế.
  Nếu không quy đổi được thời gian, tác vụ báo lỗi thay vì ghi ngày thu thập thay thế.
- Kênh: `Google Map`.
- Địa điểm: địa chỉ cơ sở (bỏ tiền tố `Koh Yam `), có dropdown tại các dòng mới.
  Từ khóa tìm kiếm Google vẫn giữ brand để tìm đúng cơ sở.
- Rate: số sao; Chi tiết: nội dung review có xuống dòng.
- Phân loại, Lý do: không ghi giá trị.
- Dùng Sheets `values.append` với `INSERT_ROWS` và `RAW`: không ghi đè header/dòng cũ,
  không diễn giải nội dung review thành công thức. Không tạo worksheet mới.
- Không loại review trùng giữa các lần chạy. Chạy lại cùng khoảng thời gian có thể thêm lại review.
- Bộ lọc `1 ngày` giữ review theo phút/giờ, dừng trước review đầu tiên có đơn vị ngày hoặc cũ hơn,
  dựa trên danh sách review được sắp xếp mới nhất trước. Thời gian Google hiển thị là tương đối.

## Kiểm tra

```powershell
node --test tests/background.test.cjs tests/content.test.cjs tests/review-time.test.cjs
node --check background.js
node --check scripts/content.js
node --check popup.js
```

Các test mô phỏng Chrome/Sheets: lịch GMT+7 và countdown, giữ dữ liệu cũ khi append,
mapping cột và dropdown, khôi phục service worker, chặn header sai,
quy đổi ngày review, mốc đầu tháng và lịch cuối tháng (kể cả tháng nhuận).
Để kiểm tra thật, reload extension tại `chrome://extensions`, đăng nhập tài khoản
có quyền sửa spreadsheet rồi dùng nút **Bắt đầu** với một địa điểm.
