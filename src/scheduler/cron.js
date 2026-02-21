const cron = require('node-cron');
const config = require('../config');
const { getActiveInvestors } = require('../monday/queries');
const { updateNextFollowUp, removeGoingColdFlag } = require('../monday/mutations');
const { runDailyScan } = require('./dailyScan');
const { runGoingColdCheck } = require('./goingCold');
const { runWeeklySummary } = require('./weeklySummary');
const { runStaleAlerts } = require('./staleAlerts');

// In-memory cache for polling Last Contact Date changes
let lastContactCache = {};

function setupCronJobs(slackClient, channelId, recordCronActivity) {
  const recordActivity = recordCronActivity || (() => {});
  console.log('[Cron] Setting up scheduled jobs...');

  // ── 1. Daily scan + going cold check: 9:00 AM EST, Mon-Fri ──
  cron.schedule(
    '0 9 * * *',
    async () => {
      recordActivity();
      try {
        console.log('[Cron] Running daily scan...');
        await runDailyScan(slackClient, channelId);
        console.log('[Cron] Daily scan complete.');
      } catch (err) {
        console.error('[Cron] Daily scan failed:', err.message);
      }

      try {
        console.log('[Cron] Running going-cold check...');
        await runGoingColdCheck(slackClient, channelId);
        console.log('[Cron] Going-cold check complete.');
      } catch (err) {
        console.error('[Cron] Going-cold check failed:', err.message);
      }
    },
    { timezone: 'America/New_York' }
  );

  // ── 2. Weekly summary: Monday 8:00 AM EST ──
  cron.schedule(
    '0 8 * * 1',
    async () => {
      recordActivity();
      try {
        console.log('[Cron] Running weekly summary...');
        await runWeeklySummary(slackClient, channelId);
        console.log('[Cron] Weekly summary complete.');
      } catch (err) {
        console.error('[Cron] Weekly summary failed:', err.message);
      }
    },
    { timezone: 'America/New_York' }
  );

  // ── 3. Stale alerts: Monday 8:30 AM EST ──
  cron.schedule(
    '30 8 * * 1',
    async () => {
      recordActivity();
      try {
        console.log('[Cron] Running stale alerts...');
        await runStaleAlerts(slackClient, channelId);
        console.log('[Cron] Stale alerts complete.');
      } catch (err) {
        console.error('[Cron] Stale alerts failed:', err.message);
      }
    },
    { timezone: 'America/New_York' }
  );

  // ── 4. Auto-calculate next follow-up (polling): every 15 minutes ──
  cron.schedule(
    '*/15 * * * *',
    async () => {
      recordActivity();
      try {
        console.log('[Cron] Polling for Last Contact Date changes...');

        const investors = await getActiveInvestors();
        let updatedCount = 0;

        for (const investor of investors) {
          const lastContactStr = investor.lastContactDate
            ? new Date(investor.lastContactDate).toISOString().split('T')[0]
            : null;

          const cachedStr = lastContactCache[investor.id] || null;

          // Check if Last Contact Date has changed since last poll
          if (lastContactStr && lastContactStr !== cachedStr) {
            const tier = config.cadence[investor.status];
            if (tier) {
              // Calculate next follow-up date
              const lastContact = new Date(investor.lastContactDate);
              const nextDate = new Date(lastContact);
              nextDate.setDate(nextDate.getDate() + tier.autoNextDays);
              const nextDateStr = nextDate.toISOString().split('T')[0];

              // Update Monday.com
              await updateNextFollowUp(investor.id, nextDateStr);

              // Remove going-cold flag if present
              if (investor.name && investor.name.startsWith('\uD83D\uDD34')) {
                await removeGoingColdFlag(investor.id, investor.name);
              }

              console.log(
                `[Cron] Auto-updated next follow-up for ${investor.name}: ${nextDateStr}`
              );
              updatedCount++;
            }
          }

          // Update cache regardless
          lastContactCache[investor.id] = lastContactStr;
        }

        console.log(
          `[Cron] Polling complete. ${updatedCount} follow-up(s) auto-calculated.`
        );
      } catch (err) {
        console.error('[Cron] Polling for contact date changes failed:', err.message);
      }
    },
    { timezone: 'America/New_York' }
  );

  console.log('[Cron] All scheduled jobs registered.');
}

module.exports = { setupCronJobs };
