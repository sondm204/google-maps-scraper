const authorizeButton = document.getElementById('authorize_button');
const accountInfo = document.getElementById('account-info');
const reviewPeriodInput = document.getElementById('review-period');

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
  const reviewPeriod = reviewPeriodInput.value || 'week';

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
      reviewPeriod,
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
