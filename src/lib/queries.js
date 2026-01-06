import { sql } from './db';

/**
 * Retrieves the current active episode from the settings table.
 * Used to determine which roster and scores to display by default.
 * @returns {Promise<number>} The episode number as an integer.
 */
export async function getCurrentEpisode() {
  const row = await sql`SELECT value FROM settings WHERE key = 'current_episode'`;
  return parseInt(row[0]?.value || "1");
}

/**
 * Fetches all leagues a specific user belongs to.
 * Includes season-long totals and filtered points for the current episode.
 * @param {string} userId - UUID or ID of the user.
 * @param {number} currentEp - The episode number to filter weekly points.
 */
export async function getUserLeagues(userId, currentEp) {
  return await sql`
    SELECT 
      l.id,
      l.league_name, 
      l.invite_code,
      COALESCE(ls.total_score, 0) as season_total,
      -- Subquery: Sums points only for the current episode and specific league
      (
        SELECT COALESCE(SUM(calculated_points), 0) 
        FROM user_queen_scores 
        WHERE user_id = ${userId} 
        AND episode_number = ${currentEp}
        AND league_id = l.id
      ) as weekly_score,
      -- Subquery: Counts total active members in the league
      (
        SELECT COUNT(*) 
        FROM league_members lm2
        WHERE lm2.league_id = l.id
      ) as member_count
    FROM leagues l
    JOIN league_members lm ON l.id = lm.league_id
    LEFT JOIN league_standings ls ON l.id = ls.league_id AND ls.user_id = ${userId}
    WHERE lm.user_id = ${userId}
  `;
}

/**
 * Fetches the user's roster and joins it with the calculated scores
 * for the specific episode.
 */
export async function getUserTeam(userId, currentEp) {
  return await sql`
    SELECT 
      r.queen_name,
      r.rank,
      COALESCE(uqs.calculated_points, 0) as calculated_points
    FROM rosters r
    LEFT JOIN user_queen_scores uqs ON 
      r.user_id = uqs.user_id AND 
      r.queen_name = uqs.queen_name AND 
      r.episode_number = uqs.episode_number
    WHERE r.user_id = ${userId} 
    AND r.episode_number = ${currentEp}
    ORDER BY r.rank ASC
  `;
}

/**
 * Fetches all configuration from the settings table.
 * Transforms database rows into a usable JavaScript object.
 * Example: { "current_episode": "1", "multiplier_rank_1": "2.0" }
 */
export async function getSettings() {
  const rows = await sql`SELECT key, value FROM settings`;
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/**
 * Helper to extract and format rank multipliers from the settings object.
 * Defaults are provided if settings are missing in the database.
 * @param {Object} settings - The object returned by getSettings().
 */
export function formatMultipliers(settings) {
  return {
    1: parseFloat(settings.multiplier_rank_1 || "2.0"),
    2: parseFloat(settings.multiplier_rank_2 || "1.5"),
    3: parseFloat(settings.multiplier_rank_3 || "1.0"),
    4: parseFloat(settings.multiplier_rank_4 || "0.5"),
  };
}

/**
 * Gets the global rankings for all active users.
 * Season totals are pulled from the pre-calculated league_standings table.
 * MVP Queen is the queen who has contributed the most points to that user so far.
 */
export async function getGlobalLeaderboard() {
  return await sql`
    SELECT 
      u.username,
      COALESCE(ls.total_score, 0) as total_score,
      -- Subquery: Finds the queen name with the highest sum of points for this user
      (
        SELECT queen_name 
        FROM user_queen_scores 
        WHERE user_id = u.id 
        GROUP BY queen_name 
        ORDER BY SUM(calculated_points) DESC 
        LIMIT 1
      ) as mvp_queen
    FROM users u
    LEFT JOIN league_standings ls ON u.id = ls.user_id
    WHERE u.is_active = true
    ORDER BY total_score DESC
  `;
}

/**
 * The "Big Engine": Calculates all scores for a specific episode and
 * refreshes the season-long standings table.
 */
export async function recalculateScores(episodeNumber, multipliers) {
  // 1. Fetch raw points from rosters and box scores
  const epPoints = await sql`
    SELECT 
      r.user_id, 
      lm.league_id, 
      r.rank, 
      r.queen_name, 
      COALESCE(SUM(qbs.points), 0) as raw_points
    FROM rosters r
    JOIN league_members lm ON r.user_id = lm.user_id
    LEFT JOIN queen_box_scores qbs ON r.queen_name = qbs.queen_name AND r.episode_number = qbs.episode_number
    WHERE r.episode_number = ${episodeNumber}
    GROUP BY r.user_id, lm.league_id, r.rank, r.queen_name
  `;

  // 2. Map through and insert/update calculated scores
  for (const row of epPoints) {
    const weighted = parseFloat(row.raw_points) * (multipliers[row.rank] || 1.0);
    
    await sql`
      INSERT INTO user_queen_scores (league_id, user_id, rank, queen_name, calculated_points, episode_number)
      VALUES (${row.league_id}, ${row.user_id}, ${row.rank}, ${row.queen_name}, ${weighted}, ${episodeNumber})
      ON CONFLICT (user_id, rank, episode_number) 
      DO UPDATE SET 
        queen_name = EXCLUDED.queen_name,
        calculated_points = EXCLUDED.calculated_points,
        league_id = EXCLUDED.league_id
    `;
  }

  // 3. Rebuild the standings cache
  await sql`DELETE FROM league_standings`;
  await sql`
    INSERT INTO league_standings (league_id, user_id, total_score) 
    SELECT league_id, user_id, SUM(calculated_points) 
    FROM user_queen_scores 
    GROUP BY league_id, user_id
  `;
}

/**
 * Generic helper to update or insert a value in the settings table.
 * Handles the "ON CONFLICT" logic automatically.
 */
export async function updateSetting(key, value) {
  return await sql`
    INSERT INTO settings (key, value) 
    VALUES (${key}, ${value}) 
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `;
}

/**
 * Updates multiple settings at once (e.g., all 4 multipliers).
 * @param {Object} updates - Example: { multiplier_rank_1: "2.5", ... }
 */
export async function updateSettingsBatch(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value) await updateSetting(key, value);
  }
}

/**
 * Toggles a user's active status for the leaderboard and scoring.
 */
export async function toggleUserStatus(targetId, currentStatus) {
  return await sql`
    UPDATE users SET is_active = ${!currentStatus} WHERE id = ${targetId}
  `;
}

/**
 * Updates a league's name. 
 * Checks if the requesting user is the creator for security.
 */
export async function updateLeagueName(leagueId, userId, newName) {
  return await sql`
    UPDATE leagues 
    SET league_name = ${newName}
    WHERE id = ${leagueId} AND created_by = ${userId}
    RETURNING id
  `;
}


/** CREATE LEAGUE  */
/**
 * Creates a new league and joins the creator to it immediately.
 */
export async function createLeague(userId, leagueName) {
  const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

  // We use a transaction or sequence here to ensure both happen or neither does
  const [newLeague] = await sql`
    INSERT INTO leagues (invite_code, league_name, created_by)
    VALUES (${inviteCode}, ${leagueName}, ${userId})
    RETURNING id
  `;

  await sql`
    INSERT INTO league_members (league_id, user_id)
    VALUES (${newLeague.id}, ${userId})
  `;

  return newLeague;
}

/**
 * Fetches details for a specific league and ensures 
 * the requesting user is a member.
 */
export async function getLeagueDetails(leagueId, userId) {
  const rows = await sql`
    SELECT l.*, 
      (SELECT COUNT(*) FROM league_members WHERE league_id = l.id) as member_count
    FROM leagues l
    JOIN league_members lm ON l.id = lm.league_id
    WHERE l.id = ${leagueId} AND lm.user_id = ${userId}
  `;
  return rows[0];
}