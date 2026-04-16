const axios = require("axios");

const definition = { type: "function", function: {
    name: "fetch_page",
    description: "Fetch a webpage and return its readable text content. Use when you have a URL and need its contents.",
    parameters: { type: "object", properties: {
        url: { type: "string" },
    }, required: ["url"] },
}};

async function execute({ url }) {
    try {
        const res = await axios.get(url, { timeout: 10000, responseType: "text",
            headers: { "User-Agent": "Mozilla/5.0" } });
        // Strip HTML tags, collapse whitespace
        const text = res.data
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim();
        return text.slice(0, 6000); // cap at 6k chars
    } catch(e) { return `Fetch failed: ${e.message}`; }
}

module.exports = { definition, execute };
