/**
 * @file Sets up the Express web server for the Telegram Mini App backend.
 * Handles static file serving, API endpoints for configuration, and authentication.
 */
import express, { Application, Request, Response, NextFunction } from 'express'; 
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { McpClientManager } from '../mcp/mcpClientManager.js';
import { GeminiClient } from '../gemini/geminiClient.js';
import { ConversationManager } from '../context/conversation.js';
import { getMcpConfigStorage } from '../mcp/storage.js';
import { UserConfiguration } from '../context/types.js';
import { MCPConfig } from '../mcp/types.js';
import { z } from 'zod';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Zod Schemas for Validation ---
const SafetySettingSchema = z.object({
    category: z.string(), // Ideally use z.enum with HarmCategory values
    threshold: z.string(), // Ideally use z.enum with HarmBlockThreshold values
});
const UserSettingsPayloadSchema = z.object({
    geminiApiKey: z.string().optional().nullable(),
    promptSystemSettings: z.object({ systemInstruction: z.string().optional().nullable() }).passthrough().optional().nullable(),
    generalSettings: z.object({ geminiModel: z.string().optional().nullable(), temperature: z.number().min(0).max(1).optional().nullable(), safetySettings: z.array(SafetySettingSchema).optional().nullable(), googleSearchEnabled: z.boolean().optional().nullable() }).passthrough().optional().nullable(),
}).passthrough();

// --- Server Setup Function ---

/**
 * Configures and sets up the Express application for the Mini App backend.
 * @param app - The Express application instance.
 * @param db - The PrismaClient instance.
 * @param mcpClientManager - The McpClientManager instance.
 * @param geminiClient - The GeminiClient instance.
 * @param conversationManager - The ConversationManager instance.
 */
export function setupWebAppServer(
    app: Application,
    db: PrismaClient, 
    mcpClientManager: McpClientManager,
    geminiClient: GeminiClient,
    conversationManager: ConversationManager,
    adminUserIds: number[]
): void {
    const mcpConfigStorage = getMcpConfigStorage(db); 
    const publicPath = join(__dirname, 'public');
    app.use(express.static(publicPath));
    console.log(`Serving static files from: ${publicPath}`);

    /**
     * Middleware to validate Telegram InitData received from the Mini App.
     * Extracts user information and attaches it to the request object if valid.
     * @param req - Express Request object.
     * @param res - Express Response object.
     * @param next - Express NextFunction.
     */
    const validateTelegramInitDataMiddleware = (req: Request, res: Response, next: NextFunction) => {
        const initData = req.query.initData as string || req.headers['x-telegram-init-data'] as string || (req.body && req.body.initData) as string;

        if (!initData) {
            console.warn('API call without Telegram InitData.');
            return res.status(401).send('Unauthorized: Missing Telegram InitData');
        }

        const botToken = process.env.BOT_TOKEN;
        if (!botToken) {
            console.error('FATAL: BOT_TOKEN is not set for initData validation.');
            return res.status(500).send('Internal Server Error: Bot token not configured.');
        }

        const { isValid, user } = isValidTelegramAuth(initData, botToken);

        if (!isValid || !user || !user.id) {
            console.warn('API call with invalid Telegram InitData or missing user ID.');
            return res.status(401).send('Unauthorized: Invalid Telegram InitData');
        }

        (req as any).telegramUserId = user.id;
        (req as any).telegramUser = user; 
        console.log(`Validated Mini App request for user ID: ${user.id}`);
        // Anexar status de admin ao request para uso nos endpoints
        (req as any).isAdmin = adminUserIds.includes(user.id);
        next();
    };

    // Apply the validation middleware to all /api routes.
    app.use('/api', validateTelegramInitDataMiddleware);

    app.get('/api/user_config', async (req: Request, res: Response) => {
        /**
         * @route GET /api/user_config
         * @group API - Mini App Backend
         * @summary Retrieves the user's current settings and MCP configurations.
         * @security TelegramInitData
         * @returns {object} 200 - An object containing 'settings' and 'mcps'.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const isAdmin = (req as any).isAdmin; // Obtenha o status de admin
        try {
            const userConfig = await mcpConfigStorage.getUserConfiguration(userId);
            const mcpConfigs = await mcpConfigStorage.getUserMcpConfigs(userId);
            res.json({
                settings: userConfig || { userId: userId, promptSystemSettings: {}, generalSettings: {} },
                mcps: mcpConfigs,
                isAdmin: isAdmin // Envie o status de admin para o frontend
            });
        } catch (error: any) {
            console.error(`Error getting user config for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to retrieve configuration. Please check server logs.' });
        }
    });

    app.post('/api/user_settings', async (req: Request, res: Response) => {
        /**
         * @route POST /api/user_settings
         * @group API - Mini App Backend
         * @summary Saves or updates the user's general settings (API key, model, etc.).
         * @security TelegramInitData
         * @returns {object} 200 - Success message.
         * @returns {object} 400 - Invalid payload format.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        try {
            // Validate payload with Zod
            const validationResult = UserSettingsPayloadSchema.safeParse(req.body);
            if (!validationResult.success) {
                console.warn(`Invalid user settings payload for user ${userId}:`, validationResult.error.errors);
                return res.status(400).json({ error: 'Invalid settings format.', details: validationResult.error.errors });
            }
            const updatedSettingsBody = validationResult.data;

            const existingConfig = await mcpConfigStorage.getUserConfiguration(userId) || {
                userId: userId,
                promptSystemSettings: {},
                generalSettings: {}
            };

            // Construct the final configuration object.
            // The McpConfigStorage.saveUserConfiguration method will handle stringifying the settings objects.
            const finalConfig: UserConfiguration = {
                userId: userId,
                geminiApiKey: updatedSettingsBody.geminiApiKey !== undefined ? updatedSettingsBody.geminiApiKey : existingConfig?.geminiApiKey,
                promptSystemSettings: {
                    ...(existingConfig.promptSystemSettings || {}), // Base
                    // Explicitly handle known fields from payload (null -> undefined), or if payload undefined, use base (which is existing)
                    systemInstruction: updatedSettingsBody.promptSystemSettings?.systemInstruction === null 
                        ? undefined 
                        : (updatedSettingsBody.promptSystemSettings?.systemInstruction ?? existingConfig.promptSystemSettings?.systemInstruction),
                    // Passthrough: spread payload fields that are not null and not already explicitly handled
                    ...(updatedSettingsBody.promptSystemSettings 
                        ? Object.fromEntries(Object.entries(updatedSettingsBody.promptSystemSettings).filter(([k,v]) => v !== null && k !== 'systemInstruction')) 
                        : {}),
                },
                generalSettings: {
                    ...(existingConfig.generalSettings || {}), // Base
                    // Explicitly handle known fields
                    geminiModel: updatedSettingsBody.generalSettings?.geminiModel === null 
                        ? undefined 
                        : (updatedSettingsBody.generalSettings?.geminiModel ?? existingConfig.generalSettings?.geminiModel),
                    temperature: updatedSettingsBody.generalSettings?.temperature === null 
                        ? undefined 
                        : (updatedSettingsBody.generalSettings?.temperature ?? existingConfig.generalSettings?.temperature),
                    safetySettings: updatedSettingsBody.generalSettings?.safetySettings === null 
                        ? undefined 
                        : (updatedSettingsBody.generalSettings?.safetySettings ?? existingConfig.generalSettings?.safetySettings),
                    googleSearchEnabled: updatedSettingsBody.generalSettings?.googleSearchEnabled === null 
                        ? undefined 
                        : (updatedSettingsBody.generalSettings?.googleSearchEnabled ?? existingConfig.generalSettings?.googleSearchEnabled),
                    // Passthrough: spread payload fields that are not null and not already explicitly handled
                    ...(updatedSettingsBody.generalSettings 
                        ? Object.fromEntries(Object.entries(updatedSettingsBody.generalSettings).filter(([k,v]) => v !== null && !['geminiModel', 'temperature', 'safetySettings', 'googleSearchEnabled'].includes(k))) 
                        : {}),
                },
            };

            // If systemInstruction is explicitly set to null or undefined in the payload,
            // ensure it's removed from the object before saving, so it doesn't become "null" string inside JSON.
            // Note: `saveUserConfiguration` will store `null` in DB if the whole settings object is empty.
            if (finalConfig.promptSystemSettings && 
                (finalConfig.promptSystemSettings.systemInstruction === null || finalConfig.promptSystemSettings.systemInstruction === undefined)) {
                delete finalConfig.promptSystemSettings.systemInstruction;
            }

            await mcpConfigStorage.saveUserConfiguration(finalConfig);
            res.json({ success: true, message: 'Settings saved successfully.' });
        } catch (error: any) {
            console.error(`Error saving user settings for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to save settings. Please check server logs.' });
        }
    });

    app.post('/api/mcps', async (req: Request, res: Response) => {
        /**
         * @route POST /api/mcps
         * @group API - Mini App Backend
         * @summary Adds or updates an MCP server configuration for the user.
         * @security TelegramInitData
         * @returns {object} 200 - Success message.
         * @returns {object} 400 - Invalid payload format or disallowed stdio command.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const isAdmin = (req as any).isAdmin;
        const config: MCPConfig = req.body;

        try {
            if (!config.name || !config.type) {
                return res.status(400).json({ error: 'MCP config name and type are required.'});
            }

            // *** INÍCIO DA VERIFICAÇÃO DE PERMISSÃO ***
            if (config.type === 'stdio' && !isAdmin) {
                console.warn(`User ${userId} (not admin) attempted to add stdio MCP server "${config.name}". Denied.`);
                return res.status(403).json({ error: "Forbidden: Only administrators can add 'stdio' type MCP servers." });
            }
            // *** FIM DA VERIFICAÇÃO DE PERMISSÃO ***

            await mcpConfigStorage.saveUserMcpConfig(userId, config);
            await mcpClientManager.addServer(userId, config); 
            console.log(`User ${userId} successfully added ${config.type} MCP server "${config.name}".`);
            res.json({ success: true, message: `MCP server "${config.name}" added.` });
        } catch (error: any) {
            console.error(`Error adding MCP config for user ${userId}:`, error.message);
            res.status(500).json({ error: error.message || 'Failed to add MCP server config.' });
        }
    });

    app.delete('/api/mcps/:serverName', async (req: Request, res: Response) => {
        /**
         * @route DELETE /api/mcps/{serverName}
         * @group API - Mini App Backend
         * @summary Deletes a specific MCP server configuration for the user.
         * @param {string} serverName.path.required - The name of the server configuration to delete.
         * @security TelegramInitData
         * @returns {object} 200 - Success message.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const serverName = req.params.serverName;
        if (!serverName) {
            return res.status(400).json({ error: 'Server name is required.' });
        }
        try {
            await mcpConfigStorage.deleteUserMcpConfig(userId, serverName);
            await mcpClientManager.removeServer(userId, serverName); 
            res.json({ success: true, message: `MCP server "${serverName}" deleted.` });
        } catch (error: any) {
            console.error(`Error deleting MCP config "${serverName}" for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to delete MCP server config. Please check server logs.' });
        }
    });

    app.post('/api/clear_history', async (req: Request, res: Response) => {
        /**
         * @route POST /api/clear_history
         * @group API - Mini App Backend
         * @summary Clears the chat history for the current user.
         * @security TelegramInitData
         * @returns {object} 200 - Success message.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId; 
        const chatId = (req as any).telegramUser?.id; 

        if(!chatId) {
            return res.status(400).json({ error: 'Chat ID not found for clearing history.' });
        }

        try {
            await conversationManager.clearHistory(chatId);
            res.json({ success: true, message: 'Chat history cleared.' });
        } catch (error: any) {
            console.error(`Error clearing chat history for chat ${chatId} (user ${userId}):`, error.message);
            res.status(500).json({ error: 'Failed to clear chat history. Please check server logs.' });
        }
    });
}

/**
 * Validates the initData string received from a Telegram Mini App.
 * Checks the hash using the bot token to ensure authenticity.
 * @param initData - The initData string from `window.Telegram.WebApp.initData`.
 * @param botToken - The secret token of the Telegram bot.
 * @returns An object containing `isValid` (boolean) and optionally the parsed `user` object.
 */
function isValidTelegramAuth(initData: string, botToken: string): { isValid: boolean, user?: any } {
  if (!initData || !botToken) {
    return { isValid: false };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash'); 

  const dataCheckArr: string[] = [];
  const sortedKeys = Array.from(params.keys()).sort();
  for (const key of sortedKeys) {
    dataCheckArr.push(`${key}=${params.get(key)}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const userParam = params.get('user');
  let user;
  if (userParam) {
    try {
      user = JSON.parse(userParam);
    } catch (e) {
      console.warn("Failed to parse user data from initData");
    }
  }

  return { isValid: calculatedHash === hash, user };
}
