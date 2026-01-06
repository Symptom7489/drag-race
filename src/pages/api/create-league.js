import { createLeague } from '../../lib/queries';

export async function POST({ request, cookies, redirect }) {
  const userId = cookies.get("userId")?.value;
  if (!userId) return redirect('/login');

  const data = await request.formData();
  const leagueName = data.get("leagueName");

  try {
    // Call our library function
    await createLeague(userId, leagueName);
    
    // Redirect back to the leagues page or dashboard
    return redirect('/dashboard?success=created');
  } catch (e) {
    console.error("League Creation Error:", e);
    return new Response(JSON.stringify({ error: "Failed to create league" }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}