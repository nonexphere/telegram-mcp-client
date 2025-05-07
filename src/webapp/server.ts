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
import { z } from 'zod'; // Import Zod

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
}).passthrough(); // Allow other fields potentially

const McpConfigPayloadSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().optional()).optional(), // Allow string or undefined values
    url: z.string().url().optional(),
}).refine(data => (data.type === 'stdio' ? !!data.command : true), {
    message: "Command is required for stdio type",
    path: ["command"],
}).refine(data => (data.type === 'http' ? !!data.url : true), {
    message: "URL is required for http type",
    path: ["url"],
});

// --- Allowed stdio commands (Example Allowlist) ---
// In a real application, this might come from config or be more sophisticated.
const ALLOWED_STDIO_COMMANDS = [
    'npx', // Allow npx to run known packages
    // Add other trusted commands/scripts here, e.g., '/usr/local/bin/my-safe-script'
];

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
        next();
    };

    // Apply the validation middleware to all /api routes.
    app.use('/api', validateTelegramInitDataMiddleware);

    app.get('/api/user_config', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;
        try {
            const userConfig = await mcpConfigStorage.getUserConfiguration(userId);
            const mcpConfigs = await mcpConfigStorage.getUserMcpConfigs(userId);
            res.json({
                settings: userConfig || { userId: userId, promptSystemSettings: {}, generalSettings: {} },
                mcps: mcpConfigs
            });
        } catch (error: any) {
            console.error(`Error getting user config for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to retrieve configuration. Please try again later.' });
        }
    });

    app.post('/api/user_settings', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;

        // Validate payload with Zod
        const validationResult = UserSettingsPayloadSchema.safeParse(req.body);
        if (!validationResult.success) {
            console.warn(`Invalid user settings payload for user ${userId}:`, validationResult.error.errors);
            return res.status(400).json({ error: 'Invalid settings format.', details: validationResult.error.errors });
        }
        const updatedSettingsBody = validationResult.data;

        try {
            const existingConfig = await mcpConfigStorage.getUserConfiguration(userId) || {
                userId: userId,
                promptSystemSettings: {},
                generalSettings: {}
            };

            const finalConfig: UserConfiguration = {
                userId: userId,
                geminiApiKey: updatedSettingsBody.geminiApiKey !== undefined ? updatedSettingsBody.geminiApiKey : existingConfig.geminiApiKey,
                promptSystemSettings: {
                    ...existingConfig.promptSystemSettings,
                    ...(updatedSettingsBody.promptSystemSettings || {}),
                },
                generalSettings: {
                    ...existingConfig.generalSettings,
                    ...(updatedSettingsBody.generalSettings || {}),
                },
            };

            // Ensure promptSystemSettings and generalSettings are valid JSON or null for Prisma
            finalConfig.promptSystemSettings = (finalConfig.promptSystemSettings && Object.keys(finalConfig.promptSystemSettings).length > 0)
                ? finalConfig.promptSystemSettings as Prisma.InputJsonValue
                : Prisma.JsonNull;
            finalConfig.generalSettings = (finalConfig.generalSettings && Object.keys(finalConfig.generalSettings).length > 0)
                ? finalConfig.generalSettings as Prisma.InputJsonValue
                : Prisma.JsonNull;
            if (finalConfig.promptSystemSettings.systemInstruction === null || finalConfig.promptSystemSettings.systemInstruction === undefined) delete finalConfig.promptSystemSettings.systemInstruction;

            await mcpConfigStorage.saveUserConfiguration(finalConfig);
            res.json({ success: true, message: 'Settings saved successfully.' });
        } catch (error: any) {
            console.error(`Error saving user settings for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to save settings. Please try again later.' });
        }
    });

    app.post('/api/mcps', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;

        // Validate payload with Zod
        const validationResult = McpConfigPayloadSchema.safeParse(req.body);
        if (!validationResult.success) {
            console.warn(`Invalid MCP config payload for user ${userId}:`, validationResult.error.errors);
            return res.status(400).json({ error: 'Invalid MCP configuration format.', details: validationResult.error.errors });
        }
        const config = validationResult.data as MCPConfig; // Cast after validation

        try {

            // Security check for stdio commands
            if (config.type === 'stdio' && config.command) {
                // --- Stricter Stdio Security ---
                // Option 1: Simple Allowlist (as implemented here)
                const commandBase = config.command.split(' ')[0]; // Get the base command
                if (!ALLOWED_STDIO_COMMANDS.includes(commandBase)) {
                    console.warn(`Attempt to add potentially unsafe stdio command by user ${userId}: ${config.command}`);
                    return res.status(400).json({ error: `Command "${commandBase}" is not allowed for stdio servers.` });
                }
                // Option 2: Predefined Types (More Secure)
                // Instead of free 'command' input, the UI would offer types like 'filesystem'.
                // The backend would map 'filesystem' to a safe, predefined command/args template.
                // Example: if (config.predefinedType === 'filesystem') { config.command = 'npx'; config.args = ['-y', '@mcp/server-filesystem', validatedPath]; }

                // TODO: Add further sanitization/validation for `args` and `env` if needed.
            }

            await mcpConfigStorage.saveUserMcpConfig(userId, config);
            await mcpClientManager.addServer(userId, config); 
            res.json({ success: true, message: `MCP server "${config.name}" added.` });
        } catch (error: any) {
            console.error(`Error adding MCP config for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to add MCP server config. Please try again later.' });
        }
    });

    app.delete('/api/mcps/:serverName', async (req: Request, res: Response) => {
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
            res.status(500).json({ error: 'Failed to delete MCP server config. Please try again later.' });
        }
    });

    app.post('/api/clear_history', async (req: Request, res: Response) => {
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
            res.status(500).json({ error: 'Failed to clear chat history. Please try again later.' });
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
