import type { PrismaClient, Prisma } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { UserConfiguration } from '../context/types.js';

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

              const config: UserConfiguration = {
                  userId: userId,
                  geminiApiKey: row.geminiApiKey ?? undefined, // Handle null from DB
                  promptSystemSettings: (row.promptSystemSettings as any) || {}, // Prisma handles JSON
                  generalSettings: (row.generalSettings as any) || {}, // Prisma handles JSON
              };
              return config;
         } catch (error) {
             console.error(`Error loading user configuration for user ${userId}:`, error);
             throw error; 
         }
     }

     async saveUserConfiguration(config: UserConfiguration): Promise<void> {
        let stmt;
        try {
            const encryptedApiKey = config.geminiApiKey; // Potentially encrypted

            const dataToSave = {
                geminiApiKey: encryptedApiKey,
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
        } finally {
            if (stmt) {
                try {
                    await stmt.finalize();
                } catch (finalizeError) {
                    console.error(`Error finalizing statement for user ${config.userId}:`, finalizeError);
                }
            }
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
