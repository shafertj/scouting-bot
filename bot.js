import TelegramBot from 'node-telegram-bot-api';
import { google } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';
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

// Load or create OAuth token
async function authorize() {
  try {
    const credentials = JSON.parse(OAUTH_CREDENTIALS_JSON);
    const { installed } = credentials;

    const oauth2Client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );

    // Try to load existing token
    try {
      const token = fs.readFileSync(TOKEN_PATH, 'utf8');
      oauth2Client.setCredentials(JSON.parse(token));
      console.log('✓ Loaded existing OAuth token');
      return oauth2Client;
    } catch (error) {
      // No token exists, need to authorize
      console.log('⚠ No OAuth token found. Attempting to generate...');
      
      // For Railway (headless), we'll use a service account workaround
      // But ideally, this should be done locally first
      console.log('ℹ First deployment detected. Authorization may be needed.');
      console.log('ℹ Using service account as fallback for now...');
      
      // Create a new token with refresh token from environment if available
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

// Initialize Google Calendar API
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

// Keywords that exclude an event from Program Snapshot (but still show in daily Chron)
const SNAPSHOT_EXCLUDE_KEYWORDS = [
  'birthday', 'hotel', 'flight', 'stay', 'workout', 'pro day',
  'pro workout', 'reservation', 'departs', 'arrives', 'layover'
];

const CST = 'America/Chicago';

function formatTimeCST(dateTimeStr) {
  const date = new Date(dateTimeStr);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: CST });
}

function formatDateCST(dateStr) {
  // All-day events come as YYYY-MM-DD — parse without timezone shift
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return {
    dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
    dateStr: date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    dayShort: date.toLocaleDateString('en-US', { weekday: 'short' }),
  };
}

function isSnapshotExcluded(summary) {
  if (!summary) return true;
  const lower = summary.toLowerCase();
  return SNAPSHOT_EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

// Format calendar events into "Morning Baseball Chron" with 2 sections
async function formatCalendarChron(events) {
  if (!events || events.length === 0) {
    return '📅 No events found for the next 3 days.';
  }

  // Group events by date
  const eventsByDate = {};
  const eventsByTeam = {};

  // Process events
  for (const event of events) {
    // Skip personal calendar events entirely
    if (event.calendarPersonal) continue;

    const startDate = event.start.dateTime ? event.start.dateTime.split('T')[0] : event.start.date;

    if (!eventsByDate[startDate]) {
      eventsByDate[startDate] = [];
    }
    eventsByDate[startDate].push(event);

    // Group by team for Program Snapshot — exclude non-game events
    if (!isSnapshotExcluded(event.summary) && event.start.dateTime) {
      const teamName = event.calendarName || 'Other';
      if (!eventsByTeam[teamName]) {
        eventsByTeam[teamName] = [];
      }
      eventsByTeam[teamName].push(event);
    }
  }

  // SECTION 1: Daily Chron
  let output = '🧭 *Morning Baseball Chron*\n───\n';

  Object.keys(eventsByDate)
    .sort()
    .forEach((date) => {
      const { dayName, dateStr } = formatDateCST(date);

      output += `📅 *${dayName}, ${dateStr}*\n`;

      eventsByDate[date].forEach((event) => {
        let timeStr = '• ';
        const isBirthday = event.summary && event.summary.toLowerCase().includes('birthday');
        if (event.start.dateTime) {
          timeStr += formatTimeCST(event.start.dateTime);
          timeStr += ` — ${event.summary}`;
        } else if (isBirthday) {
          timeStr += `🎂 ${event.summary}`;
        } else {
          timeStr += `All day — ${event.summary}`;
        }

        if (event.location) {
          timeStr += ` (${event.location})`;
        }

        output += `${timeStr}\n`;
      });

      output += '\n';
    });

  // SECTION 2: Program Snapshot
  output += '📊 *Program Snapshot*\n───\n';

  Object.keys(eventsByTeam)
    .sort()
    .forEach((team) => {
      output += `• *${team}* — `;
      const games = eventsByTeam[team];
      const gameList = games.map((g) => {
        // Get day and time
        let dayTime = '';
        if (g.start.dateTime) {
          const dayShort = new Date(g.start.dateTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' });
          const time = formatTimeCST(g.start.dateTime);
          dayTime = `(${dayShort}/${time}) `;
        } else if (g.start.date) {
          const { dayShort } = formatDateCST(g.start.date);
          dayTime = `(${dayShort}) `;
        }
        
        const opponent = g.summary;
        const location = g.location ? ` (${g.location})` : '';
        return `${dayTime}${opponent}${location}`;
      }).join('; ');
      output += `${gameList}\n`;
    });

  return output;
}

// Fetch calendar events from all calendars for next N days, with optional start date
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
    endDate.setHours(23, 59, 59, 999); // include full final day

    let allEvents = [];

    // Fetch from each calendar
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

    // Sort by start time
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

// Scrape NCAA for college baseball scores
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const scores = [];

    // Debug: Check if page loaded and has content
    const pageLength = $('body').html().length;
    console.log(`Page loaded, size: ${pageLength} bytes`);

    // Find each game pod container
    const gamePods = $('div.gamePod');
    console.log(`Found ${gamePods.length} total gamePod elements`);

    const gameTypeGames = $('div.gamePod.gamePod-type-game');
    console.log(`Found ${gameTypeGames.length} gamePod-type-game elements`);

    // Find each game pod container
    $('div.gamePod.gamePod-type-game').each((i, gameEl) => {
      const gameContainer = $(gameEl);
      
      // Get team list items
      const teamItems = gameContainer.find('ul.gamePod-game-teams li');
      
      console.log(`Game ${i}: Found ${teamItems.length} team items`);
      
      if (teamItems.length >= 2) {
        // Get first team
        const team1El = teamItems.eq(0);
        const team1Name = team1El.find('span.gamePod-game-team-name:not(.short)').first().text().trim();
        const team1Score = team1El.find('span.gamePod-game-team-score').text().trim();

        // Get second team
        const team2El = teamItems.eq(1);
        const team2Name = team2El.find('span.gamePod-game-team-name:not(.short)').first().text().trim();
        const team2Score = team2El.find('span.gamePod-game-team-score').text().trim();

        console.log(`Game ${i}: ${team1Name} vs ${team2Name}`);

        // Check if any of our teams are in this game
        const hasTeam1 = TEAMS.includes(team1Name);
        const hasTeam2 = TEAMS.includes(team2Name);

        console.log(`Game ${i}: hasTeam1=${hasTeam1}, hasTeam2=${hasTeam2}`);

        if ((hasTeam1 || hasTeam2) && team1Name && team2Name && team1Score && team2Score) {
          scores.push(`${team1Name} ${team1Score} ${team2Name} ${team2Score} F`);
          console.log(`✓ Found game: ${team1Name} ${team1Score} ${team2Name} ${team2Score}`);
        }
      }
    });

    if (scores.length === 0) {
      return `📊 No games found for your teams on ${formattedDate}\n\nTip: Scores may not be available yet. Try again after games complete.`;
    }

    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let output = `📊 NCAA Baseball Scores — ${dayName}, ${monthDay}\n───\n`;
    scores.forEach((score) => {
      output += score + '\n';
    });

    return output;
  } catch (error) {
    console.error('✗ NCAA scrape error:', error.message);
    return `❌ Failed to fetch scores. Please try again later.`;
  }
}

// Send calendar chron to chat
async function sendCalendarChron() {
  try {
    console.log('⏰ Sending calendar chron...');
    const events = await getCalendarEvents(3);
    const message = await formatCalendarChron(events);
    
    if (!message || message.length === 0) {
      console.log('⚠ Chron message is empty');
      return;
    }
    
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`✓ Sent calendar chron to ${CHAT_ID}`);
  } catch (error) {
    console.error('✗ Failed to send calendar chron:', error.message);
  }
}

// Parse calendar command arguments
// Supported formats:
//   /calendar              → next 3 days from today
//   /calendar +7           → next 7 days from today
//   /calendar 2026-03-15   → 1 day starting Mar 15
//   /calendar 2026-03-15 +7 → 7 days starting Mar 15
function getTodayCST() {
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const y = cst.getFullYear();
  const m = String(cst.getMonth() + 1).padStart(2, '0');
  const d = String(cst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseCalendarArgs(argStr) {
  if (!argStr || argStr.trim() === '') {
    return { startDate: null, daysAhead: 3 };
  }

  const parts = argStr.trim().split(/\s+/);
  let startDate = null;
  let daysAhead = 1; // default for specific date = just that day

  for (const part of parts) {
    if (part.toLowerCase() === 'today') {
      startDate = getTodayCST();
    } else if (/^\+\d+$/.test(part)) {
      daysAhead = parseInt(part.slice(1));
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
      startDate = part;
    }
  }

  // If only a +N was given with no date, start from today with N days
  if (!startDate && daysAhead !== 1) {
    return { startDate: null, daysAhead };
  }

  return { startDate, daysAhead };
}

// Bot command handlers
const HELP_TEXT = [
  '⚾ Morning Baseball Chron — Command Guide',
  '───',
  '',
  '📅 Calendar',
  '/calendar — Next 3 days from today',
  '/calendar +N — Next N days from today',
  '   Example: /calendar +7',
  '/calendar today — Just today',
  '/calendar YYYY-MM-DD — Specific date',
  '   Example: /calendar 2026-03-15',
  '/calendar YYYY-MM-DD +N — N days from a start date',
  '   Example: /calendar 2026-03-15 +7',
  '',
  '📊 Scores',
  '/espn_scores — Today\'s NCAA scores for your teams',
  '/espn_scores YYYY-MM-DD — Scores for a specific date',
  '   Example: /espn_scores 2026-03-08',
  '',
  'ℹ️ General',
  '/start — Check bot status',
  '/help — Show this guide',
].join('\n');

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const startText = [
    '⚾ Scouting Bot is running!',
    '',
    'Type /help for a full command guide.',
  ].join('\n');
  bot.sendMessage(chatId, startText);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, HELP_TEXT);
});

bot.onText(/\/calendar(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const { startDate, daysAhead } = parseCalendarArgs(match[1]);

    console.log(`📅 Fetching calendar events: startDate=${startDate || 'today'}, daysAhead=${daysAhead}`);
    const events = await getCalendarEvents(daysAhead, startDate);
    console.log(`✓ Found ${events.length} events`);

    console.log('🧭 Formatting chron...');
    const message = await formatCalendarChron(events);
    console.log(`✓ Formatted message length: ${message.length}`);

    if (!message || message.length === 0) {
      await bot.sendMessage(chatId, '❌ Formatter returned empty message');
      return;
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    console.log('✓ Message sent');
  } catch (error) {
    console.error('❌ Calendar command error:', error);
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

bot.onText(/\/espn_scores(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateArg = match[1] ? match[1].trim() : null;

  let dateStr = null;
  if (dateArg && dateArg.toLowerCase() !== 'today') {
    dateStr = dateArg;
  }

  try {
    const scores = await espnScores(dateStr);
    await bot.sendMessage(chatId, scores, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// Cron job: Send calendar chron every day at 7 AM (Central Time)
cron.schedule('0 12 * * *', () => {
  console.log('⏰ Running scheduled calendar chron...');
  sendCalendarChron();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✓ Bot shutting down gracefully');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n✓ Bot shutting down gracefully');
  bot.stopPolling();
  process.exit(0);
});

// Initialize and start
async function main() {
  console.log('🚀 Starting Scouting Bot with OAuth...');
  await initializeGoogleCalendar();

  bot.on('polling_error', (error) => {
    console.error('✗ Polling error:', error);
  });

  console.log('✓ Bot is running and listening for commands');
  console.log(`✓ Calendar chron scheduled for 7 AM Central daily`);
  console.log(`✓ Chat ID: ${CHAT_ID}`);
  console.log(`✓ Reading from ${calendarsConfig.length} calendars`);
}

main();
