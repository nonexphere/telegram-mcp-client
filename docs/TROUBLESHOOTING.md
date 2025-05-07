markdown
# Troubleshooting

Here are some common issues and troubleshooting steps for the bot.

## General Issues

*   **Bot is not responding:**
    *   Check the bot's console output for any errors.
    *   Ensure the bot process is actually running (`npm start` or `npm run dev`).
    *   Verify your `BOT_TOKEN` in the `.env` file is correct and the bot hasn't been blocked or deactivated in Telegram.
    *   Ensure the server where the bot is running has network access to Telegram's servers.

*   **Mini App button does nothing or shows an error:**
    *   Verify the `YOUR_DEPLOYED_WEBAPP_URL` environment variable (or hardcoded value) in `src/bot/commands.ts` matches the URL configured in @BotFather *exactly*.
    *   Ensure the web server is running and accessible at that URL (check port, firewall, deployment logs).
    *   The URL configured in BotFather **must** use HTTPS for production.
    *   Check the browser console within the Mini App for JavaScript errors (Right-click in the Mini App > Inspect or equivalent).
    *   Check the bot's console output for errors when the Mini App server starts or when you try to access `/api/user_config`.

*   **Mini App loads but shows "Unauthorized" or fails to load data:**
    *   The `initData` validation on the backend (`src/webapp/server.ts`) is failing. This is a critical security step. Ensure `app.initData` is being correctly passed from the Mini App frontend (`script.js`) to the backend API calls (e.g., in headers or query params) and that the backend validation logic is correct using your actual `BOT_TOKEN`.

*   **Gemini is not responding or giving strange answers:**
    *   Check the bot's console output for any errors related to the Gemini API.
    *   Check if you are using a shared API key (`SHARED_GEMINI_API_KEY` in `.env`) or a per-user key (set in Mini App).
        *   If using a shared key, ensure it's correct in `.env`.
        *   If using per-user keys, ensure you have set your key in the Mini App settings and that the key is correctly loaded from the DB and passed to the `GeminiClient`.
    *   Check the Gemini API status page.
    *   Complex prompts or inputs might confuse the model. Try simpler prompts.
    *   Consider adjusting the `temperature` or other generation parameters in the Mini App settings.

## MCP Server Issues

*   **Your configured MCP server does not appear in the list in the Mini App:**
    *   Ensure you successfully added it via the "Add New MCP Server" form and clicked "Add Server".
    *   Check the bot's console output for errors when adding the server.
    *   Verify the database is correctly saving the configuration (check the `mcp_configs` table in `db/bot.sqlite`).

*   **Gemini recognizes tools (e.g., suggests calling `tool_name_servername`) but they fail to execute:**
    *   Check the bot's console output for errors when Gemini makes a tool call request (this happens after Gemini's initial response suggesting function calls).
    *   Look for errors originating from the `mcpClientManager.callTool` method.
    *   The `McpClientManager` attempts to connect the client on demand for your user when needed. Check logs related to client connection attempts for that specific server name and user ID.
    *   Verify the underlying MCP server process starts correctly (for `stdio` type) or is reachable (for `http` type). Try running the `stdio` command manually. For `http`, check network connectivity to the URL.
    *   Ensure any environment variables specified in the MCP config's `env` field are correctly applied when the `stdio` process is launched.
    *   Check the logs of the specific MCP server itself for errors during tool execution. The bot's console might show `stderr` output from stdio servers.
    *   Ensure the mapping from MCP tool `inputSchema` to Gemini `functionDeclarations` is correct. Errors here might cause Gemini to send arguments the tool doesn't expect.
    *   **Important:** The client connection for a user is attempted *on demand*. If the server fails to start or connect, the tool call will fail.

*   **Prisma / Database Issues:**
    *   **Connection Errors:**
        *   Verify the `DATABASE_URL` in your `.env` file is correct for your database type and credentials.
        *   For SQLite, ensure the path to the database file is correct and the directory is writable by the bot process.
    *   **Migration Issues:**
        *   If you see errors like "The table `tableName` does not exist in the current database," you might have forgotten to run migrations. Execute `npx prisma migrate dev --name <migration_name>`.
        *   If a migration fails, check the error message. You might need to resolve conflicts or reset your database (for development only: `npx prisma migrate reset`).
    *   **Prisma Client Not Generated / Out of Sync:**
        *   If you get TypeScript errors related to Prisma Client types or runtime errors about missing methods, run `npx prisma generate`. This is usually done automatically by `prisma migrate dev`, but can be run manually.
    *   **`PrismaClientKnownRequestError` / `PrismaClientValidationError` etc.:**
        *   These are specific errors from Prisma. The error message usually provides good clues.
        *   `P2002`: Unique constraint failed (e.g., trying to insert a duplicate `userId` in `UserConfig` or a duplicate `userId`+`name` in `McpConfig`).
        *   `P2025`: Record to update or delete does not exist.

*   **MCP notifications (`tools/list_changed`, etc.) are not handled:**
    *   Ensure the `setupClientListeners` method in `src/mcp/mcpClientManager.ts` is correctly implemented and the event listeners are attached when a client connects.
    *   Verify the MCP server supports sending these specific notifications (check the server's documentation or capabilities during initialization).

## Multimodal Input Issues

*   **Photos/Audio/Documents are received but not processed:**
    *   Check the console for errors in `src/bot/media.ts`.
    *   Verify the `downloadFile` utility is working correctly. Network or firewall issues might prevent downloading files from Telegram URLs.
    *   Ensure the file type's mime type is correctly handled and prepared for Gemini's `inlineData`. Gemini supports specific image and audio formats.
    *   Remember that document content processing requires an MCP server capable of extracting text or data from documents. You need to configure such a server via the Mini App settings and ensure the bot backend logic calls that server when a document is received.

*   **Gemini doesn't seem to understand the content of the media:**
    *   Ensure the media type is supported by Gemini's multimodal capabilities (Gemini 2.5 Flash supports images and audio).
    *   Provide a clear caption with the media to give Gemini additional context.
    *   Complex or unusual media content might be difficult for the model to interpret.

## Conversation Context Issues

*   **Bot forgets previous turns:**
    *   Verify the `ConversationManager` is correctly adding both user and bot messages (including Gemini's direct responses, function calls, and function results) to the history database table (`chat_history`).
    *   Ensure the correct `chat_id` is used for accessing/storing history in the database.
    *   Check if history trimming logic (if implemented) is too aggressive.

## Debugging Tips

*   **Database Inspection:** Use the `sqlite3` command-line tool or a GUI client (like DB Browser for SQLite) to inspect the `db/bot.sqlite` file. Check the `user_configs`, `mcp_configs`, and `chat_history` tables to see if data is being saved as expected.
*   **Use `console.log`:** Add logging statements liberally in handlers, managers, storage functions, and web server endpoints to trace the flow and inspect variable values, especially user IDs and data being passed.
*   **Inspect Gemini/MCP Objects:** Log the `geminiResponse`, `functionCall`, `mcpToolResult`, etc., to understand their structure and values.
*   **Manual MCP Server Testing:** Use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) tool or the `mcp-cli` to test your MCP servers directly, independent of the bot. This helps isolate whether the issue is with the server or the bot's integration.
*   **Check Server Logs:** If using stdio servers, their `stderr` output should appear in the bot's console. For http servers, check their dedicated logging.
*   **Use `npm run dev`:** This restarts the bot automatically when you make code changes, speeding up the development loop.
*   **Mini App Browser Console:** Use the browser's developer tools (usually F12 or Right-click > Inspect) within the Mini App window to debug the frontend JavaScript (`script.js`) and inspect network requests to your `/api` endpoints.

