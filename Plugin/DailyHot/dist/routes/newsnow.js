const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin());

async function fetchNewsNowData() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto('https://newsnow.busiyi.world/c/realtime', { waitUntil: 'networkidle2', timeout: 30000 });

        const groupedLinks = await page.evaluate(() => {
            const results = [];
            const titleElements = Array.from(document.querySelectorAll('span.text-xl.font-bold'));

            for (const titleEl of titleElements) {
                const category = titleEl.textContent.trim();
                const container = titleEl.closest('div[class*="rounded"]');
                if (!container) continue;

                const anchors = Array.from(container.querySelectorAll('a[href]'));
                const linkData = anchors.map(anchor => ({
                    category: category, // Assign category to each item
                    title: anchor.textContent.trim(),
                    url: anchor.href
                })).filter(link =>
                    link.title &&
                    link.url &&
                    link.url.startsWith('http') &&
                    !link.url.startsWith('javascript:') &&
                    link.title.length > 5
                );
                
                const seenUrls = new Set();
                const uniqueLinks = [];
                for (const link of linkData) {
                    if (!seenUrls.has(link.url)) {
                        seenUrls.add(link.url);
                        uniqueLinks.push(link);
                    }
                }
                results.push(...uniqueLinks);
            }
            return results;
        });
        
        return groupedLinks;

    } catch (error) {
        console.error(`[DailyHot-NewsNow] Error fetching data: ${error.message}`);
        return []; // Return empty array on error
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function handleRoute(req, fromPlugin) {
    if (!fromPlugin) {
        // This module is designed to be called from the DailyHot plugin, not directly.
        return { error: "Not intended for direct access." };
    }

    const data = await fetchNewsNowData();
    
    return {
        title: 'NewsNow',
        type: '聚合',
        data: data
    };
}

module.exports = {
    handleRoute
};