typescript
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { McpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';

export function setupMessageHandlers(
  bot: Telegraf<Context>,
  mcpClientManager: McpClientManager,
  geminiClient: GeminiClient, // GeminiClient might need user-specific settings
  conversationManager: ConversationManager,
  mcpConfigStorage: McpConfigStorage // Added McpConfigStorage
): void {

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id; // Use chat.id for group/supergroup support
    const userId = ctx.from.id; // Use from.id for user-specific settings

    const userMessage = ctx.message.text;

    console.log(`Received text message from chat ${chatId} / user ${userId}: ${userMessage}`);

    try {
      // Add user message to conversation history
      await conversationManager.addMessage(chatId, { role: 'user', parts: [{ text: userMessage }] });

      // Get conversation history
      const history = await conversationManager.getHistory(chatId);

      // Get available tools from user's configured MCP servers
      const geminiTools = await mcpClientManager.getTools(userId); // Pass user ID (userId for user-specific tools)

      // Get user's specific Gemini settings (prompt system, temperature, etc.) from DB
      let userSettings: UserConfiguration | null = null;
      try {
        userSettings = await mcpConfigStorage.getUserConfiguration(userId);
      } catch (e) {
        console.error(`Failed to load user configuration for user ${userId}:`, e);
        // Decide if you want to proceed with default/shared settings or inform the user
      }

      // Call Gemini
      // Pass user settings to GeminiClient if needed for per-user configuration
      const geminiResponse = await geminiClient.generateContent(history, geminiTools, undefined, userSettings || undefined);

      // Process Gemini's response
      if (geminiResponse.functionCalls && geminiResponse.functionCalls.length > 0) {
        console.log('Gemini wants to call functions:', geminiResponse.functionCalls);

        // --- Execute MCP Tools based on Gemini's function calls ---
        const toolResults: any[] = []; // Store results to send back to Gemini

        for (const functionCall of geminiResponse.functionCalls) {
          console.log(`Attempting to call MCP tool: ${functionCall.name} for chat ${chatId}`);
          try {
            // Call the corresponding MCP tool via the manager
            // The manager routes the call to the correct client instance for this user
            const mcpToolResult = await mcpClientManager.callTool(chatId, functionCall); // Pass user ID

            // Store result in a format Gemini understands (functionResponse)
            const geminiFunctionResponse: { name: string; response: { result?: any; error?: string } } = {
                name: functionCall.name,
                response: {}
            };

            if (mcpToolResult && !mcpToolResult.isError) {
                geminiFunctionResponse.response.result = mcpToolResult.content;
            } else {
                const errorMessage = (mcpToolResult?.content?.[0]?.text || 'Unknown tool error').toString();
                geminiFunctionResponse.response.error = errorMessage;
            }
            toolResults.push(geminiFunctionResponse);

             console.log(`MCP tool "${functionCall.name}" executed for chat ${chatId}. Result:`, mcpToolResult);
             // Optionally notify user of tool execution success
             // ctx.reply(`Executed tool: ${functionCall.name}`);


          } catch (toolError: any) {
            console.error(`Error executing MCP tool "${functionCall.name}" for chat ${chatId}:`, toolError);
             // Include tool execution errors in the response to Gemini
             toolResults.push({
                name: functionCall.name,
                response: {
                    error: toolError.message || 'Unknown tool error' // Or map specific error structure
                }
            });
             ctx.reply(`Error executing tool: ${functionCall.name}. ${toolError.message || 'See logs.'}`); // Notify user of failure
          }
        }

        // Add Gemini's function call response and the tool results to history
         await conversationManager.addMessage(chatId, { role: 'model', parts: geminiResponse.functionCalls.map(fc => ({ functionCall: fc })) });
         // Add tool results as user role for Gemini's follow-up turn
         await conversationManager.addMessage(chatId, { role: 'user', parts: toolResults.map(tr => ({ functionResponse: tr })) });


        // --- Call Gemini again with tool results ---
        const historyWithToolResults = await conversationManager.getHistory(chatId);
        const finalGeminiResponse = await geminiClient.generateContent(historyWithToolResults, geminiTools, undefined, userSettings || undefined);

        // Get final text response from Gemini
        const finalText = finalGeminiResponse.text;
        if (finalText) {
             console.log('Gemini final text response:', finalText);
            ctx.reply(finalText);
             // Add final text response to history
            await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: finalText }] });
        } else {
             console.warn('Gemini did not return final text after tool execution for chat', chatId);
             ctx.reply('Action completed, but I did not get a final text response.'); // Or handle differently
        }


      } else {
        // Gemini returned a direct text response
        const textResponse = geminiResponse.text;
        if (textResponse) {
             console.log('Gemini direct text response:', textResponse);
            ctx.reply(textResponse);
             // Add Gemini's response to history
             await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: textResponse }] });
        } else {
             console.warn('Gemini returned an empty direct response for chat', chatId);
             ctx.reply('Could not process your request.');
        }
      }

    } catch (error: any) {
      console.error('Error during message processing for chat', chatId, ':', error);
      ctx.reply(`An error occurred while processing your request: ${error.message || 'See logs.'}`);
       // Consider adding an error marker to history or clearing history for this chat
       // await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: `Error: ${error.message}` }] }); // Add error to history
    }
  });

  // Add other message handlers here if needed (e.g., location, contact)
  // bot.on(message('location'), (ctx) => { ... });
}
