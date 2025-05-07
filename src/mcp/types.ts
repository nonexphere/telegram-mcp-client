// Define the structure for MCP server configurations
export interface MCPConfig {
  name: string;
  type: 'stdio' | 'http'; // Transport type
  command?: string; // For stdio
  args?: string[]; // For stdio
  url?: string; // For http
  env?: { [key: string]: string | undefined }; // Environment variables for stdio
  // Add other config properties if needed
}

// You might also want types for MCP tools, resources, etc., but
// the @modelcontextprotocol/sdk library should provide these.
// import { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/client';

