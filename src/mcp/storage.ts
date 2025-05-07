import type { Database } from 'sqlite'; 
import { MCPConfig } from './types.js';
import { UserConfiguration } from '../context/types.js';

export class McpConfigStorage {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async getUserMcpConfigs(userId: number): Promise<MCPConfig[]> {
        try {
            const rows = await this.db.all<MCPConfigRow[]>('SELECT config_json FROM mcp_configs WHERE user_id = ?', userId);
            return rows.map(row => JSON.parse(row.config_json));
        } catch (error) {
            console.error(`Error loading MCP configs for user ${userId}:`, error);
            throw error;
        }
    }

    async saveUserMcpConfig(userId: number, config: MCPConfig): Promise<void> {
        try {
            const existing = await this.db.get<{ id: number }>(
                'SELECT id FROM mcp_configs WHERE user_id = ? AND json_extract(config_json, \'$.name\') = ?',
                userId,
                config.name,
            );

            if (existing) {
                await this.db.run('UPDATE mcp_configs SET config_json = ? WHERE id = ?', JSON.stringify(config), existing.id);
                console.log(`Updated MCP config "${config.name}" for user ${userId} in DB.`);
            } else {
                await this.db.run('INSERT INTO mcp_configs (user_id, config_json) VALUES (?, ?)', userId, JSON.stringify(config));
                console.log(`Added new MCP config "${config.name}" for user ${userId} to DB.`);
            }
        } catch (error) {
            console.error(`Error saving MCP config "${config.name}" for user ${userId}:`, error);
            throw error;
        }
    }

     // Remove an MCP configuration for a specific user from the database
     async deleteUserMcpConfig(userId: number, serverName: string): Promise<void> {
         try {
             await this.db.run('DELETE FROM mcp_configs WHERE user_id = ? AND json_extract(config_json, \'$.name\') = ?', userId, serverName);
             console.log(`Deleted MCP config "${serverName}" for user ${userId} from DB.`);
         } catch (error) {
             console.error(`Error deleting MCP config "${serverName}" for user ${userId}:`, error);
             throw error;
         }
     }

     // --- User Settings (Gemini Key, Prompt System, etc.) ---
     async getUserConfiguration(userId: number): Promise<UserConfiguration | null> {
         try {
              const row = await this.db.get<UserConfigRow>(
                'SELECT gemini_api_key, prompt_system_settings, general_settings FROM user_configs WHERE user_id = ?',
                userId,
              );
              if (!row) return null;

              const config: UserConfiguration = {
                  userId: userId,
                  geminiApiKey: row.gemini_api_key,
                  promptSystemSettings: JSON.parse(row.prompt_system_settings || '{}'),
                  generalSettings: JSON.parse(row.general_settings || '{}'),
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

            stmt = await this.db.prepare(`
                INSERT INTO user_configs (user_id, gemini_api_key, prompt_system_settings, general_settings)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    gemini_api_key = EXCLUDED.gemini_api_key,
                    prompt_system_settings = EXCLUDED.prompt_system_settings,
                    general_settings = EXCLUDED.general_settings;
            `);

            await stmt.run(
                config.userId,
                encryptedApiKey,
                JSON.stringify(config.promptSystemSettings || {}),
                JSON.stringify(config.generalSettings || {})
            );

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
export function getMcpConfigStorage(db: Database): McpConfigStorage {
    if (!storageInstance) {
        storageInstance = new McpConfigStorage(db);
    } else if (storageInstance['db'] !== db) {
        console.warn("McpConfigStorage DB instance changed, re-initializing.");
        storageInstance = new McpConfigStorage(db);
    }
    return storageInstance;
}
// Interfaces para tipagem das linhas do banco de dados
interface MCPConfigRow {
  config_json: string;
}

interface UserConfigRow {
  gemini_api_key: string | null;
  prompt_system_settings: string | null;
  general_settings: string | null;
}
