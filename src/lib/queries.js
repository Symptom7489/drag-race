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
      (SELECT COUNT(*) FROM league_members WHERE league_id = l.id) as member_count,
      -- Get points for ONLY the current week
      COALESCE((
        SELECT SUM(calculated_points) 
        FROM user_queen_scores 
        WHERE user_id = ${userId} 
          AND league_id = l.id 
          AND episode_number = ${currentEp}
      ), 0) as weekly_score,
      -- Get total season points
      COALESCE((
        SELECT total_score 
        FROM league_standings 
        WHERE user_id = ${userId} 
          AND league_id = l.id
      ), 0) as season_total
    FROM leagues l
    JOIN league_members lm ON l.id = lm.league_id
    WHERE lm.user_id = ${userId}
    ORDER BY l.league_name ASC
  `;
}

/**
 * Fetches the user's roster and joins it with the calculated scores
 * for the specific episode.
 */
export async function getUserTeam(userId, currentEp, leagueId) {
  return await sql`
    SELECT 
      r.queen_name,
      r.rank,
      COALESCE(uqs.calculated_points, 0) as calculated_points
    FROM rosters r
    LEFT JOIN user_queen_scores uqs ON 
      r.user_id = uqs.user_id AND 
      r.queen_name = uqs.queen_name AND 
      r.episode_number = uqs.episode_number AND
      uqs.league_id = r.league_id
    WHERE r.user_id = ${userId} 
      AND r.episode_number = ${currentEp}
      AND r.league_id = ${leagueId}
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
    1: parseFloat(settings.multiplier_rank_1 || "2.5"),
    2: parseFloat(settings.multiplier_rank_2 || "2.0"),
    3: parseFloat(settings.multiplier_rank_3 || "1.5"),
    4: parseFloat(settings.multiplier_rank_4 || "1.0"),
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
export async function recalculateScores(episodeNumber) {
  // 1. Get all roster entries for this episode
  const allRosters = await sql`
    SELECT user_id, league_id, queen_name, rank 
    FROM rosters 
    WHERE episode_number = ${episodeNumber}
  `;

  // 2. Get box scores (using your queen_box_scores table)
  const queenPoints = await sql`
    SELECT queen_name, SUM(points) as points 
    FROM queen_box_scores 
    WHERE episode_number = ${episodeNumber}
    GROUP BY queen_name
  `;

  const pointsMap = Object.fromEntries(queenPoints.map(p => [p.queen_name, p.points]));
    const mults = formatMultipliers(await getSettings());

  // 3. Insert/Update individual scores
for (const roster of allRosters) {
    const rawPoints = parseFloat(pointsMap[roster.queen_name] || 0);
    const multiplier = mults[roster.rank] || 1.0;
    const points = rawPoints * multiplier;
    // DEBUG
    console.log(`User: ${roster.user_id} | Queen: ${roster.queen_name} | Raw: ${rawPoints} | Mult: ${multiplier} | Final: ${points}`);

    await sql`
  INSERT INTO user_queen_scores (user_id, league_id, queen_name, episode_number, calculated_points, rank)
  VALUES (${roster.user_id}, ${roster.league_id}, ${roster.queen_name}, ${episodeNumber}, ${points}, ${roster.rank})
  ON CONFLICT (user_id, league_id, queen_name, episode_number) 
  DO UPDATE SET 
    calculated_points = EXCLUDED.calculated_points,
    rank = EXCLUDED.rank
`;
}

  // 4. Update Season Totals
  await sql`
    INSERT INTO league_standings (user_id, league_id, total_score)
    SELECT 
      user_id, 
      league_id, 
      SUM(calculated_points) as total
    FROM user_queen_scores
    GROUP BY user_id, league_id
    ON CONFLICT (user_id, league_id) 
    DO UPDATE SET total_score = EXCLUDED.total_score
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

/**
 * Saves a queen to a user's roster for a SPECIFIC league and episode.
 */
export async function saveRosterSelection(userId, leagueId, episode, selections) {
  // Clear existing selections for this specific league/episode combo first
  await sql`
    DELETE FROM rosters 
    WHERE user_id = ${userId} AND league_id = ${leagueId} AND episode_number = ${episode}
  `;

  // Insert new selections
  // Assumes selections is an array: [{queen_name: 'Bob', rank: 1}, ...]
  for (const s of selections) {
    await sql`
      INSERT INTO rosters (user_id, league_id, queen_name, rank, episode_number)
      VALUES (${userId}, ${leagueId}, ${s.queen_name}, ${s.rank}, ${episode})
    `;
  }
}

/**
 * Fetches all leagues for a user and includes their 
 * specific total score within each league.
 */
export async function getUserLeaguesWithScores(userId) {
  return await sql`
    SELECT 
      l.id, 
      l.league_name, 
      l.invite_code,
      (SELECT COUNT(*) FROM league_members WHERE league_id = l.id) as member_count,
      COALESCE(ls.total_score, 0) as user_total_score
    FROM leagues l
    JOIN league_members lm ON l.id = lm.league_id
    LEFT JOIN league_standings ls ON l.id = ls.league_id AND ls.user_id = ${userId}
    WHERE lm.user_id = ${userId}
    ORDER BY l.created_at DESC
  `;
}

export async function getUserLeaguesWithScores(userId, currentEp) {
  return await sql`
    SELECT 
      l.id, 
      l.league_name, 
      l.invite_code,
      -- Get total season points from our cache table
      COALESCE(ls.total_score, 0) as season_total,
      -- Get points for ONLY the current episode
      COALESCE((
        SELECT SUM(calculated_points) 
        FROM user_queen_scores 
        WHERE user_id = ${userId} 
          AND league_id = l.id 
          AND episode_number = ${currentEp}
      ), 0) as weekly_score
    FROM leagues l
    JOIN league_members lm ON l.id = lm.league_id
    LEFT JOIN league_standings ls ON l.id = ls.league_id AND ls.user_id = ${userId}
    WHERE lm.user_id = ${userId}
    ORDER BY l.league_name ASC
  `;
}