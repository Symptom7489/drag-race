import { sql } from '../../lib/db';

export async function POST({ request, cookies, redirect }) {
  const userId = cookies.get("userId")?.value;
  if (!userId) return redirect('/login');

  const data = await request.formData();
  const leagueName = data.get("leagueName");

  // 1. Generate a random 8-digit alphanumeric code
  const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

  try {
    // 2. Insert the new league
    const [newLeague] = await sql`
      INSERT INTO leagues (invite_code, league_name, created_by)
      VALUES (${inviteCode}, ${leagueName}, ${userId})
      RETURNING id
    `;

    // 3. Automatically add the creator as the first member
    await sql`
      INSERT INTO league_members (league_id, user_id)
      VALUES (${newLeague.id}, ${userId})
    `;

    return redirect('/leagues');
  } catch (e) {
    console.error(e);
    return new Response("Error creating league", { status: 500 });
  }
}