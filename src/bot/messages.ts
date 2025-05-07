/**
 * @file Sets up message handlers for the Telegraf bot, specifically for text messages.
 * Contains the core logic for processing user input, interacting with Gemini and MCP.
 */
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { McpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';

/**
 * Registers message handlers, primarily for text messages.
 * This function orchestrates the main conversation flow.
 * @param bot - The Telegraf bot instance.
 * @param mcpClientManager - Instance for managing MCP clients.
 * @param geminiClient - Instance for interacting with Gemini.
 * @param conversationManager - Instance for managing chat history.
 * @param mcpConfigStorage - Instance for accessing user configurations.
 */
export function setupMessageHandlers(
  bot: Telegraf<Context>,
  mcpClientManager: McpClientManager,
  geminiClient: GeminiClient, // GeminiClient might need user-specific settings
  conversationManager: ConversationManager,
  mcpConfigStorage: McpConfigStorage // Added McpConfigStorage
): void {

  // Handler for incoming text messages.
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

      // Call Gemini with history, tools, and user settings.
      // Pass user settings to GeminiClient if needed for per-user configuration
      const geminiResponse = await geminiClient.generateContent(history, geminiTools, undefined, userSettings || undefined);

      // Process Gemini's response
      // Check if Gemini requested function calls (tool usage).
      if (geminiResponse.functionCalls && geminiResponse.functionCalls.length > 0) {
        console.log('Gemini wants to call functions:', geminiResponse.functionCalls);

        // --- Execute MCP Tools based on Gemini's function calls ---
        const toolResults: any[] = []; // Store results to send back to Gemini

        for (const functionCall of geminiResponse.functionCalls) {
          // Iterate through each requested function call.
          console.log(`Attempting to call MCP tool: ${functionCall.name} for chat ${chatId}`);
          try {
            // Call the corresponding MCP tool via the manager
            // The manager routes the call to the correct client instance for this user
            const mcpToolResult = await mcpClientManager.callTool(userId, functionCall); // Pass user ID

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

          // Handle errors during tool execution.
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
        // Gemini's request to call functions is added as a 'model' turn.
         await conversationManager.addMessage(chatId, { role: 'model', parts: geminiResponse.functionCalls.map((fc: any) => ({ functionCall: fc })) });
         // The results from the tools are added as a 'user' turn (specifically, functionResponse parts).
         await conversationManager.addMessage(chatId, { role: 'user', parts: toolResults.map(tr => ({ functionResponse: tr })) });


        // --- Call Gemini again with the updated history including tool results ---
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
        // Gemini returned a direct text response (no function calls requested).
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

    // Catch-all error handler for the entire message processing flow.
    } catch (error: any) {
      console.error('Error during message processing for chat', chatId, ':', error);
      ctx.reply('An error occurred while processing your request. Please try again later or contact support if the issue persists.');
       // Consider adding an error marker to history or clearing history for this chat
       // await conversationManager.addMessage(chatId, { role: 'model', parts: [{ text: `Error: ${error.message}` }] }); // Add error to history
    }
  });

  // Add other message handlers here if needed (e.g., location, contact)
  // bot.on(message('location'), (ctx) => { ... });
}
