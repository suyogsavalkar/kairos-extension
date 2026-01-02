// Kairos AI Service - Gemini Only

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * Get API key from storage
 */
async function getApiKey() {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  return result.geminiApiKey || null;
}

/**
 * Save API key to storage
 */
async function saveApiKey(apiKey) {
  await chrome.storage.local.set({ geminiApiKey: apiKey });
}

/**
 * Evaluate if a tab is a distraction based on screenshot and user's goal
 * @returns {Promise<{isDistraction: boolean, reason: string, error?: string}>}
 */
async function evaluateDistraction(screenshotBase64, goal, url) {
  const apiKey = await getApiKey();
  
  if (!apiKey) {
    return { isDistraction: false, error: 'No API key configured' };
  }
  
  const prompt = `You are Kairos, a focus assistant. The user wants to stay focused.

**User's Current Task**: ${goal}
**Current URL**: ${url}

Look at this screenshot and determine if this website is:
- RELEVANT to their work task (research, tools, reference)
- A DISTRACTION (social media, entertainment, news, shopping, etc.)

Be reasonable - if it could help their work, it's not a distraction.

Respond ONLY with valid JSON (no markdown):
{"isDistraction": true/false, "reason": "Brief explanation"}`;

  const base64Data = screenshotBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
  
  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Data
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 150
    }
  };
  
  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Kairos AI] API error:', errorData);
      return { isDistraction: false, error: errorData.error?.message || 'API error' };
    }
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      return { isDistraction: false, error: 'No response from AI' };
    }
    
    const result = JSON.parse(text);
    return { isDistraction: result.isDistraction, reason: result.reason };
    
  } catch (error) {
    console.error('[Kairos AI] Error:', error);
    return { isDistraction: false, error: error.message };
  }
}

/**
 * Evaluate if user's justification is valid
 * @returns {Promise<{accepted: boolean, reason: string, error?: string}>}
 */
async function evaluateJustification(justification, goal, url) {
  const apiKey = await getApiKey();
  
  if (!apiKey) {
    return { accepted: false, error: 'No API key configured' };
  }
  
  const prompt = `You are Kairos, a focus assistant. A page was blocked as a distraction, but the user says they need it.

**User's Work Task**: ${goal}
**Blocked URL**: ${url}
**User's Justification**: "${justification}"

Evaluate if their justification is reasonable and the page could actually help their work.
Be fair - if they make a reasonable case, accept it.
Reject if the justification is weak excuses or clearly just wanting entertainment.

Respond ONLY with valid JSON (no markdown):
{"accepted": true/false, "reason": "Brief explanation to show user"}`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 100
    }
  };
  
  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { accepted: false, error: errorData.error?.message || 'API error' };
    }
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      return { accepted: false, error: 'No response from AI' };
    }
    
    const result = JSON.parse(text);
    return { accepted: result.accepted, reason: result.reason };
    
  } catch (error) {
    console.error('[Kairos AI] Error:', error);
    return { accepted: false, error: error.message };
  }
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.KairosAI = {
    getApiKey,
    saveApiKey,
    evaluateDistraction,
    evaluateJustification
  };
}
