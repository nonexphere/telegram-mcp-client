/**
 * @file Sets up message handlers for media types (photos, audio, documents)
 * and contains logic for processing media with Gemini and MCP tools.
 */
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { downloadFile } from '../utils/file.js';
import { McpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';

/**
 * Processes the response from Gemini after a media message, handling potential tool calls.
 * This function is separated for clarity and potential reuse/testing.
 * @param ctx - The Telegraf context object.
 * @param geminiResponse - The response object from Gemini (may contain text or functionCalls).
 * @param chatId - The ID of the chat.
 * @param userId - The ID of the user who sent the media.
 * @param mcpClientManager - Instance for managing MCP clients.
 * @param geminiClient - Instance for interacting with Gemini.
 * @param conversationManager - Instance for managing chat history.
 * @param userSettings - Optional user-specific configuration.
 */
export async function processMediaWithToolExecution(
    ctx: Context,
    geminiResponse: { functionCalls?: any[]; text?: string },
    chatId: number,
    userId: number, // Added userId
    mcpClientManager: McpClientManager,
    geminiClient: GeminiClient,
    conversationManager: ConversationManager,
    userSettings?: UserConfiguration | null // Added userSettings
) {
    // Check if Gemini requested function calls based on the media.
    if (geminiResponse.functionCalls && geminiResponse.functionCalls.length > 0) {
        console.log(`[Chat ${chatId}] Gemini wants to call functions based on media:`, geminiResponse.functionCalls);

        const toolResults: any[] = [];
        // Execute each requested function call via the McpClientManager.
        for (const functionCall of geminiResponse.functionCalls) {
            try {
                const mcpToolResult = await mcpClientManager.callTool(userId, functionCall); // Pass userId
                const geminiFunctionResponse = { name: functionCall.name, response: {} as any };
                if (mcpToolResult && !mcpToolResult.isError) {
                    geminiFunctionResponse.response.result = mcpToolResult.content;
                } else {
                    geminiFunctionResponse.response.error = (mcpToolResult?.content?.[0]?.text || 'Unknown tool error').toString();
                }
                toolResults.push(geminiFunctionResponse);
                console.log(`[Chat ${chatId}] MCP tool "${functionCall.name}" executed. Result:`, mcpToolResult);
            } catch (toolError: any) {
                console.error(`[Chat ${chatId}] Error executing MCP tool "${functionCall.name}":`, toolError);
                toolResults.push({ name: functionCall.name, response: { error: toolError.message || 'Unknown tool error' } });
                ctx.reply(`Error executing tool: ${functionCall.name}. ${toolError.message || 'See logs.'}`);
            }
        }

        // Add Gemini's request and the tool results to the conversation history.
        await conversationManager.addMessage(chatId, { role: 'model', parts: geminiResponse.functionCalls.map((fc: any) => ({ functionCall: fc })) });
        await conversationManager.addMessage(chatId, { role: 'user', parts: toolResults.map(tr => ({ functionResponse: tr })) });

        const historyWithToolResults = await conversationManager.getHistory(chatId);
        // Call Gemini again with the updated history to get the final response.
        const geminiTools = await mcpClientManager.getTools(userId);
        // The `multimodalParts` argument was removed from generateContent.
        const finalGeminiResponse = await geminiClient.generateContent(historyWithToolResults, geminiTools, userSettings || undefined);

        const finalText = finalGeminiResponse.text;
        if (finalText) {
            console.log(`[Chat ${chatId}] Gemini final text response after media tool execution:`, finalText);
            ctx.reply(finalText);
            await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: finalText }] });
        } else {
            console.warn(`[Chat ${chatId}] Gemini did not return final text after media tool execution.`);
            ctx.reply('Action completed, but I did not get a final text response.');
        }
    } else if (geminiResponse.text) {
        // Gemini provided a direct text response for the media.
        console.log(`[Chat ${chatId}] Gemini direct text response for media:`, geminiResponse.text);
        ctx.reply(geminiResponse.text);
        await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: geminiResponse.text }] });
    } else {
        console.warn(`[Chat ${chatId}] Gemini returned an empty response for media.`);
        ctx.reply('Could not generate a response for the media.');
    }
}

/**
 * Registers message handlers for various media types (photo, audio, document).
 * @param bot - The Telegraf bot instance.
 * @param mcpClientManager - Instance for managing MCP clients.
 * @param geminiClient - Instance for interacting with Gemini.
 * @param conversationManager - Instance for managing chat history.
 * @param mcpConfigStorage - Instance for accessing user configurations.
 * @param _processMediaWithToolExecution - The function to handle Gemini responses and tool calls for media.
 */

export function setupMediaHandlers(
    bot: Telegraf<Context>,
    mcpClientManager: McpClientManager,
    geminiClient: GeminiClient,
    conversationManager: ConversationManager,
    mcpConfigStorage: McpConfigStorage,
    _processMediaWithToolExecution: typeof processMediaWithToolExecution // Pass the function for testability or direct call
): void {
    /**
     * Internal helper function to process common steps for media messages.
     * Downloads the file, prepares multimodal parts, updates history, calls Gemini,
     * and delegates response processing.
     * @param ctx - The Telegraf context object.
     * @param fileId - The Telegram file ID of the media.
     * @param mimeType - The MIME type of the media.
     * @param caption - Optional caption provided with the media.
     */
    const processMedia = async (ctx: Context, fileId: string, mimeType: string, caption?: string) => {
    if (!ctx.chat || !ctx.from) {
      console.warn('Received media without chat or from context:', ctx);
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from.id; // Use user ID for settings/MCPs

    console.log(`Received media from chat ${chatId} / user ${userId}: ${fileId}, mime: ${mimeType}, caption: ${caption}`);

    try {
      // Get the download URL for the file from Telegram.
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      console.log(`Downloading file from: ${fileUrl}`);
      const { data, mime } = await downloadFile(fileUrl.toString()); // Assuming downloadFile returns buffer data and mime
      console.log(`Downloaded file (${data.length} bytes), mime: ${mime}`);


      // Prepare multimodal parts for Gemini
      const multimodalParts: any[] = [];
      if (caption) {
        multimodalParts.push({ text: caption });
      }
      if (data && mime) {
         if (mime.startsWith('image/')) {
            multimodalParts.push({ inlineData: { mimeType: mime, data: data.toString('base64') } });
         } else if (mime.startsWith('audio/')) {
            multimodalParts.push({ inlineData: { mimeType: mime, data: data.toString('base64') } });
         }
         // TODO: Handle other file types (like documents) - may require an MCP server
         // For now, just add caption for unsupported types if exists
      }


      if (multimodalParts.length === 0) { // Check only multimodal parts, caption is handled separately
          ctx.reply("Could not process the file content.");
          return;
      }

      // Add user message (caption + media info/parts) to history
      const userMessage = caption || `[${mimeType} file]`; // Text part for history overview
      const messageParts = caption ? [{text: caption}] : []; // Initial parts
      // Add the actual multimodal data parts to the message for Gemini
      const partsForGemini = caption ? [{text: caption}, ...multimodalParts] : [...multimodalParts];
      // Add message to history (potentially just with text representation for brevity if needed)
      // Here we add the full parts for Gemini's context.
      await conversationManager.addMessage(chatId, { role: 'user', parts: partsForGemini });


      // Get conversation history
      const history = await conversationManager.getHistory(chatId);

      // Get available tools for this user
      const geminiTools = await mcpClientManager.getTools(userId); // Pass user ID

      // Get user's specific Gemini settings (prompt system, temperature, etc.) from DB
      let userSettings: UserConfiguration | null = null;
      try {
        userSettings = await mcpConfigStorage.getUserConfiguration(userId);
      } catch (e) {
        console.error(`Failed to load user configuration for user ${userId}:`, e);
        // Decide if you want to proceed with default/shared settings or inform the user
      }

      // Call Gemini with history, tools, the multimodal parts for this turn, and user settings.
      // Pass user settings to GeminiClient if needed
      // The `multimodalParts` argument was removed from generateContent, history now contains these.
      const geminiResponse = await geminiClient.generateContent(history, geminiTools, userSettings || undefined);

       // Use the refactored tool execution logic
       await _processMediaWithToolExecution(ctx, geminiResponse, chatId, userId, mcpClientManager, geminiClient, conversationManager, userSettings);

    } catch (error: any) {
      console.error('Error processing media for chat', chatId, ':', error);
      ctx.reply('An error occurred while processing the media. Please try again later or contact support if the issue persists.');
       // Consider adding an error marker to history
       // await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: `Error processing media: ${error.message}` }] });
    }
  };

  // Handler for photos
  bot.on(message('photo'), async (ctx) => {
    // Get the largest photo size
    const photo = ctx.message.photo.pop();
    if (photo) {
      await processMedia(ctx, photo.file_id, 'image/jpeg', ctx.message.caption);
    }
  });

  // Handler for audio (voice and audio messages)
  bot.on(message('audio'), async (ctx) => {
     const audio = ctx.message.audio;
     if (audio) {
        await processMedia(ctx, audio.file_id, audio.mime_type || 'audio/mpeg', ctx.message.caption); // Caption is less common for audio
     }
  });

   bot.on(message('voice'), async (ctx) => {
     const voice = ctx.message.voice;
     if (voice) {
        await processMedia(ctx, voice.file_id, voice.mime_type || 'audio/ogg', ctx.message.caption); // Caption is less common for voice
     }
  });


  // Handler for documents
  bot.on(message('document'), async (ctx) => {
    const document = ctx.message.document;
    if (document) {
       const chatId = ctx.chat.id;
       const userId = ctx.from.id;

       console.log(`Received document from chat ${chatId} / user ${userId}: ${document.file_name}`);
       ctx.reply(`Received document: ${document.file_name}. Document content processing requires a configured MCP server. Add a document processing MCP server via the settings Mini App (/settings) to enable this.`);
       // TODO: Add document info to history
       // await conversationManager.addMessage(chatId, { role: 'user', parts: [{ text: ctx.message.caption || `[Document: ${document.file_name}]` }] });

       // TODO: Implement logic to potentially use an MCP server to process the document
       // E.g., download, pass path/URI to an MCP document server, get extracted text, send text + caption to Gemini
       // This would involve calling mcpClientManager.callTool(chatId, ...)
       // and then calling geminiClient.generateContent(...) with the extracted text.
    }
  });

  // Add other specific media types if needed (video, video_note, animation, sticker, etc.)
  // bot.on(message('video'), (ctx) => { ... });
}
