markdown
# How to Use the Bot

Once the bot is running and you have added it to Telegram (by searching its username), you can interact with it.

## Basic Interaction

Simply send a text message to the bot. It will process your message using Gemini.

*   **Text Prompts:** Send questions or instructions. If the request can be answered using the bot's core knowledge, Gemini will respond directly.
    *   Example: "What is the capital of France?"
    *   Example: "Tell me a short story about a robot."

## Configuration via Mini App

All user-specific settings and MCP server management are done through the Mini App UI.

1.  Send the `/settings` command to the bot.
2.  Click the "Open Settings" button in the message.

Inside the Mini App, you can:

*   **General Settings:**
    *   Set your **Gemini API Key** (if the bot is configured to accept per-user keys - see [docs/SECURITY.md](./SECURITY.md)).
    *   Choose your preferred **Gemini Model**.
    *   Adjust **Temperature** and other Gemini generation parameters.
    *   Define a **System Instruction** for Gemini.
    *   Enable/Disable **Google Search** (requires a separate MCP server for Google Search and backend support).
    *   Save these settings.

*   **MCP Servers:**
    *   View your list of configured MCP servers.
    *   Click "Add New MCP Server" to provide the configuration JSON via a form. See [docs/MCP_CONFIG.md](./MCP_CONFIG.md) for the format.
    *   Delete existing MCP servers.

*   **Chat History:**
    *   (If implemented) Clear your conversation history for the current chat.

## Using MCP Features

The bot interacts with your configured MCP servers via Gemini's function calling.

*   **List Your Configured MCP Servers:**
    *   Send the command `/list_mcps`.
    *   The bot will list the names and types (stdio/http) of the MCP servers you have configured via the Mini App.

*   **Triggering MCP Tools:**
    *   Ensure you have relevant MCP servers configured via the `/settings` Mini App.
    *   Phrase your requests in natural language that requires the use of one of your configured tools.
    *   Example (with filesystem server configured): "Can you list the files in my downloads folder?"
    *   Example (with a weather server configured): "What is the temperature in London?"
    *   Example (with a document server configured): "Summarize the document I just sent."
    *   When Gemini decides to use a tool, the bot will execute the tool call using your specific server configuration. The result will be sent back to Gemini for a final response, which will then be sent to you.
    *   **Important:** Be aware that executing tools can have side effects (like modifying files, sending messages, etc.).

## Using Multimodal Inputs

The bot can receive and process certain types of media files, passing them to Gemini.

*   **Photos:** Send a photo to the bot, optionally with a caption. Gemini can process the image and caption together.
*   **Audio:** Send an audio file (like a voice message). Gemini can potentially transcribe and understand the audio.
*   **Documents:** Sending documents (like PDFs) is handled, but direct content understanding requires you to configure an MCP server specializing in document processing via the settings Mini App.

For best results with multimodal inputs, provide a caption that gives context to the media.

