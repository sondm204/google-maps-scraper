waitForElement('a.hoX6Hc[jsaction="FNFY6c"][role="button"]').then(fbLink => {
    fbLink.click();
});

const feedbackData = new Map();

waitForElement('[jsaction="click:pwGece"]').then(async () => {
    const stored = await chrome.storage.local.get('crawlConfig');
    const dateFrom = parseDateInput(stored.crawlConfig?.dateFrom, false);
    const dateTo = parseDateInput(stored.crawlConfig?.dateTo, true);

    const listBtn = document.querySelectorAll('div[jsaction="click:pwGece"]');
    listBtn[1].click();

    await waitForElement('.OG9A1');
    await wait(1000);

    const listFbWrap = document.querySelector('div[jsname="GmP9w"] > div.OG9A1');
    if (!listFbWrap) {
        throw new Error('Không tìm thấy container danh sách review .OG9A1');
    }
    let listFb = Array.from(listFbWrap.children);
    console.log('Số review tìm thấy trong .OG9A1:', listFb.length);

    async function scrollUntilTimeOfLastChanges() {
        let timeOfLast = listFb[listFb.length - 1].querySelector('.y3Ibjb').innerHTML.trim();

        while (!timeOfLast.includes('tháng')) {
            const scrollBar = document.querySelector('.RVCQse');
            scrollBar.scrollTop = scrollBar.scrollHeight;

            await new Promise(resolve => setTimeout(resolve, 100));  // Thêm delay 100ms

            const reviewContainer = document.querySelector('div[jsname="GmP9w"] > div.OG9A1');
            if (!reviewContainer) break;
            listFb = Array.from(reviewContainer.children);
            console.log('Số review sau khi cuộn:', listFb.length);
            timeOfLast = listFb[listFb.length - 1].querySelector('.y3Ibjb').innerHTML.trim();

        }
        return listFb;
    }
    async function loadReviewsByDateRange(startDate, endDate) {
        const maxScrollAttempts = 100;
        let unchangedAttempts = 0;
        let previousCount = listFb.length;

        for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
            const lastReview = listFb[listFb.length - 1];
            const lastTimeText = lastReview?.querySelector('.y3Ibjb')?.textContent?.trim() || '';
            const lastReviewDate = parseGoogleRelativeTime(lastTimeText);

            if (lastReviewDate && startDate && lastReviewDate < startDate) break;

            const scrollBar = document.querySelector('.RVCQse');
            if (!scrollBar) break;

            scrollBar.scrollTop = scrollBar.scrollHeight;
            await wait(750);

            const reviewContainer = document.querySelector('div[jsname="GmP9w"] > div.OG9A1');
            if (!reviewContainer) break;

            listFb = Array.from(reviewContainer.children);
            console.log('Số review sau khi cuộn:', listFb.length);

            if (listFb.length === previousCount) {
                unchangedAttempts++;
                if (unchangedAttempts >= 3) break;
            } else {
                previousCount = listFb.length;
                unchangedAttempts = 0;
            }
        }

        return listFb.filter(review => {
            const timeText = review.querySelector('.y3Ibjb')?.textContent?.trim() || '';
            const reviewDate = parseGoogleRelativeTime(timeText);
            if (!reviewDate) return false;
            return (!startDate || reviewDate >= startDate) &&
                (!endDate || reviewDate <= endDate);
        });
    }

    const finalList = await loadReviewsByDateRange(dateFrom, dateTo);

    const promises = finalList.map(async (fb, index) => {
        const data_id = fb.getAttribute('data-id');
        const rate = getReviewRate(fb);
        const time = fb.querySelector('.y3Ibjb')?.textContent?.trim() || '';

        // Không lọc theo thời gian trong chế độ lấy 10 review gần nhất.

        const commentElement = fb.querySelector('div.gbdaZe .d83Iyc');
        const comment = getTextWithLineBreaks(commentElement);
        feedbackData.set(index, { rate, time, comment });
    });

    Promise.all(promises).then(() => {
        const result = {
            number: 0,
            comment: [],
            rate: [],
            time: []
        };

        const sortedFeedbackData = [...feedbackData].sort((a, b) => a[0] - b[0]);

        // Duyệt qua các phần tử đã sắp xếp và xây dựng kết quả
        sortedFeedbackData.forEach(([index, value]) => {
            result.number = result.number + 1;
            result.comment.push(value.comment);
            result.rate.push(value.rate);
            result.time.push(value.time);
        });

        chrome.runtime.sendMessage({
            action: "cacheData",
            values: result
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Không gửi được dữ liệu review:', chrome.runtime.lastError);
                return;
            }

            if (!response?.success) {
                console.error('Không tạo/ghi được Google Sheet:', response?.error);
                return;
            }

            if (response.warning) {
                console.warn('Dữ liệu đã được ghi nhưng format Sheet bị lỗi:', response.warning);
            }

            if (response.success) {
                chrome.runtime.sendMessage({ action: "tabProcessed" });
            }
        });
    });
});

function parseDateInput(value, endOfDay) {
    if (!value) return null;

    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return null;

    return endOfDay
        ? new Date(year, month - 1, day, 23, 59, 59, 999)
        : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function parseGoogleRelativeTime(value) {
    if (!value) return null;

    const text = value.toLowerCase().trim();
    const result = new Date();

    if (text.includes('vừa xong') || text.includes('mới đây')) return result;
    if (text.includes('hôm qua')) {
        result.setDate(result.getDate() - 1);
        return result;
    }

    const match = text.match(/(\d+|một|mot)\s+(phút|giờ|ngày|tuần|tháng|năm)/i);
    if (!match) return null;

    const amount = match[1] === 'một' || match[1] === 'mot'
        ? 1
        : Number(match[1]);
    const unit = match[2];

    if (unit === 'phút') result.setMinutes(result.getMinutes() - amount);
    if (unit === 'giờ') result.setHours(result.getHours() - amount);
    if (unit === 'ngày') result.setDate(result.getDate() - amount);
    if (unit === 'tuần') result.setDate(result.getDate() - amount * 7);
    if (unit === 'tháng') result.setMonth(result.getMonth() - amount);
    if (unit === 'năm') result.setFullYear(result.getFullYear() - amount);

    return result;
}

function getReviewRate(reviewElement) {
    const ratingElement = reviewElement.querySelector('.h3PQJ');
    if (!ratingElement) return '';

    const stars = Array.from(ratingElement.querySelectorAll('svg'));
    const filledStars = stars.filter(star => {
        return Array.from(star.querySelectorAll('path')).some(path => {
            const fill = path.getAttribute('fill')?.trim().toLowerCase();
            const stroke = path.getAttribute('stroke')?.trim().toLowerCase();
            return fill === '#fabb05' || stroke === '#fabb05';
        });
    }).length;

    // background.js hiện nhận rating theo định dạng "5,0".
    return filledStars > 0 ? `${filledStars},0` : '';
}

function getTextWithLineBreaks(element) {
    if (!element) return '';

    const blockTags = new Set(['DIV', 'P', 'LI']);

    function readNode(node, isRoot = false) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        if (node.tagName === 'BR') return '\n';

        const text = Array.from(node.childNodes)
            .map(child => readNode(child))
            .join('');

        if (!isRoot && blockTags.has(node.tagName)) {
            return `\n${text}\n`;
        }

        return text;
    }

    return readNode(element, true)
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function waitForElement(selector) {
    return new Promise(resolve => {
        const element = document.querySelector(selector);
        if (element) {
            resolve(element); // Nếu phần tử đã tồn tại, giải quyết Promise ngay
            return;
        }

        // Sử dụng MutationObserver để theo dõi thay đổi của DOM
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
                resolve(element); // Giải quyết Promise khi phần tử xuất hiện
                observer.disconnect(); // Ngừng theo dõi
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true, // Theo dõi toàn bộ cây DOM
        });
    });
}


function waitForElementToDisappearElement(el) {
    return new Promise(resolve => {
        if (!el || !el.parentNode) return resolve(); // Nếu phần tử không tồn tại thì resolve luôn

        const observer = new MutationObserver(() => {
            if (!el.isConnected) {
                observer.disconnect();
                resolve();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
