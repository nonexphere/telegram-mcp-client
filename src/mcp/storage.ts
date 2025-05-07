import type { PrismaClient, Prisma } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { UserConfiguration } from '../context/types.js';
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;

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

function encrypt(text: string): string {
    if (!ENCRYPTION_KEY || !ENCRYPTION_IV || !text) {
        if (!text) return text; // if text is null/undefined, return as is
        if (!ENCRYPTION_KEY || !ENCRYPTION_IV) {
            console.warn('Warning: ENCRYPTION_KEY or ENCRYPTION_IV is not properly configured. User API key will be stored in plaintext if provided.');
        }
        return text;
    }
    try {
        const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        console.error("Encryption failed, storing plaintext as fallback:", error);
        return text; // Fallback to plaintext if encryption fails
    }
}

export class McpConfigStorage {
    private db: PrismaClient;

    constructor(db: PrismaClient) {
        this.db = db;
    }

    async getUserMcpConfigs(userId: number): Promise<MCPConfig[]> {
        try {
            const dbConfigs = await this.db.mcpConfig.findMany({
                where: { userId },
                select: { name: true, configJson: true }
            });
            return dbConfigs.map(dbConfig => {
                // configJson might not have 'name' if it's a separate column
                const configData: MCPConfigWithOptionalName = dbConfig.configJson as MCPConfigWithOptionalName;
                return { ...configData, name: dbConfig.name };
            });
        } catch (error) {
            console.error(`Error loading MCP configs for user ${userId}:`, error);
            throw error;
        }
    }
    async saveUserMcpConfig(userId: number, config: MCPConfig): Promise<void> {
        try {
            const { name, ...configDataToStore } = config; // Separate name from the rest of the config

            await this.db.mcpConfig.upsert({
                where: { userId_name: { userId, name } },
                update: { configJson: configDataToStore as Prisma.InputJsonValue },
                create: { userId, name, configJson: configDataToStore as Prisma.InputJsonValue },
            });
            console.log(`Saved MCP config "${name}" for user ${userId} to DB.`);
        } catch (error) {
            console.error(`Error saving MCP config "${config.name}" for user ${userId}:`, error);
            throw error;
        }
    }
     // Remove an MCP configuration for a specific user from the database
     async deleteUserMcpConfig(userId: number, serverName: string): Promise<void> {
         try {
             await this.db.mcpConfig.deleteMany({
                 where: {
                     userId: userId,
                     name: serverName,
                 }
             });
             console.log(`Deleted MCP config "${serverName}" for user ${userId} from DB.`);
         } catch (error) {
             console.error(`Error deleting MCP config "${serverName}" for user ${userId}:`, error);
             throw error;
         }
     }

     // --- User Settings (Gemini Key, Prompt System, etc.) ---
     async getUserConfiguration(userId: number): Promise<UserConfiguration | null> {
         try {
            const row = await this.db.userConfig.findUnique({
                where: { userId },
                select: { geminiApiKey: true, promptSystemSettings: true, generalSettings: true }
            });
            if (!row) return null;

            // Decryption will happen in GeminiClient before use
            const config: UserConfiguration = {
                userId: userId,
                geminiApiKey: row.geminiApiKey ?? undefined,
                promptSystemSettings: (row.promptSystemSettings as any) || {},
                generalSettings: (row.generalSettings as any) || {},
            };
            return config;
         } catch (error) {
             console.error(`Error loading user configuration for user ${userId}:`, error);
             throw error; 
         }
     }

    async saveUserConfiguration(config: UserConfiguration): Promise<void> {
        try {
            let apiKeyToSave = config.geminiApiKey;
            if (config.geminiApiKey && ENCRYPTION_KEY && ENCRYPTION_IV) {
                apiKeyToSave = encrypt(config.geminiApiKey);
            } else if (config.geminiApiKey && (!ENCRYPTION_KEY || !ENCRYPTION_IV)) {
                // Warning already logged by encrypt function or at startup
            }

            const dataToSave = {
                geminiApiKey: apiKeyToSave,
                promptSystemSettings: (config.promptSystemSettings || {}) as Prisma.InputJsonValue,
                generalSettings: (config.generalSettings || {}) as Prisma.InputJsonValue,
            };

            await this.db.userConfig.upsert({
                where: { userId: config.userId },
                update: dataToSave,
                create: { userId: config.userId, ...dataToSave },
            });
            console.log(`Saved user configuration for user ${config.userId}.`);
        } catch (error) {
            console.error(`Error saving user configuration for user ${config.userId}:`, error);
            throw error;
        }
    }
}

// Export an instance initialized with the DB
// This allows other modules to import and use it
let storageInstance: McpConfigStorage | null = null;
export function getMcpConfigStorage(db: PrismaClient): McpConfigStorage {
    if (!storageInstance) {
        storageInstance = new McpConfigStorage(db);
    } else if (storageInstance['db'] !== db) {
        console.warn("McpConfigStorage DB instance changed, re-initializing.");
        storageInstance = new McpConfigStorage(db);
    }
    return storageInstance;
}
