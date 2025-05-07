markdown
# Mini App Configuration Guide

The Telegram Mini App allows you to manage your personal settings and configured MCP servers for the bot.

## Accessing the Mini App

1.  Send the `/settings` command to the bot in Telegram.
2.  Click the "Open Settings" button in the message you receive.

This will open the Mini App interface within your Telegram client.

## General Settings

This section allows you to configure how the bot interacts with the Gemini API.

*   **Gemini API Key:** Enter your personal Gemini API key here. This is required if the bot is configured to use per-user keys. Your key will be stored in the bot's database (potentially encrypted - see [docs/SECURITY.md](./SECURITY.md)). **Handle this key securely.**
*   **Gemini Model:** Specify the Gemini model you want the bot to use for your interactions (e.g., `gemini-2.5-flash-latest`, `gemini-1.5-pro-latest`).
*   **Temperature:** Controls the randomness of Gemini's responses (0.0 for deterministic, 1.0 for maximum creativity).
*   **System Instruction:** A text field where you can provide a custom system prompt to guide Gemini's behavior for your chat sessions.
*   **Enable Google Search:** (Requires a Google Search MCP server to be available and integrated on the backend). Check this box to allow Gemini to use search tools for your requests.

Click "Save Settings" to apply your changes. Your Gemini API key will be cleared from the form after saving for security.

## MCP Servers

This section allows you to manage the external tools and data sources available to Gemini via MCP.

*   **Your Configured Servers:** Displays a list of the MCP servers you have added. Each entry shows the server's name and transport type.
    *   Click the "Delete" button next to a server to remove its configuration. This will disconnect the bot from that server *for your user* and remove the configuration from the database.

*   **Add New MCP Server:** Use this form to add a new MCP server configuration.
    *   **Server Name:** A unique name you give to this server configuration (e.g., `my-filesystem`, `weather-api`).
    *   **Transport Type:** Select the communication method the bot should use to connect to the server (either `stdio` or `http`).
        *   **stdio:** For local processes. Requires the `Command`, optional `Args`, and optional `Env` fields.
        *   **http:** For remote servers accessible via HTTP. Requires the `URL` field.
    *   **Command, Args, Env (for stdio):** Provide the executable command, optional command-line arguments (as a JSON array), and optional environment variables (as a JSON object) needed to start the stdio server process.
    *   **URL (for http):** Provide the base URL of the HTTP MCP endpoint.
    *   Click "Add Server" to save the configuration to the database and attempt to connect.

## Chat History

*   (If implemented) This section may contain options related to your chat history with the bot, such as a button to clear it.

**Security Note:** The Mini App communicates with the bot's web server backend. Your Telegram `initData` is used to authenticate you. Your configurations are stored in the bot's database linked to your Telegram user ID. If using per-user Gemini keys, they are stored in the DB. See [docs/SECURITY.md](./SECURITY.md) for more details.

