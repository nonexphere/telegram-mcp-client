import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PrismaClient } from '@prisma/client';
import { MCPConfig, MCPConfigWithOptionalName } from './types.js';
import { FunctionDeclaration } from '@google/genai'; 
import { mapMcpToolToGeminiFunctionDeclaration } from '../gemini/mapping.js';

type UserClientsMap = Map<string, { config: MCPConfig; client: Client | null }>; // client can be null

export class McpClientManager {
  private activeServers: Map<number, UserClientsMap> = new Map();
  private db: PrismaClient; 

  constructor(db: PrismaClient) {
    this.db = db;
    this.loadUserConfigsFromDb().catch(err => {
        console.error("Failed to load MCP user configs on startup:", err);
    });
  }

  private async loadUserConfigsFromDb(): Promise<void> {
    try {
      const configsFromDb = await this.db.mcpConfig.findMany({
        select: { userId: true, name: true, configJson: true }
      });
      for (const row of configsFromDb) { // Changed variable name here
        const userId = row.userId; // Corrected: use row.userId
        const name = row.name; 
        const configData: MCPConfigWithOptionalName = row.configJson as MCPConfigWithOptionalName;
        const config: MCPConfig = { ...configData, name };

        if (!this.activeServers.has(userId)) {
          this.activeServers.set(userId, new Map());
        }
        this.activeServers.get(userId)!.set(config.name, { config, client: null });
      }
      console.log(`Loaded configurations for ${this.activeServers.size} users.`);
    } catch (error) {
      console.error('Error loading MCP configurations from DB:', error);
    }
  }

  async addServer(userId: number, config: MCPConfig): Promise<void> {
    if (!config.name || !config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
      throw new Error('Invalid MCP configuration format.');
    }

    if (!this.activeServers.has(userId)) {
      this.activeServers.set(userId, new Map());
    }
    const userClients = this.activeServers.get(userId)!;

    if (userClients.has(config.name)) {
      console.log(`Updating MCP server "${config.name}" for user ${userId}. Disconnecting old client if active.`);
      await this.removeServer(userId, config.name, false);
    }

    userClients.set(config.name, { config, client: null });

    // Prepare data for Prisma: separate 'name' and store the rest in 'configJson'
    const { name, ...configDataToStore } = config;
    try {
      await this.db.mcpConfig.create({
        data: {
          userId,
          name, // Save the name separately
          configJson: configDataToStore, // Store the rest of the config as JSON
        },
      });
      console.log(`MCP server config "${config.name}" added for user ${userId} in DB.`);
    } catch (error) {
      console.error(`Error saving MCP config "${config.name}" for user ${userId} to DB:`, error);
      userClients.delete(config.name);
      throw error;
    }
  }

  async removeServer(userId: number, serverName: string, triggerDbRemove = true): Promise<void> {
    const userClients = this.activeServers.get(userId);
    if (!userClients || !userClients.has(serverName)) {
      console.warn(`MCP server "${serverName}" not found for user ${userId}. Skipping removal.`);
      return;
    }

    const serverEntry = userClients.get(serverName)!;

    if (serverEntry.client && typeof serverEntry.client.close === 'function') {
      console.log(`Disconnecting client for "${serverName}" for user ${userId}.`);
      try {
        await serverEntry.client.close();
        console.log(`Client for "${serverName}" disconnected.`);
      } catch (error) {
        console.error(`Error disconnecting client for "${serverName}" for user ${userId}:`, error);
      }
    }

    userClients.delete(serverName);
    console.log(`MCP server "${serverName}" removed from active map for user ${userId}.`);

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

  async listServers(userId: number): Promise<MCPConfig[]> {
    const userClients = this.activeServers.get(userId);
    if (!userClients) {
      return [];
    }
    return Array.from(userClients.values()).map(entry => entry.config);
  }

  private async connectClientForUser(userId: number, serverName: string): Promise<Client | null> {
    const userClients = this.activeServers.get(userId);
    const serverEntry = userClients?.get(serverName);

    if (!serverEntry) {
      try {
        const dbEntry = await this.db.mcpConfig.findUnique({
            where: { userId_name: { userId, name: serverName } }, // Using composite key
            select: { name: true, configJson: true },
        });
        if (dbEntry) {
            const configData: MCPConfigWithOptionalName = dbEntry.configJson as MCPConfigWithOptionalName;
            const config: MCPConfig = { ...configData, name: dbEntry.name };

            if (!this.activeServers.has(userId)) {
                this.activeServers.set(userId, new Map());
            }
            this.activeServers.get(userId)!.set(config.name, { config, client: null });
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

    if (serverEntry.client && serverEntry.client.isConnected()) {
      return serverEntry.client;
    }

    if (serverEntry.client && !serverEntry.client.isConnected()) {
        console.log(`Client for "${serverName}" for user ${userId} found but not connected. Disposing old client.`);
        if (serverEntry.client.close) {
             try { await serverEntry.client.close(); } catch (e) { console.error('Error closing old client:', e); }
        }
        serverEntry.client = null;
    }

    const config = serverEntry.config;
    console.log(`Connecting client for "${config.name}" for user ${userId}...`);
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

      let transport;
      if (config.type === 'stdio') {
        if (!config.command) throw new Error('Stdio config requires a command.');
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: { ...process.env, ...config.env }, 
        });
      } else if (config.type === 'http') {
        if (!config.url) throw new Error('HTTP config requires a url.');
        transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else {
        throw new Error(`Unsupported MCP transport type: ${config.type}`);
      }

      await client.connect(transport);
      console.log(`MCP client "${config.name}" initialized successfully for user ${userId}.`);
      this.setupClientListeners(userId, client, serverName);
      serverEntry.client = client;
      return client;
    } catch (error) {
      console.error(`Failed to connect client for "${config.name}" for user ${userId}:`, error);
      serverEntry.client = null; 
      return null;
    }
  }

  async getTools(userId: number): Promise<FunctionDeclaration[]> {
    const userClientsMap = this.activeServers.get(userId);
    if (!userClientsMap) {
      return [];
    }

    const allTools: FunctionDeclaration[] = [];
    for (const serverName of userClientsMap.keys()) {
      try {
        const client = await this.connectClientForUser(userId, serverName);
        if (!client || !client.isConnected()) {
            console.warn(`Client for server "${serverName}" user ${userId} is not connected. Skipping tools.`);
            continue;
        }

        const mcpToolsResult = await client.listTools();
        const mcpTools = mcpToolsResult.tools;

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

  async callTool(userId: number, toolCall: any): Promise<any> { 
    const geminiToolName = toolCall.name;

    const parts = geminiToolName.split('_');
    if (parts.length < 2) {
      throw new Error(`Invalid tool call name format: ${geminiToolName}. Expected toolName_serverName.`);
    }
    const serverName = parts.pop()!;
    const mcpToolName = parts.join('_');

    const client = await this.connectClientForUser(userId, serverName);
    if (!client || !client.isConnected()) {
      throw new Error(`MCP server "${serverName}" is not connected for user ${userId}. Cannot call tool "${geminiToolName}".`);
    }

    console.log(`Routing tool call "${mcpToolName}" to server "${serverName}" for user ${userId}...`);
    try {
      const result = await client.callTool({ name: mcpToolName, arguments: toolCall.args });
      return result;
    } catch (error: any) {
      console.error(`Error calling tool "${mcpToolName}" on server "${serverName}" for user ${userId}:`, error.message);
      throw error;
    }
  }

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

  private setupClientListeners(userId: number, client: Client, serverNameForLog: string): void {
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      console.log(`Tools list changed notification from "${serverNameForLog}" for user ${userId}.`);
    });

    client.setNotificationHandler('notifications/resources/list_changed', async () => {
      console.log(`Resources list changed notification from "${serverNameForLog}" for user ${userId}.`);
    });

    client.setNotificationHandler('notifications/message', (notification) => {
      console.log(
        `[MCP Log - ${serverNameForLog} - User ${userId} - ${notification.params.level}] ${JSON.stringify(notification.params.data)}`,
      );
    });

    client.onerror = (error) => {
      console.error(`MCP client "${serverNameForLog}" for user ${userId} encountered an error:`, error);
      const userClients = this.activeServers.get(userId);
      if (userClients && userClients.has(serverNameForLog)) {
        userClients.get(serverNameForLog)!.client = null;
      }
    };

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
