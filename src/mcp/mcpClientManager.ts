/**
 * @file Manages connections and interactions with multiple Model Context Protocol (MCP) servers
 * for different users. Handles client lifecycle, tool discovery, and routing tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; // Import only StdioClientTransport
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PrismaClient } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { FunctionDeclaration } from '@google/genai'; 
import { mapMcpToolToGeminiFunctionDeclaration } from '../gemini/mapping.js';
import {
    LoggingMessageNotificationSchema, // Import the correct schema
    ResourceListChangedNotificationSchema, // Import the correct schema
    ToolListChangedNotificationSchema, // Import the correct schema
    LoggingMessageNotification, // Import the type for the handler
} from '../types.js';
import { Stream, PassThrough } from 'node:stream';
import { IOType } from 'node:child_process';

type UserClientsMap = Map<string, { config: MCPConfig; client: Client | null }>; // client can be null

// Copied StdioServerParameters type definition locally as a workaround for import issues.
// Adjusted env to match SDK expectations: Record<string, string>
type StdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>; // SDK likely expects env values to be strings
    stderr?: IOType | Stream | number;
    cwd?: string;
};

/**
 * Manages MCP client instances for multiple users and server configurations.
 * Loads configurations from the database, connects clients on demand,
 * lists available tools, and routes tool calls to the appropriate server.
 */
export class McpClientManager {
  private activeServers: Map<number, UserClientsMap> = new Map();
  private db: PrismaClient; 

  /**
   * Creates an instance of McpClientManager.
   * @param db - The PrismaClient instance for database access.
   */
  constructor(db: PrismaClient) {
    this.db = db;
    // Load existing configurations from the database on startup.
    // Errors during initial load are logged but don't prevent startup,
    // allowing the manager to function for newly added servers.
    this.loadUserConfigsFromDb().catch(err => {
        console.error("Failed to load MCP user configs on startup:", err);
    });
  }

  private async loadUserConfigsFromDb(): Promise<void> {
    try {
      // Fetch all MCP configurations stored in the database.
      const configsFromDb = await this.db.mcpConfig.findMany({
        select: { userId: true, name: true, configJson: true }
      });
      for (const dbConfig of configsFromDb) {
        const userId = dbConfig.userId;
        const name = dbConfig.name;
         try {
             // Attempt to parse the configJson
             const configData: MCPConfigWithOptionalName = JSON.parse(dbConfig.configJson);
             // Reconstruct the full MCPConfig object including the name.
             const config: MCPConfig = { ...configData, name };

             // Basic validation after parsing
             if (!config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
                console.warn(`Skipping invalid MCP config "${name}" for user ${userId} from DB: Missing type or required fields.`);
                continue; // Skip this invalid configuration
             }

             // Initialize the map for the user if it doesn't exist.
             if (!this.activeServers.has(userId)) {
                 this.activeServers.set(userId, new Map());
             }
             // Store the configuration in the active servers map. Client is initially null.
             this.activeServers.get(userId)!.set(config.name, { config, client: null });

         } catch (parseError) {
            console.error(`Error parsing MCP config JSON for "${name}" user ${userId} from DB:`, parseError);
            // Optionally delete the invalid config from DB or mark it as invalid
         }
      }
      console.log(`Loaded configurations for ${this.activeServers.size} users from DB.`);
    } catch (error) {
      console.error('Error loading MCP configurations from DB:', error);
    }
  }

  /**
   * Adds or updates an MCP server configuration for a specific user.
   * If a server with the same name already exists for the user, it disconnects the old client
   * before adding the new configuration. Saves the configuration to the database.
   * @param userId - The ID of the user adding the server.
   * @param config - The MCP server configuration details.
   * @throws {Error} If the configuration format is invalid or if saving to the database fails.
   */
  async addServer(userId: number, config: MCPConfig): Promise<void> {
    if (!config.name || !config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
      throw new Error('Invalid MCP configuration format: Missing name, type, or required fields (command/url).');
    }

    if (!this.activeServers.has(userId)) {
      this.activeServers.set(userId, new Map());
    }
    const userClients = this.activeServers.get(userId)!;

    if (userClients.has(config.name)) {
      console.log(`Updating MCP server "${config.name}" for user ${userId}. Disconnecting old client if active.`);
      await this.removeServer(userId, config.name, false); // Don't trigger DB remove here
    }

    // Add the new configuration (client is initially null)
    userClients.set(config.name, { config, client: null });

    const { name, ...configDataToStore } = config;
    try {
      await this.db.mcpConfig.upsert({ // Changed to upsert
          where: { userId_name: { userId, name } },
          update: { configJson: JSON.stringify(configDataToStore) },
          create: {
              userId,
              name, // Save the name separately
              configJson: JSON.stringify(configDataToStore), // Store the rest of the config as JSON
          },
      });
      console.log(`MCP server config "${config.name}" saved/updated for user ${userId} in DB.`);
    } catch (error) {
      console.error(`Error saving/updating MCP config "${config.name}" for user ${userId} to DB:`, error);
      userClients.delete(config.name); // Ensure consistency
      throw error; // Re-throw the error
    }
  }

  /**
   * Removes an MCP server configuration for a user.
   * Disconnects the client if active and optionally removes the configuration from the database.
   * @param userId - The ID of the user.
   * @param serverName - The name of the server configuration to remove.
   * @param triggerDbRemove - If true (default), removes the configuration from the database.
   * @throws {Error} If removing from the database fails.
   */
  async removeServer(userId: number, serverName: string, triggerDbRemove = true): Promise<void> {
    const userClients = this.activeServers.get(userId);
    if (!userClients || !userClients.has(serverName)) {
      console.warn(`MCP server "${serverName}" not found for user ${userId}. Skipping removal.`);
      return;
    }

    const serverEntry = userClients.get(serverName)!;

    // FIX: Check typeof client.close before calling
    if (serverEntry.client && typeof serverEntry.client.close === 'function') {
      console.log(`Disconnecting client for "${serverName}" for user ${userId}.`);
      try {
        await serverEntry.client.close();
        console.log(`Client for "${serverName}" disconnected.`);
      } catch (error) {
        console.error(`Error disconnecting client for "${serverName}" for user ${userId}:`, error);
        // Continue removal even if closing fails
      }
    }

    userClients.delete(serverName);
    console.log(`MCP server "${serverName}" removed from active map for user ${userId}.`);

    if (triggerDbRemove) {
      try {
        await this.db.mcpConfig.deleteMany({
            where: {
                userId: userId,
                name: serverName,
            },
        });
        console.log(`MCP server config "${serverName}" removed from DB for user ${userId}.`);
      } catch (error) {
        console.error(`Error removing MCP config "${serverName}" for user ${userId} from DB:`, error);
        throw error; // Re-throw DB errors
      }
    }
  }

  /**
   * Lists all configured MCP servers for a specific user.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of MCPConfig objects.
   */
  async listServers(userId: number): Promise<MCPConfig[]> {
    // Load latest from DB to ensure consistency, then update memory map
    try {
        const dbConfigs = await this.db.mcpConfig.findMany({
            where: { userId },
            select: { name: true, configJson: true }
        });

        const currentConfigs: MCPConfig[] = [];
        const serversInMemory = this.activeServers.get(userId) ?? new Map();
        const namesFromDb = new Set<string>();

        for (const dbConfig of dbConfigs) {
            namesFromDb.add(dbConfig.name);
            try {
                const configData: MCPConfigWithOptionalName = JSON.parse(dbConfig.configJson);
                const fullConfig: MCPConfig = { ...configData, name: dbConfig.name };
                currentConfigs.push(fullConfig);

                // Update or add to memory map (client stays null or existing)
                const existingEntry = serversInMemory.get(dbConfig.name);
                serversInMemory.set(dbConfig.name, {
                    config: fullConfig,
                    client: existingEntry?.client ?? null
                });
            } catch (parseError) {
                console.error(`Error parsing MCP config JSON for "${dbConfig.name}" user ${userId} from DB during listServers:`, parseError);
            }
        }

        // Remove servers from memory that are no longer in the DB
        for (const nameInMemory of serversInMemory.keys()) {
            if (!namesFromDb.has(nameInMemory)) {
                const serverEntry = serversInMemory.get(nameInMemory);
                 if (serverEntry?.client && typeof serverEntry.client.close === 'function') {
                    await serverEntry.client.close().catch((e: any) => console.error(`Error closing removed client ${nameInMemory}:`, e)); // Added :any
                }
                serversInMemory.delete(nameInMemory);
                 console.log(`Removed stale server config "${nameInMemory}" from memory for user ${userId}.`);
            }
        }

         // Update the main activeServers map
        if (serversInMemory.size > 0 || this.activeServers.has(userId)) {
            this.activeServers.set(userId, serversInMemory);
        }


        return currentConfigs;
    } catch (error) {
        console.error(`Error listing MCP configs for user ${userId} from DB:`, error);
        // Fallback to in-memory list if DB fails? Or just return empty?
        // For now, return empty on DB error to avoid potentially stale data.
        return [];
    }
  }

  /**
   * Ensures an MCP client is connected for a specific user and server configuration.
   * If the client is already connected, returns it. If not connected, attempts to connect.
   * If the configuration is not in memory, attempts to load it from the database first.
   * @param userId - The ID of the user.
   * @param serverName - The name of the server configuration.
   * @returns A promise that resolves to the connected Client instance or null if connection fails or config not found.
   */
  private async connectClientForUser(userId: number, serverName: string): Promise<Client | null> {
    if (!this.activeServers.has(userId)) {
      this.activeServers.set(userId, new Map());
    }
    const userClients = this.activeServers.get(userId)!;
    let serverEntry = userClients.get(serverName);

    // If config not in memory, try loading from DB.
    if (!serverEntry) {
      try {
        const dbEntry = await this.db.mcpConfig.findUnique({
            where: { userId_name: { userId, name: serverName } }, // Using composite key
            select: { name: true, configJson: true },
        });
        if (dbEntry) {
             try {
                const configData: MCPConfigWithOptionalName = JSON.parse(dbEntry.configJson);
                const config: MCPConfig = { ...configData, name: dbEntry.name };
                // Add loaded config to memory map.
                serverEntry = { config, client: null };
                userClients.set(config.name, serverEntry);
                 console.log(`Loaded config for server "${serverName}" user ${userId} from DB.`);
             } catch (parseError) {
                 console.error(`Error parsing MCP config JSON for "${dbEntry.name}" user ${userId} from DB:`, parseError); // Use dbEntry.name for logging
                 return null;
             }
        } else {
            console.warn(`Config for server "${serverName}" user ${userId} not found in DB either.`);
            return null; // Config truly not found
        }
      } catch (dbError) {
        console.error(`Error fetching server config "${serverName}" for user ${userId} from DB:`, dbError);
        return null; // DB error
      }
    }
    // Ensure serverEntry is re-assigned if loaded from DB
    if (!serverEntry) { // Should not happen if DB load was successful and set serverEntry
        console.warn(`Config for server "${serverName}" user ${userId} not found even after DB check.`);
        return null; // Explicitly return null if serverEntry is still not defined
    }

    if (serverEntry.client) { 
            console.log(`Client instance for "${serverName}" user ${userId} exists, ensuring connection or recreating.`);
            // Check if close method exists before calling
            if (typeof serverEntry.client.close === 'function') {
                try {
                    await serverEntry.client.close(); // Close potentially stale client
                    console.log(`Closed stale client for "${serverName}" user ${userId}.`);
                } catch (e: any) { 
                    console.error('Error closing stale client:', e);
                }
            }
            serverEntry.client = null; // Clear the disconnected/stale client instance
    }

    // If client is null (either never created or cleared above), create and connect
    const config = serverEntry.config;
    console.log(`Connecting new client for "${config.name}" for user ${userId}...`);
    try {
      const client = new Client(
        {
          name: `telegram-mcp-client-bot-user${userId}-${process.pid}`, // Unique client name
          version: '1.0.0', // Example version
        },
        {
          // Define client capabilities if needed
           capabilities: {
                // Example: Declare what your client supports
                // roots: { listChanged: true },
                // sampling: {},
           },
        },
      );

      // Create the appropriate transport based on the configuration type.
      let transport;
      if (config.type === 'stdio') {
        if (!config.command) throw new Error('Stdio config requires a command.');

        // Prepare environment variables: merge process.env with config.env, ensuring all values are strings.
        const baseEnv: Record<string, string> = {};
        for (const key in process.env) {
            if (typeof process.env[key] === 'string') {
                baseEnv[key] = process.env[key]!;
            }
        }
        const configEnv: Record<string, string> = {};
        if (config.env) {
            for (const key in config.env) {
                if (typeof config.env[key] === 'string') {
                    configEnv[key] = config.env[key]!;
                }
            }
        }

         const stdioParams: StdioServerParameters = {
             command: config.command,
             args: config.args || [],
             env: { ...baseEnv, ...configEnv },
             cwd: config.cwd, // Pass cwd if defined
         };
         transport = new StdioClientTransport(stdioParams);

      } else if (config.type === 'http') {
        if (!config.url) throw new Error('HTTP config requires a url.');
         try {
            transport = new StreamableHTTPClientTransport(new URL(config.url));
         } catch(urlError) {
             throw new Error(`Invalid URL for HTTP transport "${config.name}": ${config.url}`);
         }
      } else {
        // Ensure exhaustive check with `never`
        // const _exhaustiveCheck: never = config.type;
        throw new Error(`Unsupported MCP transport type: ${(config as any).type}`);
      }

      // Attempt to connect the client using the created transport.
      await client.connect(transport);
      console.log(`MCP client "${config.name}" initialized successfully for user ${userId}.`);
      this.setupClientListeners(userId, client, config.name); // Use config.name here
      serverEntry.client = client; // Store the connected client instance
      return client;
    } catch (error) {
      console.error(`Failed to connect client for "${config.name}" for user ${userId}:`, error);
      serverEntry.client = null; // Ensure client is null on failure.
      return null; // Return null on connection failure
    }
  }

  /**
   * Retrieves a list of tools available from all connected MCP servers for a specific user,
   * formatted as Gemini FunctionDeclarations.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of FunctionDeclaration objects.
   */
  async getTools(userId: number): Promise<FunctionDeclaration[]> {
    const userClientsMap = this.activeServers.get(userId);
    if (!userClientsMap || userClientsMap.size === 0) {
       // Attempt to load from DB if map is empty, maybe configs were added but not loaded yet
       await this.loadUserConfigsFromDb();
       const refreshedMap = this.activeServers.get(userId);
       if (!refreshedMap || refreshedMap.size === 0) {
           return []; // No servers configured for this user
       }
       // If loaded, continue with the refreshed map
       return this.getToolsFromMap(userId, refreshedMap);
    }

    return this.getToolsFromMap(userId, userClientsMap);
}

private async getToolsFromMap(userId: number, userClientsMap: UserClientsMap): Promise<FunctionDeclaration[]> {
    const allTools: FunctionDeclaration[] = [];
    for (const serverName of userClientsMap.keys()) {
        try {
            const client = await this.connectClientForUser(userId, serverName); // Ensure this is awaited
            if (!client) { // connectClientForUser returns null on failure
                console.warn(`Failed to connect to server "${serverName}" for user ${userId}. Skipping tools.`);
                continue;
            }

            // List tools from the MCP server.
            const mcpToolsResult = await client.listTools();
            const mcpTools = mcpToolsResult.tools;

            // Map MCP tools to Gemini FunctionDeclarations and add to the list.
            if (mcpTools && mcpTools.length > 0) {
                const geminiServerTools = mcpTools.map(tool =>
                    mapMcpToolToGeminiFunctionDeclaration(tool, serverName), // Pass serverName
                );
                allTools.push(...geminiServerTools);
            }
        } catch (error: any) {
            console.error(`Error getting tools from server "${serverName}" for user ${userId}:`, error.message);
            // Optionally add an "error tool" to the list to indicate failure
            // allTools.push({ name: `${serverName}_error`, description: `Failed to list tools: ${error.message}`, parameters: { type: Type.OBJECT, properties: {} } });
        }
    }
    return allTools;
  }


  /**
   * Calls a specific tool on the appropriate MCP server for a user.
   * Parses the Gemini tool call name to determine the target server and MCP tool name.
   * @param userId - The ID of the user making the call.
   * @param toolCall - The function call object received from Gemini (contains name and args).
   * @returns A promise that resolves to the result returned by the MCP tool.
   * @throws {Error} If the tool name format is invalid, the server is not connected, or the tool call fails.
   */
  async callTool(userId: number, toolCall: any): Promise<any> { // Consider defining a stricter type for toolCall if possible
    const geminiToolName = toolCall.name;

    // Extract MCP tool name and server name from the Gemini tool name (format: toolName_serverName).
    const parts = geminiToolName.split('_');
    if (parts.length < 2) {
      throw new Error(`Invalid tool call name format: ${geminiToolName}. Expected toolName_serverName.`);
    }
    const serverName = parts.pop()!; // Assume last part is server name
    const mcpToolName = parts.join('_'); // Rejoin potentially multiple parts for tool name

    // Ensure the client for the target server is connected.
    const client = await this.connectClientForUser(userId, serverName);
    if (!client) { // connectClientForUser returns null on failure
      throw new Error(`MCP server "${serverName}" is not connected or failed to connect for user ${userId}. Cannot call tool "${mcpToolName}".`);
    }

    // Execute the tool call on the connected client.
    console.log(`Routing tool call "${mcpToolName}" to server "${serverName}" for user ${userId}...`);
    try {
      // The MCP SDK's callTool expects name and arguments separately
      const result = await client.callTool({ name: mcpToolName, arguments: toolCall.args });
      return result;
    } catch (error: any) {
      console.error(`Error calling tool "${mcpToolName}" on server "${serverName}" for user ${userId}:`, error.message);
      // Re-throw the error to be handled by the calling message handler
      throw new Error(`Failed to execute tool "${mcpToolName}" on server "${serverName}": ${error.message}`);
    }
  }

  /**
   * Closes all active MCP client connections gracefully.
   */
  async closeAll(): Promise<void> {
    console.log("Closing all active MCP clients...");
    const closePromises: Promise<void>[] = [];
    for (const [userId, userClients] of this.activeServers.entries()) {
      console.log(`Closing clients for user ${userId}...`);
      for (const [serverName, serverEntry] of userClients.entries()) {
        if (serverEntry.client && typeof serverEntry.client.close === 'function') {
          console.log(`Closing client for server "${serverName}"`);
          closePromises.push(
            serverEntry.client.close().catch(error => {
              console.error(`Error closing client for server "${serverName}" user ${userId}:`, error);
            }),
          );
        }
         // Clear client instance immediately after initiating close
        if(serverEntry.client) serverEntry.client = null;
      }
    }
    await Promise.all(closePromises);
     this.activeServers.clear(); // Clear the main map after all attempts
    console.log('All active MCP clients processed for shutdown.');
  }

  /**
   * Sets up standard event listeners for an MCP client instance.
   * Handles notifications, errors, and close events.
   * @param userId - The ID of the user associated with this client.
   * @param client - The MCP Client instance.
   * @param serverNameForLog - The name of the server for logging purposes.
   */
  private setupClientListeners(userId: number, client: Client, serverNameForLog: string): void {
    // FIX: Use imported schemas for handlers
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      console.log(`Tools list changed notification from "${serverNameForLog}" for user ${userId}.`);
        // TODO: Invalidate tool cache
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      // Placeholder for handling resource list changes if needed in the future.
      console.log(`Resources list changed notification from "${serverNameForLog}" for user ${userId}.`);
         // TODO: Invalidate resource cache
    });

    // FIX: Use imported schema and type for handler
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification: LoggingMessageNotification) => {
      // Type assertion might be needed if the SDK doesn't infer perfectly
      // const params = notification.params as { level: string; data: any };
      console.log(
        `[MCP Log - ${serverNameForLog} - User ${userId} - ${notification.params.level}] ${JSON.stringify(notification.params.data)}`,
      );
    });

    // Error handler for the client connection.
    client.onerror = (error) => { // Removed the duplicate, incomplete assignment. 'error' will be contextually typed.
      console.error(`MCP client "${serverNameForLog}" for user ${userId} encountered an error:`, error);
      const userClients = this.activeServers.get(userId);
      if (userClients?.has(serverNameForLog)) {
        const serverEntry = userClients.get(serverNameForLog);
        if(serverEntry) serverEntry.client = null;
      }
    };

    // Handler for when the client connection closes.
    client.onclose = () => {
      console.log(`MCP client "${serverNameForLog}" for user ${userId} connection closed.`);
      const userClients = this.activeServers.get(userId);
      if (userClients?.has(serverNameForLog)) {
        const serverEntry = userClients.get(serverNameForLog);
        if (serverEntry && serverEntry.client === client) {
            serverEntry.client = null;
        }
      }
    };
  }
}
