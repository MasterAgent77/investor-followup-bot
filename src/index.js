require('dotenv').config();

const express = require('express');
const config = require('./config');

// =============================================================================
// 1. PROCESS CRASH HANDLERS — registered before anything else
// =============================================================================

const startTime = Date.now();
let lastCronActivity = Date.now(); // Watchdog: track last cron/reminder activity

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error('[FATAL] Stack:', err.stack);
  console.error('[FATAL] Process will exit in 3 seconds (Railway auto-restart)...');
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled promise rejection:', reason);
  if (reason instanceof Error) {
    console.error('[ERROR] Stack:', reason.stack);
  }
  // Do NOT crash — log and continue
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Received SIGTERM — shutting down gracefully...');
  for (const id of activeIntervals) {
    clearInterval(id);
  }
  console.log('[shutdown] Cleanup complete. Exiting.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[shutdown] Received SIGINT — shutting down...');
  for (const id of activeIntervals) {
    clearInterval(id);
  }
  process.exit(0);
});

// Track all setInterval IDs for cleanup on shutdown
const activeIntervals = new Set();

// =============================================================================
// 2. STARTUP VALIDATION — fail fast with clear errors
// =============================================================================

function validateEnvVars() {
  const required = [
    { key: 'SLACK_BOT_TOKEN', value: config.slack.botToken },
    { key: 'SLACK_APP_TOKEN', value: config.slack.appToken },
    { key: 'SLACK_SIGNING_SECRET', value: config.slack.signingSecret },
    { key: 'MONDAY_API_TOKEN', value: config.monday.apiToken },
  ];

  const missing = required.filter(r => !r.value);

  if (missing.length > 0) {
    console.error('='.repeat(60));
    console.error('[FATAL] Missing required environment variables:');
    for (const m of missing) {
      console.error(`  ❌ ${m.key} is NOT SET`);
    }
    console.error('='.repeat(60));
    console.error('[FATAL] Bot cannot start. Exiting with code 1.');
    process.exit(1);
  }

  // Warn about optional vars
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[startup] Optional: ANTHROPIC_API_KEY not set — NLU features disabled');
  }
  if (!process.env.SMTP_HOST) {
    console.warn('[startup] Optional: SMTP_HOST not set — email reminders disabled');
  }

  console.log('[startup] ✅ All required environment variables present');
  console.log(`[startup] SLACK_BOT_TOKEN: set (starts with xoxb-: ${config.slack.botToken.startsWith('xoxb-')})`);
  console.log(`[startup] SLACK_APP_TOKEN: set (starts with xapp-: ${config.slack.appToken.startsWith('xapp-')})`);
  console.log(`[startup] MONDAY_API_TOKEN: set (first 10: ${config.monday.apiToken.substring(0, 10)}...)`);
}

async function testMondayConnectivity() {
  try {
    const { mondayApi } = require('./monday/client');
    console.log('[startup] Testing Monday.com API connectivity...');
    const data = await mondayApi('query { me { id name } }');
    if (data && data.me) {
      console.log(`[startup] ✅ Monday.com API connected as: ${data.me.name} (ID: ${data.me.id})`);
      return true;
    }
    console.error('[startup] ❌ Monday.com API returned unexpected response');
    return false;
  } catch (err) {
    console.error('[startup] ❌ Monday.com API connection FAILED:', err.message);
    console.error('[startup] Cron jobs will still start but may fail. Check MONDAY_API_TOKEN.');
    return false;
  }
}

// =============================================================================
// 3. MEMORY MONITORING + WATCHDOG
// =============================================================================

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function startMemoryMonitor() {
  const id = setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = mem.heapUsed / 1024 / 1024;
    const uptimeMin = ((Date.now() - startTime) / 60000).toFixed(1);

    console.log(
      `[health] Memory: heap=${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)} ` +
      `rss=${formatBytes(mem.rss)} external=${formatBytes(mem.external)} | uptime=${uptimeMin}min`
    );

    // Warn + GC if heap exceeds 400MB
    if (heapMB > 400) {
      console.warn(`[health] ⚠️ Heap usage ${heapMB.toFixed(0)}MB exceeds 400MB threshold!`);
      if (global.gc) {
        console.log('[health] Forcing garbage collection...');
        global.gc();
        const after = process.memoryUsage();
        console.log(`[health] After GC: heap=${formatBytes(after.heapUsed)}`);
      }
    }

    // Check for event listener leaks on process
    const names = process.eventNames();
    for (const name of names) {
      const count = process.listenerCount(name);
      if (count > 10) {
        console.warn(`[health] ⚠️ Listener leak: process.on('${String(name)}') has ${count} listeners`);
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  activeIntervals.add(id);
  console.log('[health] Memory monitor started (every 5 min)');
}

function startWatchdog() {
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  const id = setInterval(() => {
    const sinceMs = Date.now() - lastCronActivity;
    const sinceMin = (sinceMs / 60000).toFixed(1);

    if (sinceMs > TIMEOUT_MS) {
      console.error(`[watchdog] ❌ No cron/reminder activity for ${sinceMin} min — forcing restart!`);
      process.exit(1); // Railway auto-restarts
    } else {
      console.log(`[watchdog] OK — last activity ${sinceMin} min ago`);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  activeIntervals.add(id);
  console.log('[watchdog] Started (30-min inactivity timeout)');
}

/** Called from cron.js and reminder checker to reset watchdog. */
function recordCronActivity() {
  lastCronActivity = Date.now();
}

// =============================================================================
// 4. MAIN START
// =============================================================================

async function start() {
  // ── Fail fast if env vars are missing ──
  validateEnvVars();

  // ── Test Monday.com API before starting cron jobs ──
  await testMondayConnectivity();

  // ── Lazy-load modules (after env validation) ──
  const app = require('./slack/app');
  const { registerCommands } = require('./slack/commands');
  const { setupCronJobs } = require('./scheduler/cron');
  const { loadReminders } = require('./reminders/store');
  const { startReminderChecker } = require('./reminders/checker');
  const { getActiveInvestors } = require('./monday/queries');
  const { registerWebhookRoutes } = require('./webhook/server');

  // ── Health check + webhook Express server ──
  const server = express();
  server.disable('x-powered-by');
  server.use(express.json());

  server.get('/', (req, res) => {
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;

    res.json({
      status: 'ok',
      uptime: `${h}h ${m}m ${s}s`,
      uptimeSeconds: uptimeSec,
      memory: {
        heapUsed: formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal),
        rss: formatBytes(mem.rss),
      },
      lastCronActivity: new Date(lastCronActivity).toISOString(),
      cronIdleMs: Date.now() - lastCronActivity,
      startedAt: new Date(startTime).toISOString(),
    });
  });

  server.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const cronStale = (Date.now() - lastCronActivity) > 30 * 60 * 1000;

    if (cronStale) {
      return res.status(503).json({
        status: 'unhealthy',
        reason: 'No cron activity for 30+ minutes',
        uptimeSeconds: uptimeSec,
        heapUsed: formatBytes(mem.heapUsed),
      });
    }

    res.json({
      status: 'healthy',
      uptimeSeconds: uptimeSec,
      heapUsed: formatBytes(mem.heapUsed),
      lastCronActivity: new Date(lastCronActivity).toISOString(),
    });
  });

  server.listen(process.env.PORT || 3000, () => {
    console.log(`[health] Health + webhook server on port ${process.env.PORT || 3000}`);
  });

  // ── Load persisted reminders ──
  loadReminders();

  // ── Register Slack commands BEFORE app.start() ──
  registerCommands(app);
  console.log('[slack] Message listeners registered');

  // ── Start Slack app (Socket Mode) ──
  await app.start();
  console.log('[slack] Slack bot connected via Socket Mode');

  // ── Verify and join channel ──
  let channelId = config.slack.channelId;
  try {
    const info = await app.client.conversations.info({ channel: channelId });
    if (info.channel) {
      console.log(`[startup] Verified channel #${info.channel.name} (${channelId})`);
    }
  } catch (err) {
    console.warn(`[startup] Could not verify channel ${channelId}: ${err.message}`);
    try {
      let cursor;
      do {
        const result = await app.client.conversations.list({
          types: 'public_channel,private_channel',
          limit: 200,
          cursor,
        });
        const found = result.channels.find(c => c.name === config.slack.channel);
        if (found) {
          channelId = found.id;
          break;
        }
        cursor = result.response_metadata?.next_cursor;
      } while (cursor);
    } catch (listErr) {
      console.error('[startup] Error looking up Slack channel:', listErr.message);
    }
  }

  if (!channelId) {
    console.warn(`[startup] ⚠️ Channel #${config.slack.channel} not found — create it and invite the bot.`);
  } else {
    console.log(`[startup] Using channel #${config.slack.channel} (${channelId})`);

    try {
      await app.client.conversations.join({ channel: channelId });
      console.log(`[startup] Bot joined channel ${channelId} (or was already a member)`);
    } catch (joinErr) {
      if (joinErr.data?.error === 'already_in_channel') {
        console.log(`[startup] Bot already in channel ${channelId}`);
      } else if (joinErr.data?.error === 'method_not_supported_for_channel_type') {
        console.warn(`[startup] Cannot auto-join ${channelId} (private). Invite manually: /invite @InvestorBot`);
      } else if (joinErr.data?.error === 'missing_scope') {
        // FIX #3: missing_scope is non-fatal with clear instructions
        console.warn('='.repeat(60));
        console.warn(`[startup] ⚠️ MISSING SLACK SCOPE for channels:join`);
        console.warn('[startup] Required scopes: channels:history, channels:read, channels:join,');
        console.warn('[startup]   chat:write, users:read, users:read.email, im:write, connections:write');
        console.warn('[startup] Fix: https://api.slack.com/apps → OAuth & Permissions → Add scope → Reinstall');
        console.warn('[startup] Workaround: manually /invite @InvestorBot to the channel');
        console.warn('='.repeat(60));
      } else {
        console.error(`[startup] Failed to join channel ${channelId}:`, joinErr.message);
      }
    }
  }

  // ── Register Monday.com webhook routes ──
  registerWebhookRoutes(server, app.client);

  // ── Join webhook notification channel ──
  const { FOLLOWUP_CHANNEL } = require('./webhook/handler');
  try {
    await app.client.conversations.join({ channel: FOLLOWUP_CHANNEL });
    console.log(`[startup] Bot joined webhook channel ${FOLLOWUP_CHANNEL}`);
  } catch (joinErr) {
    if (joinErr.data?.error === 'already_in_channel') {
      console.log(`[startup] Bot already in webhook channel ${FOLLOWUP_CHANNEL}`);
    } else if (joinErr.data?.error === 'missing_scope') {
      console.warn(`[startup] ⚠️ Cannot join ${FOLLOWUP_CHANNEL} — missing_scope (non-fatal)`);
    } else {
      console.warn(`[startup] Could not join webhook channel ${FOLLOWUP_CHANNEL}: ${joinErr.message}`);
    }
  }

  // ── Set up cron jobs (pass recordCronActivity for watchdog) ──
  setupCronJobs(app.client, channelId, recordCronActivity);
  console.log('[cron] Scheduled: daily scan 9AM, weekly Mon 8AM, stale Mon 8:30AM, polling 15min');

  // ── Start reminder checker ──
  startReminderChecker(app.client, channelId, recordCronActivity);
  console.log('[reminders] Reminder checker started (every 60s)');

  // ── Start monitoring ──
  startMemoryMonitor();
  startWatchdog();
  recordCronActivity(); // Initial activity so watchdog doesn't trip immediately

  // ── Startup summary ──
  try {
    const investors = await getActiveInvestors();
    const statusSet = new Set(investors.map(i => i.status).filter(Boolean));
    console.log(
      `🚀 Investor Follow-Up Bot started. Monitoring ${investors.length} investors across ${statusSet.size} status categories.`
    );
  } catch (err) {
    console.log('🚀 Investor Follow-Up Bot started.');
    console.warn('[startup] Could not fetch initial investor count:', err.message);
  }
}

start().catch(err => {
  console.error('[fatal] Failed to start bot:', err);
  process.exit(1);
});
