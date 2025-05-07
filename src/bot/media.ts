typescript
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { downloadFile } from '../utils/file.js';
import { McpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';

export function setupMediaHandlers(
  bot: Telegraf<Context>,
  mcpClientManager: McpClientManager,
  geminiClient: GeminiClient,
  conversationManager: ConversationManager,
  mcpConfigStorage: McpConfigStorage // Added McpConfigStorage
): void {

  // Helper to process media common steps
  const processMedia = async (ctx: Context, fileId: string, mimeType: string, caption?: string) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id; // Use user ID for settings/MCPs

    console.log(`Received media from chat ${chatId} / user ${userId}: ${fileId}, mime: ${mimeType}, caption: ${caption}`);

    try {
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


      if (multimodalParts.length === 0 && !caption) {
          ctx.reply("Could not process the file content.");
          return;
      }

      // Add user message (caption + media info/parts) to history
      const userMessage = caption || `[${mimeType} file]`; // Text part for history overview
      const messageParts = caption ? [{text: caption}] : []; // Initial parts
      if (multimodalParts.length > 0) {
          // Add multimodal parts if successfully extracted
           messageParts.push(...multimodalParts);
      }
      await conversationManager.addMessage(chatId, { role: 'user', parts: messageParts });


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

      // Call Gemini with multimodal input
      // Pass user settings to GeminiClient if needed
      const geminiResponse = await geminiClient.generateContent(history, geminiTools, multimodalParts, userSettings || undefined);

       // Process Gemini's response (similar to text message handler)
      if (geminiResponse.functionCalls && geminiResponse.functionCalls.length > 0) {
        console.log('Gemini wants to call functions:', geminiResponse.functionCalls);
        // TODO: Implement full tool execution logic as in messages.ts
        // This logic needs to:
        // 1. Loop through geminiResponse.functionCalls
        // 2. For each functionCall:
        //    a. Call mcpClientManager.callTool(chatId, functionCall)
        //    b. Map the mcpToolResult to the Gemini functionResponse format:
        //       const geminiFunctionResponse: { name: string; response: { result?: any; error?: string } } = {
        //           name: functionCall.name,
        //           response: {}
        //       };
        //       if (mcpToolResult && !mcpToolResult.isError) {
        //           geminiFunctionResponse.response.result = mcpToolResult.content;
        //       } else {
        //           const errorMessage = (mcpToolResult?.content?.[0]?.text || 'Unknown tool error').toString();
        //           geminiFunctionResponse.response.error = errorMessage;
        //       }
        //    c. Add geminiFunctionResponse to a toolResults array.
        // 3. Add Gemini's function call response and the tool results to history (conversationManager.addMessage)
        // 4. Call geminiClient.generateContent again with the updated history and userSettings.
        // 5. Send the final text response from Gemini to the user.

        ctx.reply('Gemini wants to call tools based on the media, but tool execution for media inputs needs full implementation.');
        // For a complete implementation, you'd duplicate or refactor the tool execution logic from messages.ts here.

      } else {
        // Gemini returned a direct text response
        const textResponse = geminiResponse.text;
        if (textResponse) {
          console.log('Gemini direct text response:', textResponse);
          ctx.reply(textResponse);
           // Add Gemini's response to history
           await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: textResponse }] });
        } else {
          console.warn('Gemini returned an empty response for media from chat', chatId);
          ctx.reply('Could not generate a response for the media.');
        }
      }

    } catch (error: any) {
      console.error('Error processing media for chat', chatId, ':', error);
      ctx.reply(`An error occurred while processing the media: ${error.message || 'See logs.'}`);
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
