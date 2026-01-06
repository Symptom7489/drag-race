import { sql } from '../../lib/db';

export async function POST({ request, cookies, redirect }) {
  const userId = cookies.get("userId")?.value;
  const data = await request.formData();
  const inviteCode = data.get("inviteCode")?.toUpperCase();

  // 1. Find the league
  const [league] = await sql`SELECT id FROM leagues WHERE invite_code = ${inviteCode}`;
  
  if (league) {
    // 2. Add member (ON CONFLICT prevents double-joining)
    await sql`
      INSERT INTO league_members (league_id, user_id) 
      VALUES (${league.id}, ${userId})
      ON CONFLICT DO NOTHING
    `;
    return redirect(`/leagues/${league.id}`);
  }
  
  return redirect('/dashboard?error=invalid_code');
}