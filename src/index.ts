import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { McpClientManager } from './mcp/mcpClientManager.js';
import { GeminiClient } from './gemini/geminiClient.js';
import { ConversationManager } from './context/conversation.js';
import { setupCommands } from './bot/commands.js';
import { setupMessageHandlers } from './bot/messages.js';
import { setupMediaHandlers, processMediaWithToolExecution } from './bot/media.js';
import { initDb, closeDb, getDb } from './db.js'; 
import { getMcpConfigStorage } from './mcp/storage.js';
import { setupWebAppServer } from './webapp/server.js';
import express from 'express';
import bodyParser from 'body-parser';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHARED_GEMINI_API_KEY = process.env.SHARED_GEMINI_API_KEY; // Use a shared key or per-user key from DB
const WEB_APP_SERVER_PORT = process.env.PORT || process.env.WEB_APP_PORT || 3000;
const YOUR_DEPLOYED_WEBAPP_URL = process.env.YOUR_DEPLOYED_WEBAPP_URL || 'http://localhost:' + WEB_APP_SERVER_PORT;

if (!BOT_TOKEN) {
  console.error('FATAL ERROR: BOT_TOKEN is not set in .env');
  process.exit(1);
}

async function main() {
  try {
    const db = await initDb(); 
    const mcpClientManager = new McpClientManager(db);
    const mcpConfigStorage = getMcpConfigStorage(db);
    const conversationManager = new ConversationManager(db);
    const geminiClient = new GeminiClient(SHARED_GEMINI_API_KEY);

    const bot = new Telegraf(BOT_TOKEN);

    bot.use(async (ctx, next) => {
      console.log(`Processing update ${ctx.update.update_id}`);
      await next();
      console.log(`Finished processing update ${ctx.update.update_id}`);
    });

    setupCommands(bot, mcpClientManager, geminiClient, conversationManager);
    setupMessageHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage);
    setupMediaHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage, processMediaWithToolExecution);

    const app = express();
    app.use(bodyParser.json());

    setupWebAppServer(app, db, mcpClientManager, geminiClient, conversationManager);

    const webServer = app.listen(WEB_APP_SERVER_PORT, () => {
      console.log(`Mini App Web Server listening on port ${WEB_APP_SERVER_PORT}`);
      console.log(`Ensure your Mini App URL in BotFather is set to: ${YOUR_DEPLOYED_WEBAPP_URL}`);
      if (YOUR_DEPLOYED_WEBAPP_URL.includes('YOUR_DEPLOYED_WEBAPP_URL_NOT_SET') || YOUR_DEPLOYED_WEBAPP_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
        console.warn('WARNING: Mini App URL seems to be a placeholder or localhost. For production, it must be a publicly accessible HTTPS URL.');
      }
    });

    await bot.launch();
    console.log('Bot started successfully!');

    const gracefulStop = async (reason: string) => {
      console.log(`Stopping bot due to ${reason}...`);
      try {
        bot.stop(reason);
        webServer.close(async () => {
          console.log('Web server closed.');
          await mcpClientManager.closeAll();
          await closeDb(); 
          console.log('Bot and services stopped gracefully.');
          process.exit(0);
        });
        setTimeout(async () => {
            console.warn('Web server did not close in time, forcing shutdown.');
            await mcpClientManager.closeAll();
            await closeDb();
            process.exit(1);
        }, 5000);

      } catch (error) {
        console.error('Error during bot shutdown:', error);
        process.exit(1);
      }
    };

    process.once('SIGINT', () => gracefulStop('SIGINT'));
    process.once('SIGTERM', () => gracefulStop('SIGTERM'));

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();

