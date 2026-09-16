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

// Format a day-precision value as the date it actually is: "September 23, 2026" (UTC, as published).
function formatEventDate(isoString) {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

// Shorter form for homepage cards: "Sep 23".
function formatCardDate(isoString) {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

// Only a value the pipeline states is exact may be shown as a time or counted down to the second.
// A payload with no precision field is not such a value: its midnight is where the date had to be
// stored, not a time anyone announced. The build applies the same rule, so hydration cannot turn a
// date into a countdown to an invented midnight.
function isDayPrecision(data) {
    return !!data && data.precision !== 'exact';
}

// Topics that answer "when is the next ...": the value is only an answer while it is still ahead.
function isFutureFacing(type) {
    return !!type && (type.indexOf('next-') === 0 || type.indexOf('reset') !== -1);
}

// A future-facing date that has passed and was not re-verified is no longer an answer. A date that
// has only just passed while the data is fresh is a normal moment in the cycle.
function isUnanswered(data, nowMs) {
    if (!data || !data.nextEventUtc || !isFutureFacing(data.type)) return false;
    const at = new Date(data.nextEventUtc).getTime();
    if (isNaN(at)) return false;
    // A date-only value (or one with no stated precision) is announced for a day, not an instant, so
    // it stays the answer until that whole UTC day is over. Mirrors isUnanswered in render-pages.ts.
    const over = at + (data.precision === 'exact' ? 0 : 86400000);
    if (over >= nowMs) return false;
    return data.status === 'stale' || (nowMs - over) > 86400000;
}

// Repairs values a V1 provider concatenated without spaces ("Red Dead OnlineSeptember 1, 2026Distill…").
// Mirrors tidyNotes in scripts/render-pages.ts, so hydration cannot undo the server-rendered repair.
function tidyNotes(value) {
    var months = 'January|February|March|April|May|June|July|August|September|October|November|December';
    return String(value)
        .replace(new RegExp('([a-z])(' + months + ')\\b', 'g'), '$1 $2')
        .replace(/(\d{4})([A-Z])/g, '$1 $2');
}

// Only a sentence produced for visitors may be shown. A provider's own message (which has no
// reason_code) is never rendered: it can be a crash string, a URL or an environment variable name.
function publicStateNote(data) {
    if (!data) return '';
    if (data.status === 'stale') {
        return data.reason_code && data.reason ? data.reason : 'Showing the last verified value; the official source could not be checked';
    }
    if (data.status === 'unavailable') {
        var vetted = data.reason_code ? (data.explanation || data.reason) : '';
        return vetted || 'No verified value is available right now';
    }
    return '';
}

var NO_DATE_NOTE = 'We have not found a verified official date. NextReset will show it as soon as it can be verified from an official source.';

/**
 * What the tracker should show: a date when the source states only a date, a countdown (or time
 * since) when the instant is exact, and "Updating..." while an upcoming exact event is re-checked.
 */
function eventDisplay(data, nowMs) {
    if (isUnanswered(data, nowMs)) {
        return { mode: 'unanswered', label: 'Status', value: 'No official date announced' };
    }
    const diff = new Date(data.nextEventUtc).getTime() - nowMs;
    const isFuture = diff > 0;
    const isUpcoming = data.type ? (data.type.indexOf('next-') === 0 || data.type.indexOf('reset') !== -1) : false;

    if (isDayPrecision(data)) {
        return { mode: 'date', label: isFuture ? 'Official Date' : 'Date', value: formatEventDate(data.nextEventUtc) };
    }
    if (!isFuture && isUpcoming) {
        return { mode: 'updating', label: 'Status', value: 'Updating...' };
    }
    return { mode: 'countdown', label: isFuture ? 'Time Until Event' : 'Time Since Event', value: formatDuration(diff) };
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

        const unavailableNote = publicStateNote(data);
        if (notesEl && unavailableNote) {
            notesEl.textContent = unavailableNote;
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
        const sourceName = data.sourceName || data.title || data.source?.name || 'Official Source';
        if (sourceUrl) {
            sourceEl.innerHTML = `<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceName}</a>`;
        } else {
            sourceEl.textContent = sourceName;
        }
    }

    // Update confidence. An unanswered tracker reports none: the stored confidence described the
    // expired value, not the answer now being shown.
    if (confidenceEl) {
        const confidence = isUnanswered(data, Date.now()) ? 'none' : data.confidence;
        confidenceEl.textContent = confidence;
        confidenceEl.className = `confidence confidence-${confidence}`;
    }

    // Update notes, repaired the same way the build repairs them. A predicted date is never shown: the
    // old Fortnite branch appended the V1 provider's own guess at when a season might end.
    const notes = data.notes ? tidyNotes(data.notes) : '';

    if (notesEl && notes) {
        notesEl.innerText = notes;
        notesEl.style.display = 'block';
    }

    // A provider's own message is never shown; only the sentence publicStateNote allows.
    if (data.status === 'stale' && notesEl) {
        notesEl.textContent = publicStateNote(data);
        notesEl.style.display = 'block';
    }

    const statusEl = document.getElementById('tracker-status');

    // A deadline can pass while the page is open, so every part of the page moves together rather than
    // leaving the countdown saying "no date announced" beside a status row still claiming verification.
    function applyUnanswered() {
        if (notesEl) {
            notesEl.textContent = NO_DATE_NOTE;
            notesEl.style.display = 'block';
        }
        if (statusEl) statusEl.textContent = 'No verified official date';
        if (confidenceEl) {
            confidenceEl.textContent = 'none';
            confidenceEl.className = 'confidence confidence-none';
        }
    }

    // Update dynamic fields
    function tick() {
        const display = eventDisplay(data, Date.now());
        if (display.mode === 'unanswered') applyUnanswered();

        if (countdownEl) {
            let valueClass = display.mode === 'countdown' && new Date(data.nextEventUtc).getTime() <= Date.now()
                ? 'countdown-value elapsed'
                : 'countdown-value';
            if (display.mode === 'unanswered') valueClass = 'countdown-value unavailable';

            // Add stale class if using cached data
            if (data.status === 'stale' && display.mode !== 'unanswered') {
                valueClass += ' stale';
            }

            countdownEl.innerHTML = `
                <div class="countdown-label">${display.label}</div>
                <div class="${valueClass}">${display.value}</div>
            `;
        }

        if (updatedEl) {
            const lastUpdated = data.fetched_at_utc || data.lastUpdatedUtc;
            updatedEl.textContent = lastUpdated ? formatTimeSince(lastUpdated) : 'Never';
        }
    }

    // Initial update
    tick();

    // A date does not tick. Only the "last checked" line keeps moving for day-precision values.
    setInterval(tick, isDayPrecision(data) ? 60000 : 1000);
}

// Show error message.
//
// The build renders the verified value into this page, so a failed refresh means there is nothing
// newer to show — not that what is shown became untrue. A rendered page therefore keeps its value,
// its source and its "last checked" time, and only a page still showing the skeleton is replaced.
function showError(message) {
    const container = document.getElementById('countdown-container');
    if (container && container.querySelector && !container.querySelector('.countdown-skeleton')) return;
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

    const unanswered = !!data && isUnanswered(data, Date.now());

    if (unanswered) {
        // A card must not badge an expired date as LIVE, nor count time since it.
        state = 'unavailable';
        badgeText = 'NO DATE';
        badgeClass = 'badge badge-unavailable';
    } else if (data && !isDataUnavailable(data)) {
        // Staleness describes the value, not whether its date has passed: a last-verified value whose
        // source cannot be reached is stale whichever side of the date we are on. Badging a past event
        // LIVE would also contradict the badge the build rendered into this same card.
        state = data.status === 'stale' ? 'stale' : 'live';
        badgeText = state === 'stale' ? 'STALE' : 'LIVE';
        badgeClass = state === 'stale' ? 'badge badge-stale' : 'badge badge-live';
    }

    // Update card state. A value the pipeline has rejected — no confidence, a fallback status — leaves
    // no instant behind: the updater works from these attributes and would count down to it.
    const usable = !!data && !isDataUnavailable(data);
    card.dataset.state = state;
    card.dataset.nextUtc = usable ? data.nextEventUtc : '';
    card.dataset.type = data?.type || '';
    card.dataset.precision = usable ? data.precision || '' : '';
    card.dataset.unanswered = unanswered ? '1' : '';
    // Kept so the periodic updater can re-evaluate the state as deadlines pass.
    card.dataset.status = usable ? data.status || '' : '';
    // Kept so "checked 2 hours ago" keeps counting on a tab left open, instead of freezing at the
    // moment the page loaded.
    card.dataset.checkedUtc = data?.fetched_at_utc || data?.lastUpdatedUtc || '';

    // Update badge
    if (badgeEl) {
        badgeEl.className = badgeClass;
        badgeEl.textContent = badgeText;
    }

    // Update countdown. The build renders a full date here; a sentence and a date need the smaller
    // size, a countdown does not, so the class moves with the value instead of being left behind.
    if (countdownEl) {
        let compact = false;
        if (data && !isDataUnavailable(data)) {
            const display = eventDisplay(data, Date.now());
            if (display.mode === 'unanswered') {
                countdownEl.textContent = 'No official date announced';
                compact = true;
            } else if (display.mode === 'date') {
                countdownEl.textContent = formatCardDate(data.nextEventUtc);
            } else if (display.mode === 'updating') {
                countdownEl.innerHTML = 'Updating...';
            } else {
                countdownEl.innerHTML = formatCardDuration(getTimeDifference(data.nextEventUtc));
            }
        } else {
            countdownEl.textContent = 'Data unavailable';
        }
        countdownEl.className = compact ? 'card-countdown is-text' : 'card-countdown';
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
    card.dataset.checkedUtc = '';

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

// The heading text the build writes for the unanswered group (GROUP_HEADINGS in scripts/render-home.ts).
const UNANSWERED_HEADING = 'Waiting on an official source';

// A card whose date expires while the page is open has left the group the build put it in, and a
// heading it no longer belongs under would contradict the page. That group is the last one, so moving
// the card to the end of the grid is the whole of the regrouping; a heading left with no cards beneath
// it is then removed, since an empty section is worse than no section.
function regroupAsUnanswered(card) {
    const grid = card.parentNode;
    if (!grid || typeof grid.appendChild !== 'function') return;

    let heading = grid.querySelector('.group-heading[data-group="unknown"]');
    if (!heading) {
        heading = document.createElement('h2');
        heading.className = 'group-heading';
        heading.setAttribute('data-group', 'unknown');
        heading.textContent = UNANSWERED_HEADING;
        grid.appendChild(heading);
    }
    grid.appendChild(card);

    const children = Array.from(grid.children || []);
    children.forEach((node, i) => {
        if (!node.classList || !node.classList.contains('group-heading')) return;
        const next = children[i + 1];
        if (!next || (next.classList && next.classList.contains('group-heading'))) {
            if (node.parentNode) node.parentNode.removeChild(node);
        }
    });
}

// Update all homepage countdowns (recompute only, no network fetches)
function updateHomepageCountdowns() {
    const cards = document.querySelectorAll('.card[data-game]');
    cards.forEach(card => {
        // "Checked 2 hours ago" stops being true two hours later, so it is recomputed every cycle from
        // the instant itself rather than written once at load.
        const checkedEl = card.querySelector('.last-checked');
        if (checkedEl && card.dataset.checkedUtc) {
            checkedEl.textContent = `Checked ${formatTimeSince(card.dataset.checkedUtc)}`;
        }

        const nextUtc = card.dataset.nextUtc;
        if (!nextUtc) return;

        const countdownEl = card.querySelector('.card-countdown');
        if (!countdownEl) return;

        // A deadline can pass while the page is open, so the state is recomputed rather than trusted
        // from load time. Once a card is unanswered it stays that way until new data arrives.
        const snapshot = {
            nextEventUtc: nextUtc,
            type: card.dataset.type,
            precision: card.dataset.precision,
            status: card.dataset.status
        };
        if (isUnanswered(snapshot, Date.now())) {
            if (card.dataset.unanswered !== '1') {
                card.dataset.unanswered = '1';
                card.dataset.state = 'unavailable';
                const badgeEl = card.querySelector('.badge');
                if (badgeEl) {
                    badgeEl.className = 'badge badge-unavailable';
                    badgeEl.textContent = 'NO DATE';
                }
                regroupAsUnanswered(card);
            }
            countdownEl.textContent = 'No official date announced';
            countdownEl.className = 'card-countdown is-text';
            return;
        }

        // A date does not need recomputing, and must never turn into a countdown. Anything the pipeline
        // has not stated is exact is a date (see isDayPrecision).
        if (card.dataset.precision !== 'exact') return;

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
            // The build already wrote a verified value into this card. Replacing it with "Data
            // unavailable" because this one fetch failed would destroy good content, so only a card the
            // build had nothing to publish for is emptied.
            if (!card.dataset.nextUtc) renderCardUnavailable(card);
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

// Guarded so the display helpers above can be loaded and tested outside a browser.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
