const { chromium } = require('./browser');

const PORTAL_URL =
    'https://one.vinuni.edu.vn/student/hoc-tap/dang-ky-tin-chi';
const API_ORIGIN = 'https://one-apigw.vinuni.edu.vn';
const REGISTRATION_URL =
    `${API_ORIGIN}/connect/qldt/dang-ky-tin-chi/dang-ky/lop-hoc-phan`;

const TOKEN_REFRESH_INTERVAL_MS = 60_000;
const TOKEN_CAPTURE_TIMEOUT_MS = 30_000;
const MIN_REGISTRATION_INTERVAL_MS = 1_000;
const MAX_REGISTRATION_INTERVAL_MS = 3_000;
const REGISTRATION_START_TIME = new Date('2026-08-28T14:59:00+07:00');
const LOG_TIME_ZONE = 'Asia/Bangkok';

const BROWSER_HEADER_NAMES = [
    'accept-language',
    'priority',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'user-agent',
];

const COURSES_IDS = [
    '6a7e78be58a0c27d5d02879e',
    '6a7e78be58a0c27d5d0287e2',
    '6a7e78bf58a0c27d5d0288d7',
    '6a7e78bf58a0c27d5d02896a',
    '6a7e78bf58a0c27d5d0289aa',
];

const REGISTRATION_BODY_TEMPLATE = {
    phieuDktcId: '6a8c58a5dbe25bda45229c5e',
    dangKy: {
        maKhoaNganh: '',
    },
    silent: true,
};

function getHeadlessOption() {
    const option = process.argv.find((argument) =>
        argument.startsWith('--headless=')
    );

    if (!option) return true;

    const value = option.split('=', 2)[1].toLowerCase();

    if (value !== 'true' && value !== 'false') {
        throw new Error('--headless must be either true or false');
    }

    return value === 'true';
}

function timestamp(date = new Date()) {
    return date.toLocaleString('en-US', { timeZone: LOG_TIME_ZONE });
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [
        hours && `${hours}h`,
        (hours || minutes) && `${minutes}m`,
        `${seconds}s`,
    ].filter(Boolean).join(' ');
}

function courseLogPrefix(courseId, courseIndex, totalCourses) {
    return `[Course ${courseIndex + 1}/${totalCourses}] [${courseId}]`;
}

function randomRegistrationInterval() {
    return Math.floor(
        Math.random() *
        (MAX_REGISTRATION_INTERVAL_MS - MIN_REGISTRATION_INTERVAL_MS + 1)
    ) + MIN_REGISTRATION_INTERVAL_MS;
}

function sleep(milliseconds, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(finish, milliseconds);

        function finish() {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        }

        signal.addEventListener('abort', finish, { once: true });
    });
}

async function waitForRegistrationStart(signal) {
    const remainingMilliseconds = REGISTRATION_START_TIME.getTime() - Date.now();

    if (remainingMilliseconds <= 0) {
        console.log(
            `[${timestamp()}] Registration trigger has already passed; ` +
            'starting immediately.'
        );
        return !signal.aborted;
    }

    console.log(
        `[${timestamp()}] Waiting ${formatDuration(remainingMilliseconds)} ` +
        'before starting registration. Token refresh remains active.'
    );
    await sleep(remainingMilliseconds, signal);

    if (signal.aborted) return false;

    console.log(`[${timestamp()}] Registration trigger reached.`);
    return true;
}

function selectBrowserHeaders(headers) {
    return Object.fromEntries(
        BROWSER_HEADER_NAMES
            .filter((name) => headers[name])
            .map((name) => [name, headers[name]])
    );
}

async function loadPageAndCaptureAuthorization(page, loadPage) {
    let timeout;
    let onRequest;

    const authorizationPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(
                `No authorized request to ${API_ORIGIN} was observed within ` +
                `${TOKEN_CAPTURE_TIMEOUT_MS / 1000} seconds`
            ));
        }, TOKEN_CAPTURE_TIMEOUT_MS);

        onRequest = async (request) => {
            try {
                if (new URL(request.url()).origin !== API_ORIGIN) return;

                const [authorization, requestHeaders] = await Promise.all([
                    request.headerValue('authorization'),
                    request.allHeaders(),
                ]);

                if (!/^Bearer\s+\S+$/i.test(authorization ?? '')) return;

                resolve({
                    authorization,
                    browserHeaders: selectBrowserHeaders(requestHeaders),
                });
            } catch (error) {
                console.warn(
                    `[${timestamp()}] Could not inspect an API request: ` +
                    error.message
                );
            }
        };

        // This listener must exist before navigation so that an early API
        // request cannot pass before we start watching for the token.
        page.on('request', onRequest);
    });

    try {
        const [, capturedRequest] = await Promise.all([
            loadPage(),
            authorizationPromise,
        ]);
        return capturedRequest;
    } finally {
        clearTimeout(timeout);
        page.off('request', onRequest);
    }
}

async function refreshAuthorizationEveryMinute(page, tokenState, signal) {
    while (!signal.aborted) {
        await sleep(TOKEN_REFRESH_INTERVAL_MS, signal);
        if (signal.aborted) break;

        try {
            const capturedRequest = await loadPageAndCaptureAuthorization(
                page,
                () => page.reload({ waitUntil: 'domcontentloaded' })
            );

            Object.assign(tokenState, capturedRequest);
            console.log(`[${timestamp()}] Bearer token refreshed.`);
        } catch (error) {
            console.error(
                `[${timestamp()}] Bearer token refresh failed: ${error.message}`
            );
        }
    }
}

function responseMessage(body) {
    if (body === null || body === undefined || body === '') return '(empty body)';
    if (typeof body === 'string') return body;

    return body.message ?? body.error ?? JSON.stringify(body);
}

async function tryToRegister(authorization, browserHeaders, courseId, signal) {
    const registrationBody = {
        ...REGISTRATION_BODY_TEMPLATE,
        dangKy: {
            ...REGISTRATION_BODY_TEMPLATE.dangKy,
            lopHocPhanId: courseId,
        },
    };

    const response = await fetch(REGISTRATION_URL, {
        method: 'POST',
        signal,
        headers: {
            ...browserHeaders,
            accept: 'application/json, text/plain, */*',
            authorization,
            'content-type': 'application/json',
            origin: 'https://one.vinuni.edu.vn',
            referer: 'https://one.vinuni.edu.vn/',
        },
        body: JSON.stringify(registrationBody),
    });

    const responseText = await response.text();
    let responseBody = responseText;

    try {
        responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
        // Keep a non-JSON response as text so it is still useful in the log.
    }

    return {
        succeeded: response.ok && responseBody?.success === true,
        status: response.status,
        body: responseBody,
    };
}

async function registerCourseAtRandomIntervals(
    courseId,
    courseIndex,
    totalCourses,
    tokenState,
    signal
) {
    let attempt = 0;
    const logPrefix = courseLogPrefix(courseId, courseIndex, totalCourses);

    while (!signal.aborted) {
        const attemptStartedAt = Date.now();
        attempt += 1;
        console.log(
            `[${timestamp()}] ${logPrefix} Attempt ${attempt} started.`
        );

        try {
            const result = await tryToRegister(
                tokenState.authorization,
                tokenState.browserHeaders,
                courseId,
                signal
            );
            const message = responseMessage(result.body);

            if (result.succeeded) {
                console.log(
                    `[${timestamp()}] ${logPrefix} Registration succeeded on ` +
                    `attempt ${attempt} (HTTP ${result.status}): ${message}`
                );
                return true;
            }

            console.log(
                `[${timestamp()}] ${logPrefix} Attempt ${attempt} failed ` +
                `(HTTP ${result.status}): ${message}`
            );
        } catch (error) {
            if (signal.aborted) return false;

            console.error(
                `[${timestamp()}] ${logPrefix} Attempt ${attempt} errored: ` +
                `${error.message}`
            );
        }

        // Randomize the start-to-start interval while ensuring requests do not
        // overlap if an individual request takes longer than the chosen delay.
        const registrationInterval = randomRegistrationInterval();
        const remainingDelay = Math.max(
            0,
            registrationInterval - (Date.now() - attemptStartedAt)
        );
        await sleep(remainingDelay, signal);
    }

    return false;
}

async function runAutomation() {
    const headless = getHeadlessOption();
    const controller = new AbortController();
    const tokenState = {
        authorization: null,
        browserHeaders: {},
    };
    let browser;

    const stop = () => {
        if (controller.signal.aborted) return;
        console.log(`\n[${timestamp()}] Shutting down...`);
        controller.abort();
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
        console.log(`Launching browser with headless=${headless}`);
        console.log(
            `[${timestamp()}] Registration trigger configured for ` +
            `${timestamp(REGISTRATION_START_TIME)} (GMT+7).`
        );
        browser = await chromium.launch({ headless });

        const context = await browser.newContext({ storageState: 'auth.json' });
        const page = await context.newPage();

        const capturedRequest = await loadPageAndCaptureAuthorization(
            page,
            () => page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' })
        );
        Object.assign(tokenState, capturedRequest);
        console.log(`[${timestamp()}] Initial Bearer token captured.`);

        const refreshLoop = refreshAuthorizationEveryMinute(
            page,
            tokenState,
            controller.signal
        );
        const shouldRegister = await waitForRegistrationStart(
            controller.signal
        );

        if (shouldRegister) {
            console.log(
                `[${timestamp()}] Starting ${COURSES_IDS.length} independent ` +
                'course registration workers.'
            );

            const registrationResults = await Promise.all(
                COURSES_IDS.map((courseId, courseIndex) =>
                    registerCourseAtRandomIntervals(
                        courseId,
                        courseIndex,
                        COURSES_IDS.length,
                        tokenState,
                        controller.signal
                    )
                )
            );
            const allRegistered = registrationResults.every(Boolean);

            if (allRegistered) {
                console.log(
                    `[${timestamp()}] All ${COURSES_IDS.length} courses ` +
                    'registered successfully. Shutting down.'
                );
                controller.abort();
            }
        }

        await refreshLoop;
    } finally {
        controller.abort();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        await browser?.close();
    }
}

runAutomation().catch((error) => {
    console.error(`[${timestamp()}] Fatal error:`, error);
    process.exitCode = 1;
});
