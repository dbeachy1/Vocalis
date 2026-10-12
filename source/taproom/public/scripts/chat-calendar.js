import { moment } from '../lib.js';
import { chat, jumpToMessage } from '../script.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { timestampToMoment } from './utils.js';

const DAY_KEY_FORMAT = 'YYYY-MM-DD';

/**
 * @typedef {object} ChatDay
 * @property {string} key Day key, YYYY-MM-DD.
 * @property {number} firstId Id of the first message sent that day.
 * @property {number} count How many messages were sent that day.
 */

/**
 * Groups the current chat by calendar day.
 *
 * Messages whose send_date is missing or unparseable are skipped rather than bucketed under
 * today — a chat imported without timestamps should show an empty calendar, not a false spike
 * on the day it was opened.
 *
 * @returns {Map<string, ChatDay>} Days that have messages, keyed by YYYY-MM-DD.
 */
export function getChatDays() {
    /** @type {Map<string, ChatDay>} */
    const days = new Map();

    for (let id = 0; id < chat.length; id++) {
        const sendDate = chat[id]?.send_date;

        if (!sendDate) {
            continue;
        }

        const date = timestampToMoment(sendDate);

        if (!date.isValid()) {
            continue;
        }

        const key = date.format(DAY_KEY_FORMAT);
        const existing = days.get(key);

        if (existing) {
            existing.count++;
        } else {
            days.set(key, { key, firstId: id, count: 1 });
        }
    }

    return days;
}

/**
 * Builds the month grid for a given month.
 * @param {import('moment').Moment} month Any moment inside the month to render.
 * @param {Map<string, ChatDay>} days Populated days, from getChatDays.
 * @returns {DocumentFragment}
 */
function renderMonth(month, days) {
    const fragment = document.createDocumentFragment();
    const startOfMonth = month.clone().startOf('month');
    const daysInMonth = startOfMonth.daysInMonth();

    // moment's weekday() is locale-aware, so the grid lines up with whatever day the user's
    // locale starts its week on.
    const leadingBlanks = startOfMonth.weekday();

    const weekdayLabels = moment.weekdaysMin(true);
    for (const label of weekdayLabels) {
        const cell = document.createElement('div');
        cell.classList.add('chat_calendar_weekday');
        cell.textContent = label;
        fragment.append(cell);
    }

    for (let i = 0; i < leadingBlanks; i++) {
        const cell = document.createElement('div');
        cell.classList.add('chat_calendar_day', 'empty');
        fragment.append(cell);
    }

    for (let dayOfMonth = 1; dayOfMonth <= daysInMonth; dayOfMonth++) {
        const date = startOfMonth.clone().date(dayOfMonth);
        const key = date.format(DAY_KEY_FORMAT);
        const day = days.get(key);

        const cell = document.createElement('div');
        cell.classList.add('chat_calendar_day');
        cell.dataset.day = key;

        const number = document.createElement('span');
        number.classList.add('chat_calendar_day_number');
        number.textContent = String(dayOfMonth);
        cell.append(number);

        if (day) {
            cell.classList.add('has_messages');
            cell.dataset.firstId = String(day.firstId);
            cell.tabIndex = 0;
            cell.title = t`${String(day.count)} message(s) — jump to the first one`;

            const dot = document.createElement('span');
            dot.classList.add('chat_calendar_dot');
            cell.append(dot);
        }

        fragment.append(cell);
    }

    return fragment;
}

/**
 * Opens the chat calendar and jumps the chat view to the day the user picks.
 * @returns {Promise<void>}
 */
export async function openChatCalendar() {
    const days = getChatDays();

    if (!days.size) {
        toastr.info(t`No messages in this chat carry a date.`);
        return;
    }

    const dayKeys = Array.from(days.keys()).sort();
    const firstMonth = moment(dayKeys[0], DAY_KEY_FORMAT).startOf('month');
    const lastMonth = moment(dayKeys[dayKeys.length - 1], DAY_KEY_FORMAT).startOf('month');

    let current = lastMonth.clone();

    const container = document.createElement('div');
    container.classList.add('chat_calendar');

    const header = document.createElement('div');
    header.classList.add('chat_calendar_header');

    const previousButton = document.createElement('div');
    previousButton.classList.add('chat_calendar_nav', 'fa-solid', 'fa-chevron-left');
    previousButton.title = t`Previous month`;

    const label = document.createElement('div');
    label.classList.add('chat_calendar_label');

    const nextButton = document.createElement('div');
    nextButton.classList.add('chat_calendar_nav', 'fa-solid', 'fa-chevron-right');
    nextButton.title = t`Next month`;

    header.append(previousButton, label, nextButton);

    const grid = document.createElement('div');
    grid.classList.add('chat_calendar_grid');

    const hint = document.createElement('small');
    hint.classList.add('chat_calendar_hint');
    hint.textContent = t`Days with messages are marked. Click one to jump there.`;

    container.append(header, grid, hint);

    /** Message id to jump to once the popup closes, if any. */
    let pickedId = null;
    /** @type {import('./popup.js').Popup} */
    let popup = null;

    function draw() {
        label.textContent = current.format('MMMM YYYY');
        grid.replaceChildren(renderMonth(current, days));

        // Paging past the ends of the chat has nothing to show, so stop there.
        previousButton.classList.toggle('disabled', !current.isAfter(firstMonth, 'month'));
        nextButton.classList.toggle('disabled', !current.isBefore(lastMonth, 'month'));
    }

    function page(months) {
        const candidate = current.clone().add(months, 'month');

        if (candidate.isBefore(firstMonth, 'month') || candidate.isAfter(lastMonth, 'month')) {
            return;
        }

        current = candidate;
        draw();
    }

    previousButton.addEventListener('click', () => page(-1));
    nextButton.addEventListener('click', () => page(1));

    function pick(cell) {
        if (!(cell instanceof HTMLElement) || !cell.dataset.firstId) {
            return;
        }

        pickedId = Number(cell.dataset.firstId);
        popup?.complete(POPUP_RESULT.AFFIRMATIVE);
    }

    grid.addEventListener('click', (event) => {
        pick(event.target instanceof HTMLElement ? event.target.closest('.chat_calendar_day') : null);
    });

    grid.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        pick(event.target instanceof HTMLElement ? event.target.closest('.chat_calendar_day') : null);
    });

    draw();

    popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        allowVerticalScrolling: true,
    });

    await popup.show();

    if (pickedId !== null) {
        await jumpToMessage(pickedId);
    }
}
