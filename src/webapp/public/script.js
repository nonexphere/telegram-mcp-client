javascript
// Get the Telegram Web App object
const app = window.Telegram.WebApp;

// Expand the app to full screen and make it ready
app.ready();
app.expand();

// Get DOM elements
const settingsForm = document.getElementById('settings-form');
const mcpList = document.getElementById('mcp-list');
const addMcpForm = document.getElementById('add-mcp-form');
const mcpTypeSelect = document.getElementById('mcp-type');
const stdioFields = document.getElementById('stdio-config-fields');
const httpFields = document.getElementById('http-config-fields');
const clearHistoryButton = document.getElementById('clear-history');


// Show relevant fields based on selected transport type
mcpTypeSelect.addEventListener('change', (event) => {
    if (event.target.value === 'stdio') {
        stdioFields.classList.remove('hidden');
        httpFields.classList.add('hidden');
         // Set required attribute on relevant inputs
         document.getElementById('mcp-command').setAttribute('required', 'true');
         document.getElementById('mcp-url').removeAttribute('required');
    } else { // http
        stdioFields.classList.add('hidden');
        httpFields.classList.remove('hidden');
         // Set required attribute on relevant inputs
         document.getElementById('mcp-command').removeAttribute('required');
         document.getElementById('mcp-url').setAttribute('required', 'true');
    }
});

// Initially trigger change to show default fields
mcpTypeSelect.dispatchEvent(new Event('change'));


// Function to fetch and display current configuration
async function loadConfig() {
    try {
        // TODO: Pass initData securely (e.g., in a header)
        const response = await fetch('/api/user_config?initData=' + app.initData); // Example passing in query
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const config = await response.json();
        console.log('Loaded config:', config);

        // Populate settings form
        const settings = config.settings || { promptSystemSettings: {}, generalSettings: {} };
        document.getElementById('gemini-api-key').value = settings.geminiApiKey || '';
        document.getElementById('gemini-model').value = settings.generalSettings.geminiModel || '';
        document.getElementById('temperature').value = settings.generalSettings.temperature ?? ''; // Use ?? for null/undefined
        document.getElementById('system-instruction').value = settings.promptSystemSettings.systemInstruction || '';
        document.getElementById('google-search-enabled').checked = settings.generalSettings.googleSearchEnabled ?? false;


        // Populate MCP list
        const mcps = config.mcps || [];
        mcpList.innerHTML = mcps.map(mcp => `
            <li>
                <span>${mcp.name} (${mcp.type})</span>
                <button data-name="${mcp.name}" class="delete-mcp-btn">Delete</button>
            </li>
        `).join('');

        // Add event listeners to delete buttons
        document.querySelectorAll('.delete-mcp-btn').forEach(button => {
            button.addEventListener('click', deleteMcp);
        });

    } catch (error) {
        console.error('Error loading config:', error);
        mcpList.innerHTML = '<li>Failed to load configurations.</li>';
         // Show error to user if possible
        app.showAlert('Failed to load configurations: ' + error.message);
    }
}

// Function to save settings
settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(settingsForm);

    // Structure the data according to the UserConfiguration interface
    const settings = {
         // userId will be added on the server from validated initData
         geminiApiKey: formData.get('geminiApiKey'), // Handle securely!
         promptSystemSettings: {
             systemInstruction: formData.get('systemInstruction')
         },
         generalSettings: {
             geminiModel: formData.get('geminiModel'),
             temperature: parseFloat(formData.get('temperature')), // Parse to number
             googleSearchEnabled: formData.get('googleSearchEnabled') === 'on', // Checkbox value
              // Add other general settings here
         }
    };

    // Clean up empty fields before sending
    for (const key in settings.promptSystemSettings) {
        if (settings.promptSystemSettings[key] === '') delete settings.promptSystemSettings[key];
    }
    for (const key in settings.generalSettings) {
        if (settings.generalSettings[key] === '') delete settings.generalSettings[key];
    }
    // Note: Handling geminiApiKey secure transmission/storage is critical.

    try {
        // TODO: Pass initData securely (e.g., in a header)
        const response = await fetch('/api/user_settings?initData=' + app.initData, { // Example passing in query
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                 // 'X-Telegram-Init-Data': app.initData // More secure way
            },
            body: JSON.stringify(settings)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            app.showNotification({ message: 'Settings saved!', type: 'success' });
             // Clear the API key field after successful save for security
            document.getElementById('gemini-api-key').value = '';

        } else {
            throw new Error(result.error || 'Failed to save settings.');
        }

    } catch (error) {
        console.error('Error saving settings:', error);
        app.showNotification({ message: 'Failed to save settings: ' + error.message, type: 'error' });
    }
});

// Function to add a new MCP server
addMcpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(addMcpForm);

    const type = formData.get('type');

    const config = {
         name: formData.get('name'),
         type: type,
         // Add other fields based on type
    };

    if (type === 'stdio') {
        config.command = formData.get('command');
        // Attempt to parse args and env as JSON, handle errors
        try {
            const args = formData.get('args');
             config.args = args ? JSON.parse(args) : undefined;
        } catch (e) {
             app.showAlert('Invalid JSON for Args field.');
             return;
        }
         try {
            const env = formData.get('env');
             config.env = env ? JSON.parse(env) : undefined;
        } catch (e) {
             app.showAlert('Invalid JSON for Env field.');
             return;
        }

    } else if (type === 'http') {
        config.url = formData.get('url');
    } else {
         app.showAlert('Invalid transport type.');
         return;
    }


    // Basic validation
    if (!config.name || !config.type || (config.type === 'stdio' && !config.command) || (config.type === 'http' && !config.url)) {
         app.showAlert('Please fill all required fields.');
         return;
    }


    try {
        // TODO: Pass initData securely (e.g., in a header)
        const response = await fetch('/api/mcps?initData=' + app.initData, { // Example passing in query
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                 // 'X-Telegram-Init-Data': app.initData // More secure way
            },
            body: JSON.stringify(config)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            app.showNotification({ message: `Server "${config.name}" added!`, type: 'success' });
            addMcpForm.reset(); // Clear form
            loadConfig(); // Reload list
        } else {
             throw new Error(result.error || 'Failed to add server.');
        }

    } catch (error) {
        console.error('Error adding server:', error);
        app.showNotification({ message: 'Failed to add server: ' + error.message, type: 'error' });
    }
});

// Function to delete an MCP server
async function deleteMcp(event) {
    const serverName = event.target.dataset.name;
    if (!serverName) return;

    // Confirm deletion
    app.showConfirm(`Are you sure you want to delete server "${serverName}"?`, async (confirmed) => {
        if (confirmed) {
            try {
                // TODO: Pass initData securely (e.g., in a header)
                const response = await fetch(`/api/mcps/${serverName}?initData=` + app.initData, { // Example passing in query
                    method: 'DELETE',
                     headers: {
                         // 'X-Telegram-Init-Data': app.initData // More secure way
                     }
                });

                if (!response.ok) {
                     // Read error message from response body if available
                     const errorBody = await response.json().catch(() => ({ error: 'Unknown deletion error' }));
                     throw new Error(`HTTP error! status: ${response.status}. ${errorBody.error || ''}`);
                }

                const result = await response.json();
                if (result.success) {
                    app.showNotification({ message: `Server "${serverName}" deleted.`, type: 'success' });
                    loadConfig(); // Reload list
                } else {
                     throw new Error(result.error || 'Failed to delete server.');
                }

            } catch (error) {
                console.error('Error deleting server:', error);
                app.showNotification({ message: 'Failed to delete server: ' + error.message, type: 'error' });
            }
        }
    });
}

// TODO: Add event listener for clear history button
// clearHistoryButton.addEventListener('click', async () => { ... call API endpoint ... });


// Load initial configuration on page load
loadConfig();

// Optional: Add Mini App Close button behavior
// app.onEvent('mainButtonCLicked', () => { app.close(); }); // If you configure the Main Button

