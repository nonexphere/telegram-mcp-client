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
const stdioWarning = document.getElementById('stdio-warning');

let currentUserIsAdmin = false; // Variável para guardar o status


// Show relevant fields based on selected transport type
mcpTypeSelect.addEventListener('change', (event) => {
    const isStdio = event.target.value === 'stdio';
    stdioFields.classList.toggle('hidden', !isStdio);
    httpFields.classList.toggle('hidden', isStdio);

    document.getElementById('mcp-command').required = isStdio;
    document.getElementById('mcp-url').required = !isStdio;

    adjustMcpFormForAdminStatus();
});

// Initially trigger change to show default fields
mcpTypeSelect.dispatchEvent(new Event('change'));

// Function to fetch and display current configuration
async function loadConfig() {
    try {
        const response = await fetch(`/api/user_config?initData=${app.initData}`);
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({ error: `HTTP error! status: ${response.status}` }));
            throw new Error(errorBody.error || `HTTP error! status: ${response.status}`);
        }
        const config = await response.json();
        console.log('Loaded config:', config);

        currentUserIsAdmin = config.isAdmin === true; // Armazena o status de admin

        // Populate settings form
        const settings = config.settings || { promptSystemSettings: {}, generalSettings: {} };
        document.getElementById('gemini-api-key').value = settings.geminiApiKey || '';
        document.getElementById('gemini-model').value = settings.generalSettings.geminiModel || '';
        document.getElementById('temperature').value = settings.generalSettings.temperature ?? ''; // Use ?? for null/undefined
        document.getElementById('system-instruction').value = settings.promptSystemSettings.systemInstruction || '';
        document.getElementById('safety-settings').value = settings.generalSettings.safetySettings ? JSON.stringify(settings.generalSettings.safetySettings, null, 2) : '';
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

        // ** Ajuste inicial da UI com base no status de admin **
        adjustMcpFormForAdminStatus();

    } catch (error) {
        console.error('Error loading config:', error);
        mcpList.innerHTML = '<li>Failed to load configurations.</li>';
         // Show error to user if possible
        app.showAlert('Failed to load configurations: ' + error.message);
    }
}

// Function to adjust the MCP form based on admin status
function adjustMcpFormForAdminStatus() {
    const isStdioSelected = mcpTypeSelect.value === 'stdio';
    const addMcpButton = addMcpForm.querySelector('button[type="submit"]');
    const stdioOption = mcpTypeSelect.querySelector('option[value="stdio"]');

    if (stdioOption) {
        stdioOption.disabled = !currentUserIsAdmin;
        if (isStdioSelected && !currentUserIsAdmin) {
            mcpTypeSelect.value = 'http'; // Force selection to http
            mcpTypeSelect.dispatchEvent(new Event('change')); // Trigger change to update UI
            // After dispatching change, isStdioSelected might be outdated, re-evaluate for button
            if (addMcpButton) addMcpButton.disabled = false; // HTTP should be enabled
            if (stdioWarning) stdioWarning.classList.remove('hidden');
            return; // Exit early as UI was re-triggered
        }
    }

    if (isStdioSelected && !currentUserIsAdmin) {
        if (addMcpButton) addMcpButton.disabled = true;
        if (stdioWarning) stdioWarning.classList.remove('hidden');
        console.log("Stdio selected, user is not admin. Disabling add button.");
    } else {
        if (addMcpButton) addMcpButton.disabled = false;
        if (stdioWarning) stdioWarning.classList.add('hidden');
        console.log("Stdio not selected or user is admin. Enabling add button.");
    }
}

// Function to save settings
settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(settingsForm);

    // Structure the data according to the UserConfiguration interface
    const settings = {
         geminiApiKey: formData.get('geminiApiKey'),
         promptSystemSettings: {
             systemInstruction: formData.get('systemInstruction')
         },
         generalSettings: {
             geminiModel: formData.get('geminiModel'),
             temperature: parseFloat(formData.get('temperature')),
             safetySettings: undefined,
             googleSearchEnabled: formData.get('googleSearchEnabled') === 'on',
         }
    };
    const safetySettingsString = formData.get('safetySettings');
    if (safetySettingsString) {
        try {
            settings.generalSettings.safetySettings = JSON.parse(safetySettingsString);
        } catch (e) {
            app.showAlert('Invalid JSON for Safety Settings. Please correct it or leave it empty.'); return;
        }
    }

    for (const key in settings.promptSystemSettings) {
        if (settings.promptSystemSettings[key] === '') delete settings.promptSystemSettings[key];
    }
    for (const key in settings.generalSettings) {
        if (settings.generalSettings[key] === '' || (typeof settings.generalSettings[key] === 'number' && isNaN(settings.generalSettings[key]))) {
            delete settings.generalSettings[key];
        }
    }

    try {
        const response = await fetch('/api/user_settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Init-Data': app.initData
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
        // Stdio fields are now derived from stdioServerType
        command: undefined,
        args: undefined,
        env: undefined,
        // Http fields
        url: undefined,
    };
    if (!config.name || !config.type) {
        app.showAlert('Server name and transport type are required.');
        return;
    }

    if (type === 'stdio') {
        config.command = formData.get('command');
        // Attempt to parse args and env as JSON, handle errors
        try {
            const args = formData.get('args');
            config.args = args ? JSON.parse(args) : undefined;
        } catch (e) {
            app.showAlert('Invalid JSON for Args field.'); return;
        }
         try {
            const env = formData.get('env');
            config.env = env ? JSON.parse(env) : undefined;
        } catch (e) {
            app.showAlert('Invalid JSON for Env field.'); return;
        }

    } else if (type === 'http') {
        config.url = formData.get('url');
    } else {
         app.showAlert('Invalid transport type.');
         return;
    }

    try {
        const response = await fetch('/api/mcps', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Init-Data': app.initData
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
                const response = await fetch(`/api/mcps/${serverName}`, {
                    method: 'DELETE',
                     headers: {
                        'X-Telegram-Init-Data': app.initData
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

clearHistoryButton.addEventListener('click', async () => {
    app.showConfirm('Are you sure you want to clear your chat history with this bot?', async (confirmed) => {
        if (confirmed) {
            try {
                const response = await fetch('/api/clear_history', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json', // Though no body, good practice
                        'X-Telegram-Init-Data': app.initData
                    }
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    app.showNotification({ message: 'Chat history cleared!', type: 'success' });
                } else {
                    throw new Error(result.error || 'Failed to clear history.');
                }
            } catch (error) {
                console.error('Error clearing history:', error);
                app.showNotification({ message: 'Failed to clear history: ' + error.message, type: 'error' });
            }
        }
    });
});


// Load initial configuration on page load
loadConfig();

// Optional: Add Mini App Close button behavior
// app.onEvent('mainButtonCLicked', () => { app.close(); }); // If you configure the Main Button

