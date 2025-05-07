markdown
# Security Considerations

Integrating a bot with external APIs (Gemini, MCP servers) and allowing users to configure these integrations introduces significant security considerations. This document highlights key areas to address.

## 1. Telegram Mini App Security

The Mini App UI is the primary attack surface for user configuration.

*   **`initData` Validation (CRITICAL):** The most important security measure. All API endpoints accessed by the Mini App **MUST** validate the `window.Telegram.WebApp.initData` string provided by the Mini App frontend. This string contains authentication data signed by Telegram. Validating it ensures:
    *   The request originated from a genuine Telegram Mini App.
    *   You know *which user* is making the request (the user's ID is part of the `initData`).
    *   This prevents malicious users from sending fake API requests to your backend.
    *   Refer to the [Telegram Web Apps documentation](https://core.telegram.org/bots/webapps#authenticating-users) for the validation process (it involves checking the hash against a secret derived from your `BOT_TOKEN`). The provided `src/webapp/server.ts` has a placeholder; **replace this with a robust implementation.**
*   **HTTPS:** The web server hosting the Mini App **MUST** use HTTPS in production to protect data in transit (including potential API keys entered by users).
*   **Sanitize User Input:** Although the Mini App form provides structure, always sanitize and validate *all* data received from the frontend API endpoints before processing or saving it (e.g., server names, URLs, command arguments, environment variable values).
*   **Least Privilege:** Ensure the API endpoints only allow the specific actions needed by the Mini App (e.g., a user should only be able to manage *their own* configurations). The `initData` validation helps enforce this by providing the user ID.

## 2. API Key Management

Handling API keys (Gemini, potentially MCP server keys) is sensitive.

*   **Storage:** If storing per-user Gemini API keys or keys for MCP servers in the database, they **MUST be encrypted at rest**. Use a strong encryption library in your Node.js backend. Decrypt keys only when needed (e.g., to initialize a Gemini client or launch an stdio MCP server process).
*   **Transmission:** Be extremely cautious about transmitting API keys.
    *   Mini App frontend to backend: Transmit over HTTPS. Consider temporary tokens or other secure methods instead of sending the raw key repeatedly. Clearing the key from the input field after saving is a good UI practice but doesn't secure the transmission.
    *   Backend to MCP server: For stdio servers, keys might be passed via environment variables. Ensure these don't end up in logs. For http servers, keys are often in headers (ensure HTTPS for the MCP server connection).
*   **Shared vs. Per-User Keys:** Using a single shared API key managed by the bot owner simplifies key management and security but limits per-user customization/cost tracking. Allowing per-user keys via UI adds significant security complexity (validation, encryption, access control).

## 3. MCP Server Management

Allowing users to configure and launch external processes/services (especially stdio) is a major security boundary.

*   **Stdio Security:**
    *   Running an arbitrary command provided by a user (via `command` and `args`) is a severe security risk. A malicious user could potentially run harmful code on your bot's hosting server.
    *   **Mitigation for stdio:** For a public bot, strictly limit available stdio servers to a hardcoded allowlist of *pre-approved, trusted commands/scripts* managed by the bot owner. Do not allow arbitrary commands/paths from the user via the Mini App UI form. The form could instead offer a dropdown of *predefined stdio server types* (e.g., "Filesystem", "Weather") with fixed commands/args/env templates, perhaps allowing the user to fill in only *safe* parameters (like a root directory path *within a designated safe area* or API keys).
    *   For a personal bot, be aware that adding a stdio server runs that process on your machine/server. Only add configurations you fully trust.
*   **HTTP Security:**
    *   Connecting to an arbitrary HTTP URL provided by a user is less risky than running a local process but still exposes your bot to potential network attacks (e.g., SSRF, connecting to malicious endpoints).
    *   **Mitigation for http:** Validate URLs to prevent connection to internal networks (SSRF). Be mindful of timeout and resource limits when connecting to external HTTP endpoints.
*   **Tool Execution:** The MCP specification recommends human-in-the-loop approval for tool calls, especially destructive ones. The bot backend receiving the `tools/call` request should implement this if possible (e.g., send a confirmation message to the user in Telegram before executing the tool). This adds significant complexity to the conversation flow.
*   **Resource Access:** MCP resources expose data. Ensure that resource access controls are enforced by the MCP server itself and that the bot's setup doesn't bypass these.

## 4. Conversation History

Chat history contains user inputs and bot outputs, potentially including sensitive information passed during interactions or tool results.

*   **Storage:** Encrypt sensitive parts of the chat history in the database if necessary.
*   **Access:** Ensure users can only access their own chat history. The database queries in `ConversationManager` must be scoped by `chat_id` or `user_id`.
    *   Ensure users can only access their own chat history. The database queries in `ConversationManager` must be scoped by `chat_id` or `user_id`.

## 5. Third-Party Dependencies
*   **Database Connection String (`DATABASE_URL`)**:
    *   The `DATABASE_URL` in your `.env` file contains credentials and connection details for your database. This file should **never** be committed to version control.
    *   Ensure the `.env` file has restrictive permissions on your server.
    *   For production databases, use strong, unique passwords and consider network-level access controls (firewalls) to restrict who can connect to your database server.

*   Ensure all your npm dependencies (including transitive ones) are up-to-date and do not have known vulnerabilities. Use `npm audit` regularly.
*   Be cautious of using untrusted MCP servers or libraries. Their code runs (stdio) or is interacted with (http) by your bot.

Implementing robust security requires careful design and coding at every layer. For a public-facing bot, consulting with security experts is highly recommended. Start simple, understand the risks, and gradually add features with security in mind.

