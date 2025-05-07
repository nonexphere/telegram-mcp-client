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
    *   **Run Database Migrations:** This command will create the necessary tables in your database based on the `prisma/schema.prisma` file. It should be run after any changes to the schema.
        ```bash
        pnpm db:migrate
        ```
        *(Isso corresponde ao seu pedido de "migration")*
    *   **Generate Prisma Client & Build Project:** The Prisma Client (o código que seu aplicativo usa para interagir com o banco de dados) e o build do projeto (compilação de TypeScript para JavaScript) são gerados com o seguinte comando:
        ```bash
        pnpm build
        ```
        *(Isso corresponde aos seus pedidos de "gerar o prisma" e "gerar o build". O script `build` no `package.json` executa `prisma generate` e depois `tsc`.)*

## Running the Bot

After completing the setup steps:

*   **For Development (with auto-reload):**
    ```bash
    pnpm dev
    ```
    This command uses `tsx` to run your TypeScript code directly and will automatically restart the bot when you make changes to the source files.

*   **For Development (without auto-reload):**
    ```bash
    pnpm start
    ```
    This command also uses `tsx` to run your TypeScript code directly.

*   **For Production:**
    1.  Ensure you have built the project:
        ```bash
        pnpm build
        ```
    2.  Start the bot using the compiled JavaScript files:
        ```bash
        pnpm start:prod
        ```
        *(Este script `start:prod` executa `node dist/index.js`, que é o ponto de entrada do seu aplicativo compilado).*

*(Os comandos acima correspondem ao seu pedido de "iniciar o projeto")*
```
