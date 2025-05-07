typescript
import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { McpClientManager } from './mcp/mcpClientManager.js';
import { GeminiClient } from './gemini/geminiClient.js';
import { ConversationManager } from './context/conversation.js';
import { setupCommands } from './bot/commands.js';
import { setupMessageHandlers } from './bot/messages.js';
import { setupMediaHandlers } from './bot/media.js';
import { initDb } from './db.js';
import { getMcpConfigStorage, McpConfigStorage } from './mcp/storage.js'; // Import McpConfigStorage and getter
import { setupWebAppServer } from './webapp/server.js';
import express from 'express';
import bodyParser from 'body-parser';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHARED_GEMINI_API_KEY = process.env.SHARED_GEMINI_API_KEY; // Use a shared key or per-user key from DB

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set in .env');
  process.exit(1);
}
// If using per-user keys via UI, SHARED_GEMINI_API_KEY might be optional here

// Initialize core components
const db = initDb();
const mcpClientManager = new McpClientManager(db);
const mcpConfigStorage = getMcpConfigStorage(db); // Create McpConfigStorage instance
const conversationManager = new ConversationManager(db);
const geminiClient = new GeminiClient(SHARED_GEMINI_API_KEY); // Pass shared key or handle per-user keys internally

const bot = new Telegraf(BOT_TOKEN);

// --- Middleware ---
bot.use(async (ctx, next) => {
  // Basic middleware, potentially add context properties later
  // ctx.db = db; // Example
  // ctx.mcpClientManager = mcpClientManager; // Example
  await next();
});

// --- Handlers ---
setupCommands(bot, mcpClientManager, geminiClient, conversationManager); // Pass managers
setupMessageHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage); // Pass McpConfigStorage
setupMediaHandlers(bot, mcpClientManager, geminiClient, conversationManager, mcpConfigStorage); // Pass McpConfigStorage

// --- Web App Server ---
const app = express();
const WEB_APP_PORT = process.env.PORT || 3000; // Use PORT env var or default
app.use(bodyParser.json()); // To parse JSON body for API requests from Mini App

setupWebAppServer(app, db, mcpClientManager, geminiClient, conversationManager); // Pass dependencies

// --- Bot Lifecycle ---
async function startBot() {
  try {
    // Load user configurations and initialize their MCP clients from DB
    // This is complex and might be better triggered on user interaction
    // For simplicity in this sketch, we won't pre-load all clients here,
    // but the managers will handle user-specific data/clients on demand.

    // Start the web server
    app.listen(WEB_APP_PORT, () => {
      console.log(`Mini App Web Server listening on port ${WEB_APP_PORT}`);
      console.log(`Mini App URL: YOUR_DEPLOYED_WEBAPP_URL`); // Instructions for user
    });


    // Launch the Telegraf bot
    await bot.launch();
    console.log('Bot started successfully!');


  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

async function stopBot(reason: string) {
  console.log(`Stopping bot due to ${reason}...`);
  try {
    bot.stop(reason);
    // Consider graceful shutdown of the web server if needed
    await mcpClientManager.closeAll(); // Close all active MCP clients
    db.close(); // Close database connection
    console.log('Bot and services stopped.');
    process.exit(0);
  } catch (error) {
    console.error('Error during bot shutdown:', error);
    process.exit(1);
  }
}

// Enable graceful stop
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

// Start the bot
startBot();

