waitForElement('a.hoX6Hc[jsaction="FNFY6c"][role="button"]').then(fbLink => {
    fbLink.click();
});

const feedbackData = new Map();

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'processComplete') {
        alert(`Đã lấy review và lưu vào Google Sheet thành công cho ${request.processedCount} địa điểm.`);
    }

    if (request.action === 'scheduledConfirm') {
        const accepted = window.confirm(
            'Đã đến giờ lấy Google Reviews. Bạn có muốn bắt đầu và lưu dữ liệu vào Google Sheet ngay bây giờ không?'
        );
        chrome.runtime.sendMessage({ action: 'scheduledDecision', accepted });
    }
});

waitForElement('[jsaction="click:pwGece"]').then(async () => {
    const stored = await chrome.storage.local.get('crawlConfig');
    const reviewPeriod = stored.crawlConfig?.reviewPeriod || 'week';

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

    async function loadReviewsByPeriod(period) {
        const maxScrollAttempts = 100;
        let unchangedAttempts = 0;
        let previousCount = listFb.length;

        for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
            const boundaryIndex = listFb.findIndex(review => {
                const timeText = review.querySelector('.y3Ibjb')?.textContent?.trim() || '';
                return isPeriodBoundary(timeText, period);
            });

            if (boundaryIndex >= 0) return listFb.slice(0, boundaryIndex);

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

        return listFb;
    }

    const finalList = await loadReviewsByPeriod(reviewPeriod);

    const promises = finalList.map(async (fb, index) => {
        const data_id = fb.getAttribute('data-id');
        const reviewer = fb.querySelector('.rhtdWc')?.textContent?.trim() || '';
        const rate = getReviewRate(fb);
        const time = fb.querySelector('.y3Ibjb')?.textContent?.trim() || '';

        const commentElement = fb.querySelector('div.gbdaZe .d83Iyc');
        const comment = getTextWithLineBreaks(commentElement);
        feedbackData.set(index, { reviewer, rate, time, comment });
    });

    Promise.all(promises).then(() => {
        const result = {
            number: 0,
            reviewer: [],
            comment: [],
            rate: [],
            time: []
        };

        const sortedFeedbackData = [...feedbackData].sort((a, b) => a[0] - b[0]);

        // Duyệt qua các phần tử đã sắp xếp và xây dựng kết quả
        sortedFeedbackData.forEach(([index, value]) => {
            result.number = result.number + 1;
            result.reviewer.push(value.reviewer);
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

function isPeriodBoundary(value, period) {
    const text = (value || '').toLowerCase().trim();
    if (!text) return false;

    const unitRanks = {
        'phút': 0,
        'giờ': 1,
        'ngày': 2,
        'tuần': 3,
        'tháng': 4,
        'năm': 5
    };
    const periodRanks = {
        day: unitRanks['ngày'],
        week: unitRanks['tuần'],
        month: unitRanks['tháng'],
        year: unitRanks['năm']
    };

    if (text.includes('hôm qua')) {
        return unitRanks['ngày'] >= (periodRanks[period] ?? periodRanks.week);
    }

    const matchedUnit = Object.keys(unitRanks).find(unit => text.includes(unit));
    if (!matchedUnit) return false;

    return unitRanks[matchedUnit] >= (periodRanks[period] ?? periodRanks.week);
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
