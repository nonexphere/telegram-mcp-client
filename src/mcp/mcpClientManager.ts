import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as SdkTypes from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { MCPConfig } from './types.js';
import { FunctionDeclaration } from '@google/genai';
import { mapMcpToolToGeminiFunctionDeclaration } from '../gemini/mapping.js';
import { UserConfiguration } from '../context/types.js'; // Import user config type

// Use a nested map to store clients per user
// Use SdkMcpConfig type
type SdkMcpConfig = SdkTypes.McpConfig;

// Use a nested map to store clients per user
type UserClientsMap = Map<string, { config: MCPConfig; client: Client | null }>; // client can be null

export class McpClientManager {
  // Map<chatId, Map<serverName, { config, client }>>
  private activeServers: Map<number, UserClientsMap> = new Map();
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    // We don't pre-load clients on startup with this model.
    // Clients are initialized on demand when a user interacts or opens the Mini App.
    // However, we should load user configurations from the DB here.
    this.loadUserConfigs(); // Load configs on startup, but don't connect clients yet
  }

  // Load user configurations from the DB on startup
  private loadUserConfigs(): void {
     const configs = this.db.prepare('SELECT user_id, config_json FROM mcp_configs').all();
     for (const row of configs) {
         const userId = row.user_id;
         const config: MCPConfig = JSON.parse(row.config_json);

         if (!this.activeServers.has(userId)) {
             this.activeServers.set(userId, new Map());
         }
         // Store the config, client will be initialized on demand and set to null initially
         this.activeServers.get(userId)!.set(config.name, { config, client: null }); // Store null for client initially
     }
      console.log(`Loaded configurations for ${this.activeServers.size} users.`);
  }


  // Add/Update server configuration for a specific user
  async addServer(userId: number, config: MCPConfig): Promise<void> {
    // Validate config (basic validation)
    if (!config.name || !config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
         throw new Error('Invalid MCP configuration format.');
    }

    // Check if user exists in our active map, if not, initialize their entry
    if (!this.activeServers.has(userId)) {
        this.activeServers.set(userId, new Map());
    }

    const userClients = this.activeServers.get(userId)!;

    // If server with this name already exists for this user, remove it first
    if (userClients.has(config.name)) {
        console.log(`Updating MCP server "${config.name}" for user ${userId}. Disconnecting old client if active.`);
        await this.removeServer(userId, config.name, false); // Remove without triggering DB save yet
    }

    // Store the new config
    userClients.set(config.name, { config, client: null }); // Store null for client initially

    // Save config to DB
    // Use a transaction for atomicity if updating/inserting multiple configs
    this.db.prepare('INSERT INTO mcp_configs (user_id, config_json) VALUES (?, ?)').run(userId, JSON.stringify(config));
    console.log(`MCP server config "${config.name}" added/updated for user ${userId} in DB.`);

    // Client will be connected on demand later (e.g., on first getTools or callTool)
    // Optionally, connect immediately:
    // try {
    //     await this.connectClientForUser(userId, config.name, config);
    //     console.log(`Client for "${config.name}" connected immediately for user ${userId}.`);
    // } catch (error) {
    //     console.error(`Failed to connect client for "${config.name}" immediately for user ${userId}:`, error);
    //     // This is ok, it will be attempted again on demand
    // }
  }

  // Remove server configuration for a specific user
  async removeServer(userId: number, serverName: string, triggerDbRemove = true): Promise<void> {
    const userClients = this.activeServers.get(userId);
    if (!userClients || !userClients.has(serverName)) {
      console.warn(`MCP server "${serverName}" not found for user ${userId}. Skipping removal.`);
      return;
    }

    const serverEntry = userClients.get(serverName)!;

    // Disconnect client if active
    if (serverEntry.client && serverEntry.client.close) {
        console.log(`Disconnecting client for "${serverName}" for user ${userId}.`);
        try {
            await serverEntry.client.close();
            console.log(`Client for "${serverName}" disconnected.`);
        } catch (error) {
            console.error(`Error disconnecting client for "${serverName}" for user ${userId}:`, error);
            // Continue removal
        }
    }

    // Remove from active map
    userClients.delete(serverName);
    console.log(`MCP server "${serverName}" removed from active map for user ${userId}.`);

    // Remove from DB
    if (triggerDbRemove) {
       this.db.prepare('DELETE FROM mcp_configs WHERE user_id = ? AND json_extract(config_json, \'$.name\') = ?').run(userId, serverName);
       console.log(`MCP server config "${serverName}" removed from DB for user ${userId}.`);
    }
  }

  // List server configurations for a specific user
  async listServers(userId: number): Promise<MCPConfig[]> {
    const userClients = this.activeServers.get(userId);
    if (!userClients) {
      return [];
    }
    return Array.from(userClients.values()).map(entry => entry.config);
  }

  // Get tools from a specific user's configured servers
  async getTools(userId: number): Promise<FunctionDeclaration[]> {
    const userClients = this.activeServers.get(userId);
    if (!userClients) {
      return [];
    }

    const allTools: FunctionDeclaration[] = [];
    for (const [serverName, serverEntry] of userClients.entries()) {
      try {
        // Connect client if not already connected
        await this.connectClientForUser(userId, serverName, serverEntry.config);

        // Get tools from the client instance
         // The listTools() method is async, listToolsSync() is not standard
         // Let's use the async method and refactor this to await it
         // The MCP SDK README shows `client.listTools()`
         const mcpToolsResult = await serverEntry.client!.listTools(); 
         const mcpTools = mcpToolsResult.tools;

         if (!mcpTools || mcpTools.length === 0) continue;

        // Map MCP Tool objects to Gemini FunctionDeclaration format
        const geminiServerTools = mcpTools.map(tool => mapMcpToolToGeminiFunctionDeclaration(tool, serverName));
        allTools.push(...geminiServerTools);

      } catch (error: any) {
        console.error(`Error getting tools from server "${serverName}" for user ${userId}:`, error);
        // Optionally mark the server as errored or temporarily disable it for this user
        // For now, just skip tools from this server
      }
    }
    return allTools;
  }

  // Call a tool for a specific user, routing to the correct client instance
  async callTool(chatId: number, toolCall: any): Promise<any> { // toolCall format from Gemini, maybe refine type
    const geminiToolName = toolCall.name;

    // Assuming mapped tool name format is toolName_serverName
    const parts = geminiToolName.split('_');
    if (parts.length < 2) {
        throw new Error(`Invalid tool call name format: ${geminiToolName}. Expected toolName_serverName.`);
    }
    const serverName = parts.pop(); // Last part is server name
    const toolName = parts.join('_'); // Remaining parts are original tool name

    const userClients = this.activeServers.get(chatId); // Use chatId here to find the correct user's clients
    if (!userClients || !userClients.has(serverName || '')) {
        throw new Error(`MCP server "${serverName}" not found for chat ${chatId} for tool call "${geminiToolName}". Check your configured servers.`);
    }

    const serverEntry = userClients.get(serverName!)!; // Non-null assertion after checks

     // Connect client if not already connected
    await this.connectClientForUser(chatId, serverName!, serverEntry.config); // Pass chat ID

    console.log(`Routing tool call "${toolName}" to server "${serverName}" for chat ${chatId}...`);

    try {
      // Call the tool on the specific client instance
      const result = await serverEntry.client!.callTool({ name: toolName, arguments: toolCall.args }); // Non-null assertion after connect
      return result; // Return MCP tool result
    } catch (error) {
      console.error(`Error calling tool "${toolName}" on server "${serverName}" for chat ${chatId}:`, error);
      // Decide how to handle tool call errors before returning to message handler
      throw error;
    }
  }

   // Connects a client for a specific user and server if not already connected
   private async connectClientForUser(userId: number, serverName: string, config: MCPConfig): Promise<Client> {
       const userClients = this.activeServers.get(userId);
       if (!userClients) {
           // This should not happen if loadUserConfigs ran, but add defensive check
           throw new Error(`No servers found for user ${userId}.`);
       }
       const serverEntry = userClients.get(serverName);
       if (!serverEntry) {
            // This should not happen if loadUserConfigs or addServer ran
            throw new Error(`Server "${serverName}" config not found for user ${userId}.`);
       }

       // If client is already connected, return it
       // Check if the client object exists and is connected
       if (serverEntry.client && serverEntry.client.isConnected()) { // Assuming isConnected method exists in SDK Client
           return serverEntry.client;
       }

       // If client exists but is not connected, attempt reconnect or create new
       // Check if client object exists but is not connected (connection dropped)
       if (serverEntry.client && !serverEntry.client.isConnected()) {
           console.log(`Client for "${serverName}" for user ${userId} found but not connected. Disposing old client.`);
           // Dispose old client if needed
           if (serverEntry.client.close) {
                try { await serverEntry.client.close(); } catch (e) { console.error('Error closing old client:', e); }
           }
           serverEntry.client = null; // Clear the old client instance
       }

        console.log(`Connecting client for "${serverName}" for user ${userId}...`);
       try {
           const client = new Client({
               name: `feathers-studio-bot-client-user${userId}-${process.pid}`, // Unique name per user/process
               version: '1.0.0',
           }, {
               // ClientCapabilities type is inferred by TypeScript from the Client constructor options
               capabilities: {
                   roots: {
                        listChanged: true
                   }, // Assuming roots support is desired
                   sampling: {}, // Assuming sampling support is desired
               }
           });

           let transport;
           if (config.type === 'stdio') {
               if (!config.command) throw new Error('Stdio config requires a command.');
               transport = new StdioClientTransport({
                   command: config.command,
                   args: config.args || [],
                   env: config.env || process.env, // Merge provided env with process env
               });
               console.log(`Created StdioClientTransport for "${config.command}"`);
           } else if (config.type === 'http') {
                if (!config.url) throw new Error('HTTP config requires a url.');
                // Instantiate StreamableHTTPClientTransport
                transport = new StreamableHTTPClientTransport(new URL(config.url));
                console.log(`Created StreamableHTTPClientTransport for ${config.url}`);
           } else {
               throw new Error(`Unsupported MCP transport type: ${config.type}`);
           }
           // Connect the client using the transport
           await client.connect(transport); // The connect method establishes the connection
           console.log(`Client connected to transport for "${config.name}" for user ${userId}.`);

           // Wait for initialization (already happens inside client.connect)
           // await client.initialize(); // This is called by client.connect internally

           console.log(`MCP client "${config.name}" initialized successfully for user ${userId}.`);

           // Setup listeners for notifications (e.g., tool list changes) for this client
           this.setupClientListeners(userId, client); // Pass user ID to listeners

           // Store the connected client instance
           serverEntry.client = client;

           return client;

       } catch (error) {
            console.error(`Failed to connect client for "${config.name}" for user ${userId}:`, error);
            // Optionally mark the server as errored for this user in the activeServers map
             // For now, leave client as null, it will be attempted again next time
             serverEntry.client = null; // Ensure client is null on connection failure
            throw error;
       }
   }


  // Close all active clients for all users
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [userId, userClients] of this.activeServers.entries()) {
        for (const [serverName, serverEntry] of userClients.entries()) {
            // Check if client is not null and has a close method
            if (serverEntry.client && serverEntry.client.close) {
                console.log(`Closing client for server "${serverName}" for user ${userId}...`);
                closePromises.push(serverEntry.client.close().catch(error => {
                    console.error(`Error closing client for server "${serverName}" for user ${userId}:`, error);
                    // Continue closing others
                }));
                 serverEntry.client = null; // Mark as null immediately after attempting close
            }
        }
        // userClients.clear(); // Don't clear, just nullify clients
    }
    // this.activeServers.clear(); // Don't clear, just nullify clients
    await Promise.all(closePromises);
    console.log('All active MCP clients disconnected.');
  }

  private setupClientListeners(userId: number, client: Client): void {
    // TODO: Implement listeners for client notifications, scoped by user ID
    // The listeners should update the state for the specific user's clients

     const serverName = client.serverInfo?.name || 'unknown_server'; // Get server name from initialized client
     // setNotificationHandler needs the method name string and the handler function
     client.setNotificationHandler('notifications/tools/list_changed', async (notification) => {
         console.log(`Tools list changed notification from "${serverName}" for user ${userId}.`);
         // Logic to handle tool list changes for this specific user and server
         // This might involve re-fetching tools for this user and server
         // and potentially notifying the user via Telegram or Mini App UI
         // The `getTools` method re-fetches live, so the main impact is just logging for now.
     });
      client.setNotificationHandler('notifications/resources/list_changed', async (notification) => {
         console.log(`Resources list changed notification from "${serverName}" for user ${userId}.`);
         // Logic to handle resource list changes for this specific user and server
     });
      // Logging message notification
      client.setNotificationHandler('notifications/message', (notification) => {
          // notification.params will have level and data
          console.log(`[${serverName} - User ${userId} - ${notification.params.level}] ${notification.params.data}`);
          // Optionally forward logs to user or a logging service
      });

     // Add error and close listeners (These are properties on the Client instance, not setNotificationHandler)
     client.onerror = (error) => {
         console.error(`MCP client "${serverName}" for user ${userId} encountered an error:`, error);
         // Decide how to handle client errors - maybe mark as disconnected/errored for this user
         const userClients = this.activeServers.get(userId);
         if (userClients && userClients.has(serverName)) {
             userClients.get(serverName)!.client = null; // Mark as disconnected
         }
     };

      client.onclose = () => {
         console.log(`MCP client "${serverName}" for user ${userId} connection closed.`);
         // Remove the server/client from the active map if it wasn't a planned removal
         const userClients = this.activeServers.get(userId);
         if (userClients && userClients.has(serverName)) {
             console.warn(`Marking "${serverName}" as disconnected for user ${userId} due to connection close.`);
             userClients.get(serverName)!.client = null; // Mark as disconnected
         }
     };
  }
}
