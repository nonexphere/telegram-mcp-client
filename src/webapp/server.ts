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
import { getMcpConfigStorage, McpConfigStorage } from '../mcp/storage.js'; // Import McpConfigStorage class directly for explicit typing
import { UserConfiguration, GeneralUserSettings, PromptSystemSettings } from '../context/types.js'; // Import specific types
import { MCPConfig } from '../mcp/types.js';
import { z } from 'zod';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Zod Schemas for Validation ---
const SafetySettingSchema = z.object({
    category: z.string(), // Ideally use z.enum with HarmCategory values from @google/genai
    threshold: z.string(), // Ideally use z.enum with HarmBlockThreshold values from @google/genai
});

// Define schemas for nested settings objects to allow passthrough but validate known fields
const PromptSystemSettingsSchema = z.object({
    systemInstruction: z.string().optional().nullable(),
}).passthrough(); // Allows other fields

const GeneralUserSettingsSchema = z.object({
    geminiModel: z.string().optional().nullable(),
    temperature: z.number().min(0).max(2).optional().nullable(), // Gemini supports up to 2.0
    maxOutputTokens: z.number().int().positive().optional().nullable(),
    safetySettings: z.array(SafetySettingSchema).optional().nullable(),
    googleSearchEnabled: z.boolean().optional().nullable(),
}).passthrough(); // Allows other fields

// Main payload schema combining nested schemas
const UserSettingsPayloadSchema = z.object({
    geminiApiKey: z.string().optional().nullable(),
    promptSystemSettings: PromptSystemSettingsSchema.optional().nullable(),
    generalSettings: GeneralUserSettingsSchema.optional().nullable(),
}).passthrough(); // Allow other top-level fields if necessary

// MCP Config Schema
const MCPConfigSchema = z.object({
    name: z.string().min(1, "Server name is required"),
    type: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url("Invalid URL format").optional(),
    env: z.record(z.string().optional()).optional(),
    cwd: z.string().optional(), // Add cwd if needed
}).refine(data => {
    if (data.type === 'stdio' && !data.command) {
        return false; // Command is required for stdio
    }
    if (data.type === 'http' && !data.url) {
        return false; // URL is required for http
    }
    return true;
}, {
    message: "Command is required for stdio type, URL is required for http type",
    path: ["command", "url"], // You might adjust the path depending on how you want the error reported
});


// --- Encryption (copied from storage for direct use here, consider sharing utils) ---
const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;
const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';

if (API_KEY_ENCRYPTION_ENABLED) {
    if (process.env.ENCRYPTION_KEY) {
        if (process.env.ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
            ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_KEY is set but not a 64-character hex string. API keys will not be securely encrypted.');
        }
    }
    if (process.env.ENCRYPTION_IV) {
        if (process.env.ENCRYPTION_IV.length === 32 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_IV)) {
            ENCRYPTION_IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_IV is set but not a 32-character hex string. API keys will not be securely encrypted.');
        }
    }
}
function encrypt(text: string): string {
    if (!text) return text;
    if (!API_KEY_ENCRYPTION_ENABLED || !ENCRYPTION_KEY || !ENCRYPTION_IV) {
        // Warnings are logged in storage/client constructors
        return text; // Store plaintext
    }
    try {
        const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        console.error("Encryption failed, storing plaintext as fallback:", error);
        return text;
    }
}

// --- Server Setup Function ---

/**
 * Configures and sets up the Express application for the Mini App backend.
 * @param app - The Express application instance.
 * @param db - The PrismaClient instance.
 * @param mcpClientManager - The McpClientManager instance.
 * @param geminiClient - The GeminiClient instance.
 * @param conversationManager - The ConversationManager instance.
 * @param adminUserIds - Array of admin user IDs allowed to manage stdio servers.
 */
export function setupWebAppServer(
    app: Application,
    db: PrismaClient, 
    mcpClientManager: McpClientManager,
    geminiClient: GeminiClient, // Keep geminiClient if needed for other API endpoints
    conversationManager: ConversationManager,
    adminUserIds: number[]
): void {
    const mcpConfigStorage: McpConfigStorage = getMcpConfigStorage(db); // Get typed instance
    const publicPath = join(__dirname, 'public');
    app.use(express.static(publicPath)); // Serve static files (HTML, CSS, JS)
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

        // Attach validated user info and admin status to the request object
        (req as any).telegramUserId = user.id;
        (req as any).telegramUser = user; 
        (req as any).isAdmin = adminUserIds.includes(user.id); // Check if user is admin
        console.log(`Validated Mini App request for user ID: ${user.id}, isAdmin: ${(req as any).isAdmin}`);
        next(); // Proceed to the next middleware/handler
        next();
    };

    // Apply the validation middleware to all /api routes.
    app.use('/api', validateTelegramInitDataMiddleware);

    // --- API Endpoints ---

    app.get('/api/user_config', async (req: Request, res: Response) => {
        /**
         * @route GET /api/user_config
         * @group API - Mini App Backend
         * @summary Retrieves the user's current settings and MCP configurations.
         * @security TelegramInitData
         * @returns {object} 200 - An object containing 'settings', 'mcps', and 'isAdmin'.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const isAdmin = (req as any).isAdmin;
        try {
            // Use mcpConfigStorage to get user configuration
            const userConfigResult = await mcpConfigStorage.getUserConfiguration(userId);
            const mcpConfigs = await mcpConfigStorage.getUserMcpConfigs(userId);

             const settingsResponse: UserConfiguration = {
                 userId: userId,
                 geminiApiKey: userConfigResult?.geminiApiKey ?? undefined,
                 promptSystemSettings: userConfigResult?.promptSystemSettings ?? {},
                 generalSettings: userConfigResult?.generalSettings ?? {},
             };

            res.json({
                settings: settingsResponse,
                mcps: mcpConfigs,
                isAdmin: isAdmin // Send admin status to the frontend
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
         * @param {object} request.body.required - User settings payload.
         * @returns {object} 200 - Success message.
         * @returns {object} 400 - Invalid payload format.
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        let existingConfig: UserConfiguration | null = null;

        try {
            // Validate payload with Zod
            const validationResult = UserSettingsPayloadSchema.safeParse(req.body);
            if (!validationResult.success) {
                console.warn(`Invalid user settings payload for user ${userId}:`, validationResult.error.errors);
                return res.status(400).json({ error: 'Invalid settings format.', details: validationResult.error.flatten() });
            }
            const updatedSettingsBody = validationResult.data;

            existingConfig = await mcpConfigStorage.getUserConfiguration(userId); // FIX: Assign fetched config
            const currentPromptSettings = existingConfig?.promptSystemSettings ?? {};
            const currentGeneralSettings = existingConfig?.generalSettings ?? {};
            const currentApiKey = existingConfig?.geminiApiKey;

            const mergedPromptSettings: PromptSystemSettings = {
                ...currentPromptSettings,
                ...(updatedSettingsBody.promptSystemSettings ?? {})
            };
            if (updatedSettingsBody.promptSystemSettings && 'systemInstruction' in updatedSettingsBody.promptSystemSettings) {
                 // Preserve null if provided, otherwise it's string or undefined
                 mergedPromptSettings.systemInstruction = updatedSettingsBody.promptSystemSettings.systemInstruction ?? undefined; // Ensure undefined if null from payload
            }


            const mergedGeneralSettings: GeneralUserSettings = {
                ...currentGeneralSettings,
                ...(updatedSettingsBody.generalSettings ?? {}),
            }; // Ensure all existing fields are carried over if not in updatedSettingsBody

            // Handle explicit null/undefined for specific general settings fields
             if (updatedSettingsBody.generalSettings && 'geminiModel' in updatedSettingsBody.generalSettings) {
                 mergedGeneralSettings.geminiModel = updatedSettingsBody.generalSettings.geminiModel ?? undefined;
             }
             if (updatedSettingsBody.generalSettings && 'temperature' in updatedSettingsBody.generalSettings) {
                 mergedGeneralSettings.temperature = updatedSettingsBody.generalSettings.temperature ?? undefined;
             }
             if (updatedSettingsBody.generalSettings && 'maxOutputTokens' in updatedSettingsBody.generalSettings) {
                mergedGeneralSettings.maxOutputTokens = updatedSettingsBody.generalSettings.maxOutputTokens ?? undefined;
            }
             if (updatedSettingsBody.generalSettings && 'safetySettings' in updatedSettingsBody.generalSettings) {
                mergedGeneralSettings.safetySettings = updatedSettingsBody.generalSettings.safetySettings ?? undefined;
            }
             if (updatedSettingsBody.generalSettings && 'googleSearchEnabled' in updatedSettingsBody.generalSettings) {
                mergedGeneralSettings.googleSearchEnabled = updatedSettingsBody.generalSettings.googleSearchEnabled ?? undefined;
            }


            let apiKeyToSave: string | undefined | null = currentApiKey; // Default to existing
            if (updatedSettingsBody.geminiApiKey !== undefined) { // If key is present in payload (even if null)
                 apiKeyToSave = updatedSettingsBody.geminiApiKey; // This could be null
                 if (apiKeyToSave) { // Only encrypt if it's a non-null string
                     apiKeyToSave = encrypt(apiKeyToSave); // encrypt is defined in this file
                 }
            }

            // Prepare data for Prisma upsert, handling potential nulls correctly
            const dataForUpdate: Prisma.UserConfigUpdateInput = {};
            const dataForCreate: Prisma.UserConfigCreateInput = { userId };

            // Handle API key for Prisma (null, undefined, or value)
            if (apiKeyToSave !== undefined) { // if undefined, it means no change from existing or not provided
                dataForUpdate.geminiApiKey = apiKeyToSave;
                dataForCreate.geminiApiKey = apiKeyToSave;
            }

            // Convert merged settings to JSON string or null if empty/all undefined
            // PromptSystemSettings
            const hasValidPromptSettings = Object.values(mergedPromptSettings).some(v => v !== undefined && v !== null && v !== '');
            const promptSettingsJson = hasValidPromptSettings ? JSON.stringify(mergedPromptSettings) : null;
            dataForUpdate.promptSystemSettings = promptSettingsJson;
            dataForCreate.promptSystemSettings = promptSettingsJson;

            // GeneralUserSettings
            const hasValidGeneralSettings = Object.values(mergedGeneralSettings).some(v => v !== undefined && v !== null && v !== '');
            const generalSettingsJson = hasValidGeneralSettings ? JSON.stringify(mergedGeneralSettings) : null;
            dataForUpdate.generalSettings = generalSettingsJson;
            dataForCreate.generalSettings = generalSettingsJson;

            await db.userConfig.upsert({
                where: { userId: userId },
                update: dataForUpdate,
                create: dataForCreate,
            });
            console.log(`Saved user configuration for user ${userId}.`);

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
         * @param {MCPConfig} request.body.required - MCP server configuration.
         * @returns {object} 200 - Success message.
         * @returns {object} 400 - Invalid payload format.
         * @returns {object} 403 - Forbidden (non-admin trying to add stdio).
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const isAdmin = (req as any).isAdmin;

        try {
            // Validate payload with Zod
            const validationResult = MCPConfigSchema.safeParse(req.body);
            if (!validationResult.success) {
                console.warn(`Invalid MCP config payload for user ${userId}:`, validationResult.error.errors);
                return res.status(400).json({ error: 'Invalid MCP configuration format.', details: validationResult.error.flatten() });
            }
            const config: MCPConfig = validationResult.data; // Use validated data

            // *** Permission Check for stdio ***
            if (config.type === 'stdio' && !isAdmin) {
                console.warn(`User ${userId} (not admin) attempted to add stdio MCP server "${config.name}". Denied.`);
                return res.status(403).json({ error: "Forbidden: Only administrators can add 'stdio' type MCP servers." });
            }

            // Use the manager to add/update the server (which also saves to DB via storage)
            await mcpClientManager.addServer(userId, config);
            console.log(`User ${userId} successfully added/updated ${config.type} MCP server "${config.name}".`);
            res.json({ success: true, message: `MCP server "${config.name}" saved.` });
        } catch (error: any) {
            console.error(`Error adding/updating MCP config for user ${userId}:`, error.message);
            // Distinguish between validation errors (already handled) and other errors
             if (res.headersSent) return; // Avoid sending multiple responses
             if (error.message.includes("Invalid MCP configuration format")) { // Check if it's our specific validation error message
                 res.status(400).json({ error: error.message });
             } else {
                res.status(500).json({ error: error.message || 'Failed to save MCP server config.' });
             }
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
         * @returns {object} 400 - Bad Request (missing server name).
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId;
        const serverName = req.params.serverName;
        if (!serverName) {
            return res.status(400).json({ error: 'Server name is required.' });
        }
        try {
             // Use the manager to remove the server (which also deletes from DB via storage)
            await mcpClientManager.removeServer(userId, serverName, true); // Ensure DB remove is triggered
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
         * @summary Clears the chat history for the current user in their private chat with the bot.
         * @security TelegramInitData
         * @returns {object} 200 - Success message.
         * @returns {object} 400 - Bad Request (chat ID not found).
         * @returns {object} 500 - Internal server error.
         */
        const userId = (req as any).telegramUserId; 
        // NOTE: Clearing history typically makes sense in the context of a specific CHAT.
        // If the Mini App is launched from a private chat, user.id IS the chat.id.
        // If launched from a group, you might need the chat ID from initData if available and intended.
        // Assuming Mini App is primarily for private chat settings:
        const chatId = (req as any).telegramUser?.id; // Use user ID as chat ID for private chats

        if (!chatId) { // Should always have chatId if validation passed
            console.error(`Could not determine chat ID for user ${userId} to clear history.`);
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

    // Fallback for any other route - serve index.html (useful for single-page apps)
    // Ensure this is after all specific API routes
    app.get('*', (req, res) => {
        res.sendFile(join(publicPath, 'index.html'));
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
        console.warn("isValidTelegramAuth called with missing initData or botToken");
        return { isValid: false };
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) {
            console.warn("initData missing hash parameter");
            return { isValid: false };
        }
        params.delete('hash'); // hash should not be part of the data check string

        const dataCheckArr: string[] = [];
        // Sort keys alphabetically before joining
        const sortedKeys = Array.from(params.keys()).sort();
        for (const key of sortedKeys) {
            dataCheckArr.push(`${key}=${params.get(key)}`);
        }
        const dataCheckString = dataCheckArr.join('\n');

        // Create the secret key
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

        // Calculate the hash
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        // Compare calculated hash with the received hash
        const isValid = calculatedHash === hash;

        let user;
        const userParam = params.get('user');
        if (userParam) {
            try {
                user = JSON.parse(decodeURIComponent(userParam)); // Ensure user data is decoded if necessary
            } catch (e) {
                console.warn("Failed to parse user data from initData:", e);
                // Decide if this should invalidate the auth. Usually, yes.
                return { isValid: false };
            }
        } else {
            // If user data is critical, consider this invalid
             console.warn("initData missing user parameter");
             // return { isValid: false };
        }


        if (!isValid) {
            console.warn("Telegram initData validation failed. Hash mismatch.");
             // Log data for debugging (BE CAREFUL with sensitive data in production logs)
             // console.debug("DataCheckString:", dataCheckString);
             // console.debug("Received Hash:", hash);
             // console.debug("Calculated Hash:", calculatedHash);
        }

        return { isValid, user };
    } catch (error) {
        console.error("Error during Telegram initData validation:", error);
        return { isValid: false };
    }
}
