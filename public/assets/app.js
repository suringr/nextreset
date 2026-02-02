/**
 * NextReset - Shared JavaScript
 * Countdown timer and data fetching logic
 */

// Fetch game data from JSON
async function fetchGameData(game, type) {
    const url = `/data/${game}.${type}.json`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to load data: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error fetching game data:', error);
        throw error;
    }
}

// Calculate time difference in milliseconds
function getTimeDifference(targetDate) {
    const now = new Date();
    const target = new Date(targetDate);
    return target - now;
}

// Format milliseconds into console-style duration (02d 14h 03m 22s)
function formatDuration(ms) {
    const absMs = Math.abs(ms);

    const seconds = Math.floor(absMs / 1000) % 60;
    const minutes = Math.floor(absMs / (1000 * 60)) % 60;
    const hours = Math.floor(absMs / (1000 * 60 * 60)) % 24;
    const days = Math.floor(absMs / (1000 * 60 * 60 * 24));

    const parts = [];

    if (days > 0) parts.push(`${String(days).padStart(2, '0')}<span class="unit">d</span>`);
    if (hours > 0 || days > 0) parts.push(`${String(hours).padStart(2, '0')}<span class="unit">h</span>`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${String(minutes).padStart(2, '0')}<span class="unit">m</span>`);
    parts.push(`${String(seconds).padStart(2, '0')}<span class="unit">s</span>`);

    return parts.join(' ');
}

// Format time since update
function formatTimeSince(isoString) {
    const ms = Date.now() - new Date(isoString).getTime();
    const absMs = Math.abs(ms);

    const minutes = Math.floor(absMs / (1000 * 60));
    const hours = Math.floor(absMs / (1000 * 60 * 60));
    const days = Math.floor(absMs / (1000 * 60 * 60 * 24));

    if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    return 'just now';
}

// Check if data is unavailable
function isDataUnavailable(data) {
    return !data.nextEventUtc ||
        data.confidence === 'none' ||
        data.status === 'unavailable';
}

// Update countdown display
function updateCountdown(data) {
    const titleEl = document.getElementById('event-title');
    const countdownEl = document.getElementById('countdown');
    const sourceEl = document.getElementById('source');
    const confidenceEl = document.getElementById('confidence');
    const updatedEl = document.getElementById('last-updated');
    const notesEl = document.getElementById('notes');

    // Update title
    if (titleEl) titleEl.textContent = data.title;

    // Handle unavailable data
    if (isDataUnavailable(data)) {
        if (countdownEl) {
            countdownEl.innerHTML = `
                <div class="countdown-label">Status</div>
                <div class="countdown-value unavailable">Data Unavailable</div>
            `;
        }

        if (sourceEl) {
            sourceEl.textContent = 'Unavailable';
        }

        if (confidenceEl) {
            confidenceEl.textContent = 'none';
            confidenceEl.className = 'confidence confidence-none';
        }

        if (notesEl && data.reason) {
            notesEl.textContent = data.reason;
            notesEl.style.display = 'block';
        }

        if (updatedEl) {
            updatedEl.textContent = formatTimeSince(data.lastUpdatedUtc);
        }

        return; // Don't start countdown
    }

    // Update source
    if (sourceEl && data.source) {
        sourceEl.innerHTML = `<a href="${data.source.url}" target="_blank" rel="noopener">${data.source.name}</a>`;
    }

    // Update confidence
    if (confidenceEl) {
        confidenceEl.textContent = data.confidence;
        confidenceEl.className = `confidence confidence-${data.confidence}`;
    }

    // Update notes
    if (notesEl && data.notes) {
        notesEl.textContent = data.notes;
        notesEl.style.display = 'block';
    }

    // Show stale indicator if needed
    if (data.status === 'stale' && notesEl) {
        const staleNote = data.reason ? `⚠ Using cached data: ${data.reason}` : '⚠ Using cached data';
        notesEl.textContent = staleNote;
        notesEl.style.display = 'block';
    }

    // Update dynamic fields
    function tick() {
        const diff = getTimeDifference(data.nextEventUtc);
        const isFuture = diff > 0;

        if (countdownEl) {
            const formattedTime = formatDuration(diff);
            const label = isFuture ? 'Time Until Event' : 'Time Since Event';
            let valueClass = isFuture ? 'countdown-value' : 'countdown-value elapsed';

            // Add stale class if using cached data
            if (data.status === 'stale') {
                valueClass += ' stale';
            }

            countdownEl.innerHTML = `
                <div class="countdown-label">${label}</div>
                <div class="${valueClass}">${formattedTime}</div>
            `;
        }

        if (updatedEl) {
            updatedEl.textContent = formatTimeSince(data.lastUpdatedUtc);
        }
    }

    // Initial update
    tick();

    // Update every second
    setInterval(tick, 1000);
}

// Show error message
function showError(message) {
    const container = document.getElementById('countdown-container');
    if (container) {
        container.innerHTML = `
            <div class="error">
                <h2>⚠️ Unable to Load Data</h2>
                <p>${message}</p>
                <p><a href="/">← Back to Home</a></p>
            </div>
        `;
    }
}

// Initialize game page
async function initGamePage() {
    const container = document.getElementById('countdown-container');

    if (!container) {
        console.error('Countdown container not found');
        return;
    }

    const game = container.dataset.game;
    const type = container.dataset.type;

    if (!game || !type) {
        showError('Missing game or type configuration');
        return;
    }

    try {
        const data = await fetchGameData(game, type);
        updateCountdown(data);
    } catch (error) {
        showError(`Could not load data for ${game}. The provider may be temporarily unavailable.`);
    }
}

// Auto-initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGamePage);
} else {
    initGamePage();
}
