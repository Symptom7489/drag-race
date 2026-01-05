import { sql } from '../../lib/db';

export async function POST({ request, cookies, redirect }) {
  const userId = cookies.get("userId")?.value;
  if (!userId) return redirect('/login');

  const data = await request.formData();
  const inviteCode = data.get("inviteCode")?.trim().toUpperCase();

  // 1. Find the league
  const league = await sql`SELECT id FROM leagues WHERE invite_code = ${inviteCode}`;

  if (league.length === 0) {
    // You can handle this better later with a URL parameter like ?error=notfound
    return redirect('/leagues?error=notfound');
  }

  // 2. Insert the membership
  await sql`
    INSERT INTO league_members (league_id, user_id)
    VALUES (${league[0].id}, ${userId})
    ON CONFLICT (league_id, user_id) DO NOTHING
  `;

  return redirect('/leagues');
}