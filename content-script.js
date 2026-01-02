// Kairos Content Script - Blocking Overlay

console.log('[Kairos] Content script loaded');

let overlay = null;
let justificationMode = false;

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'BLOCK') {
    showBlockOverlay(message.reason);
  }
  
  if (message.action === 'UNBLOCK') {
    hideBlockOverlay();
  }
  
  if (message.action === 'JUSTIFICATION_RESULT') {
    handleJustificationResult(message.accepted, message.reason);
  }
});

// Show blocking overlay
function showBlockOverlay(reason) {
  if (overlay) return; // Already showing
  
  overlay = document.createElement('div');
  overlay.id = 'kairos-block-overlay';
  overlay.innerHTML = `
    <button id="kairos-close" class="kairos-close-btn" title="Dismiss (will re-check on refresh)">✕</button>
    <div class="kairos-block-content">
      <div class="kairos-logo">⏳</div>
      <h1>Blocked</h1>
      <p class="kairos-message">Please complete the task at hand.</p>
      <p class="kairos-reason">${escapeHtml(reason)}</p>
      
      <div class="kairos-buttons">
        <button id="kairos-need-this" class="kairos-btn kairos-btn-secondary">
          🙋 I Need This
        </button>
        <button id="kairos-return" class="kairos-btn kairos-btn-primary">
          ← Return to Task
        </button>
      </div>
      
      <div id="kairos-justify-form" class="kairos-justify-form" style="display: none;">
        <textarea id="kairos-justify-input" placeholder="Explain why you need this page for your work..."></textarea>
        <div class="kairos-justify-buttons">
          <button id="kairos-justify-cancel" class="kairos-btn kairos-btn-small">Cancel</button>
          <button id="kairos-justify-submit" class="kairos-btn kairos-btn-primary kairos-btn-small">Submit</button>
        </div>
      </div>
      
      <div id="kairos-justify-result" class="kairos-justify-result" style="display: none;">
        <p id="kairos-result-message"></p>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Add event listeners
  document.getElementById('kairos-close').addEventListener('click', hideBlockOverlay);
  document.getElementById('kairos-need-this').addEventListener('click', showJustifyForm);
  document.getElementById('kairos-return').addEventListener('click', returnToTask);
  document.getElementById('kairos-justify-cancel').addEventListener('click', hideJustifyForm);
  document.getElementById('kairos-justify-submit').addEventListener('click', submitJustification);
}

// Hide blocking overlay
function hideBlockOverlay() {
  if (overlay) {
    overlay.remove();
    overlay = null;
    justificationMode = false;
  }
}

// Show justification form
function showJustifyForm() {
  justificationMode = true;
  document.getElementById('kairos-justify-form').style.display = 'block';
  document.getElementById('kairos-justify-result').style.display = 'none';
  document.querySelector('.kairos-buttons').style.display = 'none';
  document.getElementById('kairos-justify-input').focus();
}

// Hide justification form
function hideJustifyForm() {
  justificationMode = false;
  document.getElementById('kairos-justify-form').style.display = 'none';
  document.querySelector('.kairos-buttons').style.display = 'flex';
}

// Submit justification
function submitJustification() {
  const input = document.getElementById('kairos-justify-input');
  const justification = input.value.trim();
  
  if (!justification) {
    alert('Please explain why you need this page.');
    return;
  }
  
  // Show loading state
  const submitBtn = document.getElementById('kairos-justify-submit');
  submitBtn.textContent = 'Checking...';
  submitBtn.disabled = true;
  
  // Send to background for evaluation
  chrome.runtime.sendMessage({
    action: 'JUSTIFY_TAB',
    tabId: null, // Background will use sender's tab
    justification: justification
  });
}

// Handle justification result from background
function handleJustificationResult(accepted, reason) {
  if (accepted) {
    hideBlockOverlay();
  } else {
    document.getElementById('kairos-justify-form').style.display = 'none';
    const resultDiv = document.getElementById('kairos-justify-result');
    resultDiv.style.display = 'block';
    document.getElementById('kairos-result-message').innerHTML = `
      <span class="kairos-rejected">❌ ${escapeHtml(reason)}</span>
      <br><br>
      <span class="kairos-hint">This is just a distraction. Return to your task!</span>
    `;
    
    // Show buttons again after delay
    setTimeout(() => {
      document.querySelector('.kairos-buttons').style.display = 'flex';
      resultDiv.style.display = 'none';
    }, 3000);
  }
}

// Return to last relevant tab
function returnToTask() {
  chrome.runtime.sendMessage({ action: 'RETURN_TO_TASK' });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
