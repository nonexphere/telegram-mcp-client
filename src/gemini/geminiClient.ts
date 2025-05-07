import {
    GoogleGenerativeAI, // Changed to GoogleGenerativeAI (matching SDK export)
    FunctionDeclaration,
    GenerationConfig,
    Tool,
    Type
} from '@google/genai/node'; // Changed from '@google/genai'
import { UserConfiguration } from '../context/types.js'; // Import user config type

export class GeminiClient {
  private gemini: GoogleGenerativeAI;
  private sharedApiKey?: string; // Optional shared key

  // Store Gemini instances per user if using per-user keys
  private userGeminiInstances: Map<number, GoogleGenerativeAI> = new Map();

  constructor(sharedApiKey?: string) {
    this.sharedApiKey = sharedApiKey;
    if (!sharedApiKey) {
        console.warn('No shared Gemini API key provided. Assuming per-user keys will be handled.');
    }
    // Create a default instance if a shared key is provided
    if (sharedApiKey) {
        // Use the GoogleGenerativeAI constructor from @google/genai/node
        this.gemini = new GoogleGenerativeAI({ apiKey: sharedApiKey });
    } else {
         // Placeholder instance, actual instance will be created per user
         // For now, let's create a dummy instance if no shared key.
         // Note: Instantiating might still require basic options even if key is null.
         // Placeholder: getGeminiInstance must handle the case where no sharedApiKey is available.
         // For now, the constructor requires an API key.
         // We will rely on getGeminiInstance to throw if no key is found.
         this.gemini = null as any; // To satisfy TypeScript, actual instance created on demand
    }
  }

  // Get or create a Gemini instance for a specific user
  private getGeminiInstance(userConfig: UserConfiguration): GoogleGenerativeAI {
      if (userConfig.geminiApiKey) {
           if (!this.userGeminiInstances.has(userConfig.userId)) {
               // Use the GoogleGenerativeAI constructor for per-user instance
               this.userGeminiInstances.set(userConfig.userId, new GoogleGenerativeAI({ apiKey: userConfig.geminiApiKey }));
           }
           return this.userGeminiInstances.get(userConfig.userId)!;
      } else if (this.sharedApiKey) {
           // If shared key exists, and main this.gemini wasn't initialized (because sharedApiKey was null in constructor), initialize it now.
           if (!this.gemini) {
               this.gemini = new GoogleGenerativeAI({ apiKey: this.sharedApiKey });
           }
           return this.gemini; // Use the shared instance
      } else {
           // This error should be caught by the caller (message/media handlers)
           throw new Error(`No Gemini API key available for user ${userConfig.userId}. Please configure your key in the settings.`);
      }
  }


  async generateContent(
    messages: any[], // History
    tools: FunctionDeclaration[], // Gemini tools
    multimodalParts?: any[], // Current turn multimodal parts
    userConfig?: UserConfiguration // User-specific settings
  ): Promise<any> {

    // Get the appropriate Gemini instance for the user
    let geminiInstance: GoogleGenerativeAI;
    if (!userConfig) { // Ensure userConfig is defined before accessing its properties
        if (this.sharedApiKey) {
            if (!this.gemini) this.gemini = new GoogleGenerativeAI({ apiKey: this.sharedApiKey });
            geminiInstance = this.gemini;
        } else {
            throw new Error("Cannot get Gemini instance: No user config or shared API key provided.");
        }
    } else {
        try {
            geminiInstance = this.getGeminiInstance(userConfig);
        } catch (e) {
           throw e;
        }
    }

    // Access the model from the geminiInstance
    const modelName = (userConfig && userConfig.generalSettings && userConfig.generalSettings.geminiModel)
        ? userConfig.generalSettings.geminiModel
        : 'gemini-2.5-flash-latest'; // Fallback model

    const model = geminiInstance.getGenerativeModel({ model: modelName });

    // Combine message history and potential multimodal parts for the current turn
    const contents = [...messages];
     if (multimodalParts && multimodalParts.length > 0) {
         // Find the last user message in history to append multimodal parts
         let lastUserMessageIndex = -1;
          for (let i = contents.length - 1; i >= 0; i--) {
              if (contents[i].role === 'user') {
                  lastUserMessageIndex = i;
                  break;
              }
          }

         if (lastUserMessageIndex !== -1) {
             // Append multimodal parts to the last user message parts
              // Ensure the 'parts' array exists
              if (!contents[lastUserMessageIndex].parts) {
                   contents[lastUserMessageIndex].parts = [];
              }
              contents[lastUserMessageIndex].parts.push(...multimodalParts);
         } else {
              // If no user message found (shouldn't happen in normal chat flow),
              // create a new user message with multimodal parts.
              contents.push({ role: 'user', parts: multimodalParts });
         }
     }


    // Prepare tools for the Gemini API request
    const geminiTools: Tool[] = [];
     if (tools && tools.length > 0) {
         geminiTools.push({
             functionDeclarations: tools
         });
     }

     // Basic generation configuration (override with user settings)
     const generationConfig: GenerationConfig = {
        temperature: (userConfig && userConfig.generalSettings && typeof userConfig.generalSettings.temperature === 'number')
            ? userConfig.generalSettings.temperature
            : 0.7,
     };

     // Apply user's prompt system if available
     const systemInstruction = (userConfig && userConfig.promptSystemSettings)
        ? userConfig.promptSystemSettings.systemInstruction
        : undefined;


    console.log('Sending content to Gemini:', JSON.stringify(contents, null, 2));
    console.log('With tools:', JSON.stringify(geminiTools, null, 2));
     if (systemInstruction) console.log('With system instruction:', systemInstruction);


    try {
      const result = await model.generateContent({
          contents: contents,
          tools: geminiTools.length > 0 ? geminiTools : undefined, // Only include tools if there are any
          generationConfig: generationConfig,
          systemInstruction: systemInstruction // Apply system instruction
      });

      const response = result.response;

      // Extract function calls
      // Check if response.candidates and response.candidates[0] exist before accessing functionCalls
      const functionCalls = response.candidates?.[0]?.functionCalls;
      // Extract text response
      const textResponse = response.text; // Use the getter property

      console.log('Received response from Gemini.');
      if (functionCalls) {
           console.log('Function calls suggested:', functionCalls);
      }
       if (textResponse) {
           console.log('Text response:', textResponse);
       }


      // Return a structured result
      return {
        functionCalls: functionCalls,
        text: textResponse
      };

    } catch (error: any) {
      console.error('Error calling Gemini API:', error);
      // Handle specific API errors if necessary
      throw error; // Re-throw to be handled by message handler
    }
  }
}
