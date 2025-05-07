import express, { Application, Request, Response, NextFunction } from 'express'; 
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto'; 
import type { Database } from 'sqlite';
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
    geminiClient: GeminiClient,
    conversationManager: ConversationManager,
): void {
    const mcpConfigStorage = getMcpConfigStorage(db); 
    const publicPath = join(__dirname, 'public');
    app.use(express.static(publicPath));
    console.log(`Serving static files from: ${publicPath}`);

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
            res.status(500).json({ error: 'Failed to retrieve configuration.' });
        }
    });

    app.post('/api/user_settings', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;
        const updatedSettingsBody: Partial<UserConfiguration> = req.body;

        if (!updatedSettingsBody || typeof updatedSettingsBody !== 'object') {
            return res.status(400).json({ error: 'Invalid request body.' });
        }

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

            if (finalConfig.geminiApiKey === null || finalConfig.geminiApiKey === undefined) delete finalConfig.geminiApiKey;
            if (finalConfig.promptSystemSettings.systemInstruction === null || finalConfig.promptSystemSettings.systemInstruction === undefined) delete finalConfig.promptSystemSettings.systemInstruction;

            await mcpConfigStorage.saveUserConfiguration(finalConfig);
            res.json({ success: true, message: 'Settings saved successfully.' });
        } catch (error: any) {
            console.error(`Error saving user settings for user ${userId}:`, error.message);
            res.status(500).json({ error: 'Failed to save settings.' });
        }
    });

    app.post('/api/mcps', async (req: Request, res: Response) => {
        const userId = (req as any).telegramUserId;
        const config: MCPConfig = req.body;
        try {
            if (!config.name || !config.type) {
                return res.status(400).json({ error: 'MCP config name and type are required.'});
            }
            await mcpConfigStorage.saveUserMcpConfig(userId, config);
            await mcpClientManager.addServer(userId, config); 
            res.json({ success: true, message: `MCP server "${config.name}" added.` });
        } catch (error: any) {
            console.error(`Error adding MCP config for user ${userId}:`, error.message);
            res.status(500).json({ error: error.message || 'Failed to add MCP server config.' });
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
            res.status(500).json({ error: error.message || 'Failed to delete MCP server config.' });
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
            console.error(`Error clearing chat history for chat ${chatId}:`, error.message);
            res.status(500).json({ error: 'Failed to clear chat history.' });
        }
    });
}

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
