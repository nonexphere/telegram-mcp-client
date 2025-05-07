markdown
# MCP Server Configuration Format

The bot reads MCP server configurations from the database, managed via the Mini App UI.

The configuration for **each** MCP server is stored as a JSON object with the following structure:

```json
{
  "name": "server-name",
  "type": "stdio",
  "command": "command-to-run-server",
  "args": ["arg1", "arg2"],
  "env": {
    "ENV_VAR_NAME": "env_var_value"
  }
}
```
or
```json
{
  "name": "server-name",
  "type": "http",
  "url": "http://localhost:8000/mcp-endpoint"
  // Additional HTTP transport specific options might go here in the future
}
```

## Configuration Fields:

*   `name` (string, required): A unique name you give to this MCP server configuration **for your user**. This name is used internally by the bot to identify and route requests to the correct server instance. It should be descriptive and unique among your configured servers (e.g., "filesystem", "weather-api", "my-database-server").
*   `type` (string, required): The transport type used to connect to the server. Must be either `"stdio"` or `"http"`.
*   `command` (string, optional): **Required if `type` is `"stdio"`.** The command to execute to start the MCP server process. This should be the path to the executable or script (e.g., `"node"`, `"python"`, `"npx"`, `"/usr/local/bin/my-mcp-server-script"`). The bot's hosting environment must have this command available and executable.
*   `args` (string[], optional): **Optional if `type` is `"stdio"`.** An array of string arguments to pass to the command. (e.g., `["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"]`).
*   `env` (object, optional): **Optional if `type` is `"stdio"`.** A key-value object defining environment variables to set for the server process. These will be merged with the current process's environment variables. Useful for passing API keys or specific server settings needed by the server itself.
*   `url` (string, optional): **Required if `type` is `"http"`.** The base URL of the MCP server's HTTP endpoint. (e.g., `"http://localhost:8000/mcp"`).

**Importante sobre o tipo `stdio`:**
A configuração de servidores MCP do tipo `stdio` é restrita a usuários administradores definidos na configuração do bot (via variável de ambiente `ADMIN_USER_IDS`). Se você não for um administrador, a opção de adicionar servidores `stdio` pode estar desabilitada ou não funcional na Mini App.

## Adding/Managing Configurations

Use the MCP Servers section in the [Mini App UI](/docs/MINIAPP_GUIDE.md) to add, view, and delete your configurations.

## Examples:

See `examples/mcp_manifest.json` for a sample JSON structure you can use when adding a server via the Mini App form.

**Example: Filesystem Server (Stdio)**

```json
{
  "name": "local-filesystem",
  "type": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/home/user/Documents",
    "/home/user/Downloads"
  ],
  "env": {}
}
```
*Note: Replace paths with actual paths accessible by the bot process on the hosting system.*

**Example: Hypothetical HTTP Server**

```json
{
  "name": "remote-api-server",
  "type": "http",
  "url": "https://api.example.com/mcp/v1"
}
```
*Note: This bot's example implementation for HTTP transport is currently minimal/placeholder.*

