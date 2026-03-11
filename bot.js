import TelegramBot from 'node-telegram-bot-api';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OAUTH_CREDENTIALS_JSON = process.env.OAUTH_CREDENTIALS || fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

// Initialize Anthropic
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Load calendars from calendars.json
let calendarsConfig = [];
try {
  const calendarsPath = path.join(__dirname, 'calendars.json');
  const calendarsData = fs.readFileSync(calendarsPath, 'utf8');
  calendarsConfig = JSON.parse(calendarsData).calendars;
  console.log(`✓ Loaded ${calendarsConfig.length} calendars from calendars.json`);
} catch (error) {
  console.error('✗ Failed to load calendars.json:', error.message);
  process.exit(1);
}

// Load teams from teams.json
let TEAMS = [];
try {
  const teamsPath = path.join(__dirname, 'teams.json');
  const teamsData = fs.readFileSync(teamsPath, 'utf8');
  TEAMS = JSON.parse(teamsData).teams;
  console.log(`✓ Loaded ${TEAMS.length} teams from teams.json`);
} catch (error) {
  console.error('✗ Failed to load teams.json:', error.message);
  process.exit(1);
}

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── OAuth ───────────────────────────────────────────────────────────────────

async function authorize() {
  try {
    const credentials = JSON.parse(OAUTH_CREDENTIALS_JSON);
    const { installed } = credentials;
    const oauth2Client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );
    try {
      const token = fs.readFileSync(TOKEN_PATH, 'utf8');
      oauth2Client.setCredentials(JSON.parse(token));
      console.log('✓ Loaded existing OAuth token');
      return oauth2Client;
    } catch (error) {
      console.log('⚠ No OAuth token found. Attempting to generate...');
      const token = process.env.OAUTH_TOKEN ? JSON.parse(process.env.OAUTH_TOKEN) : null;
      if (token) {
        oauth2Client.setCredentials(token);
        console.log('✓ Using provided OAuth token from environment');
        return oauth2Client;
      } else {
        throw new Error('No OAuth token available. Please run authorization locally first.');
      }
    }
  } catch (error) {
    console.error('✗ OAuth authorization failed:', error.message);
    process.exit(1);
  }
}

let calendar;
let auth;

async function initializeGoogleCalendar() {
  try {
    auth = await authorize();
    calendar = google.calendar({ version: 'v3', auth });
    console.log('✓ Google Calendar API initialized with OAuth');
  } catch (error) {
    console.error('✗ Failed to initialize Google Calendar:', error.message);
    process.exit(1);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

const CST = 'America/Chicago';

function formatTimeCST(dateTimeStr) {
  const date = new Date(dateTimeStr);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: CST });
}

function formatDateCST(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return {
    dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
    dateStr: date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    dayShort: date.toLocaleDateString('en-US', { weekday: 'short' }),
  };
}

function getTodayCST() {
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: CST }));
  const y = cst.getFullYear();
  const m = String(cst.getMonth() + 1).padStart(2, '0');
  const d = String(cst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Split a long message into chunks at natural line breaks, under maxLen chars
function chunkMessage(text, maxLen = 4000) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = current.length === 0 ? line : current + '\n' + line;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

// Send a potentially long message as multiple chunks
async function sendChunked(chatId, text, options = {}) {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, options);
  }
}

const SNAPSHOT_EXCLUDE_KEYWORDS = [
  'birthday', 'hotel', 'flight', 'stay', 'workout', 'pro day',
  'pro workout', 'reservation', 'departs', 'arrives', 'layover'
];

function isSnapshotExcluded(summary) {
  if (!summary) return true;
  const lower = summary.toLowerCase();
  return SNAPSHOT_EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── Weather ─────────────────────────────────────────────────────────────────

// Simple in-memory cache: { "City, ST": { data, fetchedAt } }
const weatherCache = {};
const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getWeatherEmoji(weatherId, precipitation) {
  if (precipitation >= 70) return '🌧';
  if (precipitation >= 40) return '🌦';
  if (weatherId >= 200 && weatherId < 300) return '⛈';
  if (weatherId >= 300 && weatherId < 600) return '🌧';
  if (weatherId >= 600 && weatherId < 700) return '🌨';
  if (weatherId >= 700 && weatherId < 800) return '🌫';
  if (weatherId === 800) return precipitation >= 20 ? '🌤' : '☀️';
  if (weatherId > 800) return '⛅';
  return '🌤';
}

async function getWeatherForLocation(location) {
  if (!OPENWEATHER_API_KEY || !location) return null;

  const cacheKey = location.trim().toLowerCase();
  const cached = weatherCache[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
    const geoRes = await axios.get(geoUrl, { timeout: 5000 });
    if (!geoRes.data || geoRes.data.length === 0) return null;

    const { lat, lon } = geoRes.data[0];
    const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=imperial&cnt=40`;
    const weatherRes = await axios.get(weatherUrl, { timeout: 5000 });

    const result = { forecasts: weatherRes.data.list };
    weatherCache[cacheKey] = { data: result, fetchedAt: Date.now() };
    return result;
  } catch (err) {
    console.warn(`⚠ Weather fetch failed for "${location}": ${err.message}`);
    return null;
  }
}

// Find the closest forecast entry to a given datetime string
function getForecastForTime(forecasts, dateTimeStr) {
  if (!forecasts || forecasts.length === 0) return null;
  const target = new Date(dateTimeStr).getTime();
  let closest = null;
  let minDiff = Infinity;
  for (const f of forecasts) {
    const diff = Math.abs(f.dt * 1000 - target);
    if (diff < minDiff) {
      minDiff = diff;
      closest = f;
    }
  }
  return closest;
}

async function getWeatherTag(event) {
  if (!event.start.dateTime || !event.location) return '';
  try {
    const locationStr = event.location.split('—').pop().trim(); // use city portion if "Venue — City, ST"
    const weatherData = await getWeatherForLocation(locationStr);
    if (!weatherData) return '';

    const forecast = getForecastForTime(weatherData.forecasts, event.start.dateTime);
    if (!forecast) return '';

    const temp = Math.round(forecast.main.temp);
    const precipPct = Math.round((forecast.pop || 0) * 100);
    const weatherId = forecast.weather[0]?.id || 800;
    const emoji = getWeatherEmoji(weatherId, precipPct);

    return ` ${emoji} ${temp}°F, ${precipPct}% precip`;
  } catch (err) {
    return '';
  }
}

// ─── Calendar Fetching ───────────────────────────────────────────────────────

async function getCalendarEvents(daysAhead = 3, startDate = null) {
  try {
    let now;
    if (startDate) {
      const [y, m, d] = startDate.split('-').map(Number);
      now = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      now = new Date();
    }
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + daysAhead);
    endDate.setHours(23, 59, 59, 999);

    let allEvents = [];
    for (const cal of calendarsConfig) {
      try {
        const response = await calendar.events.list({
          calendarId: cal.id,
          timeMin: now.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
        });
        const events = response.data.items || [];
        events.forEach((event) => {
          event.calendarName = cal.name;
          event.calendarPersonal = cal.personal === true;
        });
        allEvents = allEvents.concat(events);
      } catch (error) {
        console.warn(`⚠ Failed to fetch from ${cal.name}:`, error.message);
      }
    }

    allEvents.sort((a, b) => {
      const timeA = new Date(a.start.dateTime || a.start.date);
      const timeB = new Date(b.start.dateTime || b.start.date);
      return timeA - timeB;
    });

    return allEvents;
  } catch (error) {
    console.error('✗ Failed to fetch calendar events:', error.message);
    return [];
  }
}

// ─── Calendar Formatter ──────────────────────────────────────────────────────

async function formatCalendar(events) {
  if (!events || events.length === 0) {
    return '📅 No events found.';
  }

  const eventsByDate = {};

  for (const event of events) {
    if (event.calendarPersonal) continue;
    const startDate = event.start.dateTime ? event.start.dateTime.split('T')[0] : event.start.date;
    if (!eventsByDate[startDate]) eventsByDate[startDate] = [];
    eventsByDate[startDate].push(event);
  }

  let output = '🧭 *Morning Baseball Chron*\n───\n';

  for (const date of Object.keys(eventsByDate).sort()) {
    const { dayName, dateStr } = formatDateCST(date);
    output += `📅 *${dayName}, ${dateStr}*\n`;

    for (const event of eventsByDate[date]) {
      let timeStr = '• ';
      const isBirthday = event.summary && event.summary.toLowerCase().includes('birthday');

      if (event.start.dateTime) {
        timeStr += formatTimeCST(event.start.dateTime);
        timeStr += ` — ${event.summary}`;
        if (event.location) timeStr += ` (${event.location})`;
        // Add weather for timed events with a location
        const weatherTag = await getWeatherTag(event);
        timeStr += weatherTag;
      } else if (isBirthday) {
        timeStr += `🎂 ${event.summary}`;
      } else {
        timeStr += `All day — ${event.summary}`;
        if (event.location) timeStr += ` (${event.location})`;
      }

      output += `${timeStr}\n`;
    }
    output += '\n';
  }

  return output;
}

// ─── Program Snapshot Formatter ──────────────────────────────────────────────

async function formatProgramSnapshot(events) {
  if (!events || events.length === 0) {
    return '📊 No games found.';
  }

  const eventsByTeam = {};

  for (const event of events) {
    if (event.calendarPersonal) continue;
    if (!isSnapshotExcluded(event.summary) && event.start.dateTime) {
      const teamName = event.calendarName || 'Other';
      if (!eventsByTeam[teamName]) eventsByTeam[teamName] = [];
      eventsByTeam[teamName].push(event);
    }
  }

  if (Object.keys(eventsByTeam).length === 0) {
    return '📊 No games found in the selected date range.';
  }

  let output = '📊 *Program Snapshot*\n───\n';

  for (const team of Object.keys(eventsByTeam).sort()) {
    output += `• *${team}* — `;
    const gameList = eventsByTeam[team].map((g) => {
      let dayTime = '';
      if (g.start.dateTime) {
        const dayShort = new Date(g.start.dateTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: CST });
        const time = formatTimeCST(g.start.dateTime);
        dayTime = `(${dayShort}/${time}) `;
      } else if (g.start.date) {
        const { dayShort } = formatDateCST(g.start.date);
        dayTime = `(${dayShort}) `;
      }
      const location = g.location ? ` (${g.location})` : '';
      return `${dayTime}${g.summary}${location}`;
    }).join('; ');
    output += `${gameList}\n`;
  }

  return output;
}

// ─── ESPN/NCAA Scores ─────────────────────────────────────────────────────────

async function espnScores(dateStr = null) {
  try {
    let targetDate;
    if (!dateStr) {
      targetDate = new Date();
    } else {
      targetDate = new Date(dateStr);
      if (isNaN(targetDate)) {
        return '❌ Invalid date format. Use YYYY-MM-DD (e.g., 2026-03-08)';
      }
    }

    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day}`;
    const url = `https://www.ncaa.com/scoreboard/baseball/d1/${year}/${month}/${day}/all-conf`;

    console.log(`Fetching NCAA scores from: ${url}`);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const scores = [];

    $('div.gamePod.gamePod-type-game').each((i, gameEl) => {
      const gameContainer = $(gameEl);
      const teamItems = gameContainer.find('ul.gamePod-game-teams li');
      if (teamItems.length >= 2) {
        const team1Name = teamItems.eq(0).find('span.gamePod-game-team-name:not(.short)').first().text().trim();
        const team1Score = teamItems.eq(0).find('span.gamePod-game-team-score').text().trim();
        const team2Name = teamItems.eq(1).find('span.gamePod-game-team-name:not(.short)').first().text().trim();
        const team2Score = teamItems.eq(1).find('span.gamePod-game-team-score').text().trim();
        if ((TEAMS.includes(team1Name) || TEAMS.includes(team2Name)) && team1Name && team2Name && team1Score && team2Score) {
          scores.push(`${team1Name} ${team1Score} ${team2Name} ${team2Score} F`);
        }
      }
    });

    if (scores.length === 0) {
      return `📊 No games found for your teams on ${formattedDate}\n\nTip: Scores may not be available yet. Try again after games complete.`;
    }

    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let output = `📊 NCAA Baseball Scores — ${dayName}, ${monthDay}\n───\n`;
    scores.forEach((score) => { output += score + '\n'; });
    return output;
  } catch (error) {
    console.error('✗ NCAA scrape error:', error.message);
    return '❌ Failed to fetch scores. Please try again later.';
  }
}

// ─── Scheduled Chron ─────────────────────────────────────────────────────────

async function sendCalendarChron() {
  try {
    console.log('⏰ Sending calendar chron...');
    const events = await getCalendarEvents(3);
    const message = await formatCalendar(events);
    if (!message || message.length === 0) {
      console.log('⚠ Chron message is empty');
      return;
    }
    await sendChunked(CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`✓ Sent calendar chron to ${CHAT_ID}`);
  } catch (error) {
    console.error('✗ Failed to send calendar chron:', error.message);
  }
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

function parseCalendarArgs(argStr) {
  if (!argStr || argStr.trim() === '') {
    return { startDate: null, daysAhead: 3 };
  }
  const parts = argStr.trim().split(/\s+/);
  let startDate = null;
  let daysAhead = 1;

  for (const part of parts) {
    if (part.toLowerCase() === 'today') {
      startDate = getTodayCST();
    } else if (/^\+\d+$/.test(part)) {
      daysAhead = parseInt(part.slice(1));
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
      startDate = part;
    }
  }

  if (!startDate && daysAhead !== 1) {
    return { startDate: null, daysAhead };
  }

  return { startDate, daysAhead };
}

// ─── Help Text ────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  '⚾ Morning Baseball Chron — Command Guide',
  '───',
  '',
  '📅 Calendar',
  '/calendar — Next 3 days',
  '/calendar +N — Next N days',
  '/calendar today — Today only',
  '/calendar YYYY-MM-DD — Specific date',
  '/calendar YYYY-MM-DD +N — N days from date',
  '',
  '📊 Program Snapshot',
  '/program_snapshot — Team schedule (3 days)',
  '',
  '🗺 Game States',
  '/game_states — Games grouped by state (3 days)',
  '/game_states +N — N days',
  '',
  '📊 Scores',
  '/espn_scores — Today\'s NCAA scores',
  '/espn_scores YYYY-MM-DD — Specific date',
  '',
  'ℹ️ General',
  '/start — Bot status',
  '/help — This guide',
].join('\n');

// ─── Command Handlers ─────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '⚾ Scouting Bot is running!\n\nType /help for a full command guide.');
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT);
});

bot.onText(/\/calendar(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const { startDate, daysAhead } = parseCalendarArgs(match[1]);
    console.log(`📅 /calendar: startDate=${startDate || 'today'}, daysAhead=${daysAhead}`);
    const events = await getCalendarEvents(daysAhead, startDate);
    const message = await formatCalendar(events);
    await sendChunked(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ /calendar error:', error);
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

bot.onText(/\/program_snapshot(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const { startDate, daysAhead } = parseCalendarArgs(match[1] || '');
    console.log(`📊 /program_snapshot: startDate=${startDate || 'today'}, daysAhead=${daysAhead}`);
    const events = await getCalendarEvents(daysAhead, startDate);
    const message = await formatProgramSnapshot(events);
    await sendChunked(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ /program_snapshot error:', error);
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// State priority order for /game_states
const STATE_PRIORITY = ['IL', 'WI', 'IA', 'MN', 'SD', 'ND'];

function extractState(location) {
  if (!location) return null;
  // Match 2-letter state abbreviation, e.g. "Iowa City, IA" or "Iowa City, IA — Venue"
  const match = location.match(/\b([A-Z]{2})\b/g);
  if (!match) return null;
  // Return last 2-letter match (usually the state)
  return match[match.length - 1];
}

function sortStateKeys(states) {
  return Object.keys(states).sort((a, b) => {
    const ai = STATE_PRIORITY.indexOf(a);
    const bi = STATE_PRIORITY.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

async function formatGameStates(events) {
  if (!events || events.length === 0) return '🗺 No games found.';

  const byState = {};

  for (const event of events) {
    if (event.calendarPersonal) continue;
    if (isSnapshotExcluded(event.summary)) continue;
    if (!event.start.dateTime) continue;
    if (!event.location) continue;

    const state = extractState(event.location);
    if (!state) continue;

    if (!byState[state]) byState[state] = [];
    byState[state].push(event);
  }

  if (Object.keys(byState).length === 0) {
    return '🗺 No games with locations found in the selected date range.';
  }

  // Determine date range label
  const allDates = Object.values(byState).flat().map(e => e.start.dateTime.split('T')[0]);
  allDates.sort();
  const { dateStr: firstDate } = formatDateCST(allDates[0]);

  let output = `🗺 *Game States — from ${firstDate}*\n───\n`;

  for (const state of sortStateKeys(byState)) {
    output += `\n🏟 *${state}*\n`;
    const games = byState[state].sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
    for (const g of games) {
      const dayShort = new Date(g.start.dateTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: CST });
      const time = formatTimeCST(g.start.dateTime);
      output += `• ${dayShort}/${time} — ${g.summary} (${g.location})\n`;
    }
  }

  return output;
}

bot.onText(/\/game_states(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const { startDate, daysAhead } = parseCalendarArgs(match[1] || '');
    console.log(`🗺 /game_states: startDate=${startDate || 'today'}, daysAhead=${daysAhead}`);
    const events = await getCalendarEvents(daysAhead, startDate);
    const message = await formatGameStates(events);
    await sendChunked(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ /game_states error:', error);
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

bot.onText(/\/espn_scores(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateArg = match[1] ? match[1].trim() : null;
  const dateStr = (dateArg && dateArg.toLowerCase() !== 'today') ? dateArg : null;
  try {
    const scores = await espnScores(dateStr);
    await bot.sendMessage(chatId, scores, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// ─── Cron ─────────────────────────────────────────────────────────────────────

// 7 AM Central daily
cron.schedule('0 12 * * *', () => {
  console.log('⏰ Running scheduled calendar chron...');
  sendCalendarChron();
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

process.on('SIGINT', () => { console.log('\n✓ Bot shutting down'); bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n✓ Bot shutting down'); bot.stopPolling(); process.exit(0); });

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Starting Scouting Bot with OAuth...');
  await initializeGoogleCalendar();
  bot.on('polling_error', (error) => { console.error('✗ Polling error:', error); });
  console.log('✓ Bot is running and listening for commands');
  console.log(`✓ Calendar chron scheduled for 7 AM Central daily`);
  console.log(`✓ Chat ID: ${CHAT_ID}`);
  console.log(`✓ Reading from ${calendarsConfig.length} calendars`);
}

main();
