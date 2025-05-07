typescript
import { Telegraf, Context, Markup } from 'telegraf';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';

// Define a custom context type if needed, otherwise use default Context
// interface MyContext extends Context {} // Example

export function setupCommands(
  bot: Telegraf<Context>, // Use default Context for now
  mcpClientManager: McpClientManager, // Managers are passed
  geminiClient: GeminiClient, // Managers are passed
  conversationManager: ConversationManager // Managers are passed
): void {
  bot.start((ctx) => {
    ctx.reply('Hello! I am an AI bot powered by Gemini and connected to MCP servers. Use the Mini App for configuration with /settings.');
  });

  bot.command('settings', (ctx) => {
     // You need to set YOUR_DEPLOYED_WEBAPP_URL to the actual URL where your Mini App web server is hosted
     // This URL must be configured in @BotFather under Botfather -> [Your Bot] -> Bot settings -> Menu button -> Edit menu button -> Web App
     const webAppUrl = process.env.YOUR_DEPLOYED_WEBAPP_URL || 'YOUR_DEPLOYED_WEBAPP_URL_NOT_SET'; // Use env var for flexibility

     // Basic check if URL is set (replace with your actual deployed URL check)
     if (webAppUrl === 'YOUR_DEPLOYED_WEBAPP_URL_NOT_SET') {
         ctx.reply('Mini App URL is not configured. Please contact the bot owner.');
         return;
     }


    ctx.reply('Click the button below to open settings:',
      Markup.inlineKeyboard([
        Markup.button.webApp('Open Settings', webAppUrl)
      ])
    );
  });


   // Note: /add_mcp command via text reply is removed.
   // Adding/removing MCPs is now done via the Mini App UI.

   // /list_mcps command is now handled by querying the manager with user ID
   bot.command('list_mcps', async (ctx) => {
        const chatId = ctx.chat.id; // Or ctx.from.id for user-specific, decide on scope
        const servers = await mcpClientManager.listServers(chatId); // Get user-specific servers

        if (servers.length === 0) {
            ctx.reply('You have no MCP servers configured.');
            return;
        }
        const serverList = servers.map(s => `- ${s.name} (${s.type})`).join('\n');
        ctx.reply(`Your configured MCP servers:\n${serverList}`);
    });

  // Add other commands here if needed
  // bot.command('another_command', (ctx) => { ... });
}
