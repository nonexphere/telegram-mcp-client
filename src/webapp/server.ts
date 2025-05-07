import express, { Application, Request, Response } from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { getMcpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';
import { MCPConfig } from '../mcp/types.js';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function setupWebAppServer(
    app: Application,
    db: Database,
    mcpClientManager: McpClientManager,
    geminiClient: GeminiClient, // Potentially needed for settings/status
    conversationManager: ConversationManager // Potentially needed for status/clearing history
): void {

    const mcpConfigStorage = getMcpConfigStorage(db); // Get storage instance

    // Serve static files from the 'public' directory
    const publicPath = join(__dirname, 'public');
    app.use(express.static(publicPath));
    console.log(`Serving static files from: ${publicPath}`);


    // --- API Endpoints for Mini App ---

    // Middleware to validate Telegram Mini App initData
    // This is CRITICAL for security to ensure requests come from Telegram and a specific user
    const validateTelegramInitData = (req: Request, res: Response, next: any) => {
        // TODO: Implement robust initData validation
        // You need to get initData from the request (e.g., query param, header, or body)
        // Example: const initData = req.query.initData || req.headers['x-telegram-init-data'];
        // Validate the hash against your BOT_TOKEN
        // Extract user info from validated initData (e.g., user.id)
        // For this sketch, we'll use a placeholder and assume user ID is available
        const userId = parseInt(req.query.userId as string || '0'); // Placeholder - Get user ID from validated initData

        if (!userId || userId === 0) {
             console.warn('API call without valid user ID (initData validation failed or missing).');
             // In a real app, send 401 Unauthorized
             res.status(401).send('Unauthorized: Invalid or missing Telegram InitData');
             return;
        }

        // Attach user ID to the request for subsequent handlers
        (req as any).telegramUserId = userId;
        console.log(`Validated Mini App request for user ID: ${userId}`);
        next();
    };

    // Apply validation middleware to all API routes
    app.use('/api', validateTelegramInitData);


    // Get user's current configuration (Gemini key, settings, MCPs)
    app.get('/api/user_config', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId; // User ID from validation middleware

        try {
            const userConfig = await mcpConfigStorage.getUserConfiguration(userId);
            const mcpConfigs = await mcpConfigStorage.getUserMcpConfigs(userId);

            // Combine and send
            res.json({
                settings: userConfig || { userId: userId, promptSystemSettings: {}, generalSettings: {} },
                mcps: mcpConfigs
            });

        } catch (error) {
            console.error(`Error getting user config for user ${userId}:`, error);
            res.status(500).json({ error: 'Failed to retrieve configuration.' });
        }
    });

    // Save user's settings (Gemini key, prompt system, etc.)
    app.post('/api/user_settings', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;
        const updatedSettings: UserConfiguration = req.body; // Expect UserConfiguration structure

        if (!updatedSettings || updatedSettings.userId !== userId) {
             res.status(400).json({ error: 'Invalid request body or user ID mismatch.' });
             return;
        }

        try {
             // Fetch existing config to preserve any fields not sent in the update
             const existingConfig = await mcpConfigStorage.getUserConfiguration(userId);
             const finalConfig: UserConfiguration = {
                 userId: userId,
                 geminiApiKey: updatedSettings.geminiApiKey ?? existingConfig?.geminiApiKey, // Only update if provided
                 promptSystemSettings: {
                     ...existingConfig?.promptSystemSettings,
                     ...updatedSettings.promptSystemSettings
                 },
                 generalSettings: {
                     ...existingConfig?.generalSettings,
                     ...updatedSettings.generalSettings
                 }
             };

            await mcpConfigStorage.saveUserConfiguration(finalConfig);
            res.json({ success: true });

        } catch (error) {
            console.error(`Error saving user settings for user ${userId}:`, error);
            res.status(500).json({ error: 'Failed to save settings.' });
        }
    });

    // Add a new MCP server configuration for the user
    app.post('/api/mcps', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;
        const config: MCPConfig = req.body; // Expect MCPConfig structure

        try {
            // Save config to DB via storage module
            await mcpConfigStorage.saveUserMcpConfig(userId, config);
             // The client connection happens later on demand via McpClientManager

            res.json({ success: true });

        } catch (error: any) {
            console.error(`Error adding MCP config for user ${userId}:`, error);
            res.status(500).json({ error: error.message || 'Failed to add MCP server config.' });
        }
    });

     // Delete an MCP server configuration for the user
     app.delete('/api/mcps/:serverName', async (req: Request, res: Response) => {
         const userId = (req as any).telegramUserId;
         const serverName = req.params.serverName;

         if (!serverName) {
             res.status(400).json({ error: 'Server name is required.' });
             return;
         }

         try {
             // Remove config from DB via storage module
             await mcpConfigStorage.deleteUserMcpConfig(userId, serverName);
              // Disconnect the client if it's currently active for this user
             await mcpClientManager.removeServer(userId, serverName, false); // Remove from manager without triggering DB remove again

             res.json({ success: true });

         } catch (error: any) {
             console.error(`Error deleting MCP config "${serverName}" for user ${userId}:`, error);
             res.status(500).json({ error: error.message || 'Failed to delete MCP server config.' });
         }
     });


    // TODO: Add endpoints for:
    // - Clearing chat history
    // - Getting bot status (optional)
    // - Getting available Gemini models (optional, could query Gemini API)
    // - Getting available MCP tool definitions (optional, could query McpClientManager.getTools(userId))

}
