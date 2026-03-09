import TelegramBot from 'node-telegram-bot-api';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import cron from 'node-cron';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CALENDAR_ID = process.env.CALENDAR_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

// Teams to filter for ESPN scores
const TEAMS = [
  'North Dakota State',
  'UIC',
  'Southern Illinois',
  'Eastern Illinois',
  'Northwestern',
  'Duke',
  'Milwaukee',
  'Boston College',
  'Arkansas State',
  'Sam Houston',
  'App State',
  'Virginia',
  'Iowa',
  'Illinois',
  'Illinois State',
  'Minnesota',
  'SIU Edwardsville',
  'Vanderbilt',
  'Kansas State',
  'Missouri',
  'USC',
  'Omaha',
  'UNLV',
  'South Dakota State',
  'Lindenwood',
  'Bellarmine',
  'Lindenwood'
];

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Initialize Google Calendar API
let calendar;
async function initializeGoogleCalendar() {
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    calendar = google.calendar({ version: 'v3', auth });
    console.log('✓ Google Calendar API initialized');
  } catch (error) {
    console.error('✗ Failed to initialize Google Calendar:', error.message);
    process.exit(1);
  }
}

// Format calendar events into "Morning Baseball Chron" style
function formatCalendarChron(events) {
  if (!events || events.length === 0) {
    return 'No events found.';
  }

  // Group events by date
  const eventsByDate = {};
  events.forEach((event) => {
    const startDate = event.start.dateTime ? event.start.dateTime.split('T')[0] : event.start.date;
    if (!eventsByDate[startDate]) {
      eventsByDate[startDate] = [];
    }
    eventsByDate[startDate].push(event);
  });

  // Format output
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

  return output;
}

// Fetch calendar events for next N days
async function getCalendarEvents(daysAhead = 3) {
  try {
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysAhead);

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    return response.data.items || [];
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

    const url = `https://www.espn.com/college-baseball/scoreboard?date=${formattedDate.replace(/-/g, '')}`;

    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(data);
    const scores = [];

    // Find all game containers
    $('.ScoreCell').each((i, el) => {
      const matchupText = $(el).text();

      // Check if any of our teams are in this game
      const hasOurTeam = TEAMS.some((team) => matchupText.includes(team));

      if (hasOurTeam) {
        // Extract team names and score
        const teams = $(el).find('.tc');
        const scoreElements = $(el).find('.score');

        if (teams.length >= 2) {
          const team1 = teams.eq(0).text().trim();
          const team2 = teams.eq(1).text().trim();
          const score1 = scoreElements.eq(0).text().trim();
          const score2 = scoreElements.eq(1).text().trim();

          if (team1 && team2 && score1 && score2) {
            const status = $(el).find('.game-status').text().trim() || 'Live';
            scores.push(`${team1} ${score1} ${team2} ${score2} ${status}`);
          }
        }
      }
    });

    if (scores.length === 0) {
      return `📊 No games found for your teams on ${formattedDate}`;
    }

    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    const monthDay = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let output = `📊 ESPN Scores — ${dayName}, ${monthDay}\n───\n`;
    scores.forEach((score) => {
      output += score + '\n';
    });

    return output;
  } catch (error) {
    console.error('✗ ESPN scrape error:', error.message);
    return `❌ Failed to fetch scores. Error: ${error.message}`;
  }
}

// Send calendar chron to chat
async function sendCalendarChron() {
  try {
    const events = await getCalendarEvents(3);
    const message = formatCalendarChron(events);
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
    const events = await getCalendarEvents(3);
    const message = formatCalendarChron(events);
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

bot.onText(/\/espn_scores(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateArg = match[1] ? match[1].trim() : null;

  // Handle /espn_scores or /espn_scores today
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
// Note: Railway runs on UTC, so 7 AM Central = 12 PM UTC (or 1 PM during DST)
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
  console.log('🚀 Starting Scouting Bot...');
  await initializeGoogleCalendar();

  bot.on('polling_error', (error) => {
    console.error('✗ Polling error:', error);
  });

  console.log('✓ Bot is running and listening for commands');
  console.log(`✓ Calendar chron scheduled for 7 AM Central daily`);
  console.log(`✓ Chat ID: ${CHAT_ID}`);
  console.log(`✓ Calendar ID: ${CALENDAR_ID}`);
}

main();
