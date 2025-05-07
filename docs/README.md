markdown
# Telegram MCP Client Bot

A Telegram bot that acts as an MCP client, integrating with Gemini-2.5-Pro for natural language processing, tool orchestration, and multimodal input handling. Configuration is managed via a Telegram Mini App UI.

## Features

*   Telegram interface for natural language interaction.
*   Integration with Google's Gemini-2.5-Pro model.
*   Supports Gemini Function Calling to execute actions via MCP servers.
*   Handles multimodal inputs (text, photos, audio). Basic document handling is noted as requiring an MCP server.
*   **Mini App Configuration UI:** Users can configure their settings (Gemini API key, prompt system, general options) and manage their MCP servers through a web interface launched from Telegram.
*   **Per-User Persistence:** Stores chat history, user settings, and MCP server configurations in a database per user.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <repository_url>
    cd telegram-mcp-client-bot 
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install # Or npm install / yarn install
    ```

3.  **Get API Keys:**
    *   **Telegram Bot Token:** Talk to [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. Get your API token.
    *   **Gemini API Key:** Get an API key from Google AI Studio ([https://aistudio.google.com/](https://aistudio.google.com/)) or Google Cloud. You can use *one shared key* by putting it in the `.env` as `SHARED_GEMINI_API_KEY`, or allow *each user* to configure their own key via the Mini App UI. The latter requires careful security handling (see [docs/SECURITY.md](./SECURITY.md)).

4.  **Configure Environment Variables:**
    *   **Database:**
        *   Decide on your database (e.g., SQLite for simplicity, PostgreSQL for production).
        *   Prisma uses the `DATABASE_URL` environment variable.
        *   For SQLite, the default in `.env.example` is `DATABASE_URL="file:./db/bot.sqlite"`. Ensure the `db` directory exists or can be created by Prisma.
        *   For other databases, set the appropriate connection string (e.g., `DATABASE_URL="postgresql://user:password@host:port/database"`).

    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and replace the placeholder value(s) with your actual API keys:
        ```dotenv
        BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
        DATABASE_URL="file:./db/bot.sqlite" # Adjust if needed
        # SHARED_GEMINI_API_KEY=YOUR_GOOGLE_GEMINI_API_KEY # Uncomment if using a shared key
        ```
    *   You can also set the web server port here (default is 3000).
    *   Ensure your `.gitignore` file includes `.env` and potentially your database file (e.g., `db/bot.sqlite*` if using SQLite in that path, or `prisma/dev.db*` if using Prisma's default for SQLite) to protect your secrets and database.

5.  **Configure BotFather for Mini App:**
    *   Go to [@BotFather] -> [Your Bot] -> Bot settings -> Menu button -> Edit menu button -> Web App.
    *   Set the URL to the address where your bot's web server will be hosted. This URL **must** be accessible from the internet via HTTPS for production. For testing, Telegram offers a [test environment](https://core.telegram.org/bots/webapps#testing-mini-apps).
    *   Example URL: `https://your-domain.com/` or `https://your-domain.com/settings`.
    *   Update your bot's `YOUR_DEPLOYED_WEBAPP_URL_NOT_SET` placeholder in `src/bot/commands.ts` (or better, set an environment variable `YOUR_DEPLOYED_WEBAPP_URL` and read it there).

6.  **Set up Prisma and Database:**
    *   Initialize Prisma (if not already done by `npx prisma init` during setup - this command generates `prisma/schema.prisma`):
        ```bash
        npx prisma init --datasource-provider sqlite # Or your chosen provider (postgresql, mysql, mongodb, etc.)
        ```
        (The provided patch will include a `prisma/schema.prisma` file, so this step might be more about adjusting the `datasource` block if you change DB).
    *   Run database migrations to create tables:
        ```bash
        npx prisma migrate dev --name init_migration
        ```
    *   Generate Prisma Client: (This is often run by `prisma migrate dev` or can be run manually)
        ```bash
        npx prisma generate
        ```
6.  **Run the bot:**
    ```bash
    npm start
    ```
    or, for development with auto-restart on file changes:
    ```bash
    npm run dev
    ```

7.  **Access Settings:**
    *   Once the bot is running and the web server is accessible at the configured URL, send the `/settings` command to your bot in Telegram.
    *   Click the "Open Settings" button in the message. This will launch the Mini App UI.

## Contributing

Contributions are welcome! Please follow the standard GitHub flow: fork, create a branch, make your changes, and submit a pull request.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
