/**
 * @file Defines TypeScript interfaces related to Model Context Protocol (MCP) configurations.
 */

/**
 * Represents the full configuration for an MCP server connection.
 */
export interface MCPConfig {
  name: string;
  type: 'stdio' | 'http'; // Transport type
  command?: string; // For stdio
  args?: string[]; // For stdio
  url?: string; // For http
  env?: { [key: string]: string | undefined }; // Environment variables for stdio
  // Add other config properties if needed
}

/**
 * Represents the MCP configuration structure as stored in the `configJson` field in the database,
 * where the 'name' property might be omitted because it's stored as a separate column.
 */
export interface MCPConfigWithOptionalName {
  name?: string; // Name is optional here as it's a top-level field in the DB
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: { [key: string]: string | undefined };
}

// You might also want types for MCP tools, resources, etc., but
// the @modelcontextprotocol/sdk library should provide these.
// import { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/client';

