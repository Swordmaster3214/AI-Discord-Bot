# Privacy Policy

**Last updated:** April 17, 2026

This Privacy Policy describes how this Discord bot ("the Bot," "we," "us") collects, uses, and handles information when you interact with it. By using the Bot, you agree to the practices described here.

---

## 1. Who Operates the Bot

The Bot is operated by its owner ("Bot Owner"), an individual identified by the `OWNER_ID` environment variable configured at deployment. The Bot Owner has administrative access described in Section 4. If you need to contact the operator, reach out via the Discord server where you encountered the Bot.

---

## 2. What Information We Collect

### 2.1 Conversation Context (Ephemeral)

When you send a message to the Bot, your message content and the Bot's replies are stored **in memory** to maintain conversational context. This data is:

- Keyed to your Discord user ID (for DMs) or the channel/server (for guild channels), depending on configuration.
- **Not written to disk** and is lost automatically when the Bot restarts.
- Retained in memory only for the duration of the current session unless you or a server administrator explicitly clears it via `/clearcontext`.

### 2.2 Long-Term Memories (Opt-In Only)

The Bot includes an optional memory feature that allows it to remember facts about you across sessions. This feature is **disabled by default** and must be explicitly enabled by you via `/memory enable`.

When enabled:

- Facts the Bot deems relevant are stored in an encrypted SQLite database (`memory.db`) on the server hosting the Bot.
- Your Discord user ID is never stored directly. Instead, it is transformed into a pseudonymous hash (HMAC-SHA256 using a server-side secret key) before being written to disk.
- Each stored fact is individually encrypted using AES-256-GCM with a unique per-user derived key. The Bot Owner cannot read the plaintext content of your memories without access to the master encryption key.
- A maximum of 50 memories are stored per user. When the limit is reached, the oldest memory is evicted to make room for new ones.
- You can view, edit, delete, or clear all your memories at any time using the `/memory` commands.
- You can opt out at any time via `/memory disable`. Your memories are preserved but will no longer be used until you re-enable the feature. `/memory clear` permanently deletes all stored memories.

### 2.3 Configuration Data

Server administrators and DM users may configure the Bot via `/config` commands. These settings (including your Discord user ID for DM configurations) are stored in a `config.json` file on the host server.

### 2.4 Shell Command Approval Requests (If Exec Is Enabled)

If the `exec` tool is enabled in your channel or DM, and you ask the Bot to run a shell command, an approval request is sent to the Bot Owner. This request includes:

- Your Discord username.
- The server/channel where the request originated.
- The command you requested.
- Up to 6 recent messages from the conversation as context for the approval decision.

You will be notified via a message in the channel before any approval request is dispatched. Exec is disabled by default and may only be enabled by the Bot Owner in DMs.

---

## 3. How We Use Your Information

We use the information described above only to:

- Provide and improve the Bot's conversational capabilities.
- Maintain per-user memory when you have opted in.
- Facilitate the exec approval workflow when applicable.
- Allow server administrators to configure and manage the Bot.

We do not use your information for advertising, profiling, or any purpose unrelated to operating the Bot.

---

## 4. Bot Owner Access

The Bot Owner has elevated administrative access through a private DM command interface. Specifically, the Bot Owner can:

- View aggregate memory statistics (user count and memory count per pseudonymous hash — **not** memory content).
- Delete all memories associated with a specific pseudonymous user hash.
- View and resolve pending exec approval requests, which include recent conversation context as described in Section 2.4.
- Clear any conversation context from memory.
- Execute arbitrary shell commands on the host machine via the `!exec` owner command.

---

## 5. Data Sharing and Third Parties

### 5.1 Local AI Inference

The Bot uses **Ollama**, a locally hosted large language model runtime. Your messages are sent to the Ollama instance running on the same server as the Bot. **No message content is transmitted to external AI providers** unless the Bot Owner has configured Ollama to use a remote endpoint.

### 5.2 Web Search

If web search is enabled, your query (derived from your message) is sent to a **locally hosted SearXNG** instance. SearXNG is a self-hosted, privacy-respecting search engine that proxies requests to third-party search engines without identifying you to them. However, the underlying search engines may receive the search terms.

### 5.3 Page Fetching

If the page fetch tool is enabled and the Bot fetches a URL on your behalf, the request is made from the Bot's server to the target website. The target website may log the server's IP address and the requested URL.

### 5.4 Discord

All messages pass through Discord's platform. Discord's own [Privacy Policy](https://discord.com/privacy) governs how Discord handles your data.

### 5.5 No Sale of Data

We do not sell, rent, or share your personal information with any third party for their own commercial purposes.

---

## 6. Data Retention

| Data Type | Storage | Retention |
|---|---|---|
| Conversation context | In-memory only | Until Bot restart or `/clearcontext` |
| Long-term memories | Encrypted SQLite on host | Until you run `/memory clear` or the Bot Owner deletes them |
| Configuration settings | `config.json` on host | Until reset via `/config reset` |
| Exec approval requests | In-memory only | Until resolved or timed out (5 minutes) |

---

## 7. Security

- Long-term memories are encrypted at rest using AES-256-GCM with per-user derived keys.
- User IDs are pseudonymized via HMAC-SHA256 before being written to disk.
- The Bot does not implement any authentication beyond Discord's own user identity system.
- Security ultimately depends on the physical and operational security of the server hosting the Bot. We make no guarantees about the security of the host environment.

---

## 8. Children's Privacy

The Bot is not directed at children under 13 (or the applicable age of digital consent in your jurisdiction). Discord itself requires users to be at least 13 years old. We do not knowingly collect information from children under 13. If you believe a child has provided information to the Bot, please contact the Bot Owner.

---

## 9. Your Rights

You have the right to:

- **Access** your stored memories at any time via `/memory list`.
- **Correct** a stored memory via `/memory edit`.
- **Delete** individual memories via `/memory delete` or all memories via `/memory clear`.
- **Opt out** of memory storage at any time via `/memory disable`.
- **Request deletion** of your configuration data by contacting the Bot Owner.

Because conversation context is ephemeral and not persisted to disk, there is no mechanism to retrieve or delete historical conversation data after the Bot restarts.

---

## 10. Changes to This Policy

We may update this Privacy Policy from time to time. Continued use of the Bot after changes are announced constitutes acceptance of the updated policy. We recommend checking the policy periodically.

---

## 11. Contact

For privacy-related questions or requests, contact the Bot Owner via Discord.
