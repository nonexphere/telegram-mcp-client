import Database from 'better-sqlite3';
import { MCPConfig } from './types.js';
import { UserConfiguration } from '../context/types.js'; // Import UserConfig type

// This module now handles loading/saving user-specific MCP configs from/to the database

export class McpConfigStorage {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        // DB initialization is done in src/db.ts
    }

    // Get all MCP configurations for a specific user from the database
    async getUserMcpConfigs(userId: number): Promise<MCPConfig[]> {
        try {
            const rows = this.db.prepare('SELECT config_json FROM mcp_configs WHERE user_id = ?').all(userId);
            return rows.map(row => JSON.parse(row.config_json));
        } catch (error) {
            console.error(`Error loading MCP configs for user ${userId}:`, error);
            throw error;
        }
    }

    // Add or update an MCP configuration for a specific user in the database
    async saveUserMcpConfig(userId: number, config: MCPConfig): Promise<void> {
        try {
            // Check if a config with this name already exists for this user
             const existing = this.db.prepare('SELECT id FROM mcp_configs WHERE user_id = ? AND json_extract(config_json, \'$.name\') = ?').get(userId, config.name);

            if (existing) {
                 // Update existing config
                this.db.prepare('UPDATE mcp_configs SET config_json = ? WHERE id = ?').run(JSON.stringify(config), existing.id);
                 console.log(`Updated MCP config "${config.name}" for user ${userId} in DB.`);
            } else {
                 // Insert new config
                this.db.prepare('INSERT INTO mcp_configs (user_id, config_json) VALUES (?, ?)').run(userId, JSON.stringify(config));
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
             this.db.prepare('DELETE FROM mcp_configs WHERE user_id = ? AND json_extract(config_json, \'$.name\') = ?').run(userId, serverName);
             console.log(`Deleted MCP config "${serverName}" for user ${userId} from DB.`);
         } catch (error) {
             console.error(`Error deleting MCP config "${serverName}" for user ${userId}:`, error);
             throw error;
         }
     }

     // --- User Settings (Gemini Key, Prompt System, etc.) ---
     async getUserConfiguration(userId: number): Promise<UserConfiguration | null> {
         try {
              const row = this.db.prepare('SELECT gemini_api_key, prompt_system_settings, general_settings FROM user_configs WHERE user_id = ?').get(userId);
              if (!row) return null;

              // TODO: Decrypt gemini_api_key if encrypted
              const config: UserConfiguration = {
                  userId: userId,
                  geminiApiKey: row.gemini_api_key, // Potentially decrypted
                  promptSystemSettings: JSON.parse(row.prompt_system_settings || '{}'),
                  generalSettings: JSON.parse(row.general_settings || '{}')
              };
              return config;

         } catch (error) {
             console.error(`Error loading user configuration for user ${userId}:`, error);
             throw error;
         }
     }

     async saveUserConfiguration(config: UserConfiguration): Promise<void> {
         try {
             // TODO: Encrypt gemini_api_key if needed
             const encryptedApiKey = config.geminiApiKey; // Potentially encrypted

             this.db.prepare(`
                 INSERT INTO user_configs (user_id, gemini_api_key, prompt_system_settings, general_settings)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                     gemini_api_key = EXCLUDED.gemini_api_key,
                     prompt_system_settings = EXCLUDED.prompt_system_settings,
                     general_settings = EXCLUDED.general_settings;
             `).run(
                 config.userId,
                 encryptedApiKey, // Potentially encrypted
                 JSON.stringify(config.promptSystemSettings),
                 JSON.stringify(config.generalSettings)
             );
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
export function getMcpConfigStorage(db: Database): McpConfigStorage {
    if (!storageInstance) {
        storageInstance = new McpConfigStorage(db);
    }
    return storageInstance;
}
