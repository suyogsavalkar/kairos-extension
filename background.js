// Kairos Background Service Worker
// Session management and tab blocking logic

console.log('[Kairos] Background service worker started');

// Session state
let session = {
  active: false,
  goal: '',
  allowedDomains: [],
  blockedCount: 0,
  lastRelevantTabId: null, // Last tab ID that was relevant
  lastRelevantUrl: null, // Last URL that was relevant to the task
  hiddenTabUrls: [] // URLs of tabs hidden at session start
};

// Helper: sleep function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Load session from storage on startup
chrome.storage.local.get(['session'], (result) => {
  if (result.session) {
    session = { ...session, ...result.session };
    console.log('[Kairos] Loaded session:', session.active ? 'Active' : 'Inactive');
  }
});

// Listen for session commands from side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_SESSION') {
    session = { ...message.session, lastRelevantTabId: null, hiddenTabUrls: [] };
    console.log('[Kairos] Session started:', session.goal);
    // Hide irrelevant tabs
    hideIrrelevantTabs();
  }
  
  if (message.action === 'END_SESSION') {
    // Close all blocking overlays
    closeAllOverlays();
    // Restore hidden tabs before clearing session
    restoreHiddenTabs();
    session = {
      active: false,
      goal: '',
      allowedDomains: [],
      blockedCount: 0,
      lastRelevantTabId: null,
      hiddenTabUrls: []
    };
    console.log('[Kairos] Session ended');
  }
  
  if (message.action === 'GET_SESSION') {
    sendResponse({ session });
    return true;
  }
  
  if (message.action === 'JUSTIFY_TAB') {
    // Use sender.tab.id since content script doesn't know its own tab ID
    const tabId = sender.tab?.id;
    if (tabId) {
      handleJustification(tabId, message.justification);
    }
  }
  
  if (message.action === 'RETURN_TO_TASK') {
    returnToLastRelevantTab();
  }
});

// Track pending evaluations to prevent duplicates
let pendingEvaluations = new Set();

// Only evaluate on page load complete (single trigger point)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!session.active) return;
  if (changeInfo.status !== 'complete') return;
  
  // Check if this is the active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id !== tabId) return;
  
  // Skip if already evaluating this tab
  if (pendingEvaluations.has(tabId)) {
    console.log('[Kairos] Already evaluating tab:', tabId);
    return;
  }
  
  pendingEvaluations.add(tabId);
  try {
    await evaluateTab(tab);
  } finally {
    pendingEvaluations.delete(tabId);
  }
});


// Evaluate if tab should be blocked
async function evaluateTab(tab) {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return; // Skip internal pages
  }
  
  const domain = extractDomain(tab.url);
  const isAllowed = isAllowedDomain(domain);
  
  // If domain is allowed and NOT in strict mode, skip evaluation
  if (isAllowed && !session.strictMode) {
    console.log('[Kairos] Allowed domain (normal mode):', domain);
    session.lastRelevantTabId = tab.id;
    session.lastRelevantUrl = tab.url;
    await unblockTab(tab.id);
    return;
  }
  
  // Wait for page content to load before evaluating
  console.log('[Kairos] Waiting for page to load...');
  await sleep(2000);
  
  // In strict mode, we evaluate everything (even allowed domains)
  const modeLabel = session.strictMode && isAllowed ? ' [strict mode]' : '';
  console.log('[Kairos] Evaluating' + modeLabel + ':', domain);
  
  // Capture screenshot with retry (handles edge cases like tab dragging)
  let screenshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Small delay to let tab settle
      if (attempt > 0) await sleep(200);
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 50
      });
      break; // Success
    } catch (error) {
      if (attempt === 2) {
        console.warn('[Kairos] Screenshot failed after retries:', error.message);
        return; // Can't evaluate without screenshot
      }
    }
  }
  
  // Get API key
  const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
  if (!geminiApiKey) {
    console.log('[Kairos] No API key, skipping evaluation');
    return;
  }
  
  // Call Gemini to evaluate
  const result = await evaluateDistraction(screenshot, session.goal, tab.url, geminiApiKey);
  
  if (result.error) {
    console.error('[Kairos] Evaluation error:', result.error);
    return;
  }
  
  if (result.isDistraction) {
    console.log('[Kairos] Blocking distraction:', domain, '-', result.reason);
    await blockTab(tab.id, result.reason);
    session.blockedCount++;
    await saveSession();
    notifySidePanel();
    // Send activity log
    sendActivityLog(domain, 'blocked', result.reason);
  } else {
    console.log('[Kairos] Relevant to task:', domain);
    session.lastRelevantTabId = tab.id;
    session.lastRelevantUrl = tab.url;
    await unblockTab(tab.id);
    // Send activity log
    sendActivityLog(domain, 'allowed', 'Relevant to your task');
  }
}

// Check if domain is in allowed list
function isAllowedDomain(domain) {
  return session.allowedDomains.some(allowed => 
    domain === allowed || domain.endsWith('.' + allowed)
  );
}

// Extract domain from URL
function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Block tab by injecting overlay
async function blockTab(tabId, reason) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'BLOCK',
      reason: reason
    });
  } catch {
    // Content script may not be loaded, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content-styles.css']
    });
    // Retry
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'BLOCK',
          reason: reason
        });
      } catch (e) {
        console.error('[Kairos] Could not block tab:', e);
      }
    }, 100);
  }
}

// Unblock tab
async function unblockTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'UNBLOCK' });
  } catch {
    // Content script not loaded, nothing to unblock
  }
}

// Close all overlays when session ends
async function closeAllOverlays() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'UNBLOCK' });
      } catch {
        // Content script not loaded on this tab
      }
    }
  } catch (error) {
    console.error('[Kairos] Error closing overlays:', error);
  }
}

// Handle justification from content script
async function handleJustification(tabId, justification) {
  const tab = await chrome.tabs.get(tabId);
  const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
  
  if (!geminiApiKey) {
    await chrome.tabs.sendMessage(tabId, {
      action: 'JUSTIFICATION_RESULT',
      accepted: false,
      reason: 'No API key configured'
    });
    return;
  }
  
  const result = await evaluateJustifyRequest(justification, session.goal, tab.url, geminiApiKey);
  
  if (result.accepted) {
    session.lastRelevantTabId = tabId;
    session.lastRelevantUrl = tab.url;
    await unblockTab(tabId);
  }
  
  await chrome.tabs.sendMessage(tabId, {
    action: 'JUSTIFICATION_RESULT',
    accepted: result.accepted,
    reason: result.reason
  });
}

// Return to last relevant tab/URL (smart logic)
async function returnToLastRelevantTab() {
  if (!session.lastRelevantUrl) return;
  
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentDomain = extractDomain(currentTab.url);
    const targetDomain = extractDomain(session.lastRelevantUrl);
    
    // If domains are different AND we have a tab ID, switch to that tab and close current
    if (currentDomain !== targetDomain && session.lastRelevantTabId) {
      try {
        await chrome.tabs.get(session.lastRelevantTabId);
        // Tab still exists, switch to it
        await chrome.tabs.update(session.lastRelevantTabId, { active: true });
        await chrome.tabs.remove(currentTab.id);
        console.log('[Kairos] Switched to last relevant tab and closed distracting tab');
      } catch {
        // Tab doesn't exist anymore, just navigate current tab
        await chrome.tabs.update(currentTab.id, { url: session.lastRelevantUrl });
        console.log('[Kairos] Last tab gone, navigating to URL:', session.lastRelevantUrl);
      }
    } else {
      // Same domain or no tab ID, just navigate to the URL
      await chrome.tabs.update(currentTab.id, { url: session.lastRelevantUrl });
      console.log('[Kairos] Navigating to last relevant URL:', session.lastRelevantUrl);
    }
  } catch (error) {
    console.log('[Kairos] Failed to return to task:', error);
  }
}

// Send activity log to sidepanel
function sendActivityLog(domain, status, reason) {
  chrome.runtime.sendMessage({
    action: 'ACTIVITY_LOG',
    log: {
      domain,
      status, // 'blocked' or 'allowed'
      reason,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  }).catch(() => {});
}

// Hide tabs that aren't in allowed domains on session start
async function hideIrrelevantTabs() {
  // If no allowed domains specified, don't hide anything
  if (!session.allowedDomains || session.allowedDomains.length === 0) {
    console.log('[Kairos] No allowed domains specified, keeping all tabs visible');
    return;
  }
  
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const hiddenUrls = [];
    
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        continue;
      }
      
      const domain = extractDomain(tab.url);
      
      // Keep allowed domains
      if (isAllowedDomain(domain)) {
        session.lastRelevantTabId = tab.id;
        continue;
      }
      
      // Hide (close) non-allowed tabs, save their URLs
      console.log('[Kairos] Hiding tab:', domain);
      hiddenUrls.push(tab.url);
      await chrome.tabs.remove(tab.id);
    }
    
    session.hiddenTabUrls = hiddenUrls;
    await saveSession();
    console.log('[Kairos] Hidden', hiddenUrls.length, 'tabs');
    
    // Notify side panel
    chrome.runtime.sendMessage({
      action: 'TABS_HIDDEN',
      count: hiddenUrls.length
    }).catch(() => {});
    
  } catch (error) {
    console.error('[Kairos] Error hiding tabs:', error);
  }
}

// Restore hidden tabs when session ends
async function restoreHiddenTabs() {
  if (session.hiddenTabUrls.length === 0) return;
  
  console.log('[Kairos] Restoring', session.hiddenTabUrls.length, 'tabs');
  
  for (const url of session.hiddenTabUrls) {
    try {
      await chrome.tabs.create({ url, active: false });
    } catch (error) {
      console.error('[Kairos] Error restoring tab:', error);
    }
  }
}

// Save session to storage
async function saveSession() {
  await chrome.storage.local.set({ session });
}

// Notify side panel of updates
function notifySidePanel() {
  chrome.runtime.sendMessage({
    action: 'SESSION_STATS_UPDATE',
    blockedCount: session.blockedCount
  }).catch(() => {});
}

// Gemini API calls (inline to avoid import issues in service worker)
async function evaluateDistraction(screenshot, goal, url, apiKey) {
  const prompt = `User task: "${goal}"
URL: ${url}

Is this screenshot a distraction from their task? Reply with JSON only:
{"isDistraction": true, "reason": "why"}
or
{"isDistraction": false, "reason": "why"}`;

  const base64Data = screenshot.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
            ]
          }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { isDistraction: false, error: err.error?.message || 'API error' };
    }
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { isDistraction: false, error: 'No response' };
    
    return parseJsonResponse(text, { isDistraction: false, reason: 'Could not parse response' });
  } catch (e) {
    return { isDistraction: false, error: e.message };
  }
}

async function evaluateJustifyRequest(justification, goal, url, apiKey) {
  const prompt = `You are Kairos, a focus assistant. A page was blocked as a distraction, but the user says they need it.

**User's Work Task**: ${goal}
**Blocked URL**: ${url}
**User's Justification**: "${justification}"

Evaluate if their justification is reasonable and the page could actually help their work.
Be fair - if they make a reasonable case, accept it.
Reject if the justification is weak excuses or clearly just wanting entertainment.

Respond ONLY with valid JSON (no markdown):
{"accepted": true/false, "reason": "Brief explanation to show user"}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      }
    );
    
    if (!response.ok) {
      return { accepted: false, reason: 'API error' };
    }
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { accepted: false, reason: 'No response' };
    
    return parseJsonResponse(text, { accepted: false, reason: 'Could not parse response' });
  } catch (e) {
    return { accepted: false, reason: e.message };
  }
}

// Helper to parse JSON from Gemini response (handles markdown code blocks)
function parseJsonResponse(text, fallback) {
  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch {
    try {
      // Remove markdown code blocks if present
      let cleaned = text
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
      
      // Try to extract JSON object
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch {}
  }
  
  console.warn('[Kairos] Could not parse AI response:', text);
  return fallback;
}
