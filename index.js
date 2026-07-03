const { chromium } = require('playwright');

const PORTAL_URL =
    'https://one.vinuni.edu.vn/student/academic/course-registration';
const API_ORIGIN = 'https://one-apigw.vinuni.edu.vn';
const REGISTRATION_URL =
    `${API_ORIGIN}/connect/qldt/dang-ky-tin-chi/dang-ky/lop-hoc-phan`;

const TOKEN_REFRESH_INTERVAL_MS = 60_000;
const TOKEN_CAPTURE_TIMEOUT_MS = 30_000;
const REGISTRATION_INTERVAL_MS = 1_000;

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

const REGISTRATION_BODY = {
    phieuDktcId: '6a4259f7b061bb0ed785995f',
    dangKy: {
        lopHocPhanId: '6a41eb8510fdcb8786daf205',
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

function timestamp() {
    return new Date().toLocaleString();
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

async function tryToRegister(authorization, browserHeaders) {
    const response = await fetch(REGISTRATION_URL, {
        method: 'POST',
        headers: {
            ...browserHeaders,
            accept: 'application/json, text/plain, */*',
            authorization,
            'content-type': 'application/json',
            origin: 'https://one.vinuni.edu.vn',
            referer: 'https://one.vinuni.edu.vn/',
        },
        body: JSON.stringify(REGISTRATION_BODY),
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

async function registerEverySecond(tokenState, signal) {
    let attempt = 0;

    while (!signal.aborted) {
        const attemptStartedAt = Date.now();
        attempt += 1;

        try {
            const result = await tryToRegister(
                tokenState.authorization,
                tokenState.browserHeaders
            );
            const message = responseMessage(result.body);

            if (result.succeeded) {
                console.log(
                    `[${timestamp()}] Registration succeeded on attempt ` +
                    `${attempt} (HTTP ${result.status}): ${message}`
                );
                return true;
            }

            console.log(
                `[${timestamp()}] Registration attempt ${attempt} failed ` +
                `(HTTP ${result.status}): ${message}`
            );
        } catch (error) {
            console.error(
                `[${timestamp()}] Registration attempt ${attempt} errored: ` +
                error.message
            );
        }

        // Keep attempts one second apart while ensuring requests never overlap.
        const remainingDelay = Math.max(
            0,
            REGISTRATION_INTERVAL_MS - (Date.now() - attemptStartedAt)
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
        const registered = await registerEverySecond(
            tokenState,
            controller.signal
        );

        if (registered) controller.abort();
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
