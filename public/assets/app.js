/**
 * NextReset - Shared JavaScript
 * Countdown timer and data fetching logic
 */

// Fetch game data from JSON with timeout (AbortController)
async function fetchGameData(game, type) {
    const url = `/data/${game}.${type}.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Failed to load data: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.warn(`[NextReset] Fetch timeout for ${game}.${type}`);
        } else {
            console.error('[NextReset] Error fetching game data:', error);
        }
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
        data.status === 'unavailable' ||
        data.status === 'fallback';
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
            const lastUpdated = data.fetched_at_utc || data.lastUpdatedUtc;
            updatedEl.textContent = lastUpdated ? formatTimeSince(lastUpdated) : 'Never';
        }

        return; // Don't start countdown
    }

    // Update source
    if (sourceEl) {
        const sourceUrl = data.source_url || data.source?.url;
        const sourceName = data.title || data.source?.name || 'Official Source';
        if (sourceUrl) {
            sourceEl.innerHTML = `<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceName}</a>`;
        } else {
            sourceEl.textContent = sourceName;
        }
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
            const diff = getTimeDifference(data.nextEventUtc);
            const isFuture = diff > 0;
            const isUpcoming = data.type?.startsWith('next-') || data.type?.includes('reset');

            const formattedTime = formatDuration(diff);
            const label = isFuture ? 'Time Until Event' : 'Time Since Event';
            let valueClass = isFuture ? 'countdown-value' : 'countdown-value elapsed';

            // Add stale class if using cached data
            if (data.status === 'stale') {
                valueClass += ' stale';
            }

            if (!isFuture && isUpcoming) {
                countdownEl.innerHTML = `
                    <div class="countdown-label">Status</div>
                    <div class="${valueClass}">Updating...</div>
                `;
            } else {
                countdownEl.innerHTML = `
                    <div class="countdown-label">${label}</div>
                    <div class="${valueClass}">${formattedTime}</div>
                `;
            }
        }

        if (updatedEl) {
            const lastUpdated = data.fetched_at_utc || data.lastUpdatedUtc;
            updatedEl.textContent = lastUpdated ? formatTimeSince(lastUpdated) : 'Never';
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

// === HOMEPAGE FUNCTIONS ===

// Format duration for homepage cards (shorter format: 2d 14h or 03m)
function formatCardDuration(ms) {
    const absMs = Math.abs(ms);
    const minutes = Math.floor(absMs / (1000 * 60)) % 60;
    const hours = Math.floor(absMs / (1000 * 60 * 60)) % 24;
    const days = Math.floor(absMs / (1000 * 60 * 60 * 24));

    if (days > 0) {
        return `${days}<span class="unit">d</span> ${String(hours).padStart(2, '0')}<span class="unit">h</span>`;
    }
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}<span class="unit">h</span> ${String(minutes).padStart(2, '0')}<span class="unit">m</span>`;
    }
    return `${String(minutes).padStart(2, '0')}<span class="unit">m</span>`;
}

// Render a homepage card with data
function renderCard(card, data) {
    const badgeEl = card.querySelector('.badge');
    const countdownEl = card.querySelector('.card-countdown');
    const lastCheckedEl = card.querySelector('.last-checked');

    // Determine state
    let state = 'unavailable';
    let badgeText = 'UNAVAILABLE';
    let badgeClass = 'badge badge-unavailable';

    if (data && !isDataUnavailable(data)) {
        const diff = getTimeDifference(data.nextEventUtc);
        if (diff > 0) {
            state = data.status === 'stale' ? 'stale' : 'live';
            badgeText = state === 'stale' ? 'STALE' : 'LIVE';
            badgeClass = state === 'stale' ? 'badge badge-stale' : 'badge badge-live';
        } else {
            state = 'live';
            badgeText = 'LIVE';
            badgeClass = 'badge badge-live';
        }
    }

    // Update card state
    card.dataset.state = state;
    card.dataset.nextUtc = data?.nextEventUtc || '';
    card.dataset.type = data?.type || '';

    // Update badge
    if (badgeEl) {
        badgeEl.className = badgeClass;
        badgeEl.textContent = badgeText;
    }

    // Update countdown
    if (countdownEl) {
        if (data && !isDataUnavailable(data)) {
            const diff = getTimeDifference(data.nextEventUtc);
            const isUpcoming = data.type?.startsWith('next-') || data.type?.includes('reset');

            if (diff <= 0 && isUpcoming) {
                countdownEl.innerHTML = 'Updating...';
            } else {
                countdownEl.innerHTML = formatCardDuration(diff);
            }
        } else {
            countdownEl.textContent = 'Data unavailable';
        }
    }

    // Update last checked
    const lastUpdated = data?.fetched_at_utc || data?.lastUpdatedUtc;
    if (lastCheckedEl && lastUpdated) {
        lastCheckedEl.textContent = `Checked ${formatTimeSince(lastUpdated)}`;
    }
}

// Render card as unavailable (fetch failed)
function renderCardUnavailable(card) {
    card.dataset.state = 'unavailable';
    card.dataset.nextUtc = '';

    const badgeEl = card.querySelector('.badge');
    const countdownEl = card.querySelector('.card-countdown');
    const lastCheckedEl = card.querySelector('.last-checked');

    if (badgeEl) {
        badgeEl.className = 'badge badge-unavailable';
        badgeEl.textContent = 'UNAVAILABLE';
    }
    if (countdownEl) {
        countdownEl.textContent = 'Data unavailable';
    }
    if (lastCheckedEl) {
        lastCheckedEl.textContent = '--';
    }
}

// Update all homepage countdowns (recompute only, no network fetches)
function updateHomepageCountdowns() {
    const cards = document.querySelectorAll('.card[data-game]');
    cards.forEach(card => {
        const nextUtc = card.dataset.nextUtc;
        if (!nextUtc) return;

        const countdownEl = card.querySelector('.card-countdown');
        if (!countdownEl) return;

        const diff = getTimeDifference(nextUtc);
        const isUpcoming = card.dataset.type?.startsWith('next-') || card.dataset.type?.includes('reset');

        if (diff <= 0 && isUpcoming) {
            countdownEl.innerHTML = 'Updating...';
        } else {
            countdownEl.innerHTML = formatCardDuration(diff);
        }
    });
}

// Initialize homepage
async function initHomepage() {
    const grid = document.getElementById('game-grid');
    if (!grid) return false; // Not homepage

    const cards = grid.querySelectorAll('.card[data-game]');

    // Fetch all game data in parallel
    const fetchPromises = Array.from(cards).map(async (card) => {
        const game = card.dataset.game;
        const type = card.dataset.type;
        try {
            const data = await fetchGameData(game, type);
            renderCard(card, data);
        } catch {
            renderCardUnavailable(card);
        }
    });

    await Promise.all(fetchPromises);

    // Update countdowns every 60 seconds (recompute time deltas only, no network fetches)
    setInterval(updateHomepageCountdowns, 60000);

    return true;
}

// Auto-initialize on page load
async function init() {
    try {
        // Try homepage first
        const isHomepage = await initHomepage();
        if (isHomepage) return;

        // Otherwise try game page
        initGamePage();
    } catch (error) {
        console.error('[NextReset] Init failed:', error);
        // Page still shows static content - fail-safe preserved
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
