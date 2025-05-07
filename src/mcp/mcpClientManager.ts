/**
 * @file Manages connections and interactions with multiple Model Context Protocol (MCP) servers
 * for different users. Handles client lifecycle, tool discovery, and routing tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PrismaClient } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { FunctionDeclaration } from '@google/genai'; 
import { mapMcpToolToGeminiFunctionDeclaration } from '../gemini/mapping.js';

type UserClientsMap = Map<string, { config: MCPConfig; client: Client | null }>; // client can be null

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
      // Select necessary fields: userId, name (unique identifier per user), and configJson.
      const configsFromDb = await this.db.mcpConfig.findMany({
        select: { userId: true, name: true, configJson: true }
      });
      for (const row of configsFromDb) { // Changed variable name here
        const userId = row.userId; // Corrected: use row.userId
        const name = row.name; 
        const configData: MCPConfigWithOptionalName = JSON.parse(row.configJson as string) as MCPConfigWithOptionalName;        // Reconstruct the full MCPConfig object including the name.
        const config: MCPConfig = { ...configData, name };

        // Initialize the map for the user if it doesn't exist.
        if (!this.activeServers.has(userId)) {
          this.activeServers.set(userId, new Map());
        }
        // Store the configuration in the active servers map. Client is initially null.
        this.activeServers.get(userId)!.set(config.name, { config, client: null });
      }
      console.log(`Loaded configurations for ${this.activeServers.size} users.`);
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
    // Basic validation of the configuration object.
    if (!config.name || !config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
      throw new Error('Invalid MCP configuration format.');
    }

    // Ensure the user has an entry in the activeServers map.
    if (!this.activeServers.has(userId)) {
      this.activeServers.set(userId, new Map());
    }
    const userClients = this.activeServers.get(userId)!;

    // If updating an existing server, remove the old one first (disconnects client).
    if (userClients.has(config.name)) {
      console.log(`Updating MCP server "${config.name}" for user ${userId}. Disconnecting old client if active.`);
      // Call removeServer without triggering DB removal, as we'll upsert later.
      await this.removeServer(userId, config.name, false);
    }

    userClients.set(config.name, { config, client: null });

    // Prepare data for Prisma: separate 'name' and store the rest in 'configJson'
    const { name, ...configDataToStore } = config;
    try {
      // Use upsert to handle both adding new and updating existing configurations atomically.
      // The where clause uses the unique composite key { userId, name }.
      await this.db.mcpConfig.create({
        data: {
          userId,
          name, // Save the name separately
          configJson: JSON.stringify(configDataToStore), // Store the rest of the config as JSON
        },
      });
      console.log(`MCP server config "${config.name}" added for user ${userId} in DB.`);
    } catch (error) {
      console.error(`Error saving MCP config "${config.name}" for user ${userId} to DB:`, error);
      // If DB save fails, remove the entry we optimistically added to the map.
      userClients.delete(config.name);
      throw error;
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
    // Check if the server exists in the active map for this user.
    if (!userClients || !userClients.has(serverName)) {
      console.warn(`MCP server "${serverName}" not found for user ${userId}. Skipping removal.`);
      return;
    }

    const serverEntry = userClients.get(serverName)!;

    // If a client instance exists and has a close method, attempt to close it.
    if (serverEntry.client && typeof serverEntry.client.close === 'function') {
      console.log(`Disconnecting client for "${serverName}" for user ${userId}.`);
      try {
        await serverEntry.client.close();
        console.log(`Client for "${serverName}" disconnected.`);
      } catch (error) {
        console.error(`Error disconnecting client for "${serverName}" for user ${userId}:`, error);
      }
    }

    // Remove the server entry from the active map.
    userClients.delete(serverName);
    console.log(`MCP server "${serverName}" removed from active map for user ${userId}.`);

    // If requested, remove the configuration from the database.
    if (triggerDbRemove) {
      try {
        // Delete by unique constraint userId_name
        await this.db.mcpConfig.deleteMany({
            where: {
                userId: userId,
                name: serverName,
            },
        });
        console.log(`MCP server config "${serverName}" removed from DB for user ${userId}.`);
      } catch (error) {
        console.error(`Error removing MCP config "${serverName}" for user ${userId} from DB:`, error);
        throw error;
      }
    }
  }

  /**
   * Lists all configured MCP servers for a specific user.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of MCPConfig objects.
   */
  async listServers(userId: number): Promise<MCPConfig[]> {
    const userClients = this.activeServers.get(userId);
    if (!userClients) {
      return [];
    }
    return Array.from(userClients.values()).map(entry => entry.config);
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
    const userClients = this.activeServers.get(userId);
    const serverEntry = userClients?.get(serverName);

    if (!serverEntry) {
      // If config not in memory, try loading from DB.
      try {
        const dbEntry = await this.db.mcpConfig.findUnique({
            where: { userId_name: { userId, name: serverName } }, // Using composite key
            select: { name: true, configJson: true },
        });
        if (dbEntry) {
            const configData: MCPConfigWithOptionalName = JSON.parse(dbEntry.configJson as string) as MCPConfigWithOptionalName;
            const config: MCPConfig = { ...configData, name: dbEntry.name };

            // Add loaded config to memory map.
            if (!this.activeServers.has(userId)) {
                this.activeServers.set(userId, new Map());
            }
            this.activeServers.get(userId)!.set(config.name, { config, client: null });
            // Retry connection now that config is in memory.
            return this.connectClientForUser(userId, serverName); 
        } else {
            console.warn(`Config for server "${serverName}" user ${userId} not found in DB either.`);
            return null;
        }
      } catch (dbError) {
        console.error(`Error fetching server config "${serverName}" for user ${userId} from DB:`, dbError);
        return null;
      }
    }

    // If client exists and is connected, return it.
    if (serverEntry.client) { // Removed isConnected() check, rely on client object presence
      return serverEntry.client;
    }

    // If client exists but is not connected, dispose of the old instance.
    if (serverEntry.client) { // If client exists here, it means it wasn't returned above.
        console.log(`Client for "${serverName}" for user ${userId} found but needs re-establishment or was not valid. Disposing old client.`);
        if (serverEntry.client.close) {
             try { await serverEntry.client.close(); } catch (e) { console.error('Error closing old client:', e); }
        }
        serverEntry.client = null;
    }

    const config = serverEntry.config;
    console.log(`Connecting client for "${config.name}" for user ${userId}...`);
    // Create a new Client instance.
    try {
      const client = new Client(
        {
          name: `telegram-mcp-client-bot-user${userId}-${process.pid}`,
          version: '1.0.0',
        },
        {
          capabilities: {
             roots: { listChanged: true },
             sampling: {},
          },
        },
      );

      // Create the appropriate transport based on the configuration type.
      let transport;
      if (config.type === 'stdio') {
        if (!config.command) throw new Error('Stdio config requires a command.');        
        const envVars: Record<string, string> = {};
        const combinedEnv = { ...process.env, ...config.env }; // process.env first, then config.env to allow override
        for (const key in combinedEnv) {
            if (combinedEnv[key] !== undefined) {
                envVars[key] = combinedEnv[key] as string; // Ensure it's a string
            }
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: envVars, 
        });
      } else if (config.type === 'http') {
        if (!config.url) throw new Error('HTTP config requires a url.');
        transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else {
        throw new Error(`Unsupported MCP transport type: ${config.type}`);
      }

      // Attempt to connect the client using the created transport.
      await client.connect(transport);
      console.log(`MCP client "${config.name}" initialized successfully for user ${userId}.`);
      // Setup listeners for notifications, errors, and close events.
      this.setupClientListeners(userId, client, serverName);
      // Store the connected client instance.
      serverEntry.client = client;
      return client;
    } catch (error) {
      console.error(`Failed to connect client for "${config.name}" for user ${userId}:`, error);
      // Ensure client is null on failure.
      serverEntry.client = null; 
      return null;
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
    if (!userClientsMap) {
      return [];
    }

    const allTools: FunctionDeclaration[] = [];
    // Iterate through each configured server for the user.
    for (const serverName of userClientsMap.keys()) {
      try {
        // Ensure the client is connected before attempting to list tools.
        const client = await this.connectClientForUser(userId, serverName);
        if (!client) { // Removed isConnected() check
            console.warn(`Client for server "${serverName}" user ${userId} is not connected. Skipping tools.`);
            continue;
        }

        // List tools from the MCP server.
        const mcpToolsResult = await client.listTools();
        const mcpTools = mcpToolsResult.tools;

        // Map MCP tools to Gemini FunctionDeclarations and add to the list.
        if (mcpTools && mcpTools.length > 0) {
          const geminiServerTools = mcpTools.map(tool =>
            mapMcpToolToGeminiFunctionDeclaration(tool, serverName),
          );
          allTools.push(...geminiServerTools);
        }
      } catch (error: any) {
        console.error(`Error getting tools from server "${serverName}" for user ${userId}:`, error.message);
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
  async callTool(userId: number, toolCall: any): Promise<any> { 
    const geminiToolName = toolCall.name;

    // Extract MCP tool name and server name from the Gemini tool name (format: toolName_serverName).
    const parts = geminiToolName.split('_');
    if (parts.length < 2) {
      throw new Error(`Invalid tool call name format: ${geminiToolName}. Expected toolName_serverName.`);
    }
    const serverName = parts.pop()!;
    const mcpToolName = parts.join('_');

    // Ensure the client for the target server is connected.
    const client = await this.connectClientForUser(userId, serverName);
    if (!client) { // Removed isConnected() check
      throw new Error(`MCP server "${serverName}" is not connected for user ${userId}. Cannot call tool "${geminiToolName}".`);
    }

    // Execute the tool call on the connected client.
    console.log(`Routing tool call "${mcpToolName}" to server "${serverName}" for user ${userId}...`);
    try {
      const result = await client.callTool({ name: mcpToolName, arguments: toolCall.args });
      return result;
    } catch (error: any) {
      console.error(`Error calling tool "${mcpToolName}" on server "${serverName}" for user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Closes all active MCP client connections gracefully.
   */
  async closeAll(): Promise<void> {
    console.log("Closing all active MCP clients...");
    const closePromises: Promise<void>[] = [];
    for (const [, userClients] of this.activeServers.entries()) {
      for (const [, serverEntry] of userClients.entries()) {
        if (serverEntry.client && typeof serverEntry.client.close === 'function') {
          closePromises.push(
            serverEntry.client.close().catch(error => {
              console.error(`Error closing client for server "${serverEntry.config.name}":`, error);
            }),
          );
          serverEntry.client = null;
        }
      }
    }
    await Promise.all(closePromises);
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
    // Listener for tool list changes from the server.
    client.setNotificationHandler({ method: 'notifications/tools/list_changed' }, async () => {
      console.log(`Tools list changed notification from "${serverNameForLog}" for user ${userId}.`);
      // TODO: Implement logic to invalidate tool cache or notify GeminiClient
      // This might involve clearing a cached list of tools for this user/server
      // or emitting an event that relevant parts of the application can listen to.
    });

    client.setNotificationHandler({ method: 'notifications/resources/list_changed' }, async () => {
      // Placeholder for handling resource list changes if needed in the future.
      console.log(`Resources list changed notification from "${serverNameForLog}" for user ${userId}.`);
    });

    client.setNotificationHandler({ method: 'notifications/message' }, (notification: any) => { // Use any or the correct SDK type
      console.log(
        `[MCP Log - ${serverNameForLog} - User ${userId} - ${notification.params?.level}] ${JSON.stringify(notification.params?.data)}`,
      );
    });

    // Error handler for the client connection.
    client.onerror = (error: Error) => {
      console.error(`MCP client "${serverNameForLog}" for user ${userId} encountered an error:`, error);
      const userClients = this.activeServers.get(userId);
      if (userClients && userClients.has(serverNameForLog)) {
        userClients.get(serverNameForLog)!.client = null;
      }
    };

    // Handler for when the client connection closes.
    client.onclose = () => {
      console.log(`MCP client "${serverNameForLog}" for user ${userId} connection closed.`);
      const userClients = this.activeServers.get(userId);
      if (userClients && userClients.has(serverNameForLog)) {
        const serverEntry = userClients.get(serverNameForLog);
        if (serverEntry && serverEntry.client === client) { 
            serverEntry.client = null;
        }
      }
    };
  }
}
