import TelegramBot from 'node-telegram-bot-api';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import axios from 'axios';
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
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

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
let drive;
let auth;

async function initializeGoogleCalendar() {
  try {
    auth = await authorize();
    calendar = google.calendar({ version: 'v3', auth });
    drive = google.drive({ version: 'v3', auth });
    console.log('✓ Google Calendar + Drive APIs initialized with OAuth');
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
    const geoRes = await axios.get(geoUrl, { timeout: 3000 });
    if (!geoRes.data || geoRes.data.length === 0) {
      // Cache the null result so we don't retry the same bad location
      weatherCache[cacheKey] = { data: null, fetchedAt: Date.now() };
      return null;
    }

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
    // Clean location before geocoding — skip if blank or too short after stripping
    const rawLocation = event.location.split('—').pop().trim();
    const locationStr = rawLocation.replace(/^[,\s]+/, '').trim();
    if (!locationStr || locationStr.length < 3) return '';
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

// Known team name mappings for shortening
const TEAM_SHORT_NAMES = {
  'eastern illinois university baseball': 'EIU',
  'illinois state university baseball': 'Illinois St',
  'university of illinois baseball': 'Illinois',
  'illini baseball': 'Illinois',
  'university of minnesota baseball': 'Minnesota',
  'north dakota state university baseball': 'NDSU',
  'south dakota state university baseball': 'SDSU',
  'university of iowa baseball': 'Iowa',
  'iowa hawkeyes': 'Iowa',
  'northwestern university baseball': 'Northwestern',
  'northwestern baseball': 'Northwestern',
  'uic baseball': 'UIC',
  'university of illinois chicago baseball': 'UIC',
  'southern illinois university - edwardsville baseball': 'SIUE',
  'siue baseball': 'SIUE',
  'siu edwardsville baseball': 'SIUE',
  'southern illinois university baseball': 'SIU',
  'milwaukee athletics baseball': 'Milwaukee',
  'university of wisconsin-milwaukee baseball': 'Milwaukee',
  'university of nebraska baseball': 'Nebraska',
  'western illinois university baseball': 'WIU',
  'northern illinois university baseball': 'NIU',
  'bradley university baseball': 'Bradley',
  'bradley baseball': 'Bradley',
  'st. thomas baseball': 'St. Thomas',
  'university of st. thomas baseball': 'St. Thomas',
};

function shortenOpponent(name) {
  if (!name) return name;
  const lower = name.toLowerCase().trim();
  for (const [key, short] of Object.entries(TEAM_SHORT_NAMES)) {
    if (lower.startsWith(key)) return short;
  }
  return name
    .replace(/\b(university of|university|college of|college)\b/gi, '')
    .replace(/\bbaseball\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Parse a game title into a clean "Visitor at Home" format
// Returns { display, showLocation }
function parseGameTitle(summary) {
  if (!summary) return { display: summary, showLocation: true };

  // Pre-process SIUE — normalize before lookup
  let s = summary.replace(/southern illinois university\s*-\s*edwardsville baseball/gi, 'SIUE Baseball');

  // Strip leading "Baseball - " prefix (Iowa Hawkeyes calendar format)
  s = s.replace(/^baseball\s*-+\s*/i, '').trim();

  // Strip trailing event suffixes like "- FamILLy Day Friday"
  s = s.replace(/\s+-\s+[^(]+$/, '').trim();

  const lower = s.toLowerCase();

  let subjectShort = null;
  let remainder = s;

  for (const [key, short] of Object.entries(TEAM_SHORT_NAMES)) {
    if (lower.startsWith(key)) {
      subjectShort = short;
      remainder = s.slice(key.length).trim();
      break;
    }
  }

  if (!subjectShort) {
    subjectShort = shortenOpponent(s.split(/\s+at\s+|\s+vs\.?\s+/i)[0]);
  }

  const atMatch = remainder.match(/^at\s+(.+)/i);
  const vsMatch = remainder.match(/^vs\.?\s+(.+)/i);

  if (atMatch) {
    // Away game — "Visitor at Host", no location needed
    return { display: `${subjectShort} at ${shortenOpponent(atMatch[1])}`, showLocation: false };
  } else if (vsMatch) {
    // Home game — flip to "Visitor at Home", no location needed
    return { display: `${shortenOpponent(vsMatch[1])} at ${subjectShort}`, showLocation: false };
  }

  return { display: subjectShort || s, showLocation: true };
}

// Legacy wrapper used by game_states (no location suppression needed there)
function shortenGameSummary(summary) {
  return parseGameTitle(summary).display;
}

// Make a game line relative to the program it appears under in the snapshot
// "Iowa at Penn State" under Iowa Baseball → "at Penn State"
// "Western Illinois at Illinois St" under Illinois St Baseball → "vs. Western Illinois"
function relativeGameLine(display, calendarShort) {
  if (!display || !calendarShort) return display;
  const atMatch = display.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    if (atMatch[1].trim() === calendarShort) return `at ${atMatch[2].trim()}`;
    if (atMatch[2].trim() === calendarShort) return `vs. ${atMatch[1].trim()}`;
  }
  return display;
}

// Extract short name from a calendar name like "EIU Baseball" → "EIU"
function calendarNameToShort(calendarName) {
  if (!calendarName) return null;
  const lower = calendarName.toLowerCase();
  for (const [key, short] of Object.entries(TEAM_SHORT_NAMES)) {
    if (lower.startsWith(key)) return short;
  }
  // Fallback: strip "Baseball" suffix
  return calendarName.replace(/\s*baseball\s*/i, '').trim();
}

// ─── Calendar Formatter ──────────────────────────────────────────────────────

// Clean up location strings — strip leading comma/space from blank city
function cleanLocation(location) {
  if (!location) return null;
  // Remove leading ", " or ", ," artifacts from blank city fields
  const cleaned = location.replace(/^[,\s]+/, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

// Generate a deduplication key for a game event
// Events from two different calendars for the same game share date+time+location
function dedupKey(event) {
  const date = event.start.dateTime ? event.start.dateTime.split('T')[0] : event.start.date;
  const time = event.start.dateTime ? event.start.dateTime : '';
  const loc = (event.location || '').toLowerCase().trim();
  return `${date}|${time}|${loc}`;
}

async function formatCalendar(events) {
  if (!events || events.length === 0) {
    return '📅 No events found.';
  }

  const eventsByDate = {};
  const seenKeys = new Set();

  for (const event of events) {
    if (event.calendarPersonal) continue;

    // Deduplicate timed game events by date+time+location
    if (event.start.dateTime && !isSnapshotExcluded(event.summary)) {
      const key = dedupKey(event);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }

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
        const { display: line, showLocation } = parseGameTitle(event.summary);
        timeStr += ` — ${line}`;
        if (showLocation) {
          const loc = cleanLocation(event.location);
          if (loc) timeStr += ` (${loc})`;
        }
        const weatherTag = await getWeatherTag(event);
        timeStr += weatherTag;
      } else if (isBirthday) {
        timeStr += `🎂 ${event.summary}`;
      } else {
        timeStr += `All day — ${event.summary}`;
        const loc = cleanLocation(event.location);
        if (loc) timeStr += ` (${loc})`;
      }

      output += `${timeStr}\n`;
    }
    output += '\n';
  }

  return output;
}

// ─── Program Snapshot Formatter ──────────────────────────────────────────────

async function formatProgramSnapshot(events) {
  if (!events || events.length === 0) return '📊 No games found.';

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
    output += `\n• *${team}*\n`;
    const calShort = calendarNameToShort(team);
    for (const g of eventsByTeam[team]) {
      const dayShort = new Date(g.start.dateTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: CST });
      const time = formatTimeCST(g.start.dateTime);
      const { display, showLocation } = parseGameTitle(g.summary);
      const line = relativeGameLine(display, calShort);
      const location = showLocation && g.location ? ` (${cleanLocation(g.location)})` : '';
      output += `  ${dayShort}/${time} — ${line}${location}\n`;
    }
  }

  return output;
}

// ─── NCAA Scores ─────────────────────────────────────────────────────────────

// ─── Regional D2/D3 School Filter ───────────────────────────────────────────
// Keywords matched against NCAA API short names (case-insensitive)
// Used to filter /scores d2 and /scores d3 to regional schools only

const D2_REGIONAL_KEYWORDS = [
  // Illinois
  'lewis', 'mckendree', 'quincy', 'roosevelt', 'illinois springfield', 'uis',
  // Iowa
  'upper iowa',
  // Minnesota
  'bemidji', 'concordia-st. paul', 'concordia st. paul', 'minnesota st.', 'minnesota state',
  'minn.-crookston', 'minnesota-crookston', 'minnesota-duluth', 'minn.-duluth',
  'st. cloud', 'sw minnesota', 'southwest minnesota', 'winona st.', 'winona state',
  // North Dakota
  'mary', 'minot st.', 'minot state',
  // South Dakota
  'augustana (sd)', 'augustana (s.d.)', 'northern st.', 'northern state (sd)', 'sioux falls',
  // Wisconsin
  'wis.-parkside', 'parkside',
];

const D3_REGIONAL_KEYWORDS = [
  // Illinois - CCIW
  'augustana (il)', 'augustana (i', 'carroll', 'carthage', 'elmhurst',
  'illinois wesleyan', 'millikin', 'north central (il)', 'north central (i',
  'north park', 'wheaton (il)', 'wheaton (i',
  // Illinois - NACC
  'aurora', 'benedictine (il)', 'concordia chicago', 'concordia-chicago',
  'dominican (il)', 'edgewood', 'illinois tech', 'lakeland',
  'marian (wi)', 'milwaukee engineering', 'rockford', 'wis. lutheran', 'wisconsin lutheran',
  // Illinois - SLIAC
  'blackburn', 'eureka', 'greenville', 'principia',
  // Wisconsin
  'concordia wi', 'concordia (wi', 'st. norbert', 'maranatha',
  'beloit', 'ripon', 'lawrence',
  'uw-eau claire', 'uw-la crosse', 'uw-oshkosh', 'uw-platteville',
  'uw-river falls', 'uw-stevens point', 'uw-stout', 'uw-superior', 'uw-whitewater',
  // Minnesota - MIAC
  'augsburg', 'bethel (mn)', 'bethel (m', 'carleton', 'concordia-moorhead',
  'gustavus', 'hamline', 'macalester', "st. john's (mn)", "st. john's (m",
  "st. mary's (mn)", "st. mary's (m", 'st. olaf', 'st. scholastica',
  // Minnesota - UMAC
  'bethany lutheran', 'crown', 'martin luther', 'minnesota-morris',
  'north central (mn)', 'north central (m', 'northwestern (mn)', 'northwestern (m',
  // Iowa - ARC
  'buena vista', 'central (ia)', 'central (i', 'coe', 'dubuque',
  'loras', 'luther', 'simpson', 'wartburg',
  // MWC (IA/IL/WI/MN)
  'cornell college', 'grinnell', 'illinois college', 'knox',
  'monmouth (il)', 'monmouth (i',
  // UAA
  'chicago',
];

function isRegionalD2(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return D2_REGIONAL_KEYWORDS.some(kw => lower.includes(kw));
}

function isRegionalD3(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return D3_REGIONAL_KEYWORDS.some(kw => lower.includes(kw));
}

// Coverage team display names keyed by ESPN abbreviation
// Use /scores debug or ESPN scoreboard to verify abbreviations
const NCAA_TEAM_MAP = {
  'NDSU': 'NDSU',
  'SDST': 'SDSU',
  'ILL': 'Illinois',
  'ILST': 'Illinois St',
  'WIU': 'WIU',
  'SIU': 'SIU',
  'EIU': 'EIU',
  'NW': 'Northwestern',
  'MIL': 'Milwaukee',
  'IOWA': 'Iowa',
  'MINN': 'Minnesota',
  'SIUE': 'SIUE',
  'UIC': 'UIC',
  'BRAD': 'Bradley',
  'NIU': 'NIU',
  'STTH': 'St. Thomas',
};

// ─── ESPN Conference Lookup ───────────────────────────────────────────────────
// Maps ESPN team abbreviation → conference name
// Source of truth: NCAA D1 standings + real ESPN scoreboard abbreviations
// When a new abbreviation appears in "Other", add it here
const ESPN_CONF_MAP = {
  // ACC (Florida State, North Carolina, Virginia, Georgia Tech, NC State, Pittsburgh,
  //      Louisville, Wake Forest, Duke, Notre Dame, Boston College, Clemson, Miami,
  //      Virginia Tech, Stanford, California, SMU)
  'FSU': 'ACC', 'UNC': 'ACC', 'UVA': 'ACC', 'GT': 'ACC', 'NCSU': 'ACC',
  'PITT': 'ACC', 'LOU': 'ACC', 'WAKE': 'ACC', 'DUKE': 'ACC', 'ND': 'ACC',
  'BC': 'ACC', 'CLEM': 'ACC', 'MIA': 'ACC', 'VT': 'ACC', 'STAN': 'ACC',
  'CAL': 'ACC', 'SMU': 'ACC',

  // America East (Bryant, Binghamton, UMBC, UMass Lowell, NJIT, Maine, Albany)
  'BRYA': 'America East', 'BING': 'America East', 'UMBC': 'America East',
  'UML': 'America East', 'NJIT': 'America East', 'MAINE': 'America East',
  'ALB': 'America East', 'NHVN': 'America East', 'STBK': 'America East',

  // American Athletic (South Florida, UTSA, Charlotte, Wichita State, Florida Atlantic,
  //                    UAB, East Carolina, Rice, Tulane, Memphis)
  'USF': 'American', 'UTSA': 'American', 'CLT': 'American', 'WICH': 'American',
  'FAU': 'American', 'UAB': 'American', 'ECU': 'American', 'RICE': 'American',
  'TULN': 'American', 'MEM': 'American',

  // Atlantic 10 (VCU, George Mason, Saint Joseph's, Fordham, Saint Louis,
  //              George Washington, Dayton, Davidson, Rhode Island, Richmond,
  //              La Salle, St. Bonaventure)
  'VCU': 'Atlantic 10', 'GMU': 'Atlantic 10', 'SJU': 'Atlantic 10', 'JOES': 'Atlantic 10',
  'FORD': 'Atlantic 10', 'SLU': 'Atlantic 10', 'GWU': 'Atlantic 10', 'GW': 'Atlantic 10',
  'DAY': 'Atlantic 10', 'DAV': 'Atlantic 10', 'URI': 'Atlantic 10',
  'RICH': 'Atlantic 10', 'LAS': 'Atlantic 10', 'SBON': 'Atlantic 10',
  'GTWN': 'Atlantic 10', 'MASS': 'Atlantic 10',

  // Big 12 (UCF, Kansas State, West Virginia, Arizona State, Utah, Texas Tech,
  //         BYU, Cincinnati, Houston, Kansas, TCU, Arizona, Baylor, Oklahoma State)
  'UCF': 'Big 12', 'KSU': 'Big 12', 'WVU': 'Big 12', 'ASU': 'Big 12',
  'UTAH': 'Big 12', 'TTU': 'Big 12', 'BYU': 'Big 12', 'CIN': 'Big 12',
  'HOU': 'Big 12', 'KU': 'Big 12', 'TCU': 'Big 12', 'ARIZ': 'Big 12',
  'BAY': 'Big 12', 'OKST': 'Big 12',

  // Big East (Georgetown, Creighton, Seton Hall, Connecticut, Villanova,
  //           St. John's, Xavier, Butler)
  'GTWN': 'Big East', 'CREI': 'Big East', 'HALL': 'Big East', 'CONN': 'Big East',
  'VILL': 'Big East', 'STJN': 'Big East', 'XAV': 'Big East', 'BUT': 'Big East',

  // Big South (Winthrop, Gardner-Webb, USC Upstate, Presbyterian, Longwood,
  //            High Point, UNC Asheville, Charleston Southern, Radford)
  'WIN': 'Big South', 'GWEB': 'Big South', 'USCU': 'Big South', 'UPST': 'Big South',
  'PRES': 'Big South', 'LONG': 'Big South', 'HPU': 'Big South', 'UNCA': 'Big South',
  'CHSO': 'Big South', 'RAD': 'Big South',

  // Big Ten (UCLA, Nebraska, USC, Oregon, Iowa, Rutgers, Washington, Purdue,
  //          Minnesota, Illinois, Maryland, Northwestern, Penn State, Indiana,
  //          Ohio State, Michigan State, Michigan)
  'UCLA': 'Big Ten', 'NEB': 'Big Ten', 'USC': 'Big Ten', 'ORE': 'Big Ten',
  'IOWA': 'Big Ten', 'RUTG': 'Big Ten', 'WASH': 'Big Ten', 'PUR': 'Big Ten',
  'MINN': 'Big Ten', 'ILL': 'Big Ten', 'MD': 'Big Ten', 'NW': 'Big Ten',
  'PSU': 'Big Ten', 'IND': 'Big Ten', 'OSU': 'Big Ten', 'MSU': 'Big Ten',
  'MICH': 'Big Ten',

  // Big West (Cal Poly, UC San Diego, Cal State Fullerton, UC Santa Barbara,
  //           UC Davis, Cal State Northridge, Long Beach State, UC Riverside,
  //           Hawaii, UC Irvine, CSU Bakersfield)
  'CAL P': 'Big West', 'UCSD': 'Big West', 'CSUF': 'Big West', 'UCSB': 'Big West',
  'UCD': 'Big West', 'CSUN': 'Big West', 'LBSU': 'Big West', 'UCR': 'Big West',
  'HAW': 'Big West', 'UCI': 'Big West', 'CSUB': 'Big West', 'UTU': 'Big West',

  // CAA / Coastal (UNCW, Northeastern, Campbell, Monmouth, College of Charleston,
  //                Elon, Hofstra, NC A&T, Stony Brook, Towson, William & Mary)
  'UNCW': 'CAA', 'NE': 'CAA', 'CAMP': 'CAA', 'CAM': 'CAA', 'MONM': 'CAA',
  'COFC': 'CAA', 'ELON': 'CAA', 'HOF': 'CAA', 'NCAT': 'CAA', 'SBU': 'CAA',
  'TOW': 'CAA', 'W&M': 'CAA', 'DREX': 'CAA', 'DEL': 'CAA', 'NORF': 'CAA',

  // C-USA (Jacksonville State, Louisiana Tech, Western Kentucky, Missouri State,
  //        Dallas Baptist, Middle Tennessee, Liberty, Kennesaw State,
  //        New Mexico State, Sam Houston, Delaware, Florida International)
  'JKST': 'C-USA', 'LT': 'C-USA', 'WKU': 'C-USA', 'MOST': 'C-USA',
  'DBU': 'C-USA', 'MTSU': 'C-USA', 'LIB': 'C-USA', 'KENN': 'C-USA',
  'NMSU': 'C-USA', 'SHSU': 'C-USA', 'DEL': 'C-USA', 'FIU': 'C-USA',
  'CARK': 'C-USA', 'UTEP': 'C-USA',

  // Horizon (Milwaukee, Oakland, Northern Kentucky, Youngstown State, Wright State)
  'MIL': 'Horizon', 'OAKL': 'Horizon', 'NKU': 'Horizon', 'YSU': 'Horizon',
  'WRST': 'Horizon', 'UIC': 'Horizon', 'IUPU': 'Horizon',

  // Independent
  'ORST': 'Independent',

  // Ivy League (Yale, Brown, Princeton, Pennsylvania, Dartmouth, Columbia,
  //             Cornell, Harvard)
  'YALE': 'Ivy', 'BRWN': 'Ivy', 'PRIN': 'Ivy', 'PENN': 'Ivy',
  'DART': 'Ivy', 'COR': 'Ivy', 'HARV': 'Ivy', 'COLU': 'Ivy',

  // MAAC / Metro Atlantic (Rider, Marist, Mount St. Mary's, Merrimack, Fairfield,
  //                         Iona, Sacred Heart, Quinnipiac, Siena, Niagara,
  //                         Manhattan, Canisius, Saint Peter's)
  'RIDE': 'MAAC', 'MRMK': 'MAAC', 'MSM': 'MAAC', 'MERR': 'MAAC',
  'FAIR': 'MAAC', 'IONA': 'MAAC', 'SHU': 'MAAC', 'QUNN': 'MAAC', 'QUC': 'MAAC',
  'SIEN': 'MAAC', 'NIAG': 'MAAC', 'MANH': 'MAAC', 'CANI': 'MAAC',
  'SPU': 'MAAC',

  // MAC (Kent State, Miami OH, Ball State, Toledo, Western Michigan, NIU,
  //      Akron, Bowling Green, UMass, Central Michigan, Ohio, Eastern Michigan)
  'KENT': 'MAC', 'MIOH': 'MAC', 'BALL': 'MAC', 'TOL': 'MAC', 'WMU': 'MAC',
  'NIU': 'MAC', 'AKR': 'MAC', 'BGSU': 'MAC', 'UMASS': 'MAC', 'CMU': 'MAC',
  'OHIO': 'MAC', 'EMU': 'MAC',

  // Missouri Valley (Illinois State, Murray State, Southern Illinois, Belmont,
  //                  Valparaiso, Indiana State, Evansville, Illinois-Chicago, Bradley)
  'ILST': 'Missouri Valley', 'MUR': 'Missouri Valley', 'SIU': 'Missouri Valley',
  'BELM': 'Missouri Valley', 'BEL': 'Missouri Valley', 'VAL': 'Missouri Valley',
  'INST': 'Missouri Valley', 'EVAN': 'Missouri Valley', 'UIC': 'Missouri Valley',
  'BRAD': 'Missouri Valley',

  // Mountain West (Nevada, Air Force, San Diego State, San Jose State, New Mexico,
  //                Washington State, Fresno State, Grand Canyon, UNLV)
  'NEV': 'Mountain West', 'AF': 'Mountain West', 'SDSU': 'Mountain West',
  'SJSU': 'Mountain West', 'UNM': 'Mountain West', 'WSU': 'Mountain West',
  'FRES': 'Mountain West', 'GCU': 'Mountain West', 'UNLV': 'Mountain West',

  // NEC (Fairleigh Dickinson, Central Connecticut, Mercyhurst, Le Moyne,
  //      Long Island, Stonehill, Wagner, Norfolk State, Coppin State,
  //      New Haven, UMES, Delaware State)
  'FDU': 'NEC', 'CCSU': 'NEC', 'MRCY': 'NEC', 'LEM': 'NEC',
  'LIU': 'NEC', 'STNH': 'NEC', 'WAG': 'NEC', 'NSU': 'NEC',
  'COPP': 'NEC', 'NHVN': 'NEC', 'UMES': 'NEC', 'DSU': 'NEC',
  'MRMK': 'NEC', 'MRSH': 'NEC',

  // OVC (Southeast Missouri State, Southern Indiana, Eastern Illinois, Little Rock,
  //      Lindenwood, Morehead State, Tennessee-Martin, Tennessee Tech,
  //      SIU Edwardsville, Western Illinois)
  'SEMO': 'OVC', 'SOIN': 'OVC', 'USI': 'OVC', 'EIU': 'OVC', 'UALR': 'OVC',
  'LIND': 'OVC', 'MORH': 'OVC', 'UTM': 'OVC', 'TNTC': 'OVC',
  'SIUE': 'OVC', 'WIU': 'OVC', 'APSU': 'OVC', 'EKU': 'OVC',

  // Patriot (Bucknell, Holy Cross, Lehigh, Navy, Army, Lafayette)
  'BUCK': 'Patriot', 'HC': 'Patriot', 'LEHG': 'Patriot', 'NAVY': 'Patriot',
  'ARMY': 'Patriot', 'LAF': 'Patriot',

  // ASUN
  'FGCU': 'ASUN', 'JAX': 'ASUN', 'KENN': 'ASUN', 'LIP': 'ASUN', 'LIB': 'ASUN',
  'NKU': 'ASUN', 'UNF': 'ASUN', 'BELL': 'ASUN', 'UNA': 'ASUN',

  // SEC (Auburn, Kentucky, Florida, Texas, Georgia, Oklahoma, Arkansas,
  //      Vanderbilt, Texas A&M, Mississippi State, Ole Miss, Tennessee,
  //      LSU, Missouri, Alabama, South Carolina)
  'AUB': 'SEC', 'UK': 'SEC', 'FLA': 'SEC', 'TEX': 'SEC', 'UGA': 'SEC',
  'OU': 'SEC', 'ARK': 'SEC', 'VAN': 'SEC', 'TA&M': 'SEC', 'MSST': 'SEC',
  'MISS': 'SEC', 'TENN': 'SEC', 'LSU': 'SEC', 'MIZZ': 'SEC', 'MIZ': 'SEC',
  'ALA': 'SEC', 'SC': 'SEC', 'USA': 'SEC',

  // SoCon (Mercer, VMI, East Tennessee State, Western Carolina, Wofford,
  //        UNC Greensboro, The Citadel, Samford)
  'MER': 'SoCon', 'VMI': 'SoCon', 'ETSU': 'SoCon', 'WCU': 'SoCon',
  'WOF': 'SoCon', 'UNCG': 'SoCon', 'CIT': 'SoCon', 'SAM': 'SoCon',

  // Southland (Northwestern State, Lamar, Southeastern Louisiana, Houston Christian,
  //            Stephen F. Austin, UT Rio Grande Valley, Incarnate Word, McNeese,
  //            Nicholls, New Orleans, Texas A&M-Corpus Christi)
  'NWST': 'Southland', 'LAM': 'Southland', 'SELA': 'Southland', 'HCU': 'Southland',
  'SFAU': 'Southland', 'RGV': 'Southland', 'UIW': 'Southland', 'MCNS': 'Southland',
  'NICH': 'Southland', 'UNO': 'Southland', 'TXST': 'Southland',

  // Summit (Oral Roberts, Omaha, St. Thomas, Northern Colorado,
  //         South Dakota State, North Dakota State)
  'ORAL': 'Summit', 'OMA': 'Summit', 'OMAH': 'Summit', 'STTH': 'Summit',
  'UNCO': 'Summit', 'SDST': 'Summit', 'NDSU': 'Summit',

  // Sun Belt (Coastal Carolina, James Madison, Marshall, UL Monroe, Louisiana,
  //           Arkansas State, Troy, Southern Miss, South Alabama, Old Dominion,
  //           Texas State, Appalachian State, Georgia State, Georgia Southern)
  'CCU': 'Sun Belt', 'JMU': 'Sun Belt', 'MRSH': 'Sun Belt', 'ULM': 'Sun Belt',
  'ULL': 'Sun Belt', 'UL': 'Sun Belt', 'ARST': 'Sun Belt', 'TROY': 'Sun Belt',
  'USM': 'Sun Belt', 'USA': 'Sun Belt', 'ODU': 'Sun Belt', 'TXST': 'Sun Belt',
  'APP': 'Sun Belt', 'GAST': 'Sun Belt', 'GASO': 'Sun Belt',

  // SWAC (Bethune-Cookman, Arkansas-Pine Bluff, Texas Southern, Florida A&M,
  //       Alabama A&M, Grambling, Alabama State, Jackson State, Southern,
  //       Alcorn State, Mississippi Valley State, Prairie View)
  'BCU': 'SWAC', 'UAPB': 'SWAC', 'TXSO': 'SWAC', 'FAMU': 'SWAC',
  'AAMU': 'SWAC', 'GRAM': 'SWAC', 'ALST': 'SWAC', 'JXST': 'SWAC',
  'SOU': 'SWAC', 'ALCN': 'SWAC', 'MVSU': 'SWAC', 'PV': 'SWAC',

  // WAC (California Baptist, Tarleton, Utah Tech, Utah Valley, Abilene Christian,
  //      Sacramento State, UT Arlington)
  'CBU': 'WAC', 'TAR': 'WAC', 'UTU': 'WAC', 'UVU': 'WAC',
  'ACU': 'WAC', 'SAC': 'WAC', 'UTA': 'WAC', 'TARL': 'WAC',

  // WCC (Portland, Saint Mary's, Santa Clara, San Francisco, Pacific,
  //      Gonzaga, San Diego, Loyola Marymount, Pepperdine, Seattle)
  'PORT': 'WCC', 'SMC': 'WCC', 'SCU': 'WCC', 'USFCA': 'WCC',
  'PAC': 'WCC', 'GONZ': 'WCC', 'USD': 'WCC', 'LMU': 'WCC',
  'PEPP': 'WCC', 'SEA': 'WCC', 'SM': 'WCC',
};

function getEspnConference(abbrev) {
  return ESPN_CONF_MAP[abbrev] || 'Other';
}

function isCoverageTeam(name) {
  return name in NCAA_TEAM_MAP;
}

function displayName(name) {
  return NCAA_TEAM_MAP[name] || name;
}

// ─── ESPN Game Normalization ──────────────────────────────────────────────────
// Normalize an ESPN scoreboard event into a common game object
function normalizeEspnGame(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;

  const awayComp = comp.competitors.find(c => c.homeAway === 'away');
  const homeComp = comp.competitors.find(c => c.homeAway === 'home');
  if (!awayComp || !homeComp) return null;

  const status = event.status?.type;
  const state = status?.state || 'pre';

  const awayAbbrev = awayComp.team?.abbreviation || '';
  const homeAbbrev = homeComp.team?.abbreviation || '';
  if (!awayAbbrev || !homeAbbrev) return null; // skip NAIA/non-D1 opponents

  return {
    _espn: true,
    away: {
      abbrev: awayComp.team?.abbreviation || '',
      name: awayComp.team?.displayName || '',
      score: awayComp.score || '0',
      winner: awayComp.winner || false,
    },
    home: {
      abbrev: homeComp.team?.abbreviation || '',
      name: homeComp.team?.displayName || '',
      score: homeComp.score || '0',
      winner: homeComp.winner || false,
    },
    state,   // 'pre' | 'in' | 'post'
    completed: status?.completed ?? false,
    detail: status?.shortDetail || '',  // e.g. "Bot 8th", "Final", "6:00 PM ET"
    date: event.date || '',
  };
}

function formatScoreLine(g) {
  const awayAbbrev = g.away?.abbrev || '';
  const homeAbbrev = g.home?.abbrev || '';
  const awayDisplay = displayName(awayAbbrev);
  const homeDisplay = displayName(homeAbbrev);

  if (g.state === 'post') {
    if (!g.completed) return `⛈ ${awayDisplay} vs ${homeDisplay} — PPD`;
    const awayScore = g.away?.score || '';
    const homeScore = g.home?.score || '';
    if (!awayScore || !homeScore) return null;
    const awayBold = g.away?.winner ? `*${awayDisplay}*` : awayDisplay;
    const homeBold = g.home?.winner ? `*${homeDisplay}*` : homeDisplay;
    return `${awayBold} ${awayScore}, ${homeBold} ${homeScore}`;
  } else if (g.state === 'in') {
    return `🟢 ${awayDisplay} ${g.away?.score}, ${homeDisplay} ${g.home?.score} — ${g.detail}`;
  } else {
    // Format time from UTC date string to CST
    let timeStr = g.detail || 'TBA';
    if (g.date) {
      try {
        timeStr = new Date(g.date).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Chicago'
        });
      } catch (_) {}
    }
    return `${awayDisplay} @ ${homeDisplay} — ${timeStr}`;
  }
}

async function fetchNcaaScores(division = 'd1', dateStr = null, confFilter = null) {
  let targetDate;
  if (!dateStr) {
    targetDate = new Date(getTodayCST() + 'T12:00:00');
  } else {
    targetDate = new Date(dateStr + 'T12:00:00');
    if (isNaN(targetDate)) return '❌ Invalid date. Use YYYY-MM-DD';
  }

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');

  // ESPN only has D1 college baseball — D2/D3 still use NCAA API
  let games = [];
  const divLabel = division.toUpperCase();
  const dateLabel = targetDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  let output = `⚾ *NCAA ${divLabel} Scores — ${dateLabel}*\n───\n`;

  if (division === 'd1') {
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard?dates=${yyyy}${mm}${dd}&limit=300`;
    console.log(`⚾ Fetching D1 scores (ESPN): ${url}`);
    const res = await axios.get(url, { timeout: 8000 });
    const events = res.data?.events || [];
    games = events.map(normalizeEspnGame).filter(Boolean);
  } else {
    // D2/D3: NCAA API (ESPN doesn't cover these)
    const url = `https://ncaa-api.henrygd.me/scoreboard/baseball/${division}/${yyyy}/${mm}/${dd}/all-conf`;
    console.log(`⚾ Fetching ${divLabel} scores (NCAA API): ${url}`);
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    // Normalize NCAA API format to match our common shape
    games = (res.data?.games || []).map(item => {
      const g = item.game;
      if (!g) return null;
      const ncaaState = g.gameState || 'pre';
      // Map NCAA states to ESPN states for unified downstream logic
      const state = ncaaState === 'final' ? 'post' : ncaaState === 'live' ? 'in' : 'pre';
      return {
        away: { abbrev: g.away?.names?.short || '', name: g.away?.names?.full || '', score: g.away?.score || '0', winner: g.away?.winner || false },
        home: { abbrev: g.home?.names?.short || '', name: g.home?.names?.full || '', score: g.home?.score || '0', winner: g.home?.winner || false },
        state,
        detail: g.currentPeriod || '',
        date: g.startTime || '',
        _ncaaConf: {
          away: g.away?.conferences?.[0] || null,
          home: g.home?.conferences?.[0] || null,
        }
      };
    }).filter(Boolean);
  }

  if (games.length === 0) return output + 'No games found.';

  if (division === 'd1') {
    // Coverage teams first
    const coverageGames = [];
    const otherGames = [];

    for (const g of games) {
      if (isCoverageTeam(g.away.abbrev) || isCoverageTeam(g.home.abbrev)) {
        coverageGames.push(g);
      } else {
        otherGames.push(g);
      }
    }

    if (coverageGames.length > 0) {
      output += `\n🎯 *Your Coverage*\n`;
      for (const state of ['post', 'in', 'pre']) {
        const group = coverageGames.filter(g => g.state === state);
        if (group.length > 0) {
          const label = state === 'in' ? 'LIVE' : state === 'pre' ? 'SCHEDULED' : 'FINAL';
          output += `\n${label}\n`;
          group.forEach(g => { const line = formatScoreLine(g); if (line) output += `  ${line}\n`; });
        }
      }
    }

    // All other D1 — grouped by conference
    if (otherGames.length > 0) {
      if (confFilter) {
        // Conference filter: match against ESPN_CONF_MAP
        const cf = confFilter.toLowerCase();
        const filtered = otherGames.filter(g => {
          const awayConf = getEspnConference(g.away.abbrev).toLowerCase();
          const homeConf = getEspnConference(g.home.abbrev).toLowerCase();
          return awayConf.includes(cf) || homeConf.includes(cf) ||
                 g.away.name.toLowerCase().includes(cf) ||
                 g.home.name.toLowerCase().includes(cf);
        });
        if (filtered.length > 0) {
          output += `\n📋 *${confFilter}*\n`;
          for (const state of ['in', 'post', 'pre']) {
            filtered.filter(g => g.state === state)
              .forEach(g => { const line = formatScoreLine(g); if (line) output += `  ${line}\n`; });
          }
        } else {
          output += `\n❌ No games found matching "${confFilter}" today.\n`;
        }
      } else {
        // Build conference → games map with double-sort
        const byConf = {};
        for (const g of otherGames) {
          const awayConf = getEspnConference(g.away.abbrev);
          const homeConf = getEspnConference(g.home.abbrev);

          if (!byConf[awayConf]) byConf[awayConf] = [];
          byConf[awayConf].push(g);

          if (homeConf !== awayConf) {
            if (!byConf[homeConf]) byConf[homeConf] = [];
            byConf[homeConf].push(g);
          }
        }

        // Sort: known conferences alphabetically, Other always last
        const confOrder = Object.keys(byConf).sort((a, b) => {
          if (a === 'Other') return 1;
          if (b === 'Other') return -1;
          return a.localeCompare(b);
        });

        output += `\n📋 *All Other D1 Games*\n`;
        for (const conf of confOrder) {
          output += `\n*${conf}*\n`;
          const confGames = byConf[conf];
          for (const state of ['in', 'post', 'pre']) {
            confGames.filter(g => g.state === state)
              .forEach(g => { const line = formatScoreLine(g); if (line) output += `  ${line}\n`; });
          }
        }
      }
    }

  } else {
    // D2/D3: Regional filter
    const isRegional = division === 'd2' ? isRegionalD2 : isRegionalD3;
    const regionalGames = games.filter(g => isRegional(g.away.abbrev) || isRegional(g.home.abbrev));

    if (regionalGames.length === 0) {
      return output + `No regional games found today.\n\nChecked ${games.length} total ${divLabel} games.`;
    }

    output += `\n🎯 *Regional ${divLabel} Games (IL/WI/IA/MN/ND/SD)*\n`;
    for (const state of ['in', 'post', 'pre']) {
      const group = regionalGames.filter(g => g.state === state);
      if (group.length > 0) {
        const label = state === 'in' ? 'LIVE' : state === 'pre' ? 'SCHEDULED' : 'FINAL';
        output += `\n${label}\n`;
        group.forEach(g => { const line = formatScoreLine(g); if (line) output += `  ${line}\n`; });
      }
    }
  }

  return output;
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
  '🔍 Stats Query',
  '/stats [question] — Fast query via Haiku (simple ranking)',
  '/statsplus [question] — Deep query via Sonnet (derived stats, cross-team)',
  '/stats top 5 Iowa hitters by BA',
  '/statsplus BB% leaders all D1 pitchers min 20 IP',
  '',
  '⚾ Scores',
  '/scores — Today\'s D1 scores (your teams first)',
  '/scores big ten — Single conference',
  '/scores mvc 2026-03-13 +3 — Conference over N days',
  '/scores sec 2026-03-15 — Conference on date',
  '/scores d2 — D2 regional scores',
  '/scores d3 — D3 regional scores',
  '/scores YYYY-MM-DD — Specific date',
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
const STATE_PRIORITY = ['IL', 'WI', 'IA', 'MN', 'SD', 'ND', 'NE'];

// All valid US state abbreviations
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC'
]);

// Maps full names, dotted abbreviations, and short forms to 2-letter codes
const STATE_NAME_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI',
  'wyoming':'WY',
  'ill':'IL','ala':'AL','ariz':'AZ','ark':'AR','calif':'CA','colo':'CO',
  'conn':'CT','fla':'FL','ind':'IN','kan':'KS','mass':'MA','mich':'MI',
  'minn':'MN','miss':'MS','mont':'MT','neb':'NE','nev':'NV','okla':'OK',
  'ore':'OR','tenn':'TN','tex':'TX','wash':'WA','wis':'WI','wyo':'WY'
};

function extractState(location) {
  if (!location) return null;
  const loc = location.trim();

  // Tokenize on spaces and commas, strip trailing periods from each token
  const tokens = loc.split(/[\s,]+/).map(t => t.replace(/\.$/, '').trim()).filter(Boolean);

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper.length === 2 && US_STATES.has(upper)) {
      console.log('extractState: "' + loc + '" -> "' + upper + '" (2-letter code)');
      return upper;
    }
    const mapped = STATE_NAME_MAP[token.toLowerCase()];
    if (mapped) {
      console.log('extractState: "' + loc + '" -> "' + mapped + '" (name/abbr: "' + token + '")');
      return mapped;
    }
  }

  // Last resort: multi-word state names
  const lower = loc.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAME_MAP)) {
    if (name.includes(' ') && lower.includes(name)) {
      console.log('extractState: "' + loc + '" -> "' + code + '" (multi-word: "' + name + '")');
      return code;
    }
  }

  console.log('extractState: "' + loc + '" -> NO STATE FOUND');
  return null;
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
      const { display: gsLine, showLocation: gsShowLoc } = parseGameTitle(g.summary);
      const gsLoc = gsShowLoc ? ` (${cleanLocation(g.location) || g.location})` : '';
      output += `• ${dayShort}/${time} — ${gsLine}${gsLoc}\n`;
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

// /scores [d1|d2|d3] [YYYY-MM-DD]
// Fetch scores across multiple days — only used with conf/team filter
async function fetchNcaaScoresMultiDay(division, dateStr, daysAhead, confFilter) {
  const startDate = dateStr
    ? new Date(dateStr + 'T12:00:00')
    : new Date();

  const results = [];

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    try {
      const url = `https://ncaa-api.henrygd.me/scoreboard/baseball/${division}/${yyyy}/${mm}/${dd}/all-conf`;
      const res = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      const games = (res.data?.games || []).map(g => g.game);

      // Build conference map with double-sort
      const confSeoToName = {
        'acc': 'ACC', 'big-12': 'Big 12', 'big-ten': 'Big Ten', 'big-east': 'Big East',
        'sec': 'SEC', 'pac-12': 'Pac-12', 'american': 'American', 'cusa': 'C-USA',
        'mac': 'MAC', 'mwc': 'Mountain West', 'sun-belt': 'Sun Belt',
        'mvc': 'Missouri Valley', 'horizon': 'Horizon', 'summit': 'Summit League',
        'big-south': 'Big South', 'southern': 'Southern', 'southland': 'Southland',
        'wac': 'WAC', 'wcc': 'WCC', 'patriot': 'Patriot', 'ivy': 'Ivy League',
        'maac': 'MAAC', 'a-sun': 'ASUN', 'caa': 'CAA', 'meac': 'MEAC',
        'swac': 'SWAC', 'nec': 'NEC', 'ovc': 'OVC', 'big-west': 'Big West',
        'america-east': 'America East', 'atlantic-10': 'Atlantic 10',
        'atlantic-sun': 'ASUN', 'big-east': 'Big East', 'ind': 'Independent',
      };

      const byConf = {};
      for (const g of games) {
        const awaySeo = g.away?.conferences?.[0]?.conferenceSeo || '';
        const homeSeo = g.home?.conferences?.[0]?.conferenceSeo || '';
        const awayConf = confSeoToName[awaySeo] || g.away?.conferences?.[0]?.conferenceName || 'Independent';
        const homeConf = confSeoToName[homeSeo] || g.home?.conferences?.[0]?.conferenceName || 'Independent';
        if (!byConf[awayConf]) byConf[awayConf] = [];
        byConf[awayConf].push(g);
        if (homeConf !== awayConf) {
          if (!byConf[homeConf]) byConf[homeConf] = [];
          byConf[homeConf].push(g);
        }
      }

      // Filter to requested conference
      const matchedConf = Object.keys(byConf).find(c => c.toLowerCase() === confFilter.toLowerCase());
      const dayGames = matchedConf ? byConf[matchedConf] : [];

      if (dayGames.length > 0) {
        let dayOutput = `\n📅 *${dayLabel}*\n`;
        for (const state of ['live', 'final', 'preview']) {
          dayGames
            .filter(g => g.gameState === state)
            .forEach(g => {
              const line = formatScoreLine(g);
              if (line) dayOutput += `  ${line}\n`;
            });
        }
        results.push(dayOutput);
      } else {
        results.push(`\n📅 *${dayLabel}*\n  No ${confFilter} games\n`);
      }
    } catch (err) {
      results.push(`\n📅 *${dayLabel}*\n  Failed to fetch\n`);
    }
  }

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + daysAhead - 1);
  const startLabel = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let output = `⚾ *${confFilter} — ${startLabel} through ${endLabel}*\n───`;
  output += results.join('');
  return output;
}

// Conference keyword → display name mapping for /scores filter
const CONF_KEYWORDS = {
  'acc': 'ACC', 'big ten': 'Big Ten', 'big-ten': 'Big Ten', 'b1g': 'Big Ten',
  'sec': 'SEC', 'big 12': 'Big 12', 'big-12': 'Big 12', 'big twelve': 'Big 12',
  'pac-12': 'Pac-12', 'pac 12': 'Pac-12', 'pac12': 'Pac-12',
  'american': 'American', 'aac': 'American',
  'cusa': 'C-USA', 'c-usa': 'C-USA',
  'mac': 'MAC', 'mid-american': 'MAC',
  'mountain west': 'Mountain West', 'mwc': 'Mountain West',
  'sun belt': 'Sun Belt', 'sunbelt': 'Sun Belt',
  'mvc': 'Missouri Valley', 'missouri valley': 'Missouri Valley',
  'horizon': 'Horizon',
  'summit': 'Summit League', 'summit league': 'Summit League',
  'big south': 'Big South', 'big-south': 'Big South',
  'southern': 'Southern',
  'southland': 'Southland',
  'wac': 'WAC',
  'wcc': 'WCC', 'west coast': 'WCC',
  'patriot': 'Patriot', 'patriot league': 'Patriot',
  'ivy': 'Ivy League', 'ivy league': 'Ivy League',
  'maac': 'MAAC',
  'asun': 'ASUN', 'a-sun': 'ASUN', 'atlantic sun': 'ASUN',
  'caa': 'CAA', 'colonial': 'CAA',
  'meac': 'MEAC',
  'swac': 'SWAC',
  'nec': 'NEC', 'northeast': 'NEC',
  'ovc': 'OVC', 'ohio valley': 'OVC',
  'big west': 'Big West', 'big-west': 'Big West',
  'america east': 'America East',
  'atlantic 10': 'Atlantic 10', 'a-10': 'Atlantic 10', 'a10': 'Atlantic 10',
  'big east': 'Big East', 'big-east': 'Big East',
  'independent': 'Independent', 'ind': 'Independent',
};

function parseConfFilter(argStr) {
  if (!argStr) return null;
  const lower = argStr.toLowerCase().trim();
  // Sort by length descending to match longest keyword first
  const sorted = Object.entries(CONF_KEYWORDS).sort((a, b) => b[0].length - a[0].length);
  for (const [kw, name] of sorted) {
    if (lower.includes(kw)) return name;
  }
  return null;
}

bot.onText(/\/scores(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const argStr = (match[1] || '').trim().toLowerCase();
  const args = argStr.split(/\s+/);

  // Parse division, date, +N days ahead, and conference from args
  let division = 'd1';
  let dateStr = null;
  let daysAhead = null;

  for (const arg of args) {
    if (['d1', 'd2', 'd3'].includes(arg)) {
      division = arg;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      dateStr = arg;
    } else if (/^\+\d+$/.test(arg)) {
      daysAhead = parseInt(arg.slice(1));
    }
  }

  // Parse conference filter — only applies to D1
  const confFilter = division === 'd1' ? parseConfFilter(argStr) : null;

  try {
    const label = confFilter ? confFilter : division.toUpperCase();
    await bot.sendMessage(chatId, `⚾ Fetching ${label} scores...`);

    let result;
    if (confFilter && daysAhead && daysAhead > 1) {
      // Multi-day fetch — only available with conference filter
      const days = Math.min(daysAhead, 7); // cap at 7 days
      result = await fetchNcaaScoresMultiDay(division, dateStr, days, confFilter);
    } else {
      result = await fetchNcaaScores(division, dateStr, confFilter);
    }

    await sendChunked(chatId, result, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('✗ /scores error:', error.message);
    await bot.sendMessage(chatId, `❌ Failed to fetch scores: ${error.message}`);
  }
});

// ─── Cron ─────────────────────────────────────────────────────────────────────


// ─── Stats Query (Drive + Claude) ────────────────────────────────────────────

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

async function getStatsFile() {
  if (!DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID not set in environment variables.');

  // Find the Excel file in the folder
  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
  });

  const files = res.data.files;
  if (!files || files.length === 0) throw new Error('No files found in DRIVE_FOLDER_ID folder.');

  // Prefer xlsx files
  const xlsxFile = files.find(f => f.name.endsWith('.xlsx') || f.name.endsWith('.xls'));
  const target = xlsxFile || files[0];
  console.log(`📂 Found stats file: ${target.name} (${target.id})`);

  // Download the file as buffer
  const fileRes = await drive.files.get(
    { fileId: target.id, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  return { buffer: Buffer.from(fileRes.data), name: target.name };
}

async function parseStatsSheets(buffer) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheets = {};
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { skipHidden: true });
    // Only include non-empty sheets
    if (csv.trim().length > 10) {
      sheets[sheetName] = csv;
    }
  }
  return sheets;
}

// Team keyword → short name mapping for tab pre-filtering
const STATS_TEAM_KEYWORDS = [
  ['siu edwardsville', 'SIUE'], ['siue', 'SIUE'],
  ['eastern illinois', 'EIU'], ['eiu', 'EIU'],
  ['illinois state', 'Illinois St'], ['illinois st', 'Illinois St'],
  ['minnesota state', 'Minnesota St'], ['minnesota st', 'Minnesota St'],
  ['north dakota state', 'NDSU'], ['ndsu', 'NDSU'],
  ['south dakota state', 'SDSU'], ['sdsu', 'SDSU'],
  ['western illinois', 'WIU'], ['wiu', 'WIU'],
  ['northern illinois', 'NIU'], ['niu', 'NIU'],
  ['northwestern', 'Northwestern'],
  ['st. thomas', 'St. Thomas'],
  ['bradley', 'Bradley'],
  ['illini', 'Illinois'], ['university of illinois', 'Illinois'],
  ['milwaukee', 'Milwaukee'],
  ['minnesota', 'Minnesota'],
  ['illinois', 'Illinois'],
  ['iowa', 'Iowa'],
  ['uic', 'UIC'],
  ['siu', 'SIU'],
];

const STATS_DIVISION_KEYWORDS = [
  ['junior college', 'JC'], ['juco', 'JC'], ['jc', 'JC'],
  ['division 1', 'D1'], ['d1', 'D1'],
  ['division 2', 'D2'], ['d2', 'D2'],
];

function filterStatSheets(question, sheets) {
  const q = question.toLowerCase();
  const allSheetNames = Object.keys(sheets);

  let divFilter = null;
  for (const [kw, div] of STATS_DIVISION_KEYWORDS) {
    if (q.includes(kw)) { divFilter = div; break; }
  }

  let teamFilter = null;
  for (const [kw, short] of STATS_TEAM_KEYWORDS) {
    if (q.includes(kw)) { teamFilter = short; break; }
  }

  if (!teamFilter && !divFilter) {
    console.log('📊 No team/division filter — sending all tabs');
    return sheets;
  }

  const filtered = {};
  for (const name of allSheetNames) {
    const nameLower = name.toLowerCase();
    const teamMatch = !teamFilter || nameLower.includes(teamFilter.toLowerCase());
    const divMatch = !divFilter || nameLower.includes(divFilter.toLowerCase());
    if (teamMatch && divMatch) filtered[name] = sheets[name];
  }

  const count = Object.keys(filtered).length;
  console.log(`📊 Filter: team=${teamFilter || 'any'}, div=${divFilter || 'any'} → ${count} tab(s)`);

  // Fallback to all tabs if filter matched nothing
  return count > 0 ? filtered : sheets;
}

async function queryStatsWithClaude(question, sheets, model = 'claude-haiku-4-5-20251001') {
  // Pre-filter tabs based on team/division mentioned in question
  const filteredSheets = filterStatSheets(question, sheets);
  const tabCount = Object.keys(filteredSheets).length;
  const totalCount = Object.keys(sheets).length;
  if (tabCount < totalCount) {
    console.log(`📊 Sending ${tabCount}/${totalCount} tabs to Claude`);
  }

  const sheetSummary = Object.entries(filteredSheets)
    .map(([name, csv]) => `=== ${name} ===\n${csv}`)
    .join('\n\n');

  const MAX_CHARS = 80000;
  const truncated = sheetSummary.length > MAX_CHARS
    ? sheetSummary.slice(0, MAX_CHARS) + '\n\n[Data truncated due to size]'
    : sheetSummary;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      system: `You are a baseball scouting assistant. You have access to a scouting stats spreadsheet with multiple tabs — each tab represents a team's hitters or pitchers. Each tab name indicates the team, division (D1, D2, or JC), and type (hitters or pitchers). Determine a player's division strictly from the tab name only — never use your own knowledge of a school's division classification. Answer the user's question using only the data provided. Be concise and direct. Format your answer clearly for a Telegram message — use plain text, no markdown. If ranking players, use a numbered list and sort numerically — highest to lowest for offensive stats (BA, OBP, SLG, OPS, HR, RBI, BB%), lowest to highest for pitching stats (ERA, WHIP, BB%). Always include the player name, team, and the relevant stat value. If a stat is not a column, calculate it from available columns. Apply any minimum thresholds strictly before ranking.`,
      messages: [
        {
          role: 'user',
          content: `Here is the scouting stats data:\n\n${truncated}\n\nQuestion: ${question}`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(`Claude API error: ${data.error.message}`);
  return data.content[0].text;
}

async function handleStatsQuery(chatId, question, model) {
  const modelLabel = model.includes('haiku') ? 'Haiku' : 'Sonnet';
  try {
    await bot.sendMessage(chatId, `🔍 Fetching stats and querying (${modelLabel})...`);
    console.log(`📊 /stats query [${modelLabel}]: "${question}"`);

    const { buffer, name } = await getStatsFile();
    console.log(`✓ Downloaded: ${name}`);

    const sheets = await parseStatsSheets(buffer);
    console.log(`✓ Parsed ${Object.keys(sheets).length} sheets`);

    const answer = await queryStatsWithClaude(question, sheets, model);
    await sendChunked(chatId, answer);
  } catch (error) {
    console.error(`✗ /stats error:`, error.message);
    await bot.sendMessage(chatId, `❌ Stats query failed: ${error.message}`);
  }
}

// /stats — Haiku (fast, low cost, simple ranking queries)
bot.onText(/\/stats(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1] ? match[1].trim() : null;
  if (!question) {
    return bot.sendMessage(chatId, '❓ Please include a question.\nExample: /stats top 5 Iowa hitters by BA');
  }
  await handleStatsQuery(chatId, question, 'claude-haiku-4-5-20251001');
});

// /statsplus — Sonnet (complex queries, derived stats, cross-team analysis)
bot.onText(/\/statsplus(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1] ? match[1].trim() : null;
  if (!question) {
    return bot.sendMessage(chatId, '❓ Please include a question.\nExample: /statsplus BB% leaders across all D1 pitchers minimum 20 innings');
  }
  await handleStatsQuery(chatId, question, 'claude-sonnet-4-20250514');
});



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
