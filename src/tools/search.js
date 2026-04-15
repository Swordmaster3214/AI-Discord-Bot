const axios = require("axios");

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8080";

const definition = {
    type: "function",
    function: {
        name: "search",
        description:
            "Searches the web via a local SearXNG instance. " +
            "Use for current events, facts you are uncertain about, or anything " +
            "that benefits from up-to-date information.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query string.",
                },
            },
            required: ["query"],
        },
    },
};

async function execute({ query }) {
    console.log(`[SEARCH] Query: ${query}`);
    try {
        const res = await axios.get(`${SEARXNG_URL}/search`, {
            params: { q: query, format: "json" },
            timeout: 10000,
        });
        const top = (res.data.results || []).slice(0, 5).map((r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content ?? ""}`
        ).join("\n\n");
        console.log(`[SEARCH] Returned ${(res.data.results || []).length} results.`);
        return top.length > 0
            ? `Results for "${query}":\n\n${top}`
            : `No results found for "${query}".`;
    } catch (err) {
        const isDown = err.code === "ECONNREFUSED" || err.code === "ECONNRESET";
        const hint = isDown ? "SearXNG does not appear to be running." : err.message;
        console.error(`[SEARCH] Error: ${hint}`);
        return `Search unavailable: ${hint}. Respond to the user with what you know.`;
    }
}

module.exports = { definition, execute };
