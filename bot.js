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

// Teams to filter for ESPN scores
const TEAMS = [
  'North Dakota State', 'UIC', 'Southern Illinois', 'Eastern Illinois', 'Northwestern',
  'Duke', 'Milwaukee', 'Boston College', 'Arkansas State', 'Sam Houston',
  'App State', 'Virginia', 'Iowa', 'Illinois', 'Illinois State', 'Minnesota',
  'SIU Edwardsville', 'Vanderbilt', 'Kansas State', 'Missouri', 'USC',
  'Omaha', 'UNLV', 'South Dakota State', 'Lindenwood', 'Bellarmine'
];

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
    const startDate = event.start.dateTime ? event.start.dateTime.split('T')[0] : event.start.date;
    
    if (!eventsByDate[startDate]) {
      eventsByDate[startDate] = [];
    }
    eventsByDate[startDate].push(event);

    // Group by team
    const teamName = event.calendarName || 'Other';
    if (!eventsByTeam[teamName]) {
      eventsByTeam[teamName] = [];
    }
    eventsByTeam[teamName].push(event);
  }

  // SECTION 1: Daily Chron
  let output = '🧭 Morning Baseball Chron\n───\n';

  Object.keys(eventsByDate)
    .sort()
    .forEach((date) => {
      const dateObj = new Date(date);
      const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
      const dateStr = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

      output += `📅 ${dayName}, ${dateStr}\n`;

      eventsByDate[date].forEach((event) => {
        let timeStr = '• ';
        if (event.start.dateTime) {
          const time = new Date(event.start.dateTime);
          timeStr += time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        } else {
          timeStr += 'All day';
        }

        timeStr += ` — ${event.summary}`;
        if (event.location) {
          timeStr += ` (${event.location})`;
        }

        output += `${timeStr}\n`;
      });

      output += '\n';
    });

  // SECTION 2: Program Snapshot
  output += '📊 Program Snapshot\n───\n';

  Object.keys(eventsByTeam)
    .sort()
    .forEach((team) => {
      output += `• ${team} — `;
      const games = eventsByTeam[team];
      const gameList = games.map((g) => {
        // Get day and time
        let dayTime = '';
        if (g.start.dateTime) {
          const gameDate = new Date(g.start.dateTime);
          const dayName = gameDate.toLocaleDateString('en-US', { weekday: 'short' });
          const time = gameDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          dayTime = `(${dayName}/${time}) `;
        } else if (g.start.date) {
          const gameDate = new Date(g.start.date);
          const dayName = gameDate.toLocaleDateString('en-US', { weekday: 'short' });
          dayTime = `(${dayName}) `;
        }
        
        const opponent = g.summary;
        const location = g.location ? ` (${g.location})` : '';
        return `${dayTime}${opponent}${location}`;
      }).join('; ');
      output += `${gameList}\n`;
    });

  return output;
}

// Fetch calendar events from all calendars for next N days
async function getCalendarEvents(daysAhead = 3) {
  try {
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysAhead);

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

// Scrape ESPN for college baseball scores
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
    const espnDate = formattedDate.replace(/-/g, '');

    const url = `https://www.espn.com/college-baseball/scoreboard?date=${espnDate}`;

    console.log(`Fetching ESPN scores from: ${url}`);

    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const scores = new Set();

    // Strategy 1: Look for score cells with team data
    $('[data-testid="ScoreCell"]').each((i, el) => {
      const cellText = $(el).text();
      
      let foundTeams = TEAMS.filter(team => cellText.includes(team));
      
      if (foundTeams.length >= 2) {
        const nums = cellText.match(/(\d{1,3})/g) || [];
        if (nums.length >= 2) {
          scores.add(`${foundTeams[0]} ${nums[0]} ${foundTeams[1]} ${nums[1]} F`);
        }
      }
    });

    // Strategy 2: Search full page text for team name patterns
    if (scores.size === 0) {
      const pageText = $('body').text();
      
      for (let i = 0; i < TEAMS.length; i++) {
        for (let j = i + 1; j < TEAMS.length; j++) {
          const team1 = TEAMS[i];
          const team2 = TEAMS[j];
          
          if (pageText.includes(team1) && pageText.includes(team2)) {
            const idx1 = pageText.indexOf(team1);
            const idx2 = pageText.indexOf(team2, idx1);
            
            if (idx2 > idx1 && idx2 - idx1 < 500) {
              const section = pageText.substring(idx1 - 50, idx2 + team2.length + 50);
              const nums = section.match(/(\d{1,3})/g) || [];
              
              if (nums.length >= 2) {
                const score1 = nums[0];
                const score2 = nums[1];
                if (parseInt(score1) <= 30 && parseInt(score2) <= 30) {
                  scores.add(`${team1} ${score1} ${team2} ${score2} F`);
                }
              }
            }
          }
        }
      }
    }

    if (scores.size === 0) {
      return `📊 No games found for your teams on ${formattedDate}\n\nTip: Scores may not be available yet. Try again after games complete.`;
    }

    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let output = `📊 ESPN Scores — ${dayName}, ${monthDay}\n───\n`;
    Array.from(scores).slice(0, 20).forEach((score) => {
      output += score + '\n';
    });

    return output;
  } catch (error) {
    console.error('✗ ESPN scrape error:', error.message);
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

// Bot command handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `⚾ Scouting Bot Ready!\n\nCommands:\n/calendar — Get next 3 days of events\n/espn_scores — Today's scores\n/espn_scores YYYY-MM-DD — Scores for specific date`;
  bot.sendMessage(chatId, helpText);
});

bot.onText(/\/calendar/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    console.log('📅 Fetching calendar events...');
    const events = await getCalendarEvents(3);
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
