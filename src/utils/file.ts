/**
 * @file Utility functions for file operations, like downloading.
 */
import fetch from 'node-fetch';

/**
 * Downloads a file from a given URL.
 * @param url - The URL of the file to download.
 * @returns A promise resolving to an object containing the file data as a Buffer and its MIME type.
 * @throws {Error} If the download fails or the response is not OK.
 */
// Helper function to download a file from a URL and return buffer data and mime type
export async function downloadFile(url: string): Promise<{ data: Buffer, mime: string | null }> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    // Get buffer data
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Get mime type from headers
    const mimeType = response.headers.get('content-type');

    return { data: buffer, mime: mimeType };

  } catch (error) {
    console.error(`Error downloading file from ${url}:`, error);
    throw error;
  }
}

// TODO: Add other file utility functions if needed
// e.g., saveFile(buffer, path), readFile(path), getFileSize(path), etc.
