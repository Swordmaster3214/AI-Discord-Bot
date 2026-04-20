# ai-discord-bot

An agentic Discord bot that runs on [Ollama](https://ollama.com) with native tool calling. Responds in channels, DMs, and threads. Supports web search via a local SearXNG instance, shell exec with owner approval, code execution, file access, page fetching, and persistent encrypted per-user memory.

---

## Requirements

- Node.js 22.5+
- [Ollama](https://ollama.com) running locally
- Docker (for SearXNG web search, optional)
- A Discord bot token

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/yourname/ai-discord-bot
cd ai-discord-bot
npm install
```

### 2. Create your `.env`

```env
DISCORD_TOKEN=your_discord_bot_token
OWNER_ID=your_discord_user_id

# Optional — defaults shown
OLLAMA_URL=http://localhost:11434
DEFAULT_MODEL=llama3.1:8b-instruct-q4_K_M

# Optional — enables web search
SEARXNG_URL=http://localhost:8080

# Optional — enables persistent encrypted memory
# Generate with: openssl rand -hex 32
MEMORY_KEY=

# Optional — path to memory DB (default: ./memory.db)
MEMORY_DB_PATH=./memory.db

# Optional — sandbox path for the file tool (default: /tmp/bot-files)
FILE_SANDBOX=/tmp/bot-files

# Optional — max concurrent Ollama requests (default: 2)
OLLAMA_CONCURRENCY=2
```

### 3. Pull a model

```bash
ollama pull llama3.1:8b-instruct-q4_K_M
```

Any model with tool calling support will work. Thinking is optional and only works on models that support it (e.g. `qwen3`).

### 4. Start SearXNG (optional, for web search)

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080
```

```bash
docker-compose up -d
```

SearXNG needs JSON output enabled. Add this to `searxng/settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

### 5. Create your Discord bot

1. Go to [discord.com/developers](https://discord.com/developers/applications) and create a new application
2. Under **Bot**, enable **Message Content Intent**
3. Copy the token into your `.env`
4. Under **OAuth2 → URL Generator**, select `bot` + `applications.commands`, then the permissions you want
5. Invite the bot to your server with the generated URL

### 6. Run it

```bash
node main.js
```

Or with PM2 for auto-restart:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

---

## Basic configuration

The bot is **silent by default** in servers. Use slash commands to configure it.

```
/config mode auto         — respond to all messages in this channel
/config mode mention      — respond only when @mentioned
/config mode slash        — slash command (/agent) only
/config browsing true     — enable web search (requires SearXNG)
/config thinking true     — enable chain-of-thought (model must support it)
/config exec true         — enable shell exec (requires owner approval per command)
/config runcode true      — enable Python/Node code execution
/config fetch true        — enable webpage fetching
/config file true         — enable sandboxed file read/write
```

DMs work out of the box. Most tool flags in DMs are owner-only.

---

## Features

**Tools the model can use (when enabled):**
- `search` — web search via SearXNG
- `exec` — runs shell commands, requires owner approval each time
- `run_code` — executes Python or Node.js snippets
- `file` — read/write/patch files in a sandboxed directory
- `fetch_page` — fetches and reads a webpage
- `remember` / `forget` — stores per-user facts across sessions (encrypted, opt-in)

**Other stuff:**
- Per-channel, per-guild, and per-DM config
- Context scoped per-channel or per-guild
- Native thinking support for compatible models
- 🧠 button on responses to view the model's reasoning
- Queue with per-user cooldown and per-channel ordering
- Owner DM commands (`!exec`, `!models`, `!clear`, `!memory`, etc.)
- `/gaslight` — inject fake assistant messages into context (useful for steering)

---

## Memory

Memory is disabled unless you set `MEMORY_KEY` in your `.env`. Users opt in with `/memory enable`. Facts are encrypted at rest with AES-256-GCM using a per-user derived key.

```bash
# Generate a key
openssl rand -hex 32
```

---

## Owner commands

Send these as DMs to the bot (you must be the `OWNER_ID`):

```
!help
!guilds
!contexts
!clear all / guild <id> / dm <userId>
!exec <shell command>
!models
!model pull <name>
!model rm <name>
!memory stats
!memory clear <hash>
```
