const puppeteer = require("puppeteer");

const definition = { type: "function", function: {
    name: "fetch_page",
    description: "Fetch a webpage and return its readable text content. Use when you have a URL and need its contents.",
    parameters: { type: "object", properties: {
        url: { type: "string" },
    }, required: ["url"] },
}};

let browser = null;

async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
    }
    return browser;
}

async function execute({ url }) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const text = await page.evaluate(() => document.body.innerText);
        return text.replace(/\s+/g, " ").trim().slice(0, 6000);
    } catch (e) {
        return `Fetch failed: ${e.message}`;
    } finally {
        await page.close();
    }
}

module.exports = { definition, execute };
