chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension Installed');
});

let facilitiesAll = [];

let nextRow = 1;
let feedbackData = null;
let spreadsheetId = null;
let sheetName = null;
let sheetId = null;
let facility = null;
let reviewPeriod = 'week';

let currentTabIndex = 0;
let isMultiProcess = false;
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "authorize") {
    console.log("Received authorize request in background");

    // Gọi xác thực
    chrome.identity.getAuthToken({ interactive: true }, async function (token) {
      if (chrome.runtime.lastError || !token) {
        console.error("Error in authentication:", chrome.runtime.lastError);
        sendResponse({
          success: false,
          error: chrome.runtime.lastError?.message || "Không lấy được Google OAuth token"
        });
        return;
      }

      try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
        const profile = await response.json();

        if (!response.ok || profile.error) {
          throw new Error(profile.error_description || profile.error?.message || 'Không lấy được thông tin tài khoản Google');
        }

        await chrome.storage.local.set({ userProfile: profile });
        sendResponse({ success: true, profile });
      } catch (error) {
        console.error('Error fetching user info:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  if (request.action === 'logout') {
    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (chrome.runtime.lastError || !token) {
        console.error("No token found:", chrome.runtime.lastError);
        return;
      }

      // Gỡ token ra khỏi cache
      chrome.identity.removeCachedAuthToken({ token }, function () {
        console.log("Token removed");

        // (Tùy chọn) Gọi revoke để ngắt hoàn toàn phiên làm việc với Google
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .then(() => console.log("Token revoked on Google"))
          .catch(err => console.error("Failed to revoke token:", err));
      });
    });
  }

  if (request.action === 'setupSheet') {
    if (request.values) {
      spreadsheetId = request.values.spreadsheetId || "";
      sheetName = request.values.sheetName || 'Đặt tên sheet';
      facility = request.values.facility || '';
      reviewPeriod = request.values.reviewPeriod || 'week';
      const searchContent = facility
      chrome.storage.local.set({
        crawlConfig: { spreadsheetId, sheetName, facility, reviewPeriod }
      }, () => {
        chrome.tabs.create({
          url: "https://www.google.com/search?q=" + encodeURIComponent(searchContent)
        });
      });
    }
    return true;
  }

  if (request.action === 'startMultiProcess') {
    if (request.values) {
      spreadsheetId = request.values.spreadsheetId || "";
      sheetName = request.values.sheetName || 'Đặt tên sheet';
      reviewPeriod = request.values.reviewPeriod || 'week';
      facilitiesAll = Array.isArray(request.values.facilities)
        ? request.values.facilities
        : [];
      isMultiProcess = true;
      chrome.storage.local.set({
        crawlConfig: {
          spreadsheetId,
          sheetName,
          facility: '',
          facilities: facilitiesAll,
          currentTabIndex: 0,
          reviewPeriod
        }
      }, () => {
        currentTabIndex = 0;
        createTabSequentially();
      });
    }
    return true;
  }

  if (request.action === 'tabProcessed') {
    const processedTabId = sender.tab?.id;
    chrome.storage.local.get('crawlConfig', (stored) => {
      const config = stored.crawlConfig || {};
      facilitiesAll = Array.isArray(config.facilities) ? config.facilities : [];
      spreadsheetId = config.spreadsheetId || '';
      sheetName = config.sheetName || '';
      reviewPeriod = config.reviewPeriod || 'week';
      currentTabIndex = (config.currentTabIndex ?? 0) + 1;

      if (currentTabIndex >= facilitiesAll.length) {
        isMultiProcess = false;
        console.log('✅ Đã xử lý và lưu thành công tất cả địa điểm.');

        if (processedTabId !== undefined) {
          chrome.tabs.sendMessage(processedTabId, {
            action: 'processComplete',
            processedCount: facilitiesAll.length
          }, () => {
            if (chrome.runtime.lastError) {
              console.warn('Không thể hiển thị thông báo hoàn tất:', chrome.runtime.lastError.message);
            }
          });
        }
        return;
      }

      isMultiProcess = true;
      createTabSequentially();
    });
    return true;
  }

  if (request.action === "cacheData") {
    feedbackData = request.values;
    console.log('cacheData received from content script:');
    console.log(JSON.stringify(feedbackData, null, 2));
    console.log('Review count:', feedbackData?.number);
    chrome.storage.local.get('crawlConfig', (stored) => {
      const config = stored.crawlConfig || {};
      spreadsheetId = spreadsheetId || config.spreadsheetId || '';
      sheetName = sheetName || config.sheetName || '';
      facility = facility || config.facility || '';
      reviewPeriod = config.reviewPeriod || reviewPeriod || 'week';

      if (!spreadsheetId || !sheetName) {
        sendResponse({ success: false, error: 'Thiếu Spreadsheet ID hoặc tên Sheet' });
        return;
      }

    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (chrome.runtime.lastError || !token) {
        console.error("Token error:", chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError });
        return;
      }

      async function runTasks(spreadsheetId, token) {
        try {
          sheetId = await createNewSheet(spreadsheetId, sheetName, token);
          if (sheetId !== null && sheetId !== undefined) {
            await fetchDataToSheet(spreadsheetId, sheetId, token);
            sendResponse({ success: true });

            // console.log("Tất cả các bước đã thực hiện thành công!");
          } else {
            throw new Error('Google Sheets API không trả về sheetId');
          }
        } catch (error) {
          console.error('Lỗi khi tạo hoặc ghi Google Sheet:', error);
          sendResponse({ success: false, error: error.message });
        }
      }

      runTasks(spreadsheetId, token);
    });
    });
    return true;
  }
});

const setupSheet = (spreadsheetId, sheetId, token) => {

  const classifiers = Array.from({ length: 999 }, (_, i) => {
    const rowNumber = i + 2;
    const formula = `=IFERROR(IF(E${rowNumber}="Khen";"Khen";IF(E${rowNumber}="No cmt";"Khác";"Chê")))`;
    return {
      values: [
        { userEnteredValue: { formulaValue: formula } }
      ]
    };
  });

  const components = Array.from({ length: 999 }, (_, i) => {
    const row = i + 2;
    const formula = `=IFERROR(VLOOKUP(E${row};'Định nghĩa'!$A$2:$B$13;2;0))`;
    return {
      values: [
        { userEnteredValue: { formulaValue: formula } }
      ]
    };
  });

  const backgroundColorValue = Array.from({ length: 1000 }, () => {
    return {
      values: [
        {
          userEnteredFormat: {
            backgroundColor: {
              red: 189 / 255,
              green: 189 / 255,
              blue: 189 / 255
            }
          }
        }
      ]
    }
  });
  const body = {
    requests: [
      // Ghi nội dung header vào A1 và B1
      {
        updateCells: {
          rows: [
            {
              values: [
                { userEnteredValue: { stringValue: "Kênh" } },
                { userEnteredValue: { stringValue: "Địa điểm" } },
                { userEnteredValue: { stringValue: "Rate" } },
                { userEnteredValue: { stringValue: "Phân loại" } },
                { userEnteredValue: { stringValue: "Lý do chê" } },
                { userEnteredValue: { stringValue: "Chi tiết" } },
                { userEnteredValue: { stringValue: "Bộ phận" } },
              ]
            }
          ],
          fields: "*",
          start: {
            sheetId: sheetId,
            rowIndex: 0,
            columnIndex: 0
          }
        }
      },

      // Gán dropdown vào cột B từ B2 đến B100
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: 1
          },
          cell: {
            dataValidation: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "CRM" },
                  { userEnteredValue: "FB Mess" },
                  { userEnteredValue: "Comment Facebook" },
                  { userEnteredValue: "Group Social" },
                  { userEnteredValue: "Page cá nhân" },
                  { userEnteredValue: "Hotline" },
                  { userEnteredValue: "Google" },
                ]
              },
              strict: true,
              showCustomUi: true
            }
          },
          fields: "dataValidation"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: 1,
            endColumnIndex: 2
          },
          cell: {
            dataValidation: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "kohyam thái hà" },
                ]
              },
              strict: true,
              showCustomUi: true
            }
          },
          fields: "dataValidation"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: 2,
            endColumnIndex: 3
          },
          cell: {
            dataValidation: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "1" },
                  { userEnteredValue: "2" },
                  { userEnteredValue: "3" },
                  { userEnteredValue: "4" },
                  { userEnteredValue: "5" },
                  { userEnteredValue: "Không" },
                ]
              },
              strict: true,
              showCustomUi: true
            }
          },
          fields: "dataValidation"
        }
      },
      {
        updateCells: {
          rows: classifiers,
          fields: "*",
          start: {
            sheetId: sheetId,
            rowIndex: 1,
            columnIndex: 3
          }
        }
      },
      {
        updateCells: {
          range: {
            sheetId: sheetId,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 3,
            endColumnIndex: 4
          },
          rows: backgroundColorValue,
          fields: "userEnteredFormat.backgroundColor"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: 4,
            endColumnIndex: 5
          },
          cell: {
            dataValidation: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "Đồ ăn không ngon" },
                  { userEnteredValue: "Phục vụ chậm" },
                  { userEnteredValue: "Thái độ nhân viên" },
                  { userEnteredValue: "Đồ ăn không vệ sinh/thiu/hỏng" },
                  { userEnteredValue: "Lỗi CRM" },
                  { userEnteredValue: "Lỗi tư vấn online" },
                  { userEnteredValue: "Đồ nguội" },
                  { userEnteredValue: "Khác" },
                  { userEnteredValue: "No cmt" },
                  { userEnteredValue: "Khen" },
                  { userEnteredValue: "Lỗi NH tư vấn" },
                  { userEnteredValue: "Khẩu phần ít" },
                  { userEnteredValue: "Phục vụ kém" },
                  { userEnteredValue: "Chê" },
                ]
              },
              strict: true,
              showCustomUi: true
            }
          },
          fields: "dataValidation"
        }
      },
      {
        updateCells: {
          rows: components,
          fields: "*",
          start: {
            sheetId: sheetId,
            rowIndex: 1,
            columnIndex: 6
          }
        }
      },
      {
        updateCells: {
          range: {
            sheetId: sheetId,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 6,
            endColumnIndex: 7
          },
          rows: backgroundColorValue,
          fields: "userEnteredFormat.backgroundColor"
        }
      },
    ]
  };

  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Không thể thiết lập Sheet');
      return data;
    })
    .then(data => {
      // console.log("Sheet setup complete:", data);
    })
    .catch(err => {
      // console.error("Error setting up sheet:", err);
      throw err;
    });
};

const createNewSheet = async (spreadsheetId, sheetName, token) => {
  const check = await checkSheetExistenceWithToken(spreadsheetId, sheetName, token);
  if (check !== null && check !== undefined) {
    return check;
  }
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }
      ]
    })
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Không thể tạo Sheet mới');
      return data;
    })
    .then(data => {
      nextRow = 1;
      const sheetId = data.replies?.[0]?.addSheet?.properties?.sheetId;
      return sheetId;
    });
}

const fetchDataToSheet = (spreadsheetId, sheetId, token) => {
  const numberRows = feedbackData.number;
  const rates = feedbackData.rate.map(rate => {
    const value =
      rate.includes('5,0') ? 5 :
        rate.includes('4,0') ? 4 :
          rate.includes('3,0') ? 3 :
            rate.includes('2,0') ? 2 :
              rate.includes('1,0') ? 1 :
                null;

    return {
      values: [
        {
          userEnteredValue: value !== null
            ? { numberValue: value }
            : { stringValue: 'Không' }
        }
      ]
    };
  });

  const comments = feedbackData.comment.map(comment => ({
    values: [
      { userEnteredValue: { stringValue: comment } }
    ]
  }));

  const reviewers = (feedbackData.reviewer || []).map(reviewer => ({
    values: [
      { userEnteredValue: { stringValue: reviewer } }
    ]
  }));

  const reviewRows = Array.from({ length: numberRows }, (_, index) => ({
    values: [
      { userEnteredValue: { stringValue: facility } },
      reviewers[index]?.values?.[0] || { userEnteredValue: { stringValue: '' } },
      rates[index]?.values?.[0] || { userEnteredValue: { stringValue: '' } },
      comments[index]?.values?.[0] || { userEnteredValue: { stringValue: '' } }
    ]
  }));

  const body = {
    requests: [
      {
        updateCells: {
          rows: [
            {
              values: [
                {
                  userEnteredValue: { stringValue: 'Địa điểm' },
                  userEnteredFormat: {
                    backgroundColor: { red: 63 / 255, green: 86 / 255, blue: 183 / 255 },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                  }
                },
                {
                  userEnteredValue: { stringValue: 'Người đánh giá' },
                  userEnteredFormat: {
                    backgroundColor: { red: 63 / 255, green: 86 / 255, blue: 183 / 255 },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                  }
                },
                {
                  userEnteredValue: { stringValue: 'Rate' },
                  userEnteredFormat: {
                    backgroundColor: { red: 63 / 255, green: 86 / 255, blue: 183 / 255 },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                  }
                },
                {
                  userEnteredValue: { stringValue: 'Chi tiết' },
                  userEnteredFormat: {
                    backgroundColor: { red: 63 / 255, green: 86 / 255, blue: 183 / 255 },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                  }
                }
              ]
            }
          ],
          fields: 'userEnteredValue,userEnteredFormat',
          start: {
            sheetId: sheetId,
            rowIndex: 0,
            columnIndex: 0
          }
        }
      },
      {
        updateCells: {
          range: {
            sheetId: sheetId,
            startRowIndex: nextRow,
            endRowIndex: nextRow + numberRows,
            startColumnIndex: 0,
            endColumnIndex: 4
          },
          rows: reviewRows,
          fields: 'userEnteredValue'
        }
      }
    ]
  };

  if (numberRows === 0) {
    body.requests.pop();
  }

  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Không thể ghi dữ liệu vào Sheet');
      return data;
    })
    .then(data => {
      nextRow += feedbackData.number;
      // console.log("Sheet fetch data complete:", data);
    })
    .catch(err => {
      // console.error("Error fetch data:", err);
      throw err;
    });
}

const checkSheetExistenceWithToken = async (spreadsheetId, sheetName, accessToken) => {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

  try {
    // Gửi yêu cầu với access token trong header Authorization
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      }
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Không thể đọc spreadsheet');
    }
    const sheets = data.sheets;  // Danh sách các sheet trong spreadsheet

    const sheetExists = sheets.filter(sheet => sheet.properties.title === sheetName);

    // Nếu sheet tồn tại, trả về sheetId, nếu không trả về null
    if (sheetExists.length > 0) {
      return sheetExists[0].properties.sheetId;
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error fetching spreadsheet:', error);
    throw error;
  }
};

const createTabSequentially = () => {
  if (currentTabIndex < facilitiesAll.length) {
    facility = facilitiesAll[currentTabIndex];
    const query = facility;
    chrome.storage.local.set({
      crawlConfig: {
        spreadsheetId,
        sheetName,
        facility,
        facilities: facilitiesAll,
        currentTabIndex,
        reviewPeriod
      }
    }, () => {
      chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(query) });
    });
  } else {
    isMultiProcess = false;
    console.log("✅ Đã xử lý xong tất cả tab.");
  }
}

const getUserInfo = () => {
  chrome.identity.getAuthToken({ interactive: false }, function (token) {
    if (chrome.runtime.lastError || !token) {
      chrome.storage.local.remove('userProfile');
      return;
    }

    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
      .then(res => res.json())
      .then(profile => {
        if (profile.error) {
          console.error("Error fetching user info:", profile.error);
          chrome.storage.local.set({ userProfile: null });
          return;
        }
        chrome.storage.local.set({ userProfile: profile }, () => {
          console.log("User info saved:", profile);
        });
      })
      .catch(err => {
        console.error("Error fetching user info:", err);
      });
  });
}

getUserInfo();


