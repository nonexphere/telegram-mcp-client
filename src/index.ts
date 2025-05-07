/**
 * @file Main entry point for the Telegram MCP Client Bot application.
 * Initializes services, sets up the bot, starts the web server, and handles graceful shutdown.
 */
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
const YOUR_DEPLOYED_WEBAPP_URL = process.env.YOUR_DEPLOYED_WEBAPP_URL || `http://localhost:${WEB_APP_SERVER_PORT}`;
const ADMIN_USER_IDS_STRING = process.env.ADMIN_USER_IDS || '';
const ADMIN_USER_IDS: number[] = ADMIN_USER_IDS_STRING
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id));

if (!BOT_TOKEN) {
  console.error('FATAL ERROR: BOT_TOKEN is not set in .env');
  process.exit(1);
}
if (ADMIN_USER_IDS_STRING && ADMIN_USER_IDS.length === 0) {
    console.warn('WARN: ADMIN_USER_IDS is set but contains no valid numeric IDs.');
} else if (ADMIN_USER_IDS.length > 0) {
    console.log(`Admin User IDs loaded: ${ADMIN_USER_IDS.join(', ')}`);
} else {
    console.log('No Admin User IDs configured. Stdio MCP configuration will be restricted for all users via API if not admin.');
}

/**
 * Initializes all services, starts the Telegraf bot and the Express web server.
 * Sets up signal handlers for graceful shutdown.
 */
async function main() {
  try {
    const db = await initDb(); 
    const mcpClientManager = new McpClientManager(db);
    const mcpConfigStorage = getMcpConfigStorage(db);
    const conversationManager = new ConversationManager(db);
    const geminiClient = new GeminiClient(SHARED_GEMINI_API_KEY);

    const bot = new Telegraf(BOT_TOKEN);

    // Simple middleware to log incoming updates.
    bot.use(async (ctx, next) => {
      console.log(`Processing update ${ctx.update.update_id}`);
      await next();
      console.log(`Finished processing update ${ctx.update.update_id}`);
    });

    // Setup bot command handlers (/start, /settings, etc.)
    setupCommands(bot, mcpClientManager, geminiClient, conversationManager);
    // Setup handlers for text messages (main interaction logic).
    setupMessageHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage);
    // Setup handlers for media messages (photos, audio, documents).
    setupMediaHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage, processMediaWithToolExecution);

    const app = express();
    app.use(bodyParser.json());

    // Setup the Express server for the Mini App backend API.
    setupWebAppServer(app, db, mcpClientManager, geminiClient, conversationManager, ADMIN_USER_IDS);

    const webServer = app.listen(WEB_APP_SERVER_PORT, () => {
      console.log(`Mini App Web Server listening on port ${WEB_APP_SERVER_PORT}`);
      console.log(`Ensure your Mini App URL in BotFather is set to: ${YOUR_DEPLOYED_WEBAPP_URL}`);
      if (YOUR_DEPLOYED_WEBAPP_URL.includes('YOUR_DEPLOYED_WEBAPP_URL_NOT_SET') || YOUR_DEPLOYED_WEBAPP_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
        console.warn('WARNING: Mini App URL seems to be a placeholder or localhost. For production, it must be a publicly accessible HTTPS URL.');
      }
    });

    // Launch the Telegram bot.
    await bot.launch();
    console.log('Bot started successfully!');

    /**
     * Handles graceful shutdown of the application.
     * Stops the bot, closes the web server, disconnects MCP clients, and closes the DB connection.
     * @param reason - The signal or reason for stopping.
     */
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
        // Force exit if graceful shutdown takes too long.
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

    // Register signal handlers for graceful shutdown.
    process.once('SIGINT', () => gracefulStop('SIGINT'));
    process.once('SIGTERM', () => gracefulStop('SIGTERM'));

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();

