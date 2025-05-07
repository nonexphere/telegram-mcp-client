/**
 * @file Manages persistence of user configurations (API keys, settings)
 * and MCP server configurations using Prisma. Handles encryption of sensitive data.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { UserConfiguration } from '../context/types.js';
import crypto from 'crypto';

// Encryption settings
const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;
const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';

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

/**
 * Encrypts text using AES-256-CBC if encryption is enabled and keys are valid.
 * Falls back to returning plaintext if encryption is disabled or keys are missing/invalid.
 * @param text - The plaintext string to encrypt.
 * @returns The encrypted text (hex encoded) or the original plaintext on failure/disabled encryption.
 * @throws {Error} Only if the crypto library itself throws during encryption.
 */
function encrypt(text: string): string {
    if (!text) return text; // if text is null/undefined, return as is

    if (!API_KEY_ENCRYPTION_ENABLED) {
        console.warn('Warning: API_KEY_ENCRYPTION_ENABLED is false. User API key will be stored in plaintext if provided.');
        return text;
    }
    if (!ENCRYPTION_KEY || !ENCRYPTION_IV) {
        if (!text) return text; // if text is null/undefined, return as is
        console.warn('Warning: ENCRYPTION_KEY or ENCRYPTION_IV is not properly configured, but encryption is enabled. User API key will be stored in plaintext as a fallback.');
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

/**
 * Provides methods to interact with the database for storing and retrieving
 * user configurations and MCP server configurations.
 */
export class McpConfigStorage {
    private db: PrismaClient;

    /**
     * Creates an instance of McpConfigStorage.
     * @param db - The PrismaClient instance.
     */
    constructor(db: PrismaClient) {
        this.db = db;
    }

    /**
     * Retrieves all MCP server configurations for a specific user.
     * @param userId - The ID of the user.
     * @returns A promise resolving to an array of MCPConfig objects.
     */
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

    /**
     * Saves or updates an MCP server configuration for a user.
     * Uses upsert for atomic add/update based on the unique (userId, name) combination.
     * @param userId - The ID of the user.
     * @param config - The MCPConfig object to save.
     */
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

     /**
      * Removes an MCP server configuration for a specific user from the database.
      * @param userId - The ID of the user.
      * @param serverName - The name of the server configuration to delete.
      */
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

     /**
      * Retrieves the general user configuration (API key, settings) for a specific user.
      * @param userId - The ID of the user.
      * @returns A promise resolving to the UserConfiguration object or null if not found.
      */
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

    /**
     * Saves or updates the general user configuration.
     * Encrypts the Gemini API key if provided and encryption is enabled/configured.
     * Uses upsert for atomic add/update based on userId.
     * @param config - The UserConfiguration object to save.
     */
    async saveUserConfiguration(config: UserConfiguration): Promise<void> {
        try {
            let apiKeyToSave = config.geminiApiKey;
            // Encrypt the API key if it exists and encryption is enabled + configured.
            if (config.geminiApiKey && API_KEY_ENCRYPTION_ENABLED && ENCRYPTION_KEY && ENCRYPTION_IV) {
                apiKeyToSave = encrypt(config.geminiApiKey);
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
/**
 * Gets a singleton instance of McpConfigStorage.
 * @param db - The PrismaClient instance.
 * @returns The McpConfigStorage instance.
 */
export function getMcpConfigStorage(db: PrismaClient): McpConfigStorage {
    if (!storageInstance) {
        storageInstance = new McpConfigStorage(db);
    } else if (storageInstance['db'] !== db) {
        console.warn("McpConfigStorage DB instance changed, re-initializing.");
        storageInstance = new McpConfigStorage(db);
    }
    return storageInstance;
}
