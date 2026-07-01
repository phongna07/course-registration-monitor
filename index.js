const { chromium } = require('playwright');

const maxRefreshClickCount = 1000;

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

async function runAutomation() {
    const targetCourseName = 'Critical and Creative Thinking';
    const refreshIntervalMs = 1000;
    const headless = getHeadlessOption();

    console.log(`Launching browser with headless=${headless}`);
    const browser = await chromium.launch({ headless });

    // Create a new context using the saved authentication state
    const context = await browser.newContext({ storageState: 'auth.json' });
    const page = await context.newPage();

    // Navigate directly to the internal university page you need to scrape/automate
    await page.goto('https://one.vinuni.edu.vn/student/academic/course-registration');

    // Identify the pagination list by its numbered links, without relying on
    // generated classes or an optional `title` attribute on the list item.
    const pagination = page
        .getByRole('main')
        .locator('ul')
        .filter({
            has: page.locator('a').filter({ hasText: /^\s*1\s*$/ }),
        })
        .filter({
            has: page.locator('a').filter({ hasText: /^\s*2\s*$/ }),
        });

    const pageTwoLink = pagination
        .locator('a')
        .filter({ hasText: /^\s*2\s*$/ });

    const courseTable = page
        .getByRole('main')
        .getByRole('table')
        .filter({
            has: page.getByRole('columnheader', {
                name: 'Available Slots',
                exact: true,
            }),
        });

    const targetCourseRow = courseTable
        .locator('tbody tr:not([aria-hidden="true"])')
        .filter({
            has: page.getByText(targetCourseName, { exact: true }),
        });

    const registeredCreditsText = page.locator(
        '#root > div > div > div.ant-layout.ant-layout-has-sider.css-13xpg2l.css-var-_r_0_ > div.ant-pro-layout-container.css-13xpg2l > main > div > div.ant-pro-grid-content.css-13xpg2l > div > div > div:nth-child(2) > div > div.ant-card-body > div > div.header > div.action > span'
    );

    const openPageTwo = async () => {
        await courseTable.waitFor({ state: 'visible' });
        await pageTwoLink.waitFor({ state: 'visible' });
        await pageTwoLink.click();

        // The target course only appears on page 2, so its visible row confirms
        // that page 2's table data has finished rendering.
        await targetCourseRow.waitFor({ state: 'visible', timeout: 30000 });
    };

    await openPageTwo();

    const readCourseStatus = () => courseTable.evaluate((table, courseName) => {
        const normalize = (value) => value?.trim().replace(/\s+/g, ' ') ?? '';
        const headers = [...table.querySelectorAll('thead th')].map((header) =>
            normalize(header.textContent)
        );

        const courseNameIndex = headers.indexOf('Course Name');
        const row = [...table.querySelectorAll(
            'tbody tr:not([aria-hidden="true"])'
        )].find((candidate) => {
            const cells = candidate.querySelectorAll(':scope > td');
            return normalize(cells[courseNameIndex]?.textContent) === courseName;
        });

        if (!row) return null;

        const cells = [...row.querySelectorAll(':scope > td')];
        const valueFor = (headerName) => {
            const index = headers.indexOf(headerName);
            return index >= 0 ? normalize(cells[index]?.textContent) : '';
        };
        const availableSlots = Number(valueFor('Available Slots'));
        const action = valueFor('Action');
        let status = 'UNKNOWN';

        if (/registered/i.test(action)) {
            status = 'REGISTERED';
        } else if (/register/i.test(action) && availableSlots > 0) {
            status = 'AVAILABLE';
        } else if (/full/i.test(action) || availableSlots === 0) {
            status = 'FULL';
        }

        return {
            courseCode: valueFor('Course Code'),
            sectionCode: valueFor('Section Code'),
            availableSlots,
            status,
        };
    }, targetCourseName);

    const readRegisteredCredits = async () => {
        const text = (await registeredCreditsText.innerText()).trim();
        const match = text.match(/Registered Credits:\s*(\d+(?:\.\d+)?)/i);

        if (!match) {
            throw new Error(
                `Could not read registered credits from: "${text}"`
            );
        }

        return Number(match[1]);
    };

    const registerButton = targetCourseRow.getByRole('button', {
        name: 'Register',
        exact: true,
    });

    // Confirm registration in the currently visible modal. Avoid generated
    // Ant Design classes and DOM-position selectors such as nth-child.
    const confirmRegistrationButton = page.locator(
        '.ant-modal-wrap:visible .form-footer button.ant-btn-primary'
    );

    // These are application-owned structural classes, not generated CSS names.
    const refreshButton = page.locator(
        'main .header .action.no-print > button'
    );
    let refreshClickCount = 0;

    while (true) {
        const [course, registeredCredits] = await Promise.all([
            readCourseStatus(),
            readRegisteredCredits(),
        ]);

        if (!course) {
            throw new Error(`Could not find course: ${targetCourseName}`);
        }

        console.log(
            `[${new Date().toLocaleString()}] ${targetCourseName}: ` +
            `${course.status} (${course.availableSlots} slots available, ` +
            `registered credits: ${registeredCredits})`
        );

        if (course.status === 'AVAILABLE') {
            await registerButton.waitFor({ state: 'visible' });
            await registerButton.click();
            console.log(`Clicked Register for ${targetCourseName}.`);

            await confirmRegistrationButton.waitFor({ state: 'visible' });

            const registrationResponsePromise = page.waitForResponse(
                (response) =>
                    ['xhr', 'fetch'].includes(
                        response.request().resourceType()
                    ) &&
                    ['POST', 'PUT', 'PATCH'].includes(
                        response.request().method()
                    ),
                { timeout: 30000 }
            );

            await confirmRegistrationButton.click();
            const registrationResponse = await registrationResponsePromise;
            await registrationResponse.finished();

            if (!registrationResponse.ok()) {
                throw new Error(
                    `Registration request failed with HTTP ` +
                    `${registrationResponse.status()}: ` +
                    registrationResponse.url()
                );
            }

            console.log(
                `Confirmed registration for ${targetCourseName} ` +
                `(HTTP ${registrationResponse.status()}).`
            );
            break;
        }

        await page.waitForTimeout(refreshIntervalMs);
        await refreshButton.waitFor({ state: 'visible' });

        const refreshResponse = page.waitForResponse(
            (response) =>
                ['xhr', 'fetch'].includes(response.request().resourceType()) &&
                response.request().method() !== 'OPTIONS',
            { timeout: 30000 }
        );

        await refreshButton.click();
        const response = await refreshResponse;
        await response.finished();
        await targetCourseRow.waitFor({ state: 'visible' });
        refreshClickCount += 1;

        if (refreshClickCount === maxRefreshClickCount) {
            console.log(
                `Refresh button clicked ${maxRefreshClickCount} times; reloading the browser page.`
            );
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openPageTwo();
            refreshClickCount = 0;
        }
    }


    // Put the rest of your automation logic here

    await browser.close();
}

runAutomation();
