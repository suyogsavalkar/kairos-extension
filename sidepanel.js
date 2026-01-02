// Kairos Side Panel - Session Management

console.log('[Kairos] Side panel loaded');

// DOM Elements - Updated for Bento UI
const themeToggle = document.getElementById('themeToggle');
const settingsToggle = document.getElementById('settingsToggle');
const settingsContent = document.getElementById('settingsContent'); // Now an overlay
const apiKeyInput = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const apiStatus = document.getElementById('apiStatus');

// Bento Cards
const sessionSetup = document.getElementById('sessionSetup'); // Card 1: Setup State
const sessionActive = document.getElementById('sessionActive'); // Card 1: Active State (swaps)

// Inputs & Buttons
const goalInput = document.getElementById('goalInput');
const allowedSitesInput = document.getElementById('allowedSitesInput');
const startSessionBtn = document.getElementById('startSessionBtn');
const endSessionBtn = document.getElementById('endSessionBtn');

// Active Session Elements
const displayGoal = document.getElementById('displayGoal');
const blockedCount = document.getElementById('blockedCount');
const sessionTime = document.getElementById('sessionTime');

// State
let sessionStartTime = null;
let sessionTimer = null;

// Initialize
async function init() {
  loadTheme();
  await checkApiKeyStatus();
  await loadSessionState();
  await autoAddCurrentDomain();
  
  // Settings Overlay Toggle
  settingsToggle.addEventListener('click', (e) => {
    // Prevent closing if clicking input inside
    if (e.target.closest('input') || e.target.closest('button')) return;
    settingsContent.style.display = 'flex';
  });
  
  // Close overlay when clicking outside card or close button
  settingsContent.addEventListener('click', (e) => {
    if (e.target === settingsContent) {
      settingsContent.style.display = 'none';
    }
  });
  
  // Close button for settings modal
  document.getElementById('settingsCloseBtn').addEventListener('click', () => {
    settingsContent.style.display = 'none';
  });

  // Listen for session updates and activity logs
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SESSION_STATS_UPDATE') {
      if (blockedCount) blockedCount.textContent = message.blockedCount || 0;
    }
    if (message.action === 'ACTIVITY_LOG') {
      addActivityLog(message.log);
    }
  });
}

// Add activity log entry to the logs container
function addActivityLog(log) {
  const logsContainer = document.getElementById('activityLogs');
  if (!logsContainer) return;
  
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${log.status}`;
  
  const icon = log.status === 'blocked' ? '🚫' : '✅';
  const statusText = log.status === 'blocked' ? 'Blocked' : 'Allowed';
  
  logEntry.innerHTML = `
    <span class="log-icon">${icon}</span>
    <div class="log-content">
      <span class="log-domain">${log.domain}</span>
      <span class="log-reason">${log.reason}</span>
    </div>
    <span class="log-time">${log.time}</span>
  `;
  
  // Add to top of list
  logsContainer.insertBefore(logEntry, logsContainer.firstChild);
  
  // Keep only last 10 logs
  while (logsContainer.children.length > 10) {
    logsContainer.removeChild(logsContainer.lastChild);
  }
}

// Clear activity logs
function clearActivityLogs() {
  const logsContainer = document.getElementById('activityLogs');
  if (logsContainer) logsContainer.innerHTML = '';
}

// Auto-add current page's domain to allowed sites input
async function autoAddCurrentDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
      const url = new URL(tab.url);
      const domain = url.hostname.replace('www.', '');
      
      // Only add if input is empty
      if (allowedSitesInput && !allowedSitesInput.value.trim()) {
        allowedSitesInput.value = domain;
      }
    }
  } catch (e) {
    console.log('[Kairos] Could not get current tab domain:', e);
  }
}

// Theme Management
function loadTheme() {
  chrome.storage.local.get(['theme'], (result) => {
    const theme = result.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  chrome.storage.local.set({ theme });
}

themeToggle.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
});

// API Key Management
async function checkApiKeyStatus() {
  const apiKey = await window.KairosAI.getApiKey();
  if (apiKey) {
    apiStatus.innerHTML = '<span class="status-ok">✓ API key configured</span>';
    apiKeyInput.placeholder = '••••••••••••••••';
  } else {
    apiStatus.innerHTML = '<span class="status-warning">⚠️ Required to use Kairos</span>';
  }
}

saveApiKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (key && !key.includes('••••')) {
    await window.KairosAI.saveApiKey(key);
    apiStatus.innerHTML = '<span class="status-ok">✓ API key saved!</span>';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = '••••••••••••••••';
  }
});

// Session Management
async function loadSessionState() {
  const result = await chrome.storage.local.get(['session']);
  if (result.session && result.session.active) {
    showActiveSession(result.session);
  } else {
    showSessionSetup();
  }
}

function showSessionSetup() {
  sessionSetup.style.display = 'flex';
  sessionActive.style.display = 'none';
  if (sessionTimer) clearInterval(sessionTimer);
}

function showActiveSession(session) {
  sessionSetup.style.display = 'none';
  sessionActive.style.display = 'flex';
  
  if (displayGoal) displayGoal.textContent = session.goal;
  // displayAllowed might be removed in Bento UI, check existence
  if (typeof displayAllowed !== 'undefined' && displayAllowed) {
    displayAllowed.textContent = session.allowedDomains.join(', ') || 'None';
  }
  if (blockedCount) blockedCount.textContent = session.blockedCount || 0;
  
  // Start timer
  sessionStartTime = session.startTime;
  updateSessionTime();
  sessionTimer = setInterval(updateSessionTime, 60000);
}

function updateSessionTime() {
  if (!sessionStartTime) return;
  const minutes = Math.floor((Date.now() - sessionStartTime) / 60000);
  if (minutes < 60) {
    sessionTime.textContent = `${minutes}m`;
  } else {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    sessionTime.textContent = `${hours}h ${mins}m`;
  }
}

// Start Session
startSessionBtn.addEventListener('click', async () => {
  const apiKey = await window.KairosAI.getApiKey();
  if (!apiKey) {
    alert('Please add your Gemini API key first!');
    return;
  }
  
  const goal = goalInput.value.trim();
  if (!goal) {
    alert('Please enter what you\'re working on!');
    return;
  }
  
  // Parse allowed domains
  const allowedDomains = allowedSitesInput.value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
  
  // Get strict mode setting
  const strictMode = document.getElementById('strictModeToggle').checked;
  
  const session = {
    active: true,
    goal: goal,
    allowedDomains: allowedDomains,
    strictMode: strictMode,
    startTime: Date.now(),
    blockedCount: 0
  };
  
  // Save to storage
  await chrome.storage.local.set({ session });
  
  // Notify background script
  chrome.runtime.sendMessage({ action: 'START_SESSION', session });
  
  showActiveSession(session);
});

// End Session
endSessionBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('session');
  chrome.runtime.sendMessage({ action: 'END_SESSION' });
  
  // Clear inputs and logs for next session
  goalInput.value = '';
  allowedSitesInput.value = '';
  clearActivityLogs();
  
  showSessionSetup();
});

// Initialize
init();
