const authorizeButton = document.getElementById('authorize_button');
const accountInfo = document.getElementById('account-info');
const dateFromInput = document.getElementById('date-from');
const dateToInput = document.getElementById('date-to');

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const today = new Date();
const sevenDaysAgo = new Date(today);
sevenDaysAgo.setDate(today.getDate() - 7);
dateFromInput.value = formatLocalDate(sevenDaysAgo);
dateToInput.value = formatLocalDate(today);

function renderUser(user) {
  document.getElementById('avatar').src = user.picture || '';
  document.getElementById('username').textContent = user.name || '';
  document.getElementById('email').textContent = user.email || '';
  authorizeButton.style.display = 'none';
  accountInfo.style.display = 'flex';
}

authorizeButton.addEventListener('click', () => {
  authorizeButton.textContent = 'Đang đăng nhập...';
  authorizeButton.style.pointerEvents = 'none';

  chrome.runtime.sendMessage({ action: 'authorize' }, (response) => {
    authorizeButton.style.pointerEvents = 'auto';

    if (chrome.runtime.lastError) {
      console.error('Không gửi được yêu cầu đăng nhập:', chrome.runtime.lastError);
      authorizeButton.textContent = 'Đăng nhập thất bại - thử lại';
      return;
    }

    if (!response?.success || !response.profile) {
      console.error('Đăng nhập thất bại:', response?.error);
      authorizeButton.textContent = 'Đăng nhập thất bại - thử lại';
      return;
    }

    renderUser(response.profile);
  });
});

document.getElementById('execute_button').addEventListener('click', () => {
  const spreadsheetId = document.querySelector('input[name="spreadsheet"]')?.value || '';
  const sheetName = document.querySelector('input[name="sheet-name"]')?.value || '';
  const facilities = (document.querySelector('textarea[name="facilities"]')?.value || '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  const dateFrom = dateFromInput.value;
  const dateTo = dateToInput.value;

  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    console.error('Khoảng ngày không hợp lệ');
    return;
  }

  if (facilities.length === 0) {
    console.error('Vui lòng nhập ít nhất một địa điểm');
    return;
  }

  chrome.runtime.sendMessage({
    action: "startMultiProcess",
    values: {
      spreadsheetId,
      sheetName,
      facilities,
      dateFrom,
      dateTo,
    }
  });
});

document.getElementById('logout').addEventListener('click', () => {
  chrome.storage.local.remove("userProfile");
  chrome.runtime.sendMessage({ action: 'logout' });
  accountInfo.style.display = 'none';
  authorizeButton.textContent = 'Đăng nhập';
  authorizeButton.style.display = 'block';
});

chrome.storage.local.get("userProfile", (result) => {
  const user = result.userProfile;
  if (user) {
    renderUser(user);
  } else {
    authorizeButton.style.display = "block";
    accountInfo.style.display = "none";
  }
});
