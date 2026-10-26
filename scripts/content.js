const feedbackData = new Map();
const REVIEW_LIST_SELECTOR = 'div[jsname="GmP9w"] > div.OG9A1';

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'processComplete') {
        alert(`Đã lấy review và lưu vào Google Sheet thành công cho ${request.processedCount} địa điểm.`);
    }

});

chrome.runtime.sendMessage({ action: 'getActiveCrawlConfig' }).then(async response => {
    if (!response?.config) return;
    const reviewPeriod = response.config.reviewPeriod || 'day';
    const reviewWindow = response.config.reviewWindow || {};
    const observedTimes = new Map();
    function getReviewTime(review) {
        const time = review.querySelector('.y3Ibjb')?.textContent?.trim() || '';
        const previous = observedTimes.get(review);
        if (previous?.time === time) return previous;
        const capturedAt = Date.now();
        const observed = { time, capturedAt, postedAt: REVIEW_TIME.estimateTimestamp(time, capturedAt) };
        observedTimes.set(review, observed);
        return observed;
    }

    const fbLink = await waitForElement('a.hoX6Hc[jsaction="FNFY6c"][role="button"]');
    fbLink.click();
    await waitForElement('[jsaction="click:pwGece"]');

    const listBtn = document.querySelectorAll('div[jsaction="click:pwGece"]');
    const beforeSort = readReviewListState();
    const sortStartedAt = Date.now();
    listBtn[1].click();

    // Giữ khoảng đợi đã hoạt động; container cũ có thể còn trên DOM sau click.
    await wait(1000);
    const listFbWrap = await waitForReviewList({ beforeSort, sortStartedAt });
    let listFb = Array.from(listFbWrap.children);
    console.log('Số review tìm thấy trong .OG9A1:', listFb.length);

    async function loadReviewsByPeriod(period) {
        const maxScrollAttempts = 100;
        let unchangedAttempts = 0;
        let previousCount = listFb.length;

        for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
            const boundaryIndex = listFb.findIndex(review => {
                const observed = getReviewTime(review);
                return isReviewBoundary(observed.time, period, observed.capturedAt, reviewWindow);
            });

            if (boundaryIndex >= 0) return listFb.slice(0, boundaryIndex);

            const scrollBar = document.querySelector('.RVCQse');
            if (!scrollBar) break;

            scrollBar.scrollTop = scrollBar.scrollHeight;
            await wait(750);

            const reviewContainer = await waitForReviewList();

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

        const boundaryIndex = listFb.findIndex(review => {
            const observed = getReviewTime(review);
            return isReviewBoundary(observed.time, period, observed.capturedAt, reviewWindow);
        });
        return boundaryIndex >= 0 ? listFb.slice(0, boundaryIndex) : listFb;
    }

    const finalList = (await loadReviewsByPeriod(reviewPeriod)).filter(review => {
        const observed = getReviewTime(review);
        if (observed.postedAt === null) throw new Error(`Không quy đổi được thời gian review: ${observed.time}`);
        return REVIEW_TIME.inWindow(observed.postedAt, reviewWindow);
    });
    console.info('[Review Collector] Kết quả lọc', {
        reviewPeriod,
        loadedCount: listFb.length,
        selectedCount: finalList.length,
        firstTime: listFb[0]?.querySelector('.y3Ibjb')?.textContent?.trim()
    });

    const promises = finalList.map(async (fb, index) => {
        const data_id = fb.getAttribute('data-id');
        const reviewer = fb.querySelector('.rhtdWc')?.textContent?.trim() || '';
        const rate = getReviewRate(fb);
        const { time, capturedAt } = getReviewTime(fb);

        const commentElement = fb.querySelector('div.gbdaZe .d83Iyc');
        const comment = getTextWithLineBreaks(commentElement);
        feedbackData.set(index, { reviewer, rate, time, capturedAt, comment });
    });

    await Promise.all(promises);
    const result = { number: 0, reviewer: [], comment: [], rate: [], time: [], capturedAt: [] };
    const sortedFeedbackData = [...feedbackData].sort((a, b) => a[0] - b[0]);
    sortedFeedbackData.forEach(([index, value]) => {
        result.number++;
        result.reviewer.push(value.reviewer);
        result.comment.push(value.comment);
        result.rate.push(value.rate);
        result.time.push(value.time);
        result.capturedAt.push(value.capturedAt);
    });

    const resultResponse = await chrome.runtime.sendMessage({ action: 'cacheData', values: result });
    if (!resultResponse?.success) throw new Error(resultResponse?.error || 'Không lưu được review.');
    if (resultResponse.warning) console.warn(resultResponse.warning);
    const processed = await chrome.runtime.sendMessage({ action: 'tabProcessed' });
    if (!processed?.success) throw new Error(processed?.error || 'Không chuyển được địa điểm tiếp theo.');
}).catch(error => {
    console.error('Lỗi lấy review:', error);
    chrome.runtime.sendMessage({ action: 'crawlFailed', error: error.message }).catch(console.error);
});

function isReviewBoundary(value, period, capturedAt, window) {
    if (isPeriodBoundary(value, period)) return true;
    const postedAt = REVIEW_TIME.estimateTimestamp(value, capturedAt);
    return postedAt !== null && window.startAt != null && postedAt < window.startAt;
}

function isPeriodBoundary(value, period) {
    const text = (value || '').toLowerCase().trim();
    if (!text) return false;

    const unitRanks = {
        minute: 0,
        hour: 1,
        day: 2,
        week: 3,
        month: 4,
        year: 5
    };
    const periodRanks = {
        day: unitRanks.day,
        week: unitRanks.week,
        month: unitRanks.month,
        year: unitRanks.year
    };
    const boundaryRank = periodRanks[period] ?? periodRanks.week;
    const unitMatchers = [
        { rank: unitRanks.minute, test: text => text.includes('phút') || /\b(minute|minutes|min|mins)\b/.test(text) },
        { rank: unitRanks.hour, test: text => text.includes('giờ') || /\b(hour|hours|hr|hrs)\b/.test(text) },
        { rank: unitRanks.day, test: text => text.includes('ngày') || /\b(day|days)\b/.test(text) },
        { rank: unitRanks.week, test: text => text.includes('tuần') || /\b(week|weeks)\b/.test(text) },
        { rank: unitRanks.month, test: text => text.includes('tháng') || /\b(month|months)\b/.test(text) },
        { rank: unitRanks.year, test: text => text.includes('năm') || /\b(year|years)\b/.test(text) }
    ];

    if (text.includes('hôm qua') || text.includes('yesterday')) {
        return unitRanks.day >= boundaryRank;
    }

    const matchedUnit = unitMatchers.find(({ test }) => test(text));
    if (!matchedUnit) return false;

    return matchedUnit.rank >= boundaryRank;
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

function readReviewListState() {
    const container = document.querySelector(REVIEW_LIST_SELECTOR);
    if (!container) return null;
    return {
        container,
        firstReview: container.firstElementChild,
        // Theo dõi nội dung review, tránh mutation không liên quan bên ngoài list.
        signature: container.innerHTML,
        ready: Array.from(container.children).some(review =>
            review.querySelector('.y3Ibjb')?.textContent?.trim()
        )
    };
}

async function waitForReviewList({ beforeSort = null, sortStartedAt = null, timeoutMs = 90000 } = {}) {
    const startedAt = Date.now();
    let previous = null;
    let stableSince = startedAt;

    while (Date.now() - startedAt < timeoutMs) {
        const current = readReviewListState();
        const sameState = current && previous &&
            current.container === previous.container &&
            current.firstReview === previous.firstReview &&
            current.signature === previous.signature;
        if (!sameState) stableSince = Date.now();

        const changedAfterSort = beforeSort && current && (
            current.container !== beforeSort.container ||
            current.firstReview !== beforeSort.firstReview ||
            current.signature !== beforeSort.signature
        );
        const sinceSort = sortStartedAt === null ? null : Date.now() - sortStartedAt;
        // Nếu đã chọn mới nhất từ trước, danh sách có thể không thay đổi.
        // Cho Google tối thiểu 5 giây trong trường hợp không có tín hiệu đổi list.
        const sortReady = sinceSort === null || (sinceSort >= 1000 &&
            (changedAfterSort || sinceSort >= 5000));

        if (current?.ready && sameState && Date.now() - stableSince >= 500 && sortReady) {
            return current.container;
        }

        previous = current;
        await wait(200);
    }

    throw new Error(`Danh sách review chưa tải ổn định sau ${timeoutMs / 1000} giây: ${REVIEW_LIST_SELECTOR}`);
}

function waitForElement(selector) {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) {
            resolve(element); // Nếu phần tử đã tồn tại, giải quyết Promise ngay
            return;
        }

        // Sử dụng MutationObserver để theo dõi thay đổi của DOM
        const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Không tìm thấy phần tử sau 90 giây: ${selector}`));
        }, 90000);
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
                clearTimeout(timeout);
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
