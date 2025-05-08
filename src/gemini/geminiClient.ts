/**
 * @file Client for interacting with the Google Gemini API.
 * Handles API key management (shared or per-user with encryption),
 * request construction, and response parsing.
 */
import {
    GoogleGenAI,
    FunctionDeclaration,
    SafetySetting,
    HarmCategory,
    Tool,
    Part,
    Content, // Import Content type
    GenerateContentResponse,
    GenerateContentParameters,
    HarmBlockThreshold,
    GenerationConfig // Keep for type definition if used elsewhere, but not for direct param construction
} from '@google/genai/node';
import { UserConfiguration } from '../context/types.js'; // Import user config type
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;
// Controls whether encryption/decryption is attempted. Defaults to true.
const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';

if (API_KEY_ENCRYPTION_ENABLED) {
    if (process.env.ENCRYPTION_KEY) {
        if (process.env.ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
            ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_KEY is set but not a 64-character hex string. API keys will not be securely decrypted.');
        }
    } else {
         console.warn('WARN: API_KEY_ENCRYPTION_ENABLED is true, but ENCRYPTION_KEY is not set. API keys will be stored in plaintext.');
    }
    if (process.env.ENCRYPTION_IV) {
        if (process.env.ENCRYPTION_IV.length === 32 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_IV)) {
            ENCRYPTION_IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex');
        } else {
            console.error('ERROR: ENCRYPTION_IV is set but not a 32-character hex string. API keys will not be securely decrypted.');
        }
    } else {
        console.warn('WARN: API_KEY_ENCRYPTION_ENABLED is true, but ENCRYPTION_IV is not set. API keys will be stored in plaintext.');
    }
     if (!ENCRYPTION_KEY || !ENCRYPTION_IV) {
        console.warn('API Key encryption is enabled but keys are invalid/missing. Keys will be stored in plaintext.');
    } else {
        console.log('API Key encryption is enabled and keys are configured.');
    }
} else {
    console.log('API Key encryption is disabled. Keys will be stored in plaintext.');
}

/**
 * Decrypts text using AES-256-CBC if encryption is enabled and keys are valid.
 * Falls back to returning the original text if encryption is disabled, keys are missing,
 * or decryption fails (assuming the stored value might be plaintext).
 * @param encryptedText - The text to decrypt (expected to be hex encoded).
 * @returns The decrypted text or the original text on failure/disabled encryption.
 * @throws {Error} If encryption is enabled but decryption fails fundamentally (e.g., bad key/IV).
 */
function decrypt(encryptedText: string): string {
    if (!encryptedText) return encryptedText;

    // Ensure keys are valid before proceeding
    const API_KEY_ENCRYPTION_ENABLED = process.env.API_KEY_ENCRYPTION_ENABLED !== 'false';
    const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY;
    const ENCRYPTION_IV_HEX = process.env.ENCRYPTION_IV;
    let ENCRYPTION_KEY: Buffer | null = null;
    let ENCRYPTION_IV: Buffer | null = null;

    if (API_KEY_ENCRYPTION_ENABLED && ENCRYPTION_KEY_HEX && ENCRYPTION_IV_HEX && ENCRYPTION_KEY_HEX.length === 64 && /^[0-9a-fA-F]+$/.test(ENCRYPTION_KEY_HEX) && ENCRYPTION_IV_HEX.length === 32 && /^[0-9a-fA-F]+$/.test(ENCRYPTION_IV_HEX)) {
        ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
        ENCRYPTION_IV = Buffer.from(ENCRYPTION_IV_HEX, 'hex');
    } else {
        // Log warning only if encryption is enabled but keys are bad/missing
        if (API_KEY_ENCRYPTION_ENABLED) {
             console.warn("API Key encryption is enabled but keys are invalid/missing. Using key as plaintext.");
        }
        return encryptedText; // Return plaintext if disabled or keys invalid
    }

    try {
        // A simple check to see if it might be hex. If not, assume plaintext.
        // This is not foolproof but helps avoid errors if a plaintext key was stored.
        if (!/^[0-9a-fA-F]+$/.test(encryptedText) || encryptedText.length < 32) { // Encrypted keys are usually longer
             console.warn("Stored API key doesn't look like hex, returning as plaintext.");
            return encryptedText; // Likely plaintext
        }
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY!, ENCRYPTION_IV!); // Added non-null assertion
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        // If decryption fails when encryption is enabled and keys are present,
        // it indicates a real problem (corrupted data, wrong key/IV).
        console.error("Decryption failed! Check ENCRYPTION_KEY/IV and stored data integrity.", error);
        // Instead of returning potentially sensitive encrypted data, throw an error.
        // The caller (getGeminiInstance) should handle this.
        throw new Error(`Failed to decrypt API key. Ensure encryption settings are correct and the stored key is valid.`);
    }
}

/**
 * A client class to manage interactions with the Google Gemini API.
 * Supports both a shared API key and per-user API keys (stored encrypted).
 */
export class GeminiClient {
  private geminiShared?: GoogleGenAI; 
  private userGeminiInstances: Map<number, GoogleGenAI> = new Map(); // Cache for user-specific instances
  constructor(sharedApiKey?: string) {
    if (sharedApiKey) {
      this.geminiShared = new GoogleGenAI({ apiKey: sharedApiKey });
      console.log('GeminiClient initialized with a shared API key.');
    } else {
      console.log(
        'GeminiClient initialized without a shared API key. Per-user keys must be provided via UI.',
      );
    }
  }

  /**
   * Gets the appropriate GoogleGenAI instance for a given user configuration.
   * Uses the user's specific key if available (decrypting if necessary),
   * otherwise falls back to the shared key, or throws an error if no key is available.
   * Caches user-specific instances.
   * @param userConfig - The configuration for the specific user.
   * @returns The GoogleGenAI instance.
   * @throws {Error} If no API key can be determined or if decryption fails.
   */
  private getGeminiInstance(userConfig?: UserConfiguration | null): GoogleGenAI {
    const userId = userConfig?.userId;
    let apiKeyToUse: string | undefined = undefined;
    let usingUserSpecificKey = false; // Flag to track if we are intending to use the user's key

    // Step 1: Determine the API key to use
    if (userConfig?.geminiApiKey) {
        try {
            const decryptedKey = decrypt(userConfig.geminiApiKey);
            apiKeyToUse = decryptedKey;
            usingUserSpecificKey = true; // We successfully got the user's key
        } catch (decryptionError: any) {
            console.error(`Error decrypting API key for user ${userId}: ${decryptionError.message}`);
            if (this.geminiShared) {
                console.warn(`Falling back to shared API key for user ${userId} due to decryption error.`);
                // If decryption fails, apiKeyToUse remains undefined here.
                // It will be set from geminiShared in the next block if geminiShared exists.
            } else {
                // No shared key to fall back to after decryption failure.
                throw new Error(`Could not use API key for user ${userId} due to decryption failure and no shared key available. Please check configuration.`);
            }
        }
    }

    // If apiKeyToUse is still undefined (either no user key was provided, or decryption failed)
    // AND we have a shared key, then use the shared key.
    if (!apiKeyToUse && this.geminiShared) {
        apiKeyToUse = (this.geminiShared as any)?.options?.apiKey; // Access internal options (may change)
        usingUserSpecificKey = false; // Explicitly state we are now using the shared key
    }

    // Step 2: Validate that an API key was found from any source
    if (!apiKeyToUse) {
        throw new Error(
            `No Gemini API key available for user ${userId ?? 'unknown'}. Please configure your key in settings or provide a SHARED_GEMINI_API_KEY.`
        );
    }

    // Step 3: Instance Caching and Selection Logic
    // If we ended up using a user-specific key AND the userId is available for caching:
    if (usingUserSpecificKey && userId !== undefined) {
        const cachedInstance = this.userGeminiInstances.get(userId);
        // Check if cached instance exists and uses the same API key
        if (!cachedInstance || (cachedInstance as any)?.options?.apiKey !== apiKeyToUse) {
            console.log(`Creating or updating Gemini instance for user ${userId} using their API key.`);
            const newInstance = new GoogleGenAI({ apiKey: apiKeyToUse });
            this.userGeminiInstances.set(userId, newInstance);
            return newInstance;
        }
        console.log(`Using cached Gemini instance for user ${userId}.`);
        return cachedInstance;
    } else if (this.geminiShared) {
        // Use the shared instance if:
        // 1. We are not using a user-specific key (i.e., usingUserSpecificKey is false).
        // 2. Or, we intended to use a user-specific key, but userId was undefined (cannot cache), and a shared key exists as a fallback.
        console.log(`Using shared Gemini instance for user ${userId ?? 'unknown'}.`);
        return this.geminiShared;
    } else {
        // This case is reached if:
        // - `usingUserSpecificKey` is true (so `userConfig.geminiApiKey` was provided and successfully decrypted, setting `apiKeyToUse`).
        // - BUT `userId` is undefined (so we couldn't use the caching logic in the first `if` block).
        // - AND `this.geminiShared` does not exist (so we couldn't use the `else if` block).
        // Therefore, we must create a new, non-cached instance with the user's key.
        console.warn(`Creating a non-cached Gemini instance for user-provided key (user ID ${userId ?? 'unknown/unavailable for caching'}, and no shared key).`);
        return new GoogleGenAI({ apiKey: apiKeyToUse }); // apiKeyToUse is guaranteed to be the user's key here.
    }
  } // End of getGeminiInstance method

  async generateContent(
    messages: Content[], // Use imported Content type
    tools?: FunctionDeclaration[],
    multimodalParts?: Part[], // Added multimodalParts as per user's code
    userConfig?: UserConfiguration | null
  ): Promise<{ functionCalls?: any[]; text?: string }> {
    let geminiInstance: GoogleGenAI;
    try {
      geminiInstance = this.getGeminiInstance(userConfig); // This now handles errors better
    } catch (e: any) { // Explicitly type e or use unknown
      console.error('Error getting Gemini instance:', e.message); // Log e.message
      throw e;
    }

    // Determine the model name from user config or default.
    const modelName =
      userConfig?.generalSettings?.geminiModel || 'gemini-1.5-flash-latest';

    const contents = [...messages];
    if (multimodalParts && multimodalParts.length > 0) {
      let lastUserMessageIndex = -1;
      for (let i = contents.length - 1; i >= 0; i--) {
          if (contents[i].role === 'user') {
              lastUserMessageIndex = i;
              break;
          }
      }
      if (lastUserMessageIndex !== -1) {
          // Ensure parts array exists
          if (!contents[lastUserMessageIndex].parts) {
              contents[lastUserMessageIndex].parts = [];
          }
          // Append multimodalParts to the existing parts of the last user message
          contents[lastUserMessageIndex].parts!.push(...multimodalParts);
      } else {
          // If no user message found (should be rare if history is managed well),
          contents.push({ role: 'user', parts: multimodalParts });
      }
    }

    const params: GenerateContentParameters = {
        model: modelName,
        contents: contents,
    };

    if (userConfig?.generalSettings?.temperature !== undefined && userConfig.generalSettings.temperature !== null) {
      params.temperature = userConfig.generalSettings.temperature;
    }
    if (userConfig?.generalSettings?.maxOutputTokens !== undefined && userConfig.generalSettings.maxOutputTokens !== null) {
      params.maxOutputTokens = userConfig.generalSettings.maxOutputTokens;
    }

    if (userConfig?.generalSettings?.safetySettings && Array.isArray(userConfig.generalSettings.safetySettings)) {
        const safetySettings = userConfig.generalSettings.safetySettings
            .map(setting => ({
                category: setting.category as HarmCategory,
                threshold: setting.threshold as HarmBlockThreshold,
            }))
            .filter(setting =>
                Object.values(HarmCategory).includes(setting.category) &&
                Object.values(HarmBlockThreshold).includes(setting.threshold)
            );
         if (safetySettings.length > 0) {
             params.safetySettings = safetySettings;
         }
    }

    const systemInstruction = userConfig?.promptSystemSettings?.systemInstruction;
    if (systemInstruction) {
        params.systemInstruction = { role: 'system', parts: [{ text: systemInstruction }] };
    }

    const geminiTools: Tool[] | undefined = (tools && tools.length > 0)
        ? [{ functionDeclarations: tools }]
        : undefined;
    if (geminiTools) {
        params.tools = geminiTools;
    }

    try {
      console.log(`Generating content with model: ${modelName}, params: ${JSON.stringify(params)}`);
      const result: GenerateContentResponse = await geminiInstance.models.generateContent(params);
      const functionCalls = result.functionCalls;
      const textResponse = result.text;

      return {
        functionCalls: functionCalls && functionCalls.length > 0 ? functionCalls : undefined,
        text: textResponse,
      };
    } catch (error: any) { // Explicitly type error or use unknown
      console.error('Error calling Gemini API:', error.message, error.stack);
        if (error.response) {
           console.error("Gemini API Error Response Details:", JSON.stringify(error.response, null, 2));
        }
      throw new Error(`Gemini API error: ${error.message}`);
    }
  } // End of generateContent method
}
